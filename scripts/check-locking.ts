import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import { asc, isNull } from 'drizzle-orm';
import { pgTable, text, timestamp } from 'drizzle-orm/pg-core';
import { loadConfig } from '../src/config.js';
import type { AppDb } from '../src/storage/db.js';

/**
 * Живая проверка `FOR UPDATE SKIP LOCKED` против настоящего Postgres.
 *
 * Зачем отдельным скриптом, а не тестом: тесты идут на PGlite, а у него одно
 * соединение — две транзакции там выполняются по очереди, и разъехаться просто
 * не могут. Свойство, ради которого делался переезд на Postgres, проверяется
 * только двумя настоящими соединениями, то есть только вручную и против облака.
 *
 * Настоящие очереди скрипт не трогает: он заводит свою временную таблицу,
 * гоняет по ней тот же самый запрос drizzle, что и `takePendingEvents`,
 * и удаляет таблицу за собой. Проверяется связка драйвер + drizzle + сервер,
 * а не содержимое рабочей базы.
 */
const cfg = loadConfig();

const tableName = `locking_check_${randomUUID().replace(/-/g, '')}`;
const scratch = pgTable(tableName, {
  id: text('id').primaryKey(),
  createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull(),
  processedAt: timestamp('processed_at', { withTimezone: true, mode: 'date' }),
});

const first = new pg.Pool({ connectionString: cfg.DATABASE_URL, max: 1 });
const second = new pg.Pool({ connectionString: cfg.DATABASE_URL, max: 1 });
const dbA = drizzle(first);
const dbB = drizzle(second);

/** Тот же запрос, что в takePendingEvents: выборка неразобранных строк с захватом. */
function takeQuery(db: AppDb, limit: number) {
  return db.select({ id: scratch.id }).from(scratch)
    .where(isNull(scratch.processedAt))
    .orderBy(asc(scratch.createdAt))
    .limit(limit)
    .for('update', { skipLocked: true });
}

async function main(): Promise<void> {
  await first.query(
    `CREATE TABLE "${tableName}" (
       id text PRIMARY KEY,
       created_at timestamptz NOT NULL,
       processed_at timestamptz
     )`,
  );

  const now = new Date();
  const rows = Array.from({ length: 4 }, (_, i) => ({
    id: `row-${i}`, createdAt: new Date(now.getTime() + i), processedAt: null,
  }));
  await dbA.insert(scratch).values(rows);

  let takenA: string[] = [];
  let takenB: string[] = [];

  // Обе транзакции держатся открытыми одновременно: в этом весь смысл проверки.
  // Первая берёт две строки и не отпускает, вторая в это же время лезет в ту же
  // таблицу — и обязана пройти мимо заблокированных, а не ждать их
  await dbA.transaction(async (txA) => {
    takenA = (await takeQuery(txA, 2)).map((row) => row.id);

    // Вложенный await — не случайность: вторая транзакция обязана начаться
    // и закончиться, пока первая ещё держит свои строки
    await dbB.transaction(async (txB) => {
      takenB = (await takeQuery(txB, 2)).map((row) => row.id);
    });
  });

  const overlap = takenA.filter((id) => takenB.includes(id));

  console.log(`Первый воркер забрал:  ${takenA.join(', ') || '—'}`);
  console.log(`Второй воркер забрал:  ${takenB.join(', ') || '—'}`);

  if (takenA.length !== 2 || takenB.length !== 2 || overlap.length > 0) {
    console.error(
      overlap.length > 0
        ? `ОШИБКА: обе транзакции взяли одни и те же строки: ${overlap.join(', ')}`
        : 'ОШИБКА: ожидалось по две строки у каждой транзакции',
    );
    process.exitCode = 1;
    return;
  }

  console.log('OK: две транзакции разошлись по разным строкам — SKIP LOCKED работает');
}

try {
  await main();
} finally {
  // Таблицу убираем при любом исходе, иначе мусор останется в рабочей базе
  await first.query(`DROP TABLE IF EXISTS "${tableName}"`);
  await first.end();
  await second.end();
}
