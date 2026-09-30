import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { createSession, deleteSession } from '../../storage/queries/sessions.js';
import { findUserByEmail } from '../../storage/queries/users.js';
import { clearedCookie, readCookie, sessionCookie, SESSION_COOKIE } from '../http.js';
import { csrfField, guestCsrfValid, issueGuestCsrf } from '../guestCsrf.js';
import { verifyPassword } from '../password.js';
import { ttlMs, type WebDeps } from '../session.js';
import { loginPage } from '../views/login.js';

/**
 * S14: схема описывает ровно два разрешённых поля. Всё остальное, что пришло
 * в форме — роль, user_id, что угодно — не попадает в код вообще.
 */
const LoginForm = z.object({
  // Почта хранится в нижнем регистре (её так кладёт админка), и сравнение
  // должно быть таким же — иначе клиент, заведённый как `Klient@K.K`,
  // не войдёт, введя почту так, как видит её в переписке
  email: z.string().min(1).max(320).trim().toLowerCase(),
  password: z.string().min(1).max(1024),
});

/** Один текст на любую неудачу входа (S13). */
const FAILED = 'Неверная почта или пароль';

export function registerAuthRoutes(app: FastifyInstance, deps: WebDeps): void {
  /** Страница входа с ошибкой: токен формы выдаётся заново на каждом показе. */
  const page = (
    request: FastifyRequest, reply: FastifyReply, code: number, error: string | undefined,
  ): FastifyReply => reply.code(code).type('text/html; charset=utf-8')
    .send(loginPage(error, issueGuestCsrf(request, reply, deps.cfg)).value);

  app.get('/login', (request, reply) => page(request, reply, 200, undefined));

  app.post('/login', async (request, reply) => {
    const now = new Date();
    // S15: до лимита попыток, а не после. Подделанная чужим сайтом форма
    // иначе расходовала бы попытки настоящего клиента. Истёкшая cookie
    // у честной вкладки даёт ту же страницу со свежим токеном — хватит
    // отправить форму ещё раз
    if (!guestCsrfValid(request, csrfField(request.body), deps.cfg)) {
      return page(request, reply, 403, 'Форма устарела. Отправьте её ещё раз');
    }

    const parsed = LoginForm.safeParse(request.body);
    const email = parsed.success ? parsed.data.email : '';

    // S19: счётчик и по email, и по адресу — иначе перебор одного аккаунта
    // с разных адресов или разных аккаунтов с одного проходит мимо лимита.
    //
    // Адрес проверяется первым, и это не вкус: ключ по почте берётся из тела
    // запроса, то есть придумывается атакующим. Стой он первым, исчерпавший
    // лимит адрес продолжал бы заводить новый ключ на каждую выдуманную почту —
    // отказ отдавался бы уже после того, как запись легла в память.
    // При таком порядке `&&` обрывает вычисление, и отвергнутый адрес
    // памяти не занимает
    const allowed = await deps.throttle.allow(`вход:ip:${request.ip}`, now)
      && await deps.throttle.allow(`вход:email:${email}`, now);
    if (!allowed) {
      return page(request, reply, 429, 'Слишком много попыток. Попробуйте позже');
    }

    if (!parsed.success) {
      return page(request, reply, 401, FAILED);
    }

    const user = await findUserByEmail(deps.db, parsed.data.email);
    // Пароль проверяется даже когда пользователя нет: verifyPassword считает
    // хэш от заглушки, и время ответа не выдаёт существование аккаунта (S13)
    const ok = await verifyPassword(user?.passwordHash, parsed.data.password);
    if (!ok || user === undefined) {
      return page(request, reply, 401, FAILED);
    }
    // S12: отключённый клиент не входит заново. Отказ идёт тем же ответом, что
    // и неверный пароль, и после проверки пароля, а не до неё: отдельный текст
    // или мгновенный отказ выдали бы перебором, какие аккаунты сервис отключил
    if (user.disabledAt !== null) {
      return page(request, reply, 401, FAILED);
    }

    // S15: старая сессия уничтожается, новая выдаётся с нуля — иначе
    // подсунутый заранее идентификатор сессии переживёт вход
    const cookieHeader = request.headers.cookie;
    const old = readCookie(typeof cookieHeader === 'string' ? cookieHeader : undefined, SESSION_COOKIE);
    if (old !== undefined) await deleteSession(deps.db, old);

    const token = await createSession(deps.db, user.id, now, ttlMs(deps.cfg));
    return reply
      .header('set-cookie', sessionCookie(token, ttlMs(deps.cfg), deps.cfg.NODE_ENV === 'production'))
      .code(303).header('location', '/').send();
  });

  app.post('/logout', async (request, reply) => {
    const cookieHeader = request.headers.cookie;
    const token = readCookie(typeof cookieHeader === 'string' ? cookieHeader : undefined, SESSION_COOKIE);
    if (token !== undefined) await deleteSession(deps.db, token);

    return reply.header('set-cookie', clearedCookie())
      .code(303).header('location', '/login').send();
  });
}
