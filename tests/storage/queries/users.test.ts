import { describe, expect, it } from 'vitest';
import { createTestDb } from '../helpers.js';
import {
  createUser, findUserById, listClients, setUserDisabled, setUserPassword,
} from '../../../src/storage/queries/users.js';
import { createAutomation } from '../../../src/storage/queries/automations.js';
import { connectAccount } from '../../../src/storage/queries/accounts.js';

const KEY = 'a'.repeat(64);
const now = new Date('2026-09-09T12:00:00Z');

describe('пользователи', () => {
  it('отключение обратимо', () => {
    const db = createTestDb();
    const id = createUser(db, { email: 'k@k.k', passwordHash: 'x' });

    setUserDisabled(db, id, now);
    expect(findUserById(db, id)?.disabledAt).toEqual(now);

    setUserDisabled(db, id, null);
    expect(findUserById(db, id)?.disabledAt).toBeNull();
  });

  it('смена пароля не трогает остальные поля', () => {
    const db = createTestDb();
    const id = createUser(db, { email: 'k@k.k', passwordHash: 'старый' });

    setUserPassword(db, id, 'новый');

    const row = findUserById(db, id);
    expect(row?.passwordHash).toBe('новый');
    expect(row?.email).toBe('k@k.k');
    expect(row?.role).toBe('client');
  });

  it('список клиентов не показывает владельцев сервиса', () => {
    const db = createTestDb();
    createUser(db, { email: 'vladelec@k.k', passwordHash: 'x', role: 'owner' });
    createUser(db, { email: 'klient@k.k', passwordHash: 'x' });

    expect(listClients(db).map((c) => c.email)).toEqual(['klient@k.k']);
  });

  it('число воронок не размножается подключённым аккаунтом', () => {
    const db = createTestDb();
    const id = createUser(db, { email: 'k@k.k', passwordHash: 'x' });
    connectAccount(db, id, { platform: 'instagram', externalAccountId: '1', token: 't' }, KEY);
    for (const name of ['первая', 'вторая', 'третья']) {
      createAutomation(db, id, {
        name, triggerType: 'exact', triggerValue: name, steps: [{ say: 'привет' }],
      });
    }

    const row = listClients(db)[0];
    expect(row?.automationCount).toBe(3);
    expect(row?.connected).toBe(true);
  });

  it('клиент без аккаунта и воронок показывается нулями, а не пропадает', () => {
    const db = createTestDb();
    createUser(db, { email: 'novyy@k.k', passwordHash: 'x' });

    const row = listClients(db)[0];
    expect(row?.connected).toBe(false);
    expect(row?.automationCount).toBe(0);
  });
});
