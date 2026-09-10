import { describe, it, expect } from 'vitest';
import { eq } from 'drizzle-orm';
import { createTestDb } from './helpers.js';
import { users, automations, processedEvents, invites } from '../../src/storage/schema.js';
import { createUser } from '../../src/storage/queries/users.js';

describe('схема БД', () => {
  it('хранит клиента и его воронку', async () => {
    const db = await createTestDb();
    await db.insert(users).values({ id: 'u1', email: 'a@b.c', passwordHash: 'x', role: 'client' });
    await db.insert(automations).values({
      id: 'a1', userId: 'u1', name: 'Прайс', triggerType: 'contains', triggerValue: 'цена',
    });

    const rows = await db.select().from(automations).where(eq(automations.userId, 'u1'));
    expect(rows).toHaveLength(1);
    expect(rows[0]?.enabled).toBe(true);
  });

  it('не даёт создать воронку несуществующему клиенту', async () => {
    const db = await createTestDb();
    await expect(
      db.insert(automations).values({
        id: 'a1', userId: 'ghost', name: 'x', triggerType: 'exact', triggerValue: 'y',
      }),
    ).rejects.toThrow();
  });

  it('дедупликация: один dedupeKey нельзя записать дважды', async () => {
    const db = await createTestDb();
    await db.insert(users).values({ id: 'u1', email: 'a@b.c', passwordHash: 'x', role: 'client' });
    const row = { id: 'p1', userId: 'u1', dedupeKey: 'k1' };
    await db.insert(processedEvents).values(row);
    await expect(db.insert(processedEvents).values({ ...row, id: 'p2' })).rejects.toThrow();
  });

  it('два клиента не могут занять один email', async () => {
    const db = await createTestDb();
    await db.insert(users).values({ id: 'u1', email: 'same@b.c', passwordHash: 'x' });
    await expect(
      db.insert(users).values({ id: 'u2', email: 'same@b.c', passwordHash: 'y' }),
    ).rejects.toThrow();
  });
});

describe('схема фазы F', () => {
  it('приглашение хранится с хэшем токена и сроком жизни', async () => {
    const db = await createTestDb();
    const userId = await createUser(db, { email: 'k@k.k', passwordHash: 'x' });
    const expiresAt = new Date('2026-09-10T00:00:00Z');

    await db.insert(invites).values({ id: 'хэш-токена', userId, expiresAt });
    const row = (await db.select().from(invites))[0];

    expect(row?.usedAt).toBeNull();
    expect(row?.expiresAt).toEqual(expiresAt);
  });

  it('клиент по умолчанию не отключён', async () => {
    const db = await createTestDb();
    await createUser(db, { email: 'k@k.k', passwordHash: 'x' });
    expect((await db.select().from(users))[0]?.disabledAt).toBeNull();
  });
});
