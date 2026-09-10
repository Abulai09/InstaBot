import { describe, expect, it } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { migrate } from 'drizzle-orm/pglite/migrator';
import type { AppDb } from '../../src/storage/db.js';
import { createTestDb, pendingOutbox } from './helpers.js';
import { createUser } from '../../src/storage/queries/users.js';
import {
  enqueueOutbox, takeDueOutbox, takePendingEvents,
} from '../../src/storage/queries/runtime.js';

const NOW = new Date('2026-09-10T12:00:00Z');
const LEASE_MS = 60_000;

/**
 * База с логгером: он видит SQL ровно в том виде, в каком тот ушёл в Postgres.
 * Проверять формулировку запроса приходится потому, что поведение `SKIP LOCKED`
 * в PGlite не воспроизводится — у него одно соединение, и две транзакции
 * выполняются по очереди, а не одновременно (см. комментарий ниже).
 */
async function dbWithLog(): Promise<{ db: AppDb; sql: string[] }> {
  const sql: string[] = [];
  const db = drizzle(new PGlite(), { logger: { logQuery: (query) => { sql.push(query); } } });
  await migrate(db, { migrationsFolder: './drizzle' });
  return { db, sql };
}

describe('захват строк очередей несколькими копиями процесса', () => {
  it('takePendingEvents забирает события с FOR UPDATE SKIP LOCKED', async () => {
    const { db, sql } = await dbWithLog();

    await takePendingEvents(db, 20);

    const select = sql.find((q) => q.includes('from "event_queue"'));
    expect(select?.toLowerCase()).toContain('for update skip locked');
  });

  it('takeDueOutbox забирает исходящие с FOR UPDATE SKIP LOCKED', async () => {
    const { db, sql } = await dbWithLog();

    await takeDueOutbox(db, NOW, LEASE_MS);

    const select = sql.find((q) => q.includes('from "outbox"'));
    expect(select?.toLowerCase()).toContain('for update skip locked');
  });

  /**
   * Главное свойство лизинга: забранная строка исчезает из выдачи до конца срока,
   * то есть вторая копия процесса её не увидит и не отправит сообщение повторно.
   * Это проверяется поведением, а не текстом запроса.
   */
  it('забранная строка не возвращается второму вызову, пока не истёк лизинг', async () => {
    const db = await createTestDb();
    const userId = await createUser(db, { email: 'lease@x.c', passwordHash: 'h' });
    await enqueueOutbox(
      db, userId, 'instagram',
      { type: 'send_text', text: 'привет' },
      { threadId: 't1', userId: 'u-ext' },
      NOW,
    );

    expect(await takeDueOutbox(db, NOW, LEASE_MS)).toHaveLength(1);
    // Второй воркер в тот же момент времени не видит ничего
    expect(await takeDueOutbox(db, NOW, LEASE_MS)).toHaveLength(0);

    // Лизинг истёк, отправка так и не подтвердилась — строка снова в работе
    const afterLease = new Date(NOW.getTime() + LEASE_MS + 1000);
    expect(await takeDueOutbox(db, afterLease, LEASE_MS)).toHaveLength(1);
  });

  it('захват не трогает счётчик попыток: это не неудача, а взятие в работу', async () => {
    const db = await createTestDb();
    const userId = await createUser(db, { email: 'lease2@x.c', passwordHash: 'h' });
    await enqueueOutbox(
      db, userId, 'instagram',
      { type: 'send_text', text: 'привет' },
      { threadId: 't1', userId: 'u-ext' },
      NOW,
    );

    const taken = await takeDueOutbox(db, NOW, LEASE_MS);
    expect(taken[0]?.attempts).toBe(0);

    const later = new Date(NOW.getTime() + LEASE_MS + 1000);
    expect((await pendingOutbox(db, later))[0]?.attempts).toBe(0);
  });
});
