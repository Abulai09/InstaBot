import { describe, it, expect } from 'vitest';
import { createTestDb } from '../helpers.js';
import { createUser } from '../../../src/storage/queries/users.js';
import { createAutomation } from '../../../src/storage/queries/automations.js';
import { recordLead, listLeads, leadData } from '../../../src/storage/queries/leads.js';

function seed() {
  const db = createTestDb();
  const a = createUser(db, { email: 'a@x.c', passwordHash: 'h' });
  const b = createUser(db, { email: 'b@x.c', passwordHash: 'h' });
  const automationId = createAutomation(db, a, {
    name: 'x', triggerType: 'exact', triggerValue: 'x', steps: [{ say: 'привет' }],
  });
  recordLead(db, a, {
    automationId, platform: 'instagram', externalUserId: 'ig-user-1',
    data: new Map([['phone', '+7 999 111 22 33']]),
  });
  return { db, a, b, automationId };
}

describe('заявки', () => {
  it('сохраняет и отдаёт собранные ответы', () => {
    const { db, a } = seed();
    const [row] = listLeads(db, a);
    expect(row).toBeDefined();
    if (row === undefined) return;
    expect(leadData(row).get('phone')).toBe('+7 999 111 22 33');
  });

  it('S11: чужие заявки не видны', () => {
    const { db, b } = seed();
    expect(listLeads(db, b)).toEqual([]);
  });

  it('S6: ключ __proto__ из данных не портит прототип', () => {
    const { db, a, automationId } = seed();
    recordLead(db, a, {
      automationId, platform: 'instagram', externalUserId: 'ig-2',
      data: new Map([['__proto__', 'сломай меня']]),
    });
    const target = listLeads(db, a).find((r) => r.externalUserId === 'ig-2');
    expect(target).toBeDefined();
    if (target === undefined) return;
    expect(leadData(target).get('__proto__')).toBe('сломай меня');
    expect(Object.keys({}).length).toBe(0);
  });

  it('свежие заявки идут первыми', () => {
    const { db, a, automationId } = seed();
    recordLead(db, a, {
      automationId, platform: 'instagram', externalUserId: 'ig-late',
      data: new Map([['phone', '+7 000']]),
      createdAt: new Date('2030-01-01T00:00:00Z'),
    });
    expect(listLeads(db, a)[0]?.externalUserId).toBe('ig-late');
  });

  it('limit ограничивает выдачу', () => {
    const { db, a } = seed();
    expect(listLeads(db, a, 0)).toEqual([]);
  });
});
