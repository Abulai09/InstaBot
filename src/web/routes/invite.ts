import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { consumeInvite, peekInvite } from '../../storage/queries/invites.js';
import { createSession, deleteUserSessions } from '../../storage/queries/sessions.js';
import { setUserPassword } from '../../storage/queries/users.js';
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
  const allow = (ip: string, at: Date): boolean =>
    deps.throttle.allow(`приглашение:ip:${ip}`, at);

  app.get('/invite/:token', (request, reply) => {
    const now = new Date();
    if (!allow(request.ip, now)) return reply.code(429).send();

    const params = Params.safeParse(request.params);
    if (!params.success) return reply.code(404).send();

    // GET не гасит приглашение: мессенджеры и браузеры предзагружают ссылки,
    // и приглашение сгорало бы от превью, не дойдя до клиента. Здесь только
    // проверка, что форму есть смысл показывать
    if (!peekInvite(deps.db, params.data.token, now)) {
      return reply.code(404).header('cache-control', 'no-store')
        .type('text/html; charset=utf-8').send(inviteInvalidPage().value);
    }

    return reply.header('cache-control', 'no-store')
      .type('text/html; charset=utf-8')
      .send(invitePage(params.data.token, undefined).value);
  });

  app.post('/invite/:token', async (request, reply) => {
    const now = new Date();
    if (!allow(request.ip, now)) return reply.code(429).send();

    const params = Params.safeParse(request.params);
    if (!params.success) return reply.code(404).send();

    const form = PasswordForm.safeParse(request.body);
    if (!form.success) {
      // Приглашение ещё не гасим: клиент ошибся длиной пароля, а не ссылкой.
      // Присланное значение на страницу не возвращаем — это пароль (S9)
      return reply.code(400).header('cache-control', 'no-store')
        .type('text/html; charset=utf-8')
        .send(invitePage(params.data.token, 'Пароль не короче 12 символов').value);
    }

    // Гашение и чтение владельца — одна операция: двойной сабмит формы
    // не пройдёт дважды, гонку разруливает СУБД
    const invite = consumeInvite(deps.db, params.data.token, now);
    if (invite === undefined) {
      return reply.code(404).header('cache-control', 'no-store')
        .type('text/html; charset=utf-8').send(inviteInvalidPage().value);
    }

    setUserPassword(deps.db, invite.userId, await hashPassword(form.data.password));
    // S15: смена пароля выкидывает со всех устройств, новая сессия с нуля
    deleteUserSessions(deps.db, invite.userId);

    const token = createSession(deps.db, invite.userId, now, ttlMs(deps.cfg));
    return reply
      .header('set-cookie', sessionCookie(token, ttlMs(deps.cfg), deps.cfg.NODE_ENV === 'production'))
      .code(303).header('location', '/').send();
  });
}
