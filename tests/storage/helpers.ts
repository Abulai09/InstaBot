import { PGlite } from '@electric-sql/pglite';
import { and, asc, isNull, lte } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/pglite';
import { migrate } from 'drizzle-orm/pglite/migrator';
import type { AppDb } from '../../src/storage/db.js';
import { outbox } from '../../src/storage/schema.js';
import type { OutboxRow } from '../../src/storage/queries/runtime.js';

/**
 * Настоящий Postgres, собранный в WASM и запущенный внутри процесса теста:
 * тот же диалект и те же миграции, что в проде, без сети и без секретов.
 *
 * Одна база на файл тестов, а не на тест: старт PGlite стоит около секунды,
 * а `TRUNCATE` — миллисекунды. Vitest даёт каждому файлу свой модульный
 * реестр, поэтому переменная ниже у каждого файла своя, и тесты соседних
 * файлов друг друга не видят. Обязательное правило «два клиента в одной базе»
 * от этого не страдает: внутри теста база всё так же пустая.
 */
let shared: { client: PGlite; db: AppDb } | undefined;

/** Пустая база со свежей схемой. */
export async function createTestDb(): Promise<AppDb> {
  if (shared === undefined) {
    const client = new PGlite();
    const db = drizzle(client);
    await migrate(db, { migrationsFolder: './drizzle' });
    shared = { client, db };
    return db;
  }

  // `users` каскадом уносит всё остальное, но перечисляем таблицы явно:
  // новая таблица без ссылки на клиента иначе молча копила бы строки
  // между тестами, и падение всплыло бы в чужом тесте
  await shared.client.exec(`
    TRUNCATE TABLE
      users, platform_accounts, automations, automation_steps, files,
      leads, conversations, event_queue, processed_events, outbox,
      sessions, invites
    RESTART IDENTITY CASCADE;
  `);
  return shared.db;
}

/**
 * Взгляд в outbox без захвата. `takeDueOutbox` в проде не смотрит, а забирает:
 * он двигает `nextAttemptAt` на срок лизинга, и тест, подглядевший им перед
 * `runDelivery`, сам же прятал бы от воркера строки, которые собирался проверить.
 */
export async function pendingOutbox(db: AppDb, now: Date): Promise<OutboxRow[]> {
  return db.select().from(outbox)
    .where(and(
      isNull(outbox.sentAt),
      isNull(outbox.failedReason),
      lte(outbox.nextAttemptAt, now),
    ))
    .orderBy(asc(outbox.nextAttemptAt));
}
