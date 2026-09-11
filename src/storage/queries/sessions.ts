import { createHash, randomBytes } from 'node:crypto';
import { and, eq, gt, isNull } from 'drizzle-orm';
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
export async function createSession(
  db: AppDb, userId: string, now: Date, ttlMs: number,
): Promise<string> {
  const token = randomBytes(32).toString('hex');
  await db.insert(sessions).values({
    id: tokenHash(token),
    userId,
    expiresAt: new Date(now.getTime() + ttlMs),
    createdAt: now,
  });
  return token;
}

/**
 * Срок жизни проверяется в самом запросе: истёкшая строка просто не находится.
 *
 * Роль берётся из `users` тем же запросом, а не кладётся в сессию при входе:
 * в базу мы ходим здесь всё равно, а роль из БД всегда актуальна — разжалование
 * действует немедленно, а не до конца срока сессии (S12).
 *
 * По той же причине отключённость проверяется здесь, а не только в админке:
 * `deleteUserSessions` гасит сессии, которые есть в момент отключения, но
 * сессия отключённого рождается и в обход админки — по ещё действующей ссылке
 * приглашения. Условие в самой выборке закрывает все пути сразу, как
 * `isNull(users.disabledAt)` в `resolveAccountOwner` (S12).
 */
export async function loadSession(
  db: AppDb, token: string, now: Date,
): Promise<{ userId: string; role: 'client' | 'owner'; expiresAt: Date } | undefined> {
  return (await db.select({ userId: sessions.userId, role: users.role, expiresAt: sessions.expiresAt })
    .from(sessions)
    .innerJoin(users, eq(users.id, sessions.userId))
    .where(and(
      eq(sessions.id, tokenHash(token)),
      gt(sessions.expiresAt, now),
      isNull(users.disabledAt),
    )))[0];
}

/** Скользящее окно: срок считается от текущего момента, а не от входа. */
export async function touchSession(
  db: AppDb, token: string, now: Date, ttlMs: number,
): Promise<void> {
  await db.update(sessions)
    .set({ expiresAt: new Date(now.getTime() + ttlMs) })
    .where(eq(sessions.id, tokenHash(token)));
}

export async function deleteSession(db: AppDb, token: string): Promise<void> {
  await db.delete(sessions).where(eq(sessions.id, tokenHash(token)));
}

/**
 * Владелец первым аргументом, как во всех запросах слоя: это единственный
 * способ выйти со всех устройств при смене пароля (S15).
 */
export async function deleteUserSessions(db: AppDb, userId: string): Promise<void> {
  await db.delete(sessions).where(eq(sessions.userId, userId));
}
