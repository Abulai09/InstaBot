import { randomUUID } from 'node:crypto';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { Config } from '../../config.js';
import type { Platform } from '../../core/types.js';
import { connectOrUpdateAccount, type ConnectOutcome } from '../../storage/queries/accounts.js';
import { createInvite, revokeUserInvites } from '../../storage/queries/invites.js';
import { deleteUserSessions } from '../../storage/queries/sessions.js';
import {
  createUser, findUserByEmail, findUserById, listClients, setUserDisabled,
} from '../../storage/queries/users.js';
import { csrfToken, csrfValid } from '../csrf.js';
import { hashPassword } from '../password.js';
import { currentSession, redirectToLogin, type WebDeps } from '../session.js';
import { adminPage, type Notice } from '../views/admin.js';

/**
 * Единственное место, которое рисует список: все POST-маршруты заканчиваются
 * им же, только с разным `notice`. Редиректа после POST нет намеренно —
 * ссылку приглашения нужно показать, а через редирект её пришлось бы
 * протаскивать в URL, то есть в лог и в историю браузера (S9).
 */
async function renderList(
  deps: WebDeps, request: FastifyRequest, reply: FastifyReply, notice: Notice | undefined,
): Promise<FastifyReply> {
  const session = await currentSession(deps, request, new Date());
  if (session === undefined) return redirectToLogin(reply);

  return reply
    .header('cache-control', 'no-store')
    .type('text/html; charset=utf-8')
    .send(adminPage(
      await listClients(deps.db),
      csrfToken(session.token, deps.cfg.SESSION_SECRET),
      notice,
    ).value);
}

/**
 * S14: схемы описывают ровно разрешённые поля. `role`, `user_id` и `disabled_at`
 * не читаются из тела нигде и никогда — владелец берётся из сессии, роль задаётся
 * кодом. Поэтому `role=owner` в форме просто не доходит до кода.
 *
 * `csrf` необязателен в схеме намеренно: его отсутствие — отказ (403),
 * а не кривой запрос (400).
 */
const NewClientForm = z.object({
  // html5Email — тот же паттерн, что браузер применяет к `<input type="email">`:
  // строгий `z.email()` по умолчанию требует TLD от двух букв и отклоняет
  // короткие тестовые домены вида `k.k`, которые браузер считает валидными
  email: z.email({ pattern: z.regexes.html5Email }).max(320),
  csrf: z.string().optional(),
});

/** Формы без полей, кроме csrf: перевыпуск ссылки и переключатель отключения. */
const CsrfOnlyForm = z.object({ csrf: z.string().optional() });

/**
 * Внешний id проверяется по платформе: Instagram выдаёт числовые
 * идентификаторы, у TikTok id аккаунта — строка. Общее у обоих правил одно:
 * ни точек, ни слэшей. Этот id уходит в путь запроса к платформе, и «..» в нём
 * меняет вызываемый эндпоинт (S22).
 *
 * Платформа теперь приходит формой — это не нарушение S14: в форме перечислен
 * закрытый список значений, а признаком владения платформа не является.
 * Владелец по-прежнему берётся из сессии, клиент — из пути.
 */
function accountForm<P extends Platform>(platform: P, externalId: RegExp) {
  return z.object({
    platform: z.literal(platform),
    external_account_id: z.string().regex(externalId),
    token: z.string().min(1).max(512),
    csrf: z.string().optional(),
  });
}

const AccountForm = z.discriminatedUnion('platform', [
  accountForm('instagram', /^[0-9]{1,32}$/),
  accountForm('tiktok', /^[A-Za-z0-9_-]{1,64}$/),
]);

const Params = z.object({ id: z.string().min(1) });

/**
 * Единая проверка CSRF для всех POST-маршрутов админки: раньше строка была
 * дословно повторена в каждом обработчике. Поведение не меняется — отсутствие
 * или неверный токен по-прежнему дают 403 без тела, а не 400.
 */
function requireCsrf(deps: WebDeps, sessionToken: string, csrf: string | undefined): boolean {
  return csrfValid(sessionToken, csrf, deps.cfg.SESSION_SECRET);
}

async function inviteFor(deps: WebDeps, userId: string, now: Date): Promise<string> {
  // Перевыпуск гасит прежние: иначе после «ссылка утекла, выпустите новую»
  // старая продолжала бы работать до конца своего срока
  await revokeUserInvites(deps.db, userId, now);
  const token = await createInvite(deps.db, userId, now, deps.cfg.INVITE_TTL_HOURS * 3_600_000);
  return `${base(deps.cfg)}/invite/${token}`;
}

function base(cfg: Config): string {
  return cfg.PUBLIC_BASE_URL.replace(/\/+$/, '');
}

/**
 * S12 — function-level авторизация. Хук живёт внутри плагина, а Fastify
 * инкапсулирует хуки: он действует на маршруты этого плагина и только на них.
 * Новый маршрут внутри защищён автоматически — забыть проверку физически нечего.
 *
 * Это другая проверка, чем S11: там «твой ли объект», тут «твоя ли роль».
 */
export function registerAdminRoutes(app: FastifyInstance, deps: WebDeps): void {
  app.register((admin, _opts, done) => {
    admin.addHook('onRequest', async (request, reply) => {
      const session = await currentSession(deps, request, new Date());
      if (session === undefined) {
        await redirectToLogin(reply);
        return;
      }
      if (session.role !== 'owner') {
        // 403, а не 404: скрывать существование админки бессмысленно,
        // а разные коды помогают владельцу понять, что он зашёл не тем входом
        await reply.code(403).send();
      }
    });

    // Обработчики зовут currentSession повторно: им нужен `token` для CSRF.
    // Это один индексированный SELECT — дешевле, чем протаскивать сессию
    // через декоратор запроса и подпирать его расширением типов Fastify
    admin.get('/', (request, reply) => renderList(deps, request, reply, undefined));

    admin.post('/clients', async (request, reply) => {
      const session = await currentSession(deps, request, new Date());
      if (session === undefined) return redirectToLogin(reply);

      const parsed = NewClientForm.safeParse(request.body);
      if (!parsed.success) {
        return renderList(deps, request, reply, { kind: 'error', text: 'Некорректная почта' });
      }
      if (!requireCsrf(deps, session.token, parsed.data.csrf)) {
        return reply.code(403).send();
      }

      const email = parsed.data.email.trim().toLowerCase();
      if (await findUserByEmail(deps.db, email) !== undefined) {
        return renderList(deps, request, reply, {
          kind: 'error', text: 'Клиент с такой почтой уже заведён',
        });
      }

      // Пароля у клиента ещё нет, а колонка notNull. Хэш от случайного UUID
      // не совпадёт ни с одним вводом, и путь установки пароля остаётся один —
      // через приглашение (S13)
      let userId: string;
      try {
        userId = await createUser(deps.db, {
          email, passwordHash: await hashPassword(randomUUID()),
        });
      } catch {
        // Между проверкой почты и вставкой есть щель — её закрывает UNIQUE-индекс.
        // Объект ошибки не логируем и наружу не отдаём: в нём бывает вся строка (S9)
        return renderList(deps, request, reply, {
          kind: 'error', text: 'Клиент с такой почтой уже заведён',
        });
      }

      const link = await inviteFor(deps, userId, new Date());
      return renderList(deps, request, reply, {
        kind: 'invite', text: `Ссылка для ${email}, показывается один раз: ${link}`,
      });
    });

    admin.post('/clients/:id/invite', async (request, reply) => {
      const session = await currentSession(deps, request, new Date());
      if (session === undefined) return redirectToLogin(reply);

      const params = Params.safeParse(request.params);
      const body = CsrfOnlyForm.safeParse(request.body);
      if (!params.success || !body.success) return reply.code(400).send();
      if (!requireCsrf(deps, session.token, body.data.csrf)) {
        return reply.code(403).send();
      }

      // Владельцы сервиса через админку не управляются: перевыпустить ссылку
      // себе или другому владельцу отсюда нельзя
      const target = await findUserById(deps.db, params.data.id);
      if (target === undefined || target.role !== 'client') {
        return renderList(deps, request, reply, { kind: 'error', text: 'Клиент не найден' });
      }

      const link = await inviteFor(deps, target.id, new Date());
      return renderList(deps, request, reply, {
        kind: 'invite', text: `Новая ссылка для ${target.email}: ${link}`,
      });
    });

    admin.post('/clients/:id/toggle', async (request, reply) => {
      const session = await currentSession(deps, request, new Date());
      if (session === undefined) return redirectToLogin(reply);

      const params = Params.safeParse(request.params);
      const body = CsrfOnlyForm.safeParse(request.body);
      if (!params.success || !body.success) return reply.code(400).send();
      if (!requireCsrf(deps, session.token, body.data.csrf)) {
        return reply.code(403).send();
      }

      const target = await findUserById(deps.db, params.data.id);
      if (target === undefined || target.role !== 'client') {
        return renderList(deps, request, reply, { kind: 'error', text: 'Клиент не найден' });
      }

      const disabling = target.disabledAt === null;
      await setUserDisabled(deps.db, target.id, disabling ? new Date() : null);
      // Отключённость действует немедленно, а не с истечением сессии:
      // вебхук уже отсекает `resolveAccountOwner`, вход — общий ответ S13,
      // а живой кабинет закрывается только этим (S15)
      if (disabling) await deleteUserSessions(deps.db, target.id);

      return renderList(deps, request, reply, {
        kind: 'invite',
        text: `${target.email}: ${disabling ? 'отключён' : 'включён обратно'}`,
      });
    });

    admin.post('/clients/:id/accounts', async (request, reply) => {
      const session = await currentSession(deps, request, new Date());
      if (session === undefined) return redirectToLogin(reply);

      const params = Params.safeParse(request.params);
      if (!params.success) return reply.code(400).send();

      // CSRF проверяется до разбора остальных полей: подделанный запрос не
      // должен получать в ответ страницу с подсказкой, что именно в форме
      // не так — и вообще доходить до работы с данными клиента
      const csrf = CsrfOnlyForm.safeParse(request.body);
      if (!csrf.success) return reply.code(400).send();
      if (!requireCsrf(deps, session.token, csrf.data.csrf)) {
        return reply.code(403).send();
      }

      const body = AccountForm.safeParse(request.body);
      if (!body.success) {
        // Текст ошибки не содержит присланного значения: в этой же форме
        // рядом лежит токен, и эхо ввода — лишний путь для него в разметку (S9, S21)
        return renderList(deps, request, reply, {
          kind: 'error', text: 'Проверьте платформу, ID аккаунта и токен',
        });
      }

      const target = await findUserById(deps.db, params.data.id);
      if (target === undefined || target.role !== 'client') {
        return renderList(deps, request, reply, { kind: 'error', text: 'Клиент не найден' });
      }

      // Между проверкой занятости внешнего id и вставкой внутри
      // connectOrUpdateAccount есть щель — её закрывает UNIQUE-индекс
      // platform_accounts_external_idx. При одновременном подключении одного
      // и того же id двум клиентам второй запрос ловит здесь то же исключение,
      // что 'taken' обрабатывает штатно. Объект ошибки не логируем и не
      // отдаём наружу: в нём бывает вся строка, включая зашифрованный токен (S9)
      let outcome: ConnectOutcome;
      try {
        outcome = await connectOrUpdateAccount(deps.db, target.id, {
          platform: body.data.platform,
          externalAccountId: body.data.external_account_id,
          token: body.data.token,
        }, deps.cfg.CREDENTIALS_ENC_KEY);
      } catch {
        outcome = 'taken';
      }

      const text = outcome === 'taken'
        ? 'Этот аккаунт уже подключён другому клиенту'
        : `${target.email}: аккаунт ${outcome === 'created' ? 'подключён' : 'обновлён'}`;
      return renderList(deps, request, reply, {
        kind: outcome === 'taken' ? 'error' : 'invite', text,
      });
    });

    done();
  }, { prefix: '/admin' });
}
