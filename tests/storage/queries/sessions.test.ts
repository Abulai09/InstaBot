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

function seed() {
  const db = createTestDb();
  const a = createUser(db, { email: 'a@a.a', passwordHash: 'x' });
  const b = createUser(db, { email: 'b@b.b', passwordHash: 'x' });
  return { db, a, b };
}

describe('сессии', () => {
  it('созданная сессия находится по своему токену', () => {
    const { db, a } = seed();
    const token = createSession(db, a, NOW, 7 * DAY);
    expect(loadSession(db, token, NOW)?.userId).toBe(a);
  });

  it('S15: в базе лежит не токен, а его хэш', () => {
    const { db, a } = seed();
    const token = createSession(db, a, NOW, 7 * DAY);

    const rows = db.select().from(sessions).all();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.id).not.toBe(token);
    expect(db.select().from(sessions).where(eq(sessions.id, token)).all()).toHaveLength(0);
  });

  it('два входа дают разные токены', () => {
    const { db, a } = seed();
    expect(createSession(db, a, NOW, 7 * DAY)).not.toBe(createSession(db, a, NOW, 7 * DAY));
  });

  it('истёкшая сессия не находится', () => {
    const { db, a } = seed();
    const token = createSession(db, a, NOW, 7 * DAY);
    expect(loadSession(db, token, new Date(NOW.getTime() + 8 * DAY))).toBeUndefined();
  });

  it('продление отодвигает срок от текущего момента', () => {
    const { db, a } = seed();
    const token = createSession(db, a, NOW, 7 * DAY);
    const later = new Date(NOW.getTime() + 6 * DAY);

    touchSession(db, token, later, 7 * DAY);

    // Без продления сессия умерла бы на 7-й день, с продлением жива на 12-й
    expect(loadSession(db, token, new Date(NOW.getTime() + 12 * DAY))?.userId).toBe(a);
  });

  it('выход удаляет именно эту сессию', () => {
    const { db, a } = seed();
    const first = createSession(db, a, NOW, 7 * DAY);
    const second = createSession(db, a, NOW, 7 * DAY);

    deleteSession(db, first);

    expect(loadSession(db, first, NOW)).toBeUndefined();
    expect(loadSession(db, second, NOW)?.userId).toBe(a);
  });

  it('S15: смена пароля убивает все сессии пользователя', () => {
    const { db, a } = seed();
    const first = createSession(db, a, NOW, 7 * DAY);
    const second = createSession(db, a, NOW, 7 * DAY);

    deleteUserSessions(db, a);

    expect(loadSession(db, first, NOW)).toBeUndefined();
    expect(loadSession(db, second, NOW)).toBeUndefined();
  });

  it('S15: чужие сессии при этом живы', () => {
    const { db, a, b } = seed();
    const mine = createSession(db, a, NOW, 7 * DAY);
    const theirs = createSession(db, b, NOW, 7 * DAY);

    deleteUserSessions(db, a);

    expect(loadSession(db, mine, NOW)).toBeUndefined();
    expect(loadSession(db, theirs, NOW)?.userId).toBe(b);
  });

  it('мусор вместо токена не находит ничего и не падает', () => {
    const { db } = seed();
    expect(loadSession(db, '', NOW)).toBeUndefined();
    expect(loadSession(db, '../../etc/passwd', NOW)).toBeUndefined();
  });
});
