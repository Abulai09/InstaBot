import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { createSession, deleteSession } from '../../storage/queries/sessions.js';
import { findUserByEmail } from '../../storage/queries/users.js';
import { clearedCookie, readCookie, sessionCookie, SESSION_COOKIE } from '../http.js';
import { verifyPassword } from '../password.js';
import { ttlMs, type WebDeps } from '../session.js';
import { loginPage } from '../views/login.js';

/**
 * S14: схема описывает ровно два разрешённых поля. Всё остальное, что пришло
 * в форме — роль, user_id, что угодно — не попадает в код вообще.
 */
const LoginForm = z.object({
  email: z.string().min(1).max(320),
  password: z.string().min(1).max(1024),
});

/** Один текст на любую неудачу входа (S13). */
const FAILED = 'Неверная почта или пароль';

export function registerAuthRoutes(app: FastifyInstance, deps: WebDeps): void {
  app.get('/login', (_request, reply) =>
    reply.type('text/html; charset=utf-8').send(loginPage(undefined).value));

  app.post('/login', async (request, reply) => {
    const now = new Date();
    const parsed = LoginForm.safeParse(request.body);
    const email = parsed.success ? parsed.data.email : '';

    // S19: счётчик и по email, и по адресу — иначе перебор одного аккаунта
    // с разных адресов или разных аккаунтов с одного проходит мимо лимита
    const allowed = deps.throttle.allow(`вход:email:${email}`, now)
      && deps.throttle.allow(`вход:ip:${request.ip}`, now);
    if (!allowed) {
      return reply.code(429).type('text/html; charset=utf-8')
        .send(loginPage('Слишком много попыток. Попробуйте позже').value);
    }

    if (!parsed.success) {
      return reply.code(401).type('text/html; charset=utf-8').send(loginPage(FAILED).value);
    }

    const user = findUserByEmail(deps.db, parsed.data.email);
    // Пароль проверяется даже когда пользователя нет: verifyPassword считает
    // хэш от заглушки, и время ответа не выдаёт существование аккаунта (S13)
    const ok = await verifyPassword(user?.passwordHash, parsed.data.password);
    if (!ok || user === undefined) {
      return reply.code(401).type('text/html; charset=utf-8').send(loginPage(FAILED).value);
    }

    // S15: старая сессия уничтожается, новая выдаётся с нуля — иначе
    // подсунутый заранее идентификатор сессии переживёт вход
    const cookieHeader = request.headers.cookie;
    const old = readCookie(typeof cookieHeader === 'string' ? cookieHeader : undefined, SESSION_COOKIE);
    if (old !== undefined) deleteSession(deps.db, old);

    const token = createSession(deps.db, user.id, now, ttlMs(deps.cfg));
    return reply
      .header('set-cookie', sessionCookie(token, ttlMs(deps.cfg), deps.cfg.NODE_ENV === 'production'))
      .code(303).header('location', '/').send();
  });

  app.post('/logout', (request, reply) => {
    const cookieHeader = request.headers.cookie;
    const token = readCookie(typeof cookieHeader === 'string' ? cookieHeader : undefined, SESSION_COOKIE);
    if (token !== undefined) deleteSession(deps.db, token);

    return reply.header('set-cookie', clearedCookie())
      .code(303).header('location', '/login').send();
  });
}
