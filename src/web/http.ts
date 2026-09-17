import type { FastifyError, FastifyInstance } from 'fastify';

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

/**
 * Код ошибки драйвера: у `pg` это `28P01` или `42P01`, у сетевого сбоя —
 * `ENETUNREACH` или `ETIMEDOUT`. drizzle заворачивает исходную ошибку в свою,
 * поэтому причину ищем и в `cause`, но не глубже трёх уровней — дальше
 * начинается чужой стек, а не наша диагностика.
 */
function driverCode(error: unknown): string {
  let current: unknown = error;
  for (let depth = 0; depth < 3; depth += 1) {
    if (typeof current !== 'object' || current === null) return 'нет кода';
    if ('code' in current && typeof current.code === 'string') return current.code;
    if (!('cause' in current)) return 'нет кода';
    current = current.cause;
  }
  return 'нет кода';
}

/**
 * S9. Наружу уходит только код ответа. Сообщение драйвера содержит текст
 * запроса и значения параметров: на входе это почта, на вставке в `leads` —
 * текст сообщения человека, на `platform_accounts` — зашифрованный токен.
 * Стандартный обработчик Fastify кладёт это сообщение в тело ответа, то есть
 * отдаёт браузеру; свой обработчик обязателен, а не желателен.
 *
 * В лог идёт код драйвера и маршрут — этого хватает, чтобы понять причину
 * (`ENETUNREACH` — сеть до базы, `42P01` — не накатаны миграции, `28P01` —
 * неверный пароль базы), и данных в нём нет.
 *
 * Ошибки с кодом 4xx остаются собой: их ставит наш же код, они не содержат
 * ничего лишнего и несут смысл для клиента.
 */
export function registerErrorHandler(app: FastifyInstance): void {
  app.setErrorHandler((error: FastifyError, request, reply) => {
    const status = error.statusCode ?? 500;
    if (status < 500) {
      return reply.code(status).send();
    }

    request.log.error({ driver: driverCode(error), method: request.method }, 'запрос упал');
    return reply
      .code(500)
      .type('text/plain; charset=utf-8')
      .send('Внутренняя ошибка. Попробуйте ещё раз.');
  });
}
