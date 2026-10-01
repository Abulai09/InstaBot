import { createHash, randomUUID } from 'node:crypto';
import { and, count, eq, gt, lte, sql } from 'drizzle-orm';
import type { AppDb } from '../db.js';
import { authAttempts } from '../schema.js';

function keyHash(key: string): string {
  return createHash('sha256').update(key, 'utf8').digest('hex');
}

/**
 * Засчитывает попытку, если в окне их меньше `max`. Отказ строку не пишет:
 * иначе атакующий, давно упёршийся в лимит, продолжал бы раздувать таблицу.
 *
 * Проверка и запись — одна транзакция под advisory-блокировкой по ключу.
 * Без неё параллельные запросы одновременно увидели бы «пока четыре»
 * и прошли бы все: лимит, обходимый пачкой запросов, лимитом не является.
 * Блокировка транзакционная и снимается коммитом, чужие ключи она не держит.
 *
 * Уборка истёкших строк здесь же: вход редок, а индекс по времени делает её
 * дешёвой. Отдельного таймера ради неё заводить незачем.
 *
 * Функция без `userId`: гость ещё не аутентифицирован, а клиентских данных
 * в таблице нет — правило «владелец первым аргументом» её не касается.
 */
export async function allowAttempt(
  db: AppDb, key: string, now: Date, max: number, windowMs: number,
): Promise<boolean> {
  const hash = keyHash(key);
  const cutoff = new Date(now.getTime() - windowMs);

  return db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${hash}))`);
    await tx.delete(authAttempts).where(lte(authAttempts.at, cutoff));

    const [row] = await tx.select({ n: count() }).from(authAttempts)
      .where(and(eq(authAttempts.keyHash, hash), gt(authAttempts.at, cutoff)));
    if ((row?.n ?? 0) >= max) return false;

    await tx.insert(authAttempts).values({ id: randomUUID(), keyHash: hash, at: now });
    return true;
  });
}
