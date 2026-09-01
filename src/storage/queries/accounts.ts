import { randomUUID } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import type { Platform } from '../../core/types.js';
import type { AppDb } from '../db.js';
import { platformAccounts } from '../schema.js';
import { decryptSecret, encryptSecret } from '../crypto.js';

export type AccountRow = typeof platformAccounts.$inferSelect;

export function connectAccount(
  db: AppDb,
  userId: string,
  input: { platform: Platform; externalAccountId: string; token: string },
  keyHex: string,
): string {
  const id = randomUUID();
  db.insert(platformAccounts).values({
    id,
    userId,
    platform: input.platform,
    externalAccountId: input.externalAccountId,
    tokenEncrypted: encryptSecret(input.token, keyHex),
  }).run();
  return id;
}

export function listAccounts(db: AppDb, userId: string): AccountRow[] {
  return db.select().from(platformAccounts).where(eq(platformAccounts.userId, userId)).all();
}

/**
 * S11: владелец входит в условие выборки, а не проверяется отдельным `if` после неё.
 * Чужой id просто не находит строку — забыть проверку при рефакторинге нельзя.
 */
export function getAccountToken(
  db: AppDb,
  userId: string,
  accountId: string,
  keyHex: string,
): string | undefined {
  const row = db.select().from(platformAccounts)
    .where(and(eq(platformAccounts.id, accountId), eq(platformAccounts.userId, userId)))
    .all()[0];
  return row === undefined ? undefined : decryptSecret(row.tokenEncrypted, keyHex);
}

/**
 * S11: владелец в условии выборки. Воркеру известен только userId из строки outbox,
 * а не accountId — в v1 у клиента один аккаунт на платформу.
 */
export function getAccountTokenForPlatform(
  db: AppDb,
  userId: string,
  platform: Platform,
  keyHex: string,
): { accountId: string; token: string } | undefined {
  const row = db.select().from(platformAccounts)
    .where(and(eq(platformAccounts.userId, userId), eq(platformAccounts.platform, platform)))
    .all()[0];
  return row === undefined
    ? undefined
    : { accountId: row.id, token: decryptSecret(row.tokenEncrypted, keyHex) };
}

/**
 * S17: единственный вход без userId — здесь он и определяется, по внешнему
 * идентификатору аккаунта из вебхука. Не нашли — событие отбрасывается,
 * а не обрабатывается «по умолчанию».
 */
export function resolveAccountOwner(
  db: AppDb,
  platform: Platform,
  externalAccountId: string,
): { userId: string; accountId: string } | undefined {
  const row = db.select().from(platformAccounts)
    .where(and(
      eq(platformAccounts.platform, platform),
      eq(platformAccounts.externalAccountId, externalAccountId),
    ))
    .all()[0];
  return row === undefined ? undefined : { userId: row.userId, accountId: row.id };
}
