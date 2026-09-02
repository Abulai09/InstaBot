import Fastify, { type FastifyInstance } from 'fastify';
import { loadConfig } from './config.js';
import { InstagramAdapter } from './adapters/instagram/sender.js';
import type { MessageSender } from './adapters/types.js';
import { ReplyThrottle } from './core/throttle.js';
import type { Platform } from './core/types.js';
import { openDb } from './storage/db.js';
import { registerFormParser, registerSecurityHeaders } from './web/http.js';
import { registerAuthRoutes } from './web/routes/auth.js';
import { registerDashboardRoutes } from './web/routes/dashboard.js';
import { registerLeadsRoutes } from './web/routes/leads.js';
import { registerWebhookRoutes } from './web/routes/webhooks.js';
import { runDelivery, runIntake, type WorkerDeps } from './worker.js';

function main(): void {
  const cfg = loadConfig();
  const db = openDb(cfg.DATABASE_URL);
  const instagram = new InstagramAdapter({ maxTextLength: cfg.MAX_INCOMING_TEXT_LENGTH });

  const app: FastifyInstance = Fastify({
    logger: { level: cfg.NODE_ENV === 'production' ? 'info' : 'debug' },
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
  registerAuthRoutes(app, web);
  registerDashboardRoutes(app, web);
  registerLeadsRoutes(app, web);

  const worker: WorkerDeps = {
    db, cfg,
    senders: new Map<Platform, MessageSender>([['instagram', instagram]]),
    throttle: new ReplyThrottle(cfg.THROTTLE_MAX_REPLIES_PER_MINUTE),
  };

  // Один процесс на бота и веб: общий деплой, общая база (раздел 10 спеки).
  // Таймер, а не бесконечный цикл: так шаг воркера остаётся вызываемым из теста.
  // Флаг running не даёт прогонам наложиться, если один затянулся дольше интервала.
  let running = false;
  setInterval(() => {
    if (running) return;
    running = true;
    const now = new Date();

    try {
      runIntake(worker, now);
    } catch {
      // Одно битое событие не роняет процесс. Объект ошибки не печатаем:
      // в нём оказываются тело сообщения и параметры подключения (S4, S9)
      app.log.error('цикл приёма упал');
    }

    void runDelivery(worker, now)
      .catch(() => { app.log.error('цикл доставки упал'); })
      .finally(() => { running = false; });
  }, cfg.WORKER_INTERVAL_MS);

  app.listen({ port: cfg.PORT, host: '0.0.0.0' }).catch((): void => {
    // Ошибку не печатаем целиком: в ней бывает конфигурация (S9)
    app.log.error('не удалось занять порт');
    process.exit(1);
  });
}

main();
