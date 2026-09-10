import { describe, it, expect } from 'vitest';
import { eq } from 'drizzle-orm';
import { createTestDb } from '../helpers.js';
import { outbox } from '../../../src/storage/schema.js';
import { createUser } from '../../../src/storage/queries/users.js';
import {
  markEventSeen, enqueueEvent, takePendingEvents, markEventProcessed,
  loadConversation, saveConversation, enqueueOutbox,
  takeDueOutbox, markOutboxSent, markOutboxFailed, deferOutbox, listDeliveryErrors,
} from '../../../src/storage/queries/runtime.js';

/** Лизинг строки outbox: то же значение, что OUTBOX_LEASE_SEC по умолчанию. */
const LEASE_MS = 60_000;

const key = { platform: 'instagram', externalThreadId: 't1', externalUserId: 'u-ext' } as const;

async function seed() {
  const db = await createTestDb();
  const a = await createUser(db, { email: 'a@x.c', passwordHash: 'h' });
  const b = await createUser(db, { email: 'b@x.c', passwordHash: 'h' });
  return { db, a, b };
}

describe('дедупликация событий', () => {
  it('второе появление того же ключа отвергается', async () => {
    const { db, a } = await seed();
    expect(await markEventSeen(db, a, 'k1')).toBe(true);
    expect(await markEventSeen(db, a, 'k1')).toBe(false);
  });

  it('не выдаёт чужую ошибку за повтор: событие несуществующего клиента падает', async () => {
    const { db } = await seed();
    await expect(markEventSeen(db, 'ghost', 'k1')).rejects.toThrow();
  });

  it('разные ключи проходят оба', async () => {
    const { db, a } = await seed();
    expect(await markEventSeen(db, a, 'k1')).toBe(true);
    expect(await markEventSeen(db, a, 'k2')).toBe(true);
  });
});

describe('очередь событий', () => {
  it('отдаёт необработанные события и закрывает их', async () => {
    const { db, a } = await seed();
    const id = await enqueueEvent(db, a, 'instagram', { text: 'цена' });
    expect(await takePendingEvents(db)).toHaveLength(1);
    await markEventProcessed(db, id);
    expect(await takePendingEvents(db)).toEqual([]);
  });

  it('событие несёт владельца: воркер знает, чьи воронки грузить', async () => {
    const { db, a } = await seed();
    await enqueueEvent(db, a, 'instagram', { text: 'цена' });
    expect((await takePendingEvents(db))[0]?.userId).toBe(a);
  });
});

describe('состояние диалога', () => {
  it('новый диалог начинается с пустого состояния', async () => {
    const { db, a } = await seed();
    const state = await loadConversation(db, a, key);
    expect(state.stepId).toBeNull();
    expect(state.context.size).toBe(0);
  });

  it('сохраняет и восстанавливает состояние', async () => {
    const { db, a } = await seed();
    await saveConversation(db, a, key, {
      stepId: 'ask_phone',
      context: new Map([['product', 'кроссовки']]),
      lastUserMessageAt: new Date('2026-08-27T10:00:00Z'),
    });
    const state = await loadConversation(db, a, key);
    expect(state.stepId).toBe('ask_phone');
    expect(state.context.get('product')).toBe('кроссовки');
    expect(state.lastUserMessageAt?.toISOString()).toBe('2026-08-27T10:00:00.000Z');
  });

  it('повторное сохранение обновляет ту же запись', async () => {
    const { db, a } = await seed();
    const base = { context: new Map<string, string>(), lastUserMessageAt: null };
    await saveConversation(db, a, key, { ...base, stepId: 'one' });
    await saveConversation(db, a, key, { ...base, stepId: 'two' });
    expect((await loadConversation(db, a, key)).stepId).toBe('two');
  });

  it('S11: диалог другого клиента с тем же тредом — отдельная запись', async () => {
    const { db, a, b } = await seed();
    await saveConversation(db, a, key, {
      stepId: 'ask_phone', context: new Map(), lastUserMessageAt: null,
    });
    expect((await loadConversation(db, b, key)).stepId).toBeNull();
  });

  it('S6: ключ __proto__ в контексте переживает сохранение', async () => {
    const { db, a } = await seed();
    await saveConversation(db, a, key, {
      stepId: 's1', context: new Map([['__proto__', 'X']]), lastUserMessageAt: null,
    });
    expect((await loadConversation(db, a, key)).context.get('__proto__')).toBe('X');
  });
});

describe('outbox', () => {
  it('складывает исходящее действие неотправленным', async () => {
    const { db, a } = await seed();
    const id = await enqueueOutbox(db, a, 'instagram',
      { type: 'send_text', text: 'привет' },
      { threadId: 't1', userId: 'u-ext' });

    const row = (await db.select().from(outbox).where(eq(outbox.id, id)))[0];
    expect(row?.attempts).toBe(0);
    expect(row?.sentAt).toBeNull();
    expect(row?.userId).toBe(a);
  });
});

describe('outbox: разгребание', () => {
  const now = new Date('2026-08-28T12:00:00Z');
  const later = new Date('2026-08-28T13:00:00Z');

  it('берёт только те, чьё время пришло и которые ещё не отправлены', async () => {
    const { db, a } = await seed();
    const due = await enqueueOutbox(db, a, 'instagram', { type: 'send_text', text: 'да' }, { threadId: 't1' }, now);
    const sent = await enqueueOutbox(db, a, 'instagram', { type: 'send_text', text: 'уже ушло' }, { threadId: 't2' }, now);
    const notYet = await enqueueOutbox(db, a, 'instagram', { type: 'send_text', text: 'потом' }, { threadId: 't3' }, now);

    await markOutboxSent(db, sent);
    await markOutboxFailed(db, notYet, 'сеть', later);

    expect((await takeDueOutbox(db, now, LEASE_MS)).map((r) => r.id)).toEqual([due]);
  });

  it('без времени следующей попытки строка закрывается навсегда', async () => {
    const { db, a } = await seed();
    const id = await enqueueOutbox(db, a, 'instagram', { type: 'send_text', text: 'плохой запрос' }, { threadId: 't1' }, now);

    await markOutboxFailed(db, id, 'HTTP 400', null);

    expect(await takeDueOutbox(db, new Date('2030-01-01T00:00:00Z'), LEASE_MS)).toHaveLength(0);
  });

  it('каждая неудача увеличивает attempts', async () => {
    const { db, a } = await seed();
    const id = await enqueueOutbox(db, a, 'instagram', { type: 'send_text', text: 'ретрай' }, { threadId: 't1' }, now);
    const past = new Date('2020-01-01T00:00:00Z');

    await markOutboxFailed(db, id, 'сеть', past);
    await markOutboxFailed(db, id, 'сеть', past);

    expect((await takeDueOutbox(db, now, LEASE_MS))[0]?.attempts).toBe(2);
  });

  it('S11: воркер видит строки обоих клиентов, владелец едет в строке', async () => {
    const { db, a, b } = await seed();
    await enqueueOutbox(db, a, 'instagram', { type: 'send_text', text: 'A' }, { threadId: 't1' }, now);
    await enqueueOutbox(db, b, 'instagram', { type: 'send_text', text: 'B' }, { threadId: 't2' }, now);

    const rows = await takeDueOutbox(db, now, LEASE_MS);
    expect(new Set(rows.map((r) => r.userId))).toEqual(new Set([a, b]));
  });

  it('запланированное на будущее не берётся раньше срока', async () => {
    const { db, a } = await seed();
    const id = await enqueueOutbox(db, a, 'instagram', { type: 'send_text', text: 'через час' }, { threadId: 't1' }, later);

    expect(await takeDueOutbox(db, now, LEASE_MS)).toHaveLength(0);
    expect((await takeDueOutbox(db, later, LEASE_MS)).map((r) => r.id)).toEqual([id]);
  });

  it('S20: deferOutbox переносит время без увеличения счётчика попыток', async () => {
    const { db, a } = await seed();
    const id = await enqueueOutbox(db, a, 'instagram', { type: 'send_text', text: 'троттлинг' }, { threadId: 't1' }, now);

    await deferOutbox(db, id, later);

    const row = (await db.select().from(outbox).where(eq(outbox.id, id)))[0];
    expect(row?.attempts).toBe(0);
    expect(row?.nextAttemptAt).toEqual(later);
  });

  it('S11: listDeliveryErrors возвращает только ошибки указанного пользователя', async () => {
    const { db, a, b } = await seed();
    const errA = await enqueueOutbox(db, a, 'instagram', { type: 'send_text', text: 'A' }, { threadId: 't1' }, now);
    const errB = await enqueueOutbox(db, b, 'instagram', { type: 'send_text', text: 'B' }, { threadId: 't2' }, now);

    await markOutboxFailed(db, errA, 'Истекло 24-часовое окно ответа', null);
    await markOutboxFailed(db, errB, 'Недействительный токен аккаунта', null);

    const errorsA = await listDeliveryErrors(db, a);
    expect(errorsA).toHaveLength(1);
    expect(errorsA[0]?.id).toBe(errA);
    expect(errorsA[0]?.failedReason).toBe('Истекло 24-часовое окно ответа');

    const errorsB = await listDeliveryErrors(db, b);
    expect(errorsB).toHaveLength(1);
    expect(errorsB[0]?.id).toBe(errB);
  });
});
