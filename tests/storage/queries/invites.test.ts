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

async function seedClient(email = 'k@k.k') {
  const db = await createTestDb();
  return { db, userId: await createUser(db, { email, passwordHash: 'x' }) };
}

describe('приглашения', () => {
  it('токен не хранится в базе — только его хэш', async () => {
    const { db, userId } = await seedClient();
    const token = await createInvite(db, userId, now, 48 * HOUR);

    const stored = (await db.select().from(invites))[0];
    expect(stored?.id).not.toBe(token);
    expect(token.length).toBeGreaterThanOrEqual(32);
  });

  it('действующее приглашение гасится и отдаёт владельца', async () => {
    const { db, userId } = await seedClient();
    const token = await createInvite(db, userId, now, 48 * HOUR);

    expect(await consumeInvite(db, token, later)).toEqual({ userId });
  });

  it('погашенное приглашение второй раз не срабатывает', async () => {
    const { db, userId } = await seedClient();
    const token = await createInvite(db, userId, now, 48 * HOUR);

    await consumeInvite(db, token, later);
    expect(await consumeInvite(db, token, later)).toBeUndefined();
  });

  it('протухшее приглашение не срабатывает', async () => {
    const { db, userId } = await seedClient();
    const token = await createInvite(db, userId, now, HOUR);

    expect(await consumeInvite(db, token, new Date('2026-09-09T14:00:00Z'))).toBeUndefined();
  });

  it('несуществующий токен не роняет запрос', async () => {
    const { db } = await seedClient();
    expect(await consumeInvite(db, 'выдуманный-токен', now)).toBeUndefined();
  });

  it('перевыпуск гасит прежние ссылки того же клиента', async () => {
    const { db, userId } = await seedClient();
    const old = await createInvite(db, userId, now, 48 * HOUR);

    await revokeUserInvites(db, userId, later);
    const fresh = await createInvite(db, userId, later, 48 * HOUR);

    expect(await consumeInvite(db, old, later)).toBeUndefined();
    expect(await consumeInvite(db, fresh, later)).toEqual({ userId });
  });

  it('S11: отзыв не трогает приглашения другого клиента', async () => {
    const { db, userId: a } = await seedClient('a@a.a');
    const b = await createUser(db, { email: 'b@b.b', passwordHash: 'x' });
    const tokenB = await createInvite(db, b, now, 48 * HOUR);

    await revokeUserInvites(db, a, later);

    expect(await consumeInvite(db, tokenB, later)).toEqual({ userId: b });
  });

  // Ruling 2: peekInvite есть в коде брифа (шаг 3), но не покрыта тестами брифа.
  // Экспорт без теста — дефект, поэтому добавляем три своих теста ниже.

  it('действующее приглашение: peekInvite отдаёт true', async () => {
    const { db, userId } = await seedClient();
    const token = await createInvite(db, userId, now, 48 * HOUR);

    expect(await peekInvite(db, token, later)).toBe(true);
  });

  it('погашенное приглашение: peekInvite отдаёт false', async () => {
    const { db, userId } = await seedClient();
    const token = await createInvite(db, userId, now, 48 * HOUR);

    await consumeInvite(db, token, later);
    expect(await peekInvite(db, token, later)).toBe(false);
  });

  it('peekInvite не гасит приглашение — consumeInvite после неё всё ещё срабатывает', async () => {
    const { db, userId } = await seedClient();
    const token = await createInvite(db, userId, now, 48 * HOUR);

    await peekInvite(db, token, later);
    await peekInvite(db, token, later);

    expect(await consumeInvite(db, token, later)).toEqual({ userId });
  });
});
