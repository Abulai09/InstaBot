import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { consumeInvite, peekInvite } from '../../storage/queries/invites.js';
import { createSession, deleteUserSessions } from '../../storage/queries/sessions.js';
import { setUserPassword } from '../../storage/queries/users.js';
import { csrfField, guestCsrfValid, issueGuestCsrf } from '../guestCsrf.js';
import { sessionCookie } from '../http.js';
import { hashPassword } from '../password.js';
import { ttlMs, type WebDeps } from '../session.js';
import { inviteInvalidPage, invitePage } from '../views/invite.js';

const Params = z.object({ token: z.string().min(1).max(128) });

/**
 * S13: нижняя граница пароля, верхняя — чтобы argon2 не считал мегабайт.
 * Те же значения, что в спеке: 12–1024.
 */
const PasswordForm = z.object({
  password: z.string().min(12).max(1024),
});

/**
 * Маршруты вне плагина админки: у гостя ещё нет сессии, и хук роли
 * не пропустил бы его.
 */
export function registerInviteRoutes(app: FastifyInstance, deps: WebDeps): void {
  // S19: токен в ссылке — секрет, и без лимита он перебирается запросами.
  // Счётчик общий с формой входа, ключ свой: лимиты одинаковые, счёт раздельный
  const allow = async (ip: string, at: Date): Promise<boolean> =>
    deps.throttle.allow(`приглашение:ip:${ip}`, at);

  /** Форма пароля: токен формы выдаётся на каждом показе, страница не кэшируется. */
  const page = (
    request: FastifyRequest, reply: FastifyReply,
    code: number, token: string, error: string | undefined,
  ): FastifyReply => reply.code(code).header('cache-control', 'no-store')
    .type('text/html; charset=utf-8')
    .send(invitePage(token, error, issueGuestCsrf(request, reply, deps.cfg)).value);

  app.get('/invite/:token', async (request, reply) => {
    const now = new Date();
    if (!await allow(request.ip, now)) return reply.code(429).send();

    const params = Params.safeParse(request.params);
    if (!params.success) return reply.code(404).send();

    // GET не гасит приглашение: мессенджеры и браузеры предзагружают ссылки,
    // и приглашение сгорало бы от превью, не дойдя до клиента. Здесь только
    // проверка, что форму есть смысл показывать
    if (!await peekInvite(deps.db, params.data.token, now)) {
      return reply.code(404).header('cache-control', 'no-store')
        .type('text/html; charset=utf-8').send(inviteInvalidPage().value);
    }

    return page(request, reply, 200, params.data.token, undefined);
  });

  app.post('/invite/:token', async (request, reply) => {
    const now = new Date();
    const params = Params.safeParse(request.params);
    if (!params.success) return reply.code(404).send();

    // S15: до лимита и до базы. Приглашение не гасится: подделанная чужим
    // сайтом форма не должна сжигать ссылку настоящего клиента
    if (!guestCsrfValid(request, csrfField(request.body), deps.cfg)) {
      return page(request, reply, 403, params.data.token, 'Форма устарела. Отправьте её ещё раз');
    }
    if (!await allow(request.ip, now)) return reply.code(429).send();

    const form = PasswordForm.safeParse(request.body);
    if (!form.success) {
      // Приглашение ещё не гасим: клиент ошибся длиной пароля, а не ссылкой.
      // Присланное значение на страницу не возвращаем — это пароль (S9)
      return page(request, reply, 400, params.data.token, 'Пароль не короче 12 символов');
    }

    // Гашение и чтение владельца — одна операция: двойной сабмит формы
    // не пройдёт дважды, гонку разруливает СУБД
    const invite = await consumeInvite(deps.db, params.data.token, now);
    if (invite === undefined) {
      return reply.code(404).header('cache-control', 'no-store')
        .type('text/html; charset=utf-8').send(inviteInvalidPage().value);
    }

    await setUserPassword(deps.db, invite.userId, await hashPassword(form.data.password));
    // S15: смена пароля выкидывает со всех устройств, новая сессия с нуля
    await deleteUserSessions(deps.db, invite.userId);

    const token = await createSession(deps.db, invite.userId, now, ttlMs(deps.cfg));
    return reply
      .header('set-cookie', sessionCookie(token, ttlMs(deps.cfg), deps.cfg.NODE_ENV === 'production'))
      .code(303).header('location', '/').send();
  });
}
