import { randomUUID } from 'node:crypto';
import { and, eq, isNull } from 'drizzle-orm';
import type { Platform } from '../../core/types.js';
import type { AppDb } from '../db.js';
import { platformAccounts, users } from '../schema.js';
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
 * Отключённый клиент неотличим от неизвестного аккаунта: вебхук такого
 * клиента тоже не находит владельца.
 */
export function resolveAccountOwner(
  db: AppDb,
  platform: Platform,
  externalAccountId: string,
): { userId: string; accountId: string } | undefined {
  const row = db.select({ userId: platformAccounts.userId, accountId: platformAccounts.id })
    .from(platformAccounts)
    .innerJoin(users, eq(users.id, platformAccounts.userId))
    .where(and(
      eq(platformAccounts.platform, platform),
      eq(platformAccounts.externalAccountId, externalAccountId),
      // Отключённый клиент неотличим от неизвестного аккаунта: новое требование
      // выражено через уже написанный S17, а не отдельной проверкой выше по стеку
      isNull(users.disabledAt),
    ))
    .all()[0];
  return row;
}

export type ConnectOutcome = 'created' | 'updated' | 'taken';

/**
 * Три исхода вместо булева результата: «занят другим» и «обновили свой» —
 * разные события для владельца, и сводить их к `false`/`true` значит
 * заставить вызывающего гадать.
 *
 * `taken` — не удобство, а требование: без него клиент вписывает внешний id
 * чужого аккаунта и перехватывает его вебхуки (пробой S17 через админку).
 * `updated` — тоже не удобство: токены Instagram живут 60 дней, без перезаписи
 * сервис молча умирает через два месяца.
 *
 * S11: владелец первым аргументом и в условии обновления. Чужую строку
 * эта функция изменить не может — она её только видит, чтобы отказать.
 *
 * `resolveAccountOwner` здесь намеренно не переиспользуется: он с задачи 3
 * не видит отключённых клиентов, а занятость внешнего id от отключённости
 * не зависит — иначе аккаунт отключённого клиента можно было бы увести.
 */
export function connectOrUpdateAccount(
  db: AppDb,
  userId: string,
  input: { platform: Platform; externalAccountId: string; token: string },
  keyHex: string,
): ConnectOutcome {
  const existing = db.select({ userId: platformAccounts.userId })
    .from(platformAccounts)
    .where(and(
      eq(platformAccounts.platform, input.platform),
      eq(platformAccounts.externalAccountId, input.externalAccountId),
    ))
    .all()[0];

  if (existing !== undefined && existing.userId !== userId) return 'taken';

  if (existing !== undefined) {
    db.update(platformAccounts)
      .set({ tokenEncrypted: encryptSecret(input.token, keyHex) })
      .where(and(
        eq(platformAccounts.userId, userId),
        eq(platformAccounts.platform, input.platform),
        eq(platformAccounts.externalAccountId, input.externalAccountId),
      ))
      .run();
    return 'updated';
  }

  connectAccount(db, userId, input, keyHex);
  return 'created';
}
