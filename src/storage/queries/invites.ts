import { createHash, randomBytes } from 'node:crypto';
import { and, eq, gt, isNull } from 'drizzle-orm';
import type { AppDb } from '../db.js';
import { invites } from '../schema.js';

/**
 * Тот же приём, что в `sessions`: в ссылку уезжает токен, в базу ложится хэш.
 * Соли и растягивания нет намеренно — токен уже случайный на 256 бит.
 */
function tokenHash(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

/** Возвращает токен: он существует только здесь и в ссылке у владельца. */
export function createInvite(db: AppDb, userId: string, now: Date, ttlMs: number): string {
  const token = randomBytes(32).toString('hex');
  db.insert(invites).values({
    id: tokenHash(token),
    userId,
    expiresAt: new Date(now.getTime() + ttlMs),
    createdAt: now,
  }).run();
  return token;
}

/**
 * Проверка и гашение — одна операция, а не транзакция из двух шагов: между
 * «нашли действующее» и «пометили использованным» есть щель, в которую
 * проходит двойной сабмит формы. `RETURNING` отдаёт владельца той же строкой,
 * которую только что погасил, — если не затронуто ни одной, ссылка недействительна.
 *
 * Владельца функция не принимает, а определяет: гость, идущий по ссылке,
 * ещё не аутентифицирован. Осознанное исключение из правила S11, как
 * `resolveAccountOwner`.
 */
export function consumeInvite(
  db: AppDb, token: string, now: Date,
): { userId: string } | undefined {
  return db.update(invites)
    .set({ usedAt: now })
    .where(and(
      eq(invites.id, tokenHash(token)),
      isNull(invites.usedAt),
      gt(invites.expiresAt, now),
    ))
    .returning({ userId: invites.userId })
    .all()[0];
}

/** Только проверка, без гашения: нужна GET-маршруту, чтобы решить, показывать ли форму. */
export function peekInvite(db: AppDb, token: string, now: Date): boolean {
  return db.select({ id: invites.id }).from(invites)
    .where(and(
      eq(invites.id, tokenHash(token)),
      isNull(invites.usedAt),
      gt(invites.expiresAt, now),
    ))
    .all().length === 1;
}

/**
 * S11: владелец в условии. Гасит все действующие приглашения клиента — иначе
 * после «ссылка утекла, выпустите новую» старая работала бы до конца срока.
 */
export function revokeUserInvites(db: AppDb, userId: string, now: Date): void {
  db.update(invites)
    .set({ usedAt: now })
    .where(and(eq(invites.userId, userId), isNull(invites.usedAt)))
    .run();
}
