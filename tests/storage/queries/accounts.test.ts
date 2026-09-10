import { describe, it, expect } from 'vitest';
import { createTestDb } from '../helpers.js';
import { createUser, findUserByEmail, setUserDisabled } from '../../../src/storage/queries/users.js';
import {
  connectAccount, listAccounts, getAccountToken, resolveAccountOwner,
  getAccountTokenForPlatform, connectOrUpdateAccount,
} from '../../../src/storage/queries/accounts.js';

const key = 'a'.repeat(64);

async function twoClients() {
  const db = await createTestDb();
  const a = await createUser(db, { email: 'a@x.c', passwordHash: 'h' });
  const b = await createUser(db, { email: 'b@x.c', passwordHash: 'h' });
  return { db, a, b };
}

describe('клиенты', () => {
  it('находит клиента по email', async () => {
    const { db, a } = await twoClients();
    expect((await findUserByEmail(db, 'a@x.c'))?.id).toBe(a);
  });

  it('по умолчанию роль — client, не owner', async () => {
    const { db } = await twoClients();
    expect((await findUserByEmail(db, 'a@x.c'))?.role).toBe('client');
  });

  it('неизвестный email не находится', async () => {
    const { db } = await twoClients();
    expect(await findUserByEmail(db, 'ghost@x.c')).toBeUndefined();
  });
});

describe('подключённые аккаунты', () => {
  it('сохраняет токен и отдаёт его обратно', async () => {
    const { db, a } = await twoClients();
    const id = await connectAccount(db, a, { platform: 'instagram', externalAccountId: 'ig1', token: 'EAAG-1' }, key);
    expect(await getAccountToken(db, a, id, key)).toBe('EAAG-1');
  });

  it('S4: токен не хранится открытым текстом', async () => {
    const { db, a } = await twoClients();
    await connectAccount(db, a, { platform: 'instagram', externalAccountId: 'ig1', token: 'EAAG-1' }, key);
    const [row] = await listAccounts(db, a);
    expect(row?.tokenEncrypted).not.toContain('EAAG-1');
  });

  it('S11: клиент не видит чужие аккаунты в списке', async () => {
    const { db, a, b } = await twoClients();
    await connectAccount(db, a, { platform: 'instagram', externalAccountId: 'ig1', token: 't' }, key);
    expect(await listAccounts(db, b)).toEqual([]);
  });

  it('S11: клиент не достаёт чужой токен по id', async () => {
    const { db, a, b } = await twoClients();
    const id = await connectAccount(db, a, { platform: 'instagram', externalAccountId: 'ig1', token: 't' }, key);
    expect(await getAccountToken(db, b, id, key)).toBeUndefined();
  });

  it('S17: находит владельца по внешнему id аккаунта', async () => {
    const { db, a } = await twoClients();
    const id = await connectAccount(db, a, { platform: 'instagram', externalAccountId: 'ig1', token: 't' }, key);
    expect(await resolveAccountOwner(db, 'instagram', 'ig1')).toEqual({ userId: a, accountId: id });
  });

  it('S17: неизвестный аккаунт не имеет владельца', async () => {
    const { db } = await twoClients();
    expect(await resolveAccountOwner(db, 'instagram', 'ghost')).toBeUndefined();
  });

  it('S17: тот же внешний id на другой платформе — другой аккаунт', async () => {
    const { db, a } = await twoClients();
    await connectAccount(db, a, { platform: 'instagram', externalAccountId: 'same', token: 't' }, key);
    expect(await resolveAccountOwner(db, 'tiktok', 'same')).toBeUndefined();
  });

  it('S17: вебхук отключённого клиента не находит владельца', async () => {
    const db = await createTestDb();
    const userId = await createUser(db, { email: 'k@k.k', passwordHash: 'x' });
    await connectAccount(db, userId, {
      platform: 'instagram', externalAccountId: '17841400000000000', token: 't',
    }, key);

    expect(await resolveAccountOwner(db, 'instagram', '17841400000000000')).toBeDefined();

    await setUserDisabled(db, userId, new Date('2026-09-09T12:00:00Z'));

    expect(await resolveAccountOwner(db, 'instagram', '17841400000000000')).toBeUndefined();
  });
});

describe('токен аккаунта по платформе', () => {
  it('S11: достаётся только своему владельцу', async () => {
    const { db, a, b } = await twoClients();
    await connectAccount(db, a, { platform: 'instagram', externalAccountId: '178414001', token: 'секрет-A' }, key);

    expect((await getAccountTokenForPlatform(db, a, 'instagram', key))?.token).toBe('секрет-A');
    expect(await getAccountTokenForPlatform(db, b, 'instagram', key)).toBeUndefined();
  });

  it('возвращает и id аккаунта: он понадобится при отправке файлов', async () => {
    const { db, a } = await twoClients();
    const accountId = await connectAccount(db, a, { platform: 'instagram', externalAccountId: '178414002', token: 't' }, key);

    expect((await getAccountTokenForPlatform(db, a, 'instagram', key))?.accountId).toBe(accountId);
  });

  it('чужая платформа не подходит: у клиента только instagram', async () => {
    const { db, a } = await twoClients();
    await connectAccount(db, a, { platform: 'instagram', externalAccountId: '178414003', token: 't' }, key);

    expect(await getAccountTokenForPlatform(db, a, 'tiktok', key)).toBeUndefined();
  });
});

describe('подключение аккаунта из админки', () => {
  it('свободный внешний id создаёт запись', async () => {
    const db = await createTestDb();
    const userId = await createUser(db, { email: 'a@a.a', passwordHash: 'x' });

    const outcome = await connectOrUpdateAccount(db, userId, {
      platform: 'instagram', externalAccountId: '111', token: 'токен-1',
    }, key);

    expect(outcome).toBe('created');
    expect((await getAccountTokenForPlatform(db, userId, 'instagram', key))?.token).toBe('токен-1');
  });

  it('свой аккаунт перезаписывает токен, а не плодит вторую строку', async () => {
    const db = await createTestDb();
    const userId = await createUser(db, { email: 'a@a.a', passwordHash: 'x' });
    await connectOrUpdateAccount(db, userId, {
      platform: 'instagram', externalAccountId: '111', token: 'старый',
    }, key);

    const outcome = await connectOrUpdateAccount(db, userId, {
      platform: 'instagram', externalAccountId: '111', token: 'новый',
    }, key);

    expect(outcome).toBe('updated');
    expect((await getAccountTokenForPlatform(db, userId, 'instagram', key))?.token).toBe('новый');
    expect(await listAccounts(db, userId)).toHaveLength(1);
  });

  it('S17: чужой внешний id отвергается и токен владельца не меняется', async () => {
    const db = await createTestDb();
    const a = await createUser(db, { email: 'a@a.a', passwordHash: 'x' });
    const b = await createUser(db, { email: 'b@b.b', passwordHash: 'x' });
    await connectOrUpdateAccount(db, a, {
      platform: 'instagram', externalAccountId: '111', token: 'токен-А',
    }, key);

    const outcome = await connectOrUpdateAccount(db, b, {
      platform: 'instagram', externalAccountId: '111', token: 'токен-Б',
    }, key);

    expect(outcome).toBe('taken');
    expect((await getAccountTokenForPlatform(db, a, 'instagram', key))?.token).toBe('токен-А');
    expect(await listAccounts(db, b)).toHaveLength(0);
    expect(await resolveAccountOwner(db, 'instagram', '111')).toMatchObject({ userId: a });
  });
});
