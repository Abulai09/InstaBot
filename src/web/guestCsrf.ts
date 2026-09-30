import { randomBytes } from 'node:crypto';
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { Config } from '../config.js';
import { csrfToken, csrfValid } from './csrf.js';
import { readCookie } from './http.js';

/**
 * CSRF для форм гостя — входа и приглашения (S15). Токен кабинета выводится
 * из сессии, а у гостя её ещё нет, и без защиты чужой сайт отправляет форму
 * входа с логином атакующего: жертва работает в чужом кабинете, и всё, что
 * она туда загрузит, видит атакующий.
 *
 * Вместо сессии — случайное значение в cookie, форма несёт его HMAC
 * (`csrfToken`, тот же ключ). Cookie с `SameSite=Lax` браузер к межсайтовому
 * POST не прикладывает, а без неё токен сверять не с чем — запрос отвергается.
 * Прочитать cookie или страницу с токеном чужой сайт не может.
 */
const GUEST_COOKIE = 'gcsrf';
const GUEST_VALUE = /^[0-9a-f]{64}$/;
const DAY_SECONDS = 86_400;

function guestValue(request: FastifyRequest): string | undefined {
  const header = request.headers.cookie;
  const value = readCookie(typeof header === 'string' ? header : undefined, GUEST_COOKIE);
  return value !== undefined && GUEST_VALUE.test(value) ? value : undefined;
}

/**
 * Токен для формы. Уже выданная cookie переиспользуется: две открытые вкладки
 * входа не должны ломать друг другу форму. Новая выдаётся, только если её нет.
 */
export function issueGuestCsrf(request: FastifyRequest, reply: FastifyReply, cfg: Config): string {
  let value = guestValue(request);
  if (value === undefined) {
    value = randomBytes(32).toString('hex');
    const parts = [
      `${GUEST_COOKIE}=${value}`, 'Path=/', 'HttpOnly', 'SameSite=Lax', `Max-Age=${DAY_SECONDS}`,
    ];
    if (cfg.NODE_ENV === 'production') parts.push('Secure');
    reply.header('set-cookie', parts.join('; '));
  }
  return csrfToken(value, cfg.SESSION_SECRET);
}

export function guestCsrfValid(request: FastifyRequest, provided: unknown, cfg: Config): boolean {
  const value = guestValue(request);
  if (value === undefined || typeof provided !== 'string') return false;
  return csrfValid(value, provided, cfg.SESSION_SECRET);
}

/** Поле `csrf` из тела формы: разбор тела здесь не повторяется в каждом маршруте. */
export function csrfField(body: unknown): unknown {
  return typeof body === 'object' && body !== null && 'csrf' in body ? body.csrf : undefined;
}
