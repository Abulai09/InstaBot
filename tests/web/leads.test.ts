import Fastify, { type FastifyInstance } from 'fastify';
import { describe, expect, it } from 'vitest';
import { createTestDb } from '../storage/helpers.js';
import { createUser } from '../../src/storage/queries/users.js';
import { createAutomation } from '../../src/storage/queries/automations.js';
import { recordLead } from '../../src/storage/queries/leads.js';
import { createSession } from '../../src/storage/queries/sessions.js';
import { loadConfig } from '../../src/config.js';
import { ReplyThrottle } from '../../src/core/throttle.js';
import { registerLeadsRoutes } from '../../src/web/routes/leads.js';
import type { AppDb } from '../../src/storage/db.js';

const NOW = new Date('2026-09-01T12:00:00Z');
const DAY = 86_400_000;

function config() {
  return loadConfig({
    DATABASE_URL: 'postgresql://u:p@localhost:5432/test',
    META_APP_SECRET: 's', META_VERIFY_TOKEN: 'v',
    CREDENTIALS_ENC_KEY: 'a'.repeat(64), SESSION_SECRET: 'a'.repeat(32),
    PUBLIC_BASE_URL: 'https://bot.example.com',
  } as unknown as NodeJS.ProcessEnv);
}

function build(db: AppDb): FastifyInstance {
  const app = Fastify();
  registerLeadsRoutes(app, { db, cfg: config(), throttle: new ReplyThrottle(5) });
  return app;
}

async function cookieFor(db: AppDb, userId: string) {
  // Сессия выдаётся от текущего момента: маршрут проверяет срок по реальному
  // времени (`new Date()` внутри `currentSession`), и фиксированная дата
  // протухает через неделю после написания теста
  return `sid=${await createSession(db, userId, new Date(), 7 * DAY)}`;
}

async function seed() {
  const db = await createTestDb();
  const a = await createUser(db, { email: 'a@a.a', passwordHash: 'x' });
  const b = await createUser(db, { email: 'b@b.b', passwordHash: 'x' });

  for (const [userId, name, phone] of [[a, 'Абылай', '+7 700 000 00 01'], [b, 'Борис', '+7 700 000 00 02']] as const) {
    const automationId = await createAutomation(db, userId, {
      name: 'Заявка', triggerType: 'contains', triggerValue: 'запись', steps: [{ say: 'Как вас зовут?' }],
    });
    await recordLead(db, userId, {
      automationId, platform: 'instagram', externalUserId: '99',
      data: new Map([['name', name], ['phone', phone]]), createdAt: NOW,
    });
  }
  return { db, a, b };
}

describe('заявки', () => {
  it('без сессии уводит на форму входа', async () => {
    const { db } = await seed();
    expect((await build(db).inject({ method: 'GET', url: '/leads' })).statusCode).toBe(303);
  });

  it('S11: клиент видит свои заявки и не видит чужие', async () => {
    const { db, a } = await seed();
    const res = await build(db).inject({
      method: 'GET', url: '/leads', headers: { cookie: await cookieFor(db, a) },
    });

    expect(res.body).toContain('Абылай');
    expect(res.body).not.toContain('Борис');
  });

  it('ПД не оседают в кэше браузера', async () => {
    const { db, a } = await seed();
    const res = await build(db).inject({
      method: 'GET', url: '/leads', headers: { cookie: await cookieFor(db, a) },
    });

    expect(res.headers['cache-control']).toBe('no-store');
  });

  it('S11: выгрузка содержит только свои заявки', async () => {
    const { db, a } = await seed();
    const res = await build(db).inject({
      method: 'GET', url: '/leads.csv', headers: { cookie: await cookieFor(db, a) },
    });

    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('Абылай');
    expect(res.body).not.toContain('Борис');
  });

  it('выгрузка отдаётся файлом, а не открывается в браузере', async () => {
    const { db, a } = await seed();
    const res = await build(db).inject({
      method: 'GET', url: '/leads.csv', headers: { cookie: await cookieFor(db, a) },
    });

    expect(String(res.headers['content-type'])).toContain('text/csv');
    expect(String(res.headers['content-disposition'])).toContain('attachment');
    expect(res.headers['x-content-type-options']).toBe('nosniff');
  });

  it('CSV-инъекция: ответ с формулой обезврежен в выгрузке', async () => {
    const db = await createTestDb();
    const userId = await createUser(db, { email: 'x@x.x', passwordHash: 'x' });
    const automationId = await createAutomation(db, userId, {
      name: 'З', triggerType: 'contains', triggerValue: 'з', steps: [{ say: 'Как вас зовут?' }],
    });
    await recordLead(db, userId, {
      automationId, platform: 'instagram', externalUserId: '99',
      data: new Map([['name', '=HYPERLINK("http://зло","клик")']]), createdAt: NOW,
    });

    const res = await build(db).inject({
      method: 'GET', url: '/leads.csv', headers: { cookie: await cookieFor(db, userId) },
    });

    expect(res.body).toContain(`"'=HYPERLINK`);
    expect(res.body).not.toContain('"=HYPERLINK');
  });

  it('S21: ответ со скриптом на странице выводится текстом', async () => {
    const db = await createTestDb();
    const userId = await createUser(db, { email: 'y@y.y', passwordHash: 'x' });
    const automationId = await createAutomation(db, userId, {
      name: 'З', triggerType: 'contains', triggerValue: 'з', steps: [{ say: 'Как вас зовут?' }],
    });
    await recordLead(db, userId, {
      automationId, platform: 'instagram', externalUserId: '99',
      data: new Map([['name', '<script>alert(1)</script>']]), createdAt: NOW,
    });

    const res = await build(db).inject({
      method: 'GET', url: '/leads', headers: { cookie: await cookieFor(db, userId) },
    });

    expect(res.body).not.toContain('<script>alert(1)</script>');
  });
});
