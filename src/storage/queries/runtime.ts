import { randomUUID } from 'node:crypto';
import { and, asc, eq, inArray, isNull, lte, sql } from 'drizzle-orm';
import {
  emptyState,
  type ConversationState,
  type DeliveryContext,
  type OutgoingAction,
  type Platform,
} from '../../core/types.js';
import type { AppDb } from '../db.js';
import { parseStringMap } from '../jsonMap.js';
import { conversations, eventQueue, outbox, processedEvents } from '../schema.js';

export type EventRow = typeof eventQueue.$inferSelect;

export interface ThreadKey {
  platform: Platform;
  externalThreadId: string;
  externalUserId: string;
}

/**
 * Обе платформы доставляют события at-least-once. Уникальный индекс по dedupeKey —
 * это и есть защита: вторая вставка ничего не пишет, `RETURNING` отдаёт пустой
 * массив, и мы возвращаем false вместо повторной обработки.
 *
 * Код ошибки СУБД здесь намеренно не ловится: это была единственная привязка
 * `src/` к конкретной базе, и замена SQLITE_CONSTRAINT_UNIQUE на SQLSTATE 23505
 * её бы сохранила. Прежнее свойство осталось: любая другая ошибка по-прежнему
 * летит наружу, а не превращается в «уже виденное» — иначе событие тихо
 * пропало бы навсегда.
 */
export async function markEventSeen(
  db: AppDb, userId: string, dedupeKey: string,
): Promise<boolean> {
  const inserted = await db.insert(processedEvents)
    .values({ id: randomUUID(), userId, dedupeKey })
    .onConflictDoNothing({ target: processedEvents.dedupeKey })
    .returning({ id: processedEvents.id });
  return inserted.length === 1;
}

export async function enqueueEvent(
  db: AppDb, userId: string, platform: Platform, payload: unknown,
): Promise<string> {
  const id = randomUUID();
  await db.insert(eventQueue).values({
    id, userId, platform, payloadJson: JSON.stringify(payload),
  });
  return id;
}

/**
 * Без userId осознанно: воркер разгребает очередь всех клиентов сразу.
 * Владелец уже записан в строке и дальше едет вместе с событием.
 *
 * `FOR UPDATE SKIP LOCKED` — то, ради чего сделан переезд на Postgres: вторая
 * копия процесса пропустит строки, которые уже держит первая, вместо того чтобы
 * обработать то же событие дважды. Блокировка живёт до конца транзакции, поэтому
 * вызывать эту функцию можно только внутри `db.transaction` — снаружи блокировка
 * снимется сразу после SELECT и смысла в ней не будет. Так её и вызывает
 * `runIntake`: выборка и пометка обработанным идут одной транзакцией.
 */
export async function takePendingEvents(db: AppDb, limit = 20): Promise<EventRow[]> {
  return db.select().from(eventQueue)
    .where(isNull(eventQueue.processedAt))
    .orderBy(asc(eventQueue.createdAt))
    .limit(limit)
    .for('update', { skipLocked: true });
}

export async function markEventProcessed(db: AppDb, eventId: string): Promise<void> {
  await db.update(eventQueue).set({ processedAt: new Date() }).where(eq(eventQueue.id, eventId));
}

function threadWhere(userId: string, key: ThreadKey) {
  return and(
    eq(conversations.userId, userId),
    eq(conversations.platform, key.platform),
    eq(conversations.externalThreadId, key.externalThreadId),
    eq(conversations.externalUserId, key.externalUserId),
  );
}

export async function loadConversation(
  db: AppDb, userId: string, key: ThreadKey,
): Promise<ConversationState> {
  const row = (await db.select().from(conversations).where(threadWhere(userId, key)))[0];
  if (row === undefined) return emptyState();

  return {
    stepId: row.stepId,
    context: parseStringMap(row.contextJson, 'контекст диалога'),
    lastUserMessageAt: row.lastUserMessageAt,
  };
}

export async function saveConversation(
  db: AppDb, userId: string, key: ThreadKey, state: ConversationState,
): Promise<void> {
  const existing = (await db.select().from(conversations).where(threadWhere(userId, key)))[0];
  const values = {
    stepId: state.stepId,
    contextJson: JSON.stringify(Object.fromEntries(state.context)),
    lastUserMessageAt: state.lastUserMessageAt,
  };

  if (existing === undefined) {
    await db.insert(conversations).values({
      id: randomUUID(),
      userId,
      platform: key.platform,
      externalThreadId: key.externalThreadId,
      externalUserId: key.externalUserId,
      ...values,
    });
    return;
  }
  await db.update(conversations).set(values).where(eq(conversations.id, existing.id));
}

/**
 * `nextAttemptAt` — момент, раньше которого строку не заберёт цикл доставки.
 * По умолчанию «сейчас»: обычное сообщение уходит ближайшей итерацией воркера.
 *
 * Время приходит параметром, а не берётся внутри из `new Date()`, по двум причинам:
 * так появляется отложенная отправка (пауза между сообщениями цепочки), и так тест
 * задаёт время явно, вместо того чтобы зависеть от системных часов и протухнуть
 * через несколько дней.
 */
export async function enqueueOutbox(
  db: AppDb,
  userId: string,
  platform: Platform,
  action: OutgoingAction,
  delivery: DeliveryContext,
  nextAttemptAt: Date = new Date(),
): Promise<string> {
  const id = randomUUID();
  await db.insert(outbox).values({
    id, userId, platform,
    actionJson: JSON.stringify(action),
    deliveryJson: JSON.stringify(delivery),
    nextAttemptAt,
  });
  return id;
}

export type OutboxRow = typeof outbox.$inferSelect;

/**
 * Без userId по той же причине, что и takePendingEvents: цикл доставки
 * разгребает исходящие всех клиентов сразу. Владелец уже записан в строке
 * и едет вместе с действием до самой отправки.
 *
 * Строки не просто выбираются, а забираются: короткая транзакция берёт их
 * с `SKIP LOCKED` и тут же двигает `nextAttemptAt` на `leaseMs` вперёд.
 * После коммита соседняя копия процесса этих строк не видит, а блокировки
 * уже сняты — сетевая отправка идёт вне транзакции.
 *
 * Так сделано, а не «транзакция вокруг всей пачки»: внутри пачки идут вызовы
 * к платформе, и откат транзакции после успешной отправки вернул бы строки
 * в очередь — человек получил бы то же сообщение в директ второй раз.
 *
 * Если процесс упадёт после захвата, строки вернутся в работу сами, когда
 * лизинг истечёт. Поэтому `OUTBOX_LEASE_SEC` обязан быть заметно больше
 * времени одной отправки.
 */
export async function takeDueOutbox(
  db: AppDb, now: Date, leaseMs: number, limit = 20,
): Promise<OutboxRow[]> {
  return db.transaction(async (tx) => {
    const rows = await tx.select().from(outbox)
      .where(and(
        isNull(outbox.sentAt),
        isNull(outbox.failedReason),
        lte(outbox.nextAttemptAt, now),
      ))
      .orderBy(asc(outbox.nextAttemptAt))
      .limit(limit)
      .for('update', { skipLocked: true });

    if (rows.length === 0) return [];

    await tx.update(outbox)
      .set({ nextAttemptAt: new Date(now.getTime() + leaseMs) })
      .where(inArray(outbox.id, rows.map((row) => row.id)));

    return rows;
  });
}

/** id взят из строки, которую вернул takeDueOutbox — снаружи он не приходит. */
export async function markOutboxSent(db: AppDb, id: string): Promise<void> {
  await db.update(outbox).set({ sentAt: new Date() }).where(eq(outbox.id, id));
}

/**
 * Два исхода одной функцией: nextAttemptAt === null — осмысленный отказ платформы,
 * повторять бессмысленно, строка закрывается и позже показывается клиенту.
 * Иначе ошибка временная: счётчик растёт, попытка откладывается.
 *
 * Отдельный булев параметр `retry` рядом с датой дал бы невозможные сочетания
 * вроде «повторять, но времени нет»; с одним параметром их просто не существует.
 *
 * attempts увеличивает сама СУБД: чтение строки и запись `attempts + 1` —
 * это два запроса и гонка между ними.
 *
 * Переданное время затирает лизинг, поставленный при захвате: строка либо
 * закрыта, либо получила новое честное время повтора.
 */
export async function markOutboxFailed(
  db: AppDb, id: string, reason: string, nextAttemptAt: Date | null,
): Promise<void> {
  await db.update(outbox)
    .set({
      attempts: sql`${outbox.attempts} + 1`,
      ...(nextAttemptAt === null ? { failedReason: reason } : { nextAttemptAt }),
    })
    .where(eq(outbox.id, id));
}

/**
 * S20: откладывает строку outbox при троттлинге на клиента, не увеличивая счётчик attempts.
 */
export async function deferOutbox(db: AppDb, id: string, nextAttemptAt: Date): Promise<void> {
  await db.update(outbox)
    .set({ nextAttemptAt })
    .where(eq(outbox.id, id));
}

export interface DeliveryErrorRow {
  id: string;
  platform: Platform;
  failedReason: string;
  attempts: number;
  nextAttemptAt: Date;
  sentAt: Date | null;
}

/**
 * S11: список ошибок доставки конкретного клиента (userId в WHERE).
 */
export async function listDeliveryErrors(
  db: AppDb, userId: string, limit = 50,
): Promise<DeliveryErrorRow[]> {
  return db.select({
    id: outbox.id,
    platform: outbox.platform,
    failedReason: sql<string>`coalesce(${outbox.failedReason}, 'Превышен лимит попыток')`,
    attempts: outbox.attempts,
    nextAttemptAt: outbox.nextAttemptAt,
    sentAt: outbox.sentAt,
  })
    .from(outbox)
    .where(and(
      eq(outbox.userId, userId),
      sql`${outbox.failedReason} IS NOT NULL`,
    ))
    .orderBy(asc(outbox.nextAttemptAt))
    .limit(limit);
}
