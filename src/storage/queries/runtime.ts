import { randomUUID } from 'node:crypto';
import { and, asc, eq, isNull, lte, sql } from 'drizzle-orm';
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

/** Повтор события — это нарушение UNIQUE, и только оно. Прочие ошибки — не наши. */
function isDuplicateKey(error: unknown): boolean {
  return (
    typeof error === 'object' && error !== null && 'code' in error &&
    error.code === 'SQLITE_CONSTRAINT_UNIQUE'
  );
}

/**
 * Обе платформы доставляют события at-least-once. Уникальный индекс по dedupeKey —
 * это и есть защита: вторая вставка нарушает UNIQUE, и мы возвращаем false
 * вместо повторной обработки.
 *
 * Любая другая ошибка пробрасывается наружу: если её проглотить, сломанная запись
 * навсегда притворится «уже виденной», и событие тихо пропадёт.
 */
export function markEventSeen(db: AppDb, userId: string, dedupeKey: string): boolean {
  try {
    db.insert(processedEvents).values({ id: randomUUID(), userId, dedupeKey }).run();
    return true;
  } catch (error) {
    if (isDuplicateKey(error)) return false;
    // Сам объект ошибки не логируем: в нём бывает содержимое строки (S9)
    throw error;
  }
}

export function enqueueEvent(
  db: AppDb, userId: string, platform: Platform, payload: unknown,
): string {
  const id = randomUUID();
  db.insert(eventQueue).values({
    id, userId, platform, payloadJson: JSON.stringify(payload),
  }).run();
  return id;
}

/**
 * Без userId осознанно: воркер разгребает очередь всех клиентов сразу.
 * Владелец уже записан в строке и дальше едет вместе с событием.
 */
export function takePendingEvents(db: AppDb, limit = 20): EventRow[] {
  return db.select().from(eventQueue)
    .where(isNull(eventQueue.processedAt))
    .orderBy(asc(eventQueue.createdAt))
    .limit(limit)
    .all();
}

export function markEventProcessed(db: AppDb, eventId: string): void {
  db.update(eventQueue).set({ processedAt: new Date() }).where(eq(eventQueue.id, eventId)).run();
}

function threadWhere(userId: string, key: ThreadKey) {
  return and(
    eq(conversations.userId, userId),
    eq(conversations.platform, key.platform),
    eq(conversations.externalThreadId, key.externalThreadId),
    eq(conversations.externalUserId, key.externalUserId),
  );
}

export function loadConversation(db: AppDb, userId: string, key: ThreadKey): ConversationState {
  const row = db.select().from(conversations).where(threadWhere(userId, key)).all()[0];
  if (row === undefined) return emptyState();

  return {
    stepId: row.stepId,
    context: parseStringMap(row.contextJson, 'контекст диалога'),
    lastUserMessageAt: row.lastUserMessageAt,
  };
}

export function saveConversation(
  db: AppDb, userId: string, key: ThreadKey, state: ConversationState,
): void {
  const existing = db.select().from(conversations).where(threadWhere(userId, key)).all()[0];
  const values = {
    stepId: state.stepId,
    contextJson: JSON.stringify(Object.fromEntries(state.context)),
    lastUserMessageAt: state.lastUserMessageAt,
  };

  if (existing === undefined) {
    db.insert(conversations).values({
      id: randomUUID(),
      userId,
      platform: key.platform,
      externalThreadId: key.externalThreadId,
      externalUserId: key.externalUserId,
      ...values,
    }).run();
    return;
  }
  db.update(conversations).set(values).where(eq(conversations.id, existing.id)).run();
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
export function enqueueOutbox(
  db: AppDb,
  userId: string,
  platform: Platform,
  action: OutgoingAction,
  delivery: DeliveryContext,
  nextAttemptAt: Date = new Date(),
): string {
  const id = randomUUID();
  db.insert(outbox).values({
    id, userId, platform,
    actionJson: JSON.stringify(action),
    deliveryJson: JSON.stringify(delivery),
    nextAttemptAt,
  }).run();
  return id;
}

export type OutboxRow = typeof outbox.$inferSelect;

/**
 * Без userId по той же причине, что и takePendingEvents: цикл доставки
 * разгребает исходящие всех клиентов сразу. Владелец уже записан в строке
 * и едет вместе с действием до самой отправки.
 */
export function takeDueOutbox(db: AppDb, now: Date, limit = 20): OutboxRow[] {
  return db.select().from(outbox)
    .where(and(
      isNull(outbox.sentAt),
      isNull(outbox.failedReason),
      lte(outbox.nextAttemptAt, now),
    ))
    .orderBy(asc(outbox.nextAttemptAt))
    .limit(limit)
    .all();
}

/** id взят из строки, которую вернул takeDueOutbox — снаружи он не приходит. */
export function markOutboxSent(db: AppDb, id: string): void {
  db.update(outbox).set({ sentAt: new Date() }).where(eq(outbox.id, id)).run();
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
 */
export function markOutboxFailed(
  db: AppDb, id: string, reason: string, nextAttemptAt: Date | null,
): void {
  db.update(outbox)
    .set({
      attempts: sql`${outbox.attempts} + 1`,
      ...(nextAttemptAt === null ? { failedReason: reason } : { nextAttemptAt }),
    })
    .where(eq(outbox.id, id))
    .run();
}

/**
 * S20: откладывает строку outbox при троттлинге на клиента, не увеличивая счётчик attempts.
 */
export function deferOutbox(db: AppDb, id: string, nextAttemptAt: Date): void {
  db.update(outbox)
    .set({ nextAttemptAt })
    .where(eq(outbox.id, id))
    .run();
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
export function listDeliveryErrors(db: AppDb, userId: string, limit = 50): DeliveryErrorRow[] {
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
    .limit(limit)
    .all();
}
