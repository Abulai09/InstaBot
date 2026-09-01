import { describe, it, expect } from 'vitest';
import { eq } from 'drizzle-orm';
import { createTestDb } from '../helpers.js';
import { outbox } from '../../../src/storage/schema.js';
import { createUser } from '../../../src/storage/queries/users.js';
import {
  markEventSeen, enqueueEvent, takePendingEvents, markEventProcessed,
  loadConversation, saveConversation, enqueueOutbox,
  takeDueOutbox, markOutboxSent, markOutboxFailed,
} from '../../../src/storage/queries/runtime.js';

const key = { platform: 'instagram', externalThreadId: 't1', externalUserId: 'u-ext' } as const;

function seed() {
  const db = createTestDb();
  const a = createUser(db, { email: 'a@x.c', passwordHash: 'h' });
  const b = createUser(db, { email: 'b@x.c', passwordHash: 'h' });
  return { db, a, b };
}

describe('дедупликация событий', () => {
  it('второе появление того же ключа отвергается', () => {
    const { db, a } = seed();
    expect(markEventSeen(db, a, 'k1')).toBe(true);
    expect(markEventSeen(db, a, 'k1')).toBe(false);
  });

  it('не выдаёт чужую ошибку за повтор: событие несуществующего клиента падает', () => {
    const { db } = seed();
    expect(() => markEventSeen(db, 'ghost', 'k1')).toThrow();
  });

  it('разные ключи проходят оба', () => {
    const { db, a } = seed();
    expect(markEventSeen(db, a, 'k1')).toBe(true);
    expect(markEventSeen(db, a, 'k2')).toBe(true);
  });
});

describe('очередь событий', () => {
  it('отдаёт необработанные события и закрывает их', () => {
    const { db, a } = seed();
    const id = enqueueEvent(db, a, 'instagram', { text: 'цена' });
    expect(takePendingEvents(db)).toHaveLength(1);
    markEventProcessed(db, id);
    expect(takePendingEvents(db)).toEqual([]);
  });

  it('событие несёт владельца: воркер знает, чьи воронки грузить', () => {
    const { db, a } = seed();
    enqueueEvent(db, a, 'instagram', { text: 'цена' });
    expect(takePendingEvents(db)[0]?.userId).toBe(a);
  });
});

describe('состояние диалога', () => {
  it('новый диалог начинается с пустого состояния', () => {
    const { db, a } = seed();
    const state = loadConversation(db, a, key);
    expect(state.stepId).toBeNull();
    expect(state.context.size).toBe(0);
  });

  it('сохраняет и восстанавливает состояние', () => {
    const { db, a } = seed();
    saveConversation(db, a, key, {
      stepId: 'ask_phone',
      context: new Map([['product', 'кроссовки']]),
      lastUserMessageAt: new Date('2026-08-27T10:00:00Z'),
    });
    const state = loadConversation(db, a, key);
    expect(state.stepId).toBe('ask_phone');
    expect(state.context.get('product')).toBe('кроссовки');
    expect(state.lastUserMessageAt?.toISOString()).toBe('2026-08-27T10:00:00.000Z');
  });

  it('повторное сохранение обновляет ту же запись', () => {
    const { db, a } = seed();
    const base = { context: new Map<string, string>(), lastUserMessageAt: null };
    saveConversation(db, a, key, { ...base, stepId: 'one' });
    saveConversation(db, a, key, { ...base, stepId: 'two' });
    expect(loadConversation(db, a, key).stepId).toBe('two');
  });

  it('S11: диалог другого клиента с тем же тредом — отдельная запись', () => {
    const { db, a, b } = seed();
    saveConversation(db, a, key, {
      stepId: 'ask_phone', context: new Map(), lastUserMessageAt: null,
    });
    expect(loadConversation(db, b, key).stepId).toBeNull();
  });

  it('S6: ключ __proto__ в контексте переживает сохранение', () => {
    const { db, a } = seed();
    saveConversation(db, a, key, {
      stepId: 's1', context: new Map([['__proto__', 'X']]), lastUserMessageAt: null,
    });
    expect(loadConversation(db, a, key).context.get('__proto__')).toBe('X');
  });
});

describe('outbox', () => {
  it('складывает исходящее действие неотправленным', () => {
    const { db, a } = seed();
    const id = enqueueOutbox(db, a, 'instagram',
      { type: 'send_text', text: 'привет' },
      { threadId: 't1', userId: 'u-ext' });

    const row = db.select().from(outbox).where(eq(outbox.id, id)).all()[0];
    expect(row?.attempts).toBe(0);
    expect(row?.sentAt).toBeNull();
    expect(row?.userId).toBe(a);
  });
});

describe('outbox: разгребание', () => {
  const now = new Date('2026-08-28T12:00:00Z');
  const later = new Date('2026-08-28T13:00:00Z');

  it('берёт только те, чьё время пришло и которые ещё не отправлены', () => {
    const { db, a } = seed();
    const due = enqueueOutbox(db, a, 'instagram', { type: 'send_text', text: 'да' }, { threadId: 't1' }, now);
    const sent = enqueueOutbox(db, a, 'instagram', { type: 'send_text', text: 'уже ушло' }, { threadId: 't2' }, now);
    const notYet = enqueueOutbox(db, a, 'instagram', { type: 'send_text', text: 'потом' }, { threadId: 't3' }, now);

    markOutboxSent(db, sent);
    markOutboxFailed(db, notYet, 'сеть', later);

    expect(takeDueOutbox(db, now).map((r) => r.id)).toEqual([due]);
  });

  it('без времени следующей попытки строка закрывается навсегда', () => {
    const { db, a } = seed();
    const id = enqueueOutbox(db, a, 'instagram', { type: 'send_text', text: 'плохой запрос' }, { threadId: 't1' }, now);

    markOutboxFailed(db, id, 'HTTP 400', null);

    expect(takeDueOutbox(db, new Date('2030-01-01T00:00:00Z'))).toHaveLength(0);
  });

  it('каждая неудача увеличивает attempts', () => {
    const { db, a } = seed();
    const id = enqueueOutbox(db, a, 'instagram', { type: 'send_text', text: 'ретрай' }, { threadId: 't1' }, now);
    const past = new Date('2020-01-01T00:00:00Z');

    markOutboxFailed(db, id, 'сеть', past);
    markOutboxFailed(db, id, 'сеть', past);

    expect(takeDueOutbox(db, now)[0]?.attempts).toBe(2);
  });

  it('S11: воркер видит строки обоих клиентов, владелец едет в строке', () => {
    const { db, a, b } = seed();
    enqueueOutbox(db, a, 'instagram', { type: 'send_text', text: 'A' }, { threadId: 't1' }, now);
    enqueueOutbox(db, b, 'instagram', { type: 'send_text', text: 'B' }, { threadId: 't2' }, now);

    const rows = takeDueOutbox(db, now);
    expect(new Set(rows.map((r) => r.userId))).toEqual(new Set([a, b]));
  });

  it('запланированное на будущее не берётся раньше срока', () => {
    const { db, a } = seed();
    const id = enqueueOutbox(db, a, 'instagram', { type: 'send_text', text: 'через час' }, { threadId: 't1' }, later);

    expect(takeDueOutbox(db, now)).toHaveLength(0);
    expect(takeDueOutbox(db, later).map((r) => r.id)).toEqual([id]);
  });
});
