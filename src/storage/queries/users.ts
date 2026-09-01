import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import type { AppDb } from '../db.js';
import { users } from '../schema.js';

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
