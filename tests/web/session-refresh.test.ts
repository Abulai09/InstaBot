import type { FastifyRequest } from 'fastify';
import { describe, expect, it } from 'vitest';
import { createTestDb } from '../storage/helpers.js';
import { loadConfig } from '../../src/config.js';
import { ReplyThrottle } from '../../src/core/throttle.js';
import type { AppDb } from '../../src/storage/db.js';
import { createUser } from '../../src/storage/queries/users.js';
import { createSession, deleteSession, loadSession } from '../../src/storage/queries/sessions.js';
import { currentSession, ttlMs } from '../../src/web/session.js';

const HOUR = 3_600_000;
const DAY = 86_400_000;

const cfg = loadConfig({
  DATABASE_URL: 'postgresql://u:p@localhost:5432/test',
  META_APP_SECRET: 's', META_VERIFY_TOKEN: 'v',
  CREDENTIALS_ENC_KEY: 'a'.repeat(64), SESSION_SECRET: 'a'.repeat(32),
  PUBLIC_BASE_URL: 'https://bot.example.com',
} as unknown as NodeJS.ProcessEnv);

function deps(db: AppDb) {
  return { db, cfg, throttle: new ReplyThrottle(100, 60_000) };
}

/** `currentSession` читает из запроса только заголовок cookie. */
function withCookie(token: string): FastifyRequest {
  return { headers: { cookie: `sid=${token}` } } as unknown as FastifyRequest;
}

async function expiresAt(db: AppDb, token: string, now: Date): Promise<Date | undefined> {
  return (await loadSession(db, token, now))?.expiresAt;
}

describe('продление сессии', () => {
  /**
   * Продление — это запись в базу, и до этой правки она случалась на каждый
   * запрос. На облачной базе за океаном это лишний round-trip на каждую
   * страницу, причём самого дорогого вида — UPDATE.
   */
  it('не пишет в базу, пока с прошлого продления прошло мало времени', async () => {
    const db = await createTestDb();
    const userId = await createUser(db, { email: 'a@a.a', passwordHash: 'x' });
    const start = new Date('2026-09-10T10:00:00Z');
    const token = await createSession(db, userId, start, ttlMs(cfg));

    const before = await expiresAt(db, token, start);
    const soon = new Date(start.getTime() + 5 * 60_000);
    await currentSession(deps(db), withCookie(token), soon);

    expect((await expiresAt(db, token, soon))?.getTime()).toBe(before?.getTime());
  });

  it('продлевает, когда с прошлого продления прошёл час', async () => {
    const db = await createTestDb();
    const userId = await createUser(db, { email: 'a@a.a', passwordHash: 'x' });
    const start = new Date('2026-09-10T10:00:00Z');
    const token = await createSession(db, userId, start, ttlMs(cfg));

    const before = await expiresAt(db, token, start);
    const later = new Date(start.getTime() + HOUR + 60_000);
    await currentSession(deps(db), withCookie(token), later);
    const after = await expiresAt(db, token, later);

    expect(after?.getTime()).toBeGreaterThan(before?.getTime() ?? 0);
    expect(after?.getTime()).toBe(later.getTime() + ttlMs(cfg));
  });

  /**
   * Главное свойство скользящей сессии обязано сохраниться: человек, который
   * заходит регулярно, не должен внезапно оказаться на странице входа.
   */
  it('сессия живёт дольше срока, если в кабинет заходят каждый день', async () => {
    const db = await createTestDb();
    const userId = await createUser(db, { email: 'a@a.a', passwordHash: 'x' });
    let moment = new Date('2026-09-10T10:00:00Z');
    const token = await createSession(db, userId, moment, ttlMs(cfg));

    for (let day = 1; day <= 12; day += 1) {
      moment = new Date(moment.getTime() + DAY);
      expect(await currentSession(deps(db), withCookie(token), moment), `день ${day}`).toBeDefined();
    }
  });

  it('сессия всё так же умирает, если не заходить дольше срока', async () => {
    const db = await createTestDb();
    const userId = await createUser(db, { email: 'a@a.a', passwordHash: 'x' });
    const start = new Date('2026-09-10T10:00:00Z');
    const token = await createSession(db, userId, start, ttlMs(cfg));

    const late = new Date(start.getTime() + 8 * DAY);

    expect(await currentSession(deps(db), withCookie(token), late)).toBeUndefined();
  });
});

describe('повторная проверка сессии в одном запросе', () => {
  /**
   * Админка проверяет сессию дважды: хук роли на входе в плагин (S12) и сам
   * обработчик, которому нужен токен для CSRF. Это были два SELECT'а, то есть
   * два round-trip'а к облачной базе на одну страницу.
   */
  it('второй вызов с тем же запросом не ходит в базу', async () => {
    const db = await createTestDb();
    const userId = await createUser(db, { email: 'a@a.a', passwordHash: 'x' });
    const now = new Date('2026-09-10T10:00:00Z');
    const token = await createSession(db, userId, now, ttlMs(cfg));
    const request = withCookie(token);

    expect((await currentSession(deps(db), request, now))?.userId).toBe(userId);

    // Строки в базе больше нет: если второй вызов сходит за ней, он вернёт
    // undefined. Значит, ответ ниже доказывает, что похода не было
    await deleteSession(db, token);

    expect((await currentSession(deps(db), request, now))?.userId).toBe(userId);
  });

  /**
   * Граница памяти — запрос, а не сессия. Иначе выход, отключение клиента
   * и разжалование роли начали бы действовать с задержкой (S12, S15).
   */
  it('в следующем запросе сессия проверяется заново', async () => {
    const db = await createTestDb();
    const userId = await createUser(db, { email: 'a@a.a', passwordHash: 'x' });
    const now = new Date('2026-09-10T10:00:00Z');
    const token = await createSession(db, userId, now, ttlMs(cfg));

    expect(await currentSession(deps(db), withCookie(token), now)).toBeDefined();
    await deleteSession(db, token);

    expect(await currentSession(deps(db), withCookie(token), now)).toBeUndefined();
  });
});
