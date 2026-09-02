import type { FastifyInstance } from 'fastify';

const SESSION_COOKIE = 'sid';

/**
 * Разбор вручную, без зависимости: нужна ровно одна cookie с шестнадцатеричным
 * значением. Имя сравнивается целиком, иначе `notsid` совпал бы с `sid`.
 */
export function readCookie(header: string | undefined, name: string): string | undefined {
  if (header === undefined) return undefined;

  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq === -1) continue;
    if (part.slice(0, eq).trim() !== name) continue;
    return part.slice(eq + 1).trim();
  }
  return undefined;
}

/**
 * S15: HttpOnly закрывает cookie от JavaScript, SameSite=Lax отсекает
 * межсайтовые POST-запросы, Secure требует HTTPS. Secure только в проде —
 * иначе браузер не примет cookie с localhost по http.
 */
export function sessionCookie(token: string, ttlMs: number, secure: boolean): string {
  const parts = [
    `${SESSION_COOKIE}=${token}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    `Max-Age=${Math.floor(ttlMs / 1000)}`,
  ];
  if (secure) parts.push('Secure');
  return parts.join('; ');
}

export function clearedCookie(): string {
  return `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`;
}

export { SESSION_COOKIE };

/**
 * Формы приходят как application/x-www-form-urlencoded, а Fastify по умолчанию
 * разбирает только JSON. URLSearchParams вместо ручного разбора: он же обрабатывает
 * проценты и плюсы.
 *
 * Object.fromEntries на URLSearchParams не создаёт `__proto__` как свойство
 * прототипа — ключ ложится обычным собственным свойством (S6).
 */
export function registerFormParser(app: FastifyInstance): void {
  app.addContentTypeParser(
    'application/x-www-form-urlencoded',
    { parseAs: 'string', bodyLimit: 65_536 },
    (_request, body, done) => {
      try {
        done(null, Object.fromEntries(new URLSearchParams(String(body))));
      } catch {
        done(null, {});
      }
    },
  );
}

/**
 * S22. CSP без `unsafe-inline` — второй рубеж после экранирования: даже если
 * разметка утечёт, инлайновый скрипт не выполнится. Поэтому стили и скрипты
 * страниц кабинета не могут быть инлайновыми.
 */
export function registerSecurityHeaders(app: FastifyInstance, isProduction: boolean): void {
  app.addHook('onSend', (_request, reply, payload, done) => {
    reply.header('x-frame-options', 'DENY');
    reply.header('x-content-type-options', 'nosniff');
    reply.header('referrer-policy', 'same-origin');
    reply.header(
      'content-security-policy',
      "default-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
    );
    if (isProduction) {
      reply.header('strict-transport-security', 'max-age=31536000; includeSubDomains');
    }
    done(null, payload);
  });
}
