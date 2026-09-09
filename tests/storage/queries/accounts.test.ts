import { describe, it, expect } from 'vitest';
import { createTestDb } from '../helpers.js';
import { createUser, findUserByEmail, setUserDisabled } from '../../../src/storage/queries/users.js';
import {
  connectAccount, listAccounts, getAccountToken, resolveAccountOwner,
  getAccountTokenForPlatform,
} from '../../../src/storage/queries/accounts.js';

const key = 'a'.repeat(64);

function twoClients() {
  const db = createTestDb();
  const a = createUser(db, { email: 'a@x.c', passwordHash: 'h' });
  const b = createUser(db, { email: 'b@x.c', passwordHash: 'h' });
  return { db, a, b };
}

describe('клиенты', () => {
  it('находит клиента по email', () => {
    const { db, a } = twoClients();
    expect(findUserByEmail(db, 'a@x.c')?.id).toBe(a);
  });

  it('по умолчанию роль — client, не owner', () => {
    const { db } = twoClients();
    expect(findUserByEmail(db, 'a@x.c')?.role).toBe('client');
  });

  it('неизвестный email не находится', () => {
    const { db } = twoClients();
    expect(findUserByEmail(db, 'ghost@x.c')).toBeUndefined();
  });
});

describe('подключённые аккаунты', () => {
  it('сохраняет токен и отдаёт его обратно', () => {
    const { db, a } = twoClients();
    const id = connectAccount(db, a, { platform: 'instagram', externalAccountId: 'ig1', token: 'EAAG-1' }, key);
    expect(getAccountToken(db, a, id, key)).toBe('EAAG-1');
  });

  it('S4: токен не хранится открытым текстом', () => {
    const { db, a } = twoClients();
    connectAccount(db, a, { platform: 'instagram', externalAccountId: 'ig1', token: 'EAAG-1' }, key);
    const [row] = listAccounts(db, a);
    expect(row?.tokenEncrypted).not.toContain('EAAG-1');
  });

  it('S11: клиент не видит чужие аккаунты в списке', () => {
    const { db, a, b } = twoClients();
    connectAccount(db, a, { platform: 'instagram', externalAccountId: 'ig1', token: 't' }, key);
    expect(listAccounts(db, b)).toEqual([]);
  });

  it('S11: клиент не достаёт чужой токен по id', () => {
    const { db, a, b } = twoClients();
    const id = connectAccount(db, a, { platform: 'instagram', externalAccountId: 'ig1', token: 't' }, key);
    expect(getAccountToken(db, b, id, key)).toBeUndefined();
  });

  it('S17: находит владельца по внешнему id аккаунта', () => {
    const { db, a } = twoClients();
    const id = connectAccount(db, a, { platform: 'instagram', externalAccountId: 'ig1', token: 't' }, key);
    expect(resolveAccountOwner(db, 'instagram', 'ig1')).toEqual({ userId: a, accountId: id });
  });

  it('S17: неизвестный аккаунт не имеет владельца', () => {
    const { db } = twoClients();
    expect(resolveAccountOwner(db, 'instagram', 'ghost')).toBeUndefined();
  });

  it('S17: тот же внешний id на другой платформе — другой аккаунт', () => {
    const { db, a } = twoClients();
    connectAccount(db, a, { platform: 'instagram', externalAccountId: 'same', token: 't' }, key);
    expect(resolveAccountOwner(db, 'tiktok', 'same')).toBeUndefined();
  });

  it('S17: вебхук отключённого клиента не находит владельца', () => {
    const db = createTestDb();
    const userId = createUser(db, { email: 'k@k.k', passwordHash: 'x' });
    connectAccount(db, userId, {
      platform: 'instagram', externalAccountId: '17841400000000000', token: 't',
    }, key);

    expect(resolveAccountOwner(db, 'instagram', '17841400000000000')).toBeDefined();

    setUserDisabled(db, userId, new Date('2026-09-09T12:00:00Z'));

    expect(resolveAccountOwner(db, 'instagram', '17841400000000000')).toBeUndefined();
  });
});

describe('токен аккаунта по платформе', () => {
  it('S11: достаётся только своему владельцу', () => {
    const { db, a, b } = twoClients();
    connectAccount(db, a, { platform: 'instagram', externalAccountId: '178414001', token: 'секрет-A' }, key);

    expect(getAccountTokenForPlatform(db, a, 'instagram', key)?.token).toBe('секрет-A');
    expect(getAccountTokenForPlatform(db, b, 'instagram', key)).toBeUndefined();
  });

  it('возвращает и id аккаунта: он понадобится при отправке файлов', () => {
    const { db, a } = twoClients();
    const accountId = connectAccount(db, a, { platform: 'instagram', externalAccountId: '178414002', token: 't' }, key);

    expect(getAccountTokenForPlatform(db, a, 'instagram', key)?.accountId).toBe(accountId);
  });

  it('чужая платформа не подходит: у клиента только instagram', () => {
    const { db, a } = twoClients();
    connectAccount(db, a, { platform: 'instagram', externalAccountId: '178414003', token: 't' }, key);

    expect(getAccountTokenForPlatform(db, a, 'tiktok', key)).toBeUndefined();
  });
});
