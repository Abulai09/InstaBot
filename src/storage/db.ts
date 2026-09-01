import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';

export type AppDb = BetterSQLite3Database<Record<string, never>>;

/**
 * `foreign_keys` в SQLite выключен по умолчанию — без этой строки внешние ключи
 * из схемы не проверяются вообще, и «воронка несуществующего клиента» пройдёт молча.
 */
export function openDb(url: string): AppDb {
  const sqlite = new Database(url);
  sqlite.pragma('journal_mode = WAL');
  sqlite.pragma('foreign_keys = ON');
  return drizzle(sqlite);
}
