import type { AppDb } from '../../storage/db.js';
import { decryptSecret } from '../../storage/crypto.js';
import { listActivePlatformAccounts } from '../../storage/queries/accounts.js';
import { enqueueEvent, markEventSeen } from '../../storage/queries/runtime.js';
import type { TikTokAdapter } from './adapter.js';

/**
 * Фоновый опрос TikTok: у платформы нет вебхука на комментарии, поэтому
 * события приходят не к нам, а мы за ними ходим сами.
 *
 * Владелец не первым аргументом осознанно — тот же случай, что у воркера:
 * поллер обходит аккаунты всех клиентов сразу, а userId берётся из строки
 * аккаунта и дальше едет вместе с событием в очередь. Отключённых клиентов
 * (S17) отсекает сама выборка `listActivePlatformAccounts`.
 *
 * Возвращает число новых событий, поставленных в очередь.
 */
export async function pollAllTikTokAccounts(
  db: AppDb,
  adapter: TikTokAdapter,
  keyHex: string,
): Promise<number> {
  const accounts = await listActivePlatformAccounts(db, 'tiktok');
  let enqueued = 0;

  for (const account of accounts) {
    const token = decryptSecret(account.tokenEncrypted, keyHex);
    const result = await adapter.pollComments(token, account.externalAccountId);
    // Отказ по одному аккаунту не останавливает обход остальных: следующий
    // тик опроса повторит попытку. Причину не логируем здесь — в ней бывают
    // данные платформы, а поллер не знает уровня логирования (S9)
    if (!result.ok) continue;

    for (const event of result.events) {
      // Дедупликация до постановки в очередь: опрос по определению возвращает
      // одни и те же комментарии на каждом тике, пока они не уедут из выдачи
      if (!await markEventSeen(db, account.userId, event.dedupeKey)) continue;
      await enqueueEvent(db, account.userId, 'tiktok', event);
      enqueued += 1;
    }
  }

  return enqueued;
}
