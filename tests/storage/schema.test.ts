import { describe, it, expect } from 'vitest';
import { eq } from 'drizzle-orm';
import { createTestDb } from './helpers.js';
import { users, automations, processedEvents } from '../../src/storage/schema.js';

describe('схема БД', () => {
  it('хранит клиента и его воронку', () => {
    const db = createTestDb();
    db.insert(users).values({ id: 'u1', email: 'a@b.c', passwordHash: 'x', role: 'client' }).run();
    db.insert(automations).values({
      id: 'a1', userId: 'u1', name: 'Прайс', triggerType: 'contains', triggerValue: 'цена',
    }).run();

    const rows = db.select().from(automations).where(eq(automations.userId, 'u1')).all();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.enabled).toBe(true);
  });

  it('не даёт создать воронку несуществующему клиенту', () => {
    const db = createTestDb();
    expect(() =>
      db.insert(automations).values({
        id: 'a1', userId: 'ghost', name: 'x', triggerType: 'exact', triggerValue: 'y',
      }).run(),
    ).toThrow();
  });

  it('дедупликация: один dedupeKey нельзя записать дважды', () => {
    const db = createTestDb();
    db.insert(users).values({ id: 'u1', email: 'a@b.c', passwordHash: 'x', role: 'client' }).run();
    const row = { id: 'p1', userId: 'u1', dedupeKey: 'k1' };
    db.insert(processedEvents).values(row).run();
    expect(() => db.insert(processedEvents).values({ ...row, id: 'p2' }).run()).toThrow();
  });

  it('два клиента не могут занять один email', () => {
    const db = createTestDb();
    db.insert(users).values({ id: 'u1', email: 'same@b.c', passwordHash: 'x' }).run();
    expect(() =>
      db.insert(users).values({ id: 'u2', email: 'same@b.c', passwordHash: 'y' }).run(),
    ).toThrow();
  });
});
