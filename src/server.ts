import Fastify, { type FastifyInstance, type FastifyRequest } from 'fastify';
import { loadConfig } from './config.js';
import { InstagramAdapter } from './adapters/instagram/sender.js';
import { TikTokAdapter } from './adapters/tiktok/adapter.js';
import { pollAllTikTokAccounts } from './adapters/tiktok/poller.js';
import type { MessageSender } from './adapters/types.js';
import { ReplyThrottle } from './core/throttle.js';
import type { Platform } from './core/types.js';
import { openDb } from './storage/db.js';
import { registerErrorHandler, registerFormParser, registerSecurityHeaders } from './web/http.js';
import { registerAuthRoutes } from './web/routes/auth.js';
import { registerDashboardRoutes } from './web/routes/dashboard.js';
import { registerLeadsRoutes } from './web/routes/leads.js';
import { registerFilesRoutes } from './web/routes/files.js';
import { registerConstructorRoutes } from './web/routes/constructor.js';
import { registerAdminRoutes } from './web/routes/admin.js';
import { registerInviteRoutes } from './web/routes/invite.js';
import { registerStyleRoute } from './web/routes/style.js';
import { registerThemeRoute } from './web/routes/theme.js';
import { registerWebhookRoutes } from './web/routes/webhooks.js';
import { runDelivery, runIntake, type WorkerDeps } from './worker.js';

function main(): void {
  const cfg = loadConfig();
  // Миграции при старте не применяются: при нескольких копиях процесса это
  // гонка — две копии накатывают одну миграцию одновременно. Отдельный шаг
  // `npm run migrate` перед запуском
  const { db, warmUp } = openDb(cfg.DATABASE_URL);
  // Страница кабинета шлёт несколько запросов разом; соединения под них лучше
  // открыть на старте, чем счётом за рукопожатия TLS встретить первого клиента.
  // Не блокирует запуск: сервер начинает слушать порт, не дожидаясь базы
  void warmUp(3);
  const instagram = new InstagramAdapter({ maxTextLength: cfg.MAX_INCOMING_TEXT_LENGTH });
  const tiktok = new TikTokAdapter({ maxTextLength: cfg.MAX_INCOMING_TEXT_LENGTH });

  const app: FastifyInstance = Fastify({
    logger: {
      level: cfg.NODE_ENV === 'production' ? 'info' : 'debug',
      // S9: Fastify логирует URL каждого запроса, а в `/invite/<токен>` лежит
      // секрет. До этой фазы секретов в путях не было — теперь путь усечён
      serializers: {
        req: (request: FastifyRequest) => ({
          method: request.method,
          url: request.url.startsWith('/invite/') ? '/invite/:token' : request.url,
        }),
      },
    },
  });
  registerWebhookRoutes(app, { db, cfg, source: instagram });

  // Кабинет и вебхук живут в одном процессе (раздел 10 спеки). Троттлинг входа
  // свой, отдельный от троттлинга ответов боту: у них разные окна и разная цена
  // ошибки
  const web = {
    db, cfg,
    throttle: new ReplyThrottle(cfg.LOGIN_MAX_ATTEMPTS, cfg.LOGIN_WINDOW_MINUTES * 60_000),
  };
  registerFormParser(app);
  registerSecurityHeaders(app, cfg.NODE_ENV === 'production');
  // Ставится до маршрутов: он ловит и те ошибки, что рождаются в их хуках
  registerErrorHandler(app);
  registerAuthRoutes(app, web);
  registerDashboardRoutes(app, web);
  registerLeadsRoutes(app, web);
  registerFilesRoutes(app, web);
  registerConstructorRoutes(app, web);
  registerAdminRoutes(app, web);
  registerInviteRoutes(app, web);
  registerStyleRoute(app);
  registerThemeRoute(app, cfg);

  const worker: WorkerDeps = {
    db, cfg,
    senders: new Map<Platform, MessageSender>([['instagram', instagram], ['tiktok', tiktok]]),
    throttle: new ReplyThrottle(cfg.THROTTLE_MAX_REPLIES_PER_MINUTE),
    clientThrottle: new ReplyThrottle(cfg.THROTTLE_MAX_REPLIES_PER_CLIENT_PER_MINUTE),
  };

  // Один процесс на бота и веб: общий деплой, общая база (раздел 10 спеки).
  // Таймер, а не бесконечный цикл: так шаг воркера остаётся вызываемым из теста.
  // Флаг running не даёт прогонам наложиться, если один затянулся дольше интервала.
  let running = false;
  setInterval(() => {
    if (running) return;
    running = true;
    const now = new Date();

    // Приём стал асинхронным вместе со слоем хранилища, поэтому обе половины
    // шага — одна цепочка промисов. Объект ошибки не печатаем: в нём оказываются
    // тело сообщения и параметры подключения (S4, S9)
    void runIntake(worker, now)
      .catch(() => { app.log.error('цикл приёма упал'); })
      .then(() => runDelivery(worker, now))
      .catch(() => { app.log.error('цикл доставки упал'); })
      .finally(() => { running = false; });
  }, cfg.WORKER_INTERVAL_MS);

  // У TikTok нет вебхука на комментарии — события приходится забирать самим.
  // Интервал свой, много длиннее шага воркера: опрос ходит в сеть за каждым
  // аккаунтом, и частый обход упрётся в лимиты платформы. Флаг polling не даёт
  // прогонам наложиться, если обход затянулся дольше интервала
  let polling = false;
  setInterval(() => {
    if (polling) return;
    polling = true;
    void pollAllTikTokAccounts(db, tiktok, cfg.CREDENTIALS_ENC_KEY)
      // Объект ошибки не печатаем: в нём оказываются токен и тела комментариев (S9)
      .catch(() => { app.log.error('опрос TikTok упал'); })
      .finally(() => { polling = false; });
  }, cfg.TIKTOK_POLL_INTERVAL_SEC * 1000);

  app.listen({ port: cfg.PORT, host: '0.0.0.0' }).catch((): void => {
    // Ошибку не печатаем целиком: в ней бывает конфигурация (S9)
    app.log.error('не удалось занять порт');
    process.exit(1);
  });
}

main();
