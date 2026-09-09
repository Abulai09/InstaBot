import { randomUUID } from 'node:crypto';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { Config } from '../../config.js';
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
function renderList(
  deps: WebDeps, request: FastifyRequest, reply: FastifyReply, notice: Notice | undefined,
): FastifyReply {
  const session = currentSession(deps, request, new Date());
  if (session === undefined) return redirectToLogin(reply);

  return reply
    .header('cache-control', 'no-store')
    .type('text/html; charset=utf-8')
    .send(adminPage(
      listClients(deps.db),
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

const Params = z.object({ id: z.string().min(1) });

function inviteFor(deps: WebDeps, userId: string, now: Date): string {
  // Перевыпуск гасит прежние: иначе после «ссылка утекла, выпустите новую»
  // старая продолжала бы работать до конца своего срока
  revokeUserInvites(deps.db, userId, now);
  const token = createInvite(deps.db, userId, now, deps.cfg.INVITE_TTL_HOURS * 3_600_000);
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
    admin.addHook('onRequest', (request, reply, next) => {
      const session = currentSession(deps, request, new Date());
      if (session === undefined) {
        void redirectToLogin(reply);
        return;
      }
      if (session.role !== 'owner') {
        // 403, а не 404: скрывать существование админки бессмысленно,
        // а разные коды помогают владельцу понять, что он зашёл не тем входом
        void reply.code(403).send();
        return;
      }
      next();
    });

    // Обработчики зовут currentSession повторно: им нужен `token` для CSRF.
    // Это один индексированный SELECT — дешевле, чем протаскивать сессию
    // через декоратор запроса и подпирать его расширением типов Fastify
    admin.get('/', (request, reply) => renderList(deps, request, reply, undefined));

    admin.post('/clients', async (request, reply) => {
      const session = currentSession(deps, request, new Date());
      if (session === undefined) return redirectToLogin(reply);

      const parsed = NewClientForm.safeParse(request.body);
      if (!parsed.success) {
        return renderList(deps, request, reply, { kind: 'error', text: 'Некорректная почта' });
      }
      if (!csrfValid(session.token, parsed.data.csrf, deps.cfg.SESSION_SECRET)) {
        return reply.code(403).send();
      }

      const email = parsed.data.email.trim().toLowerCase();
      if (findUserByEmail(deps.db, email) !== undefined) {
        return renderList(deps, request, reply, {
          kind: 'error', text: 'Клиент с такой почтой уже заведён',
        });
      }

      // Пароля у клиента ещё нет, а колонка notNull. Хэш от случайного UUID
      // не совпадёт ни с одним вводом, и путь установки пароля остаётся один —
      // через приглашение (S13)
      let userId: string;
      try {
        userId = createUser(deps.db, {
          email, passwordHash: await hashPassword(randomUUID()),
        });
      } catch {
        // Между проверкой почты и вставкой есть щель — её закрывает UNIQUE-индекс.
        // Объект ошибки не логируем и наружу не отдаём: в нём бывает вся строка (S9)
        return renderList(deps, request, reply, {
          kind: 'error', text: 'Клиент с такой почтой уже заведён',
        });
      }

      const link = inviteFor(deps, userId, new Date());
      return renderList(deps, request, reply, {
        kind: 'invite', text: `Ссылка для ${email}, показывается один раз: ${link}`,
      });
    });

    admin.post('/clients/:id/invite', (request, reply) => {
      const session = currentSession(deps, request, new Date());
      if (session === undefined) return redirectToLogin(reply);

      const params = Params.safeParse(request.params);
      const body = CsrfOnlyForm.safeParse(request.body);
      if (!params.success || !body.success) return reply.code(400).send();
      if (!csrfValid(session.token, body.data.csrf, deps.cfg.SESSION_SECRET)) {
        return reply.code(403).send();
      }

      // Владельцы сервиса через админку не управляются: перевыпустить ссылку
      // себе или другому владельцу отсюда нельзя
      const target = findUserById(deps.db, params.data.id);
      if (target === undefined || target.role !== 'client') {
        return renderList(deps, request, reply, { kind: 'error', text: 'Клиент не найден' });
      }

      const link = inviteFor(deps, target.id, new Date());
      return renderList(deps, request, reply, {
        kind: 'invite', text: `Новая ссылка для ${target.email}: ${link}`,
      });
    });

    admin.post('/clients/:id/toggle', (request, reply) => {
      const session = currentSession(deps, request, new Date());
      if (session === undefined) return redirectToLogin(reply);

      const params = Params.safeParse(request.params);
      const body = CsrfOnlyForm.safeParse(request.body);
      if (!params.success || !body.success) return reply.code(400).send();
      if (!csrfValid(session.token, body.data.csrf, deps.cfg.SESSION_SECRET)) {
        return reply.code(403).send();
      }

      const target = findUserById(deps.db, params.data.id);
      if (target === undefined || target.role !== 'client') {
        return renderList(deps, request, reply, { kind: 'error', text: 'Клиент не найден' });
      }

      const disabling = target.disabledAt === null;
      setUserDisabled(deps.db, target.id, disabling ? new Date() : null);
      // Отключённость действует немедленно, а не с истечением сессии:
      // вебхук уже отсекает `resolveAccountOwner`, вход — общий ответ S13,
      // а живой кабинет закрывается только этим (S15)
      if (disabling) deleteUserSessions(deps.db, target.id);

      return renderList(deps, request, reply, {
        kind: 'invite',
        text: `${target.email}: ${disabling ? 'отключён' : 'включён обратно'}`,
      });
    });

    done();
  }, { prefix: '/admin' });
}
