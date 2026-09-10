import { describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { createTestDb } from '../helpers.js';
import { createUser } from '../../../src/storage/queries/users.js';
import { sessions } from '../../../src/storage/schema.js';
import {
  createSession, deleteSession, deleteUserSessions, loadSession, touchSession,
} from '../../../src/storage/queries/sessions.js';

const DAY = 86_400_000;
const NOW = new Date('2026-09-01T12:00:00Z');

async function seed() {
  const db = await createTestDb();
  const a = await createUser(db, { email: 'a@a.a', passwordHash: 'x' });
  const b = await createUser(db, { email: 'b@b.b', passwordHash: 'x' });
  return { db, a, b };
}

describe('сессии', () => {
  it('созданная сессия находится по своему токену', async () => {
    const { db, a } = await seed();
    const token = await createSession(db, a, NOW, 7 * DAY);
    expect((await loadSession(db, token, NOW))?.userId).toBe(a);
  });

  it('S15: в базе лежит не токен, а его хэш', async () => {
    const { db, a } = await seed();
    const token = await createSession(db, a, NOW, 7 * DAY);

    const rows = await db.select().from(sessions);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.id).not.toBe(token);
    expect(await db.select().from(sessions).where(eq(sessions.id, token))).toHaveLength(0);
  });

  it('два входа дают разные токены', async () => {
    const { db, a } = await seed();
    expect(await createSession(db, a, NOW, 7 * DAY)).not.toBe(await createSession(db, a, NOW, 7 * DAY));
  });

  it('истёкшая сессия не находится', async () => {
    const { db, a } = await seed();
    const token = await createSession(db, a, NOW, 7 * DAY);
    expect(await loadSession(db, token, new Date(NOW.getTime() + 8 * DAY))).toBeUndefined();
  });

  it('продление отодвигает срок от текущего момента', async () => {
    const { db, a } = await seed();
    const token = await createSession(db, a, NOW, 7 * DAY);
    const later = new Date(NOW.getTime() + 6 * DAY);

    await touchSession(db, token, later, 7 * DAY);

    // Без продления сессия умерла бы на 7-й день, с продлением жива на 12-й
    expect((await loadSession(db, token, new Date(NOW.getTime() + 12 * DAY)))?.userId).toBe(a);
  });

  it('выход удаляет именно эту сессию', async () => {
    const { db, a } = await seed();
    const first = await createSession(db, a, NOW, 7 * DAY);
    const second = await createSession(db, a, NOW, 7 * DAY);

    await deleteSession(db, first);

    expect(await loadSession(db, first, NOW)).toBeUndefined();
    expect((await loadSession(db, second, NOW))?.userId).toBe(a);
  });

  it('S15: смена пароля убивает все сессии пользователя', async () => {
    const { db, a } = await seed();
    const first = await createSession(db, a, NOW, 7 * DAY);
    const second = await createSession(db, a, NOW, 7 * DAY);

    await deleteUserSessions(db, a);

    expect(await loadSession(db, first, NOW)).toBeUndefined();
    expect(await loadSession(db, second, NOW)).toBeUndefined();
  });

  it('S15: чужие сессии при этом живы', async () => {
    const { db, a, b } = await seed();
    const mine = await createSession(db, a, NOW, 7 * DAY);
    const theirs = await createSession(db, b, NOW, 7 * DAY);

    await deleteUserSessions(db, a);

    expect(await loadSession(db, mine, NOW)).toBeUndefined();
    expect((await loadSession(db, theirs, NOW))?.userId).toBe(b);
  });

  it('мусор вместо токена не находит ничего и не падает', async () => {
    const { db } = await seed();
    expect(await loadSession(db, '', NOW)).toBeUndefined();
    expect(await loadSession(db, '../../etc/passwd', NOW)).toBeUndefined();
  });
});
