import { createHash, randomBytes } from 'node:crypto';
import { and, eq, gt } from 'drizzle-orm';
import type { AppDb } from '../db.js';
import { sessions, users } from '../schema.js';

/**
 * В cookie уезжает токен, в базу ложится его хэш. Дамп базы после этого
 * не даёт войти ни в один кабинет (S15).
 *
 * Соли и растягивания нет намеренно: токен уже случайный на 256 бит, словарь
 * к нему не подберёшь, а сессия проверяется на каждый запрос — argon2 здесь
 * стоил бы десятки миллисекунд на каждой странице.
 */
function tokenHash(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

/**
 * Возвращает токен, а не id строки: id — это уже хэш, и наружу он не нужен.
 * Токен существует только в этом возврате и в cookie клиента.
 */
export function createSession(db: AppDb, userId: string, now: Date, ttlMs: number): string {
  const token = randomBytes(32).toString('hex');
  db.insert(sessions).values({
    id: tokenHash(token),
    userId,
    expiresAt: new Date(now.getTime() + ttlMs),
    createdAt: now,
  }).run();
  return token;
}

/**
 * Срок жизни проверяется в самом запросе: истёкшая строка просто не находится.
 *
 * Роль берётся из `users` тем же запросом, а не кладётся в сессию при входе:
 * в базу мы ходим здесь всё равно, а роль из БД всегда актуальна — разжалование
 * действует немедленно, а не до конца срока сессии (S12).
 */
export function loadSession(
  db: AppDb, token: string, now: Date,
): { userId: string; role: 'client' | 'owner' } | undefined {
  return db.select({ userId: sessions.userId, role: users.role })
    .from(sessions)
    .innerJoin(users, eq(users.id, sessions.userId))
    .where(and(eq(sessions.id, tokenHash(token)), gt(sessions.expiresAt, now)))
    .all()[0];
}

/** Скользящее окно: срок считается от текущего момента, а не от входа. */
export function touchSession(db: AppDb, token: string, now: Date, ttlMs: number): void {
  db.update(sessions)
    .set({ expiresAt: new Date(now.getTime() + ttlMs) })
    .where(eq(sessions.id, tokenHash(token)))
    .run();
}

export function deleteSession(db: AppDb, token: string): void {
  db.delete(sessions).where(eq(sessions.id, tokenHash(token))).run();
}

/**
 * Владелец первым аргументом, как во всех запросах слоя: это единственный
 * способ выйти со всех устройств при смене пароля (S15).
 */
export function deleteUserSessions(db: AppDb, userId: string): void {
  db.delete(sessions).where(eq(sessions.userId, userId)).run();
}
