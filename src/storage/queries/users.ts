import { randomUUID } from 'node:crypto';
import { count, eq, inArray } from 'drizzle-orm';
import type { AppDb } from '../db.js';
import { automations, platformAccounts, users } from '../schema.js';

export type UserRow = typeof users.$inferSelect;

/**
 * `passwordHash` принимается готовым: хеширование — забота слоя входа (S13),
 * хранилище не должно знать, каким алгоритмом получен хэш.
 */
export function createUser(
  db: AppDb,
  input: { email: string; passwordHash: string; role?: 'client' | 'owner' },
): string {
  const id = randomUUID();
  db.insert(users).values({
    id,
    email: input.email,
    passwordHash: input.passwordHash,
    role: input.role ?? 'client',
  }).run();
  return id;
}

export function findUserByEmail(db: AppDb, email: string): UserRow | undefined {
  return db.select().from(users).where(eq(users.email, email)).all()[0];
}

export function findUserById(db: AppDb, userId: string): UserRow | undefined {
  return db.select().from(users).where(eq(users.id, userId)).all()[0];
}

/** `null` включает клиента обратно. Отключение обратимо, удаления в v1 нет. */
export function setUserDisabled(db: AppDb, userId: string, disabledAt: Date | null): void {
  db.update(users).set({ disabledAt }).where(eq(users.id, userId)).run();
}

/** Хэш приходит готовым: как и в `createUser`, хранилище не знает про argon2 (S13). */
export function setUserPassword(db: AppDb, userId: string, passwordHash: string): void {
  db.update(users).set({ passwordHash }).where(eq(users.id, userId)).run();
}

export interface ClientRow {
  id: string;
  email: string;
  disabledAt: Date | null;
  connected: boolean;
  automationCount: number;
}

/**
 * Четвёртое осознанное исключение из правила «владелец первым аргументом»:
 * у владельца сервиса нет «своих» клиентов — ему принадлежат все. Защищает
 * эту функцию не `WHERE`, а хук роли плагина `/admin` (S12), и вызываться
 * она обязана только оттуда.
 *
 * Три запроса, а не один JOIN: `LEFT JOIN` сразу на воронки и аккаунты
 * размножил бы строки и посчитал воронки неверно.
 */
export function listClients(db: AppDb): ClientRow[] {
  const rows = db.select({
    id: users.id, email: users.email, disabledAt: users.disabledAt,
  }).from(users).where(eq(users.role, 'client')).all();

  if (rows.length === 0) return [];
  const ids = rows.map((r) => r.id);

  const counts = new Map(
    db.select({ userId: automations.userId, n: count() })
      .from(automations).where(inArray(automations.userId, ids))
      .groupBy(automations.userId).all()
      .map((r) => [r.userId, r.n] as const),
  );
  const connected = new Set(
    db.select({ userId: platformAccounts.userId })
      .from(platformAccounts).where(inArray(platformAccounts.userId, ids))
      .all().map((r) => r.userId),
  );

  return rows.map((r) => ({
    ...r,
    connected: connected.has(r.id),
    automationCount: counts.get(r.id) ?? 0,
  }));
}
