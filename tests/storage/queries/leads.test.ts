import { describe, it, expect } from 'vitest';
import { createTestDb } from '../helpers.js';
import { createUser } from '../../../src/storage/queries/users.js';
import { createAutomation } from '../../../src/storage/queries/automations.js';
import { recordLead, listLeads, leadData } from '../../../src/storage/queries/leads.js';

async function seed() {
  const db = await createTestDb();
  const a = await createUser(db, { email: 'a@x.c', passwordHash: 'h' });
  const b = await createUser(db, { email: 'b@x.c', passwordHash: 'h' });
  const automationId = await createAutomation(db, a, {
    name: 'x', triggerType: 'exact', triggerValue: 'x', steps: [{ say: 'привет' }],
  });
  await recordLead(db, a, {
    automationId, platform: 'instagram', externalUserId: 'ig-user-1',
    data: new Map([['phone', '+7 999 111 22 33']]),
  });
  return { db, a, b, automationId };
}

describe('заявки', () => {
  it('сохраняет и отдаёт собранные ответы', async () => {
    const { db, a } = await seed();
    const [row] = await listLeads(db, a);
    expect(row).toBeDefined();
    if (row === undefined) return;
    expect(leadData(row).get('phone')).toBe('+7 999 111 22 33');
  });

  it('S11: чужие заявки не видны', async () => {
    const { db, b } = await seed();
    expect(await listLeads(db, b)).toEqual([]);
  });

  it('S6: ключ __proto__ из данных не портит прототип', async () => {
    const { db, a, automationId } = await seed();
    await recordLead(db, a, {
      automationId, platform: 'instagram', externalUserId: 'ig-2',
      data: new Map([['__proto__', 'сломай меня']]),
    });
    const target = (await listLeads(db, a)).find((r) => r.externalUserId === 'ig-2');
    expect(target).toBeDefined();
    if (target === undefined) return;
    expect(leadData(target).get('__proto__')).toBe('сломай меня');
    expect(Object.keys({}).length).toBe(0);
  });

  it('свежие заявки идут первыми', async () => {
    const { db, a, automationId } = await seed();
    await recordLead(db, a, {
      automationId, platform: 'instagram', externalUserId: 'ig-late',
      data: new Map([['phone', '+7 000']]),
      createdAt: new Date('2030-01-01T00:00:00Z'),
    });
    expect((await listLeads(db, a))[0]?.externalUserId).toBe('ig-late');
  });

  it('limit ограничивает выдачу', async () => {
    const { db, a } = await seed();
    expect(await listLeads(db, a, 0)).toEqual([]);
  });
});
