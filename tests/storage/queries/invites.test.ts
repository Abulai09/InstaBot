import { describe, expect, it } from 'vitest';
import { createTestDb } from '../helpers.js';
import { createUser } from '../../../src/storage/queries/users.js';
import {
  consumeInvite, createInvite, peekInvite, revokeUserInvites,
} from '../../../src/storage/queries/invites.js';
import { invites } from '../../../src/storage/schema.js';

const HOUR = 3_600_000;
const now = new Date('2026-09-09T12:00:00Z');
const later = new Date('2026-09-09T13:00:00Z');

function seedClient(email = 'k@k.k') {
  const db = createTestDb();
  return { db, userId: createUser(db, { email, passwordHash: 'x' }) };
}

describe('приглашения', () => {
  it('токен не хранится в базе — только его хэш', () => {
    const { db, userId } = seedClient();
    const token = createInvite(db, userId, now, 48 * HOUR);

    const stored = db.select().from(invites).all()[0];
    expect(stored?.id).not.toBe(token);
    expect(token.length).toBeGreaterThanOrEqual(32);
  });

  it('действующее приглашение гасится и отдаёт владельца', () => {
    const { db, userId } = seedClient();
    const token = createInvite(db, userId, now, 48 * HOUR);

    expect(consumeInvite(db, token, later)).toEqual({ userId });
  });

  it('погашенное приглашение второй раз не срабатывает', () => {
    const { db, userId } = seedClient();
    const token = createInvite(db, userId, now, 48 * HOUR);

    consumeInvite(db, token, later);
    expect(consumeInvite(db, token, later)).toBeUndefined();
  });

  it('протухшее приглашение не срабатывает', () => {
    const { db, userId } = seedClient();
    const token = createInvite(db, userId, now, HOUR);

    expect(consumeInvite(db, token, new Date('2026-09-09T14:00:00Z'))).toBeUndefined();
  });

  it('несуществующий токен не роняет запрос', () => {
    const { db } = seedClient();
    expect(consumeInvite(db, 'выдуманный-токен', now)).toBeUndefined();
  });

  it('перевыпуск гасит прежние ссылки того же клиента', () => {
    const { db, userId } = seedClient();
    const old = createInvite(db, userId, now, 48 * HOUR);

    revokeUserInvites(db, userId, later);
    const fresh = createInvite(db, userId, later, 48 * HOUR);

    expect(consumeInvite(db, old, later)).toBeUndefined();
    expect(consumeInvite(db, fresh, later)).toEqual({ userId });
  });

  it('S11: отзыв не трогает приглашения другого клиента', () => {
    const { db, userId: a } = seedClient('a@a.a');
    const b = createUser(db, { email: 'b@b.b', passwordHash: 'x' });
    const tokenB = createInvite(db, b, now, 48 * HOUR);

    revokeUserInvites(db, a, later);

    expect(consumeInvite(db, tokenB, later)).toEqual({ userId: b });
  });

  // Ruling 2: peekInvite есть в коде брифа (шаг 3), но не покрыта тестами брифа.
  // Экспорт без теста — дефект, поэтому добавляем три своих теста ниже.

  it('действующее приглашение: peekInvite отдаёт true', () => {
    const { db, userId } = seedClient();
    const token = createInvite(db, userId, now, 48 * HOUR);

    expect(peekInvite(db, token, later)).toBe(true);
  });

  it('погашенное приглашение: peekInvite отдаёт false', () => {
    const { db, userId } = seedClient();
    const token = createInvite(db, userId, now, 48 * HOUR);

    consumeInvite(db, token, later);
    expect(peekInvite(db, token, later)).toBe(false);
  });

  it('peekInvite не гасит приглашение — consumeInvite после неё всё ещё срабатывает', () => {
    const { db, userId } = seedClient();
    const token = createInvite(db, userId, now, 48 * HOUR);

    peekInvite(db, token, later);
    peekInvite(db, token, later);

    expect(consumeInvite(db, token, later)).toEqual({ userId });
  });
});
