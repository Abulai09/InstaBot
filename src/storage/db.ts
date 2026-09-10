import pg from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import type { PgDatabase, PgQueryResultHKT } from 'drizzle-orm/pg-core';

/**
 * Тип базы намеренно driver-agnostic: `PgDatabase` — общий предок и пула
 * `node-postgres` (прод), и PGlite (тесты), и транзакции. Благодаря этому
 * функция из `queries/` принимает и базу, и `tx` внутри транзакции, а тесты
 * не тянут в проект сетевой драйвер.
 */
export type AppDb = PgDatabase<PgQueryResultHKT, Record<string, never>>;

/**
 * `close` возвращается вместе с базой, потому что пул держит открытые сокеты
 * и не даёт процессу завершиться. Серверу это безразлично — он и так живёт
 * вечно, — а вот скрипт (`seed`, `owner`) без него просто повиснет после
 * последней строки, чего с синхронным SQLite не бывало.
 */
export interface Database {
  db: AppDb;
  close: () => Promise<void>;
}

/**
 * Пул, а не одно соединение: процесс долгоживущий, и веб-запрос не должен
 * ждать, пока воркер закончит свой запрос.
 *
 * Внешние ключи в Postgres проверяются всегда — прагмы, как у SQLite, здесь нет.
 * Миграции при старте не применяются: при нескольких копиях процесса это гонка,
 * поэтому `npm run migrate` — отдельный шаг перед запуском.
 */
export function openDb(url: string): Database {
  const pool = new pg.Pool({ connectionString: url });
  return { db: drizzle(pool), close: () => pool.end() };
}
