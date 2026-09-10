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
  it('отключение обратимо', async () => {
    const db = await createTestDb();
    const id = await createUser(db, { email: 'k@k.k', passwordHash: 'x' });

    await setUserDisabled(db, id, now);
    expect((await findUserById(db, id))?.disabledAt).toEqual(now);

    await setUserDisabled(db, id, null);
    expect((await findUserById(db, id))?.disabledAt).toBeNull();
  });

  it('смена пароля не трогает остальные поля', async () => {
    const db = await createTestDb();
    const id = await createUser(db, { email: 'k@k.k', passwordHash: 'старый' });

    await setUserPassword(db, id, 'новый');

    const row = await findUserById(db, id);
    expect(row?.passwordHash).toBe('новый');
    expect(row?.email).toBe('k@k.k');
    expect(row?.role).toBe('client');
  });

  it('список клиентов не показывает владельцев сервиса', async () => {
    const db = await createTestDb();
    await createUser(db, { email: 'vladelec@k.k', passwordHash: 'x', role: 'owner' });
    await createUser(db, { email: 'klient@k.k', passwordHash: 'x' });

    expect((await listClients(db)).map((c) => c.email)).toEqual(['klient@k.k']);
  });

  it('число воронок не размножается подключённым аккаунтом', async () => {
    const db = await createTestDb();
    const id = await createUser(db, { email: 'k@k.k', passwordHash: 'x' });
    await connectAccount(db, id, { platform: 'instagram', externalAccountId: '1', token: 't' }, KEY);
    for (const name of ['первая', 'вторая', 'третья']) {
      await createAutomation(db, id, {
        name, triggerType: 'exact', triggerValue: name, steps: [{ say: 'привет' }],
      });
    }

    const row = (await listClients(db))[0];
    expect(row?.automationCount).toBe(3);
    expect(row?.connected).toBe(true);
  });

  it('клиент без аккаунта и воронок показывается нулями, а не пропадает', async () => {
    const db = await createTestDb();
    await createUser(db, { email: 'novyy@k.k', passwordHash: 'x' });

    const row = (await listClients(db))[0];
    expect(row?.connected).toBe(false);
    expect(row?.automationCount).toBe(0);
  });
});
