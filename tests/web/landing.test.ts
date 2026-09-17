import Fastify, { type FastifyInstance } from 'fastify';
import { describe, expect, it } from 'vitest';
import { createTestDb } from '../storage/helpers.js';
import { createUser } from '../../src/storage/queries/users.js';
import { createAutomation } from '../../src/storage/queries/automations.js';
import { createSession } from '../../src/storage/queries/sessions.js';
import { loadConfig } from '../../src/config.js';
import { ReplyThrottle } from '../../src/core/throttle.js';
import { registerFormParser } from '../../src/web/http.js';
import { registerDashboardRoutes } from '../../src/web/routes/dashboard.js';
import type { AppDb } from '../../src/storage/db.js';

const SECRET = 'a'.repeat(32);
const DAY = 86_400_000;

function build(db: AppDb): FastifyInstance {
  const cfg = loadConfig({
    DATABASE_URL: 'postgresql://u:p@localhost:5432/test',
    META_APP_SECRET: 's', META_VERIFY_TOKEN: 'v',
    CREDENTIALS_ENC_KEY: 'a'.repeat(64), SESSION_SECRET: SECRET,
    PUBLIC_BASE_URL: 'https://bot.example.com',
  } as unknown as NodeJS.ProcessEnv);

  const app = Fastify();
  registerFormParser(app);
  registerDashboardRoutes(app, { db, cfg, throttle: new ReplyThrottle(5) });
  return app;
}

async function seed() {
  const db = await createTestDb();
  const userId = await createUser(db, { email: 'a@a.a', passwordHash: 'x' });
  await createAutomation(db, userId, {
    name: 'Прайс A', triggerType: 'contains', triggerValue: 'цена', steps: [{ say: 'Ответ A' }],
  });
  return { db, userId };
}

describe('лендинг', () => {
  it('гость на корне видит лендинг, а не форму входа', async () => {
    const { db } = await seed();
    const res = await build(db).inject({ method: 'GET', url: '/' });

    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('<h1');
    expect(res.body).toContain('/login');
  });

  it('S11: лендинг не показывает данные клиентов', async () => {
    const { db } = await seed();
    const res = await build(db).inject({ method: 'GET', url: '/' });

    // Воронка в базе есть, но страница публичная — её содержимое наружу
    // не попадает ни строкой
    expect(res.body).not.toContain('Прайс A');
    expect(res.body).not.toContain('Ответ A');
  });

  it('залогиненный на корне по-прежнему попадает в кабинет', async () => {
    const { db, userId } = await seed();
    const token = await createSession(db, userId, new Date(), 7 * DAY);
    const res = await build(db).inject({
      method: 'GET', url: '/', headers: { cookie: `sid=${token}` },
    });

    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('Прайс A');
  });

  it('CSP: на лендинге нет инлайнового скрипта и инлайнового стиля', async () => {
    const { db } = await seed();
    const res = await build(db).inject({ method: 'GET', url: '/' });

    // `default-src 'self'` без `unsafe-inline`: инлайновый JS просто не выполнится,
    // и страница с ним поехала бы только в проде
    expect(res.body).not.toContain('<script');
    expect(res.body).not.toContain('style="');
    expect(res.body).not.toMatch(/\son[a-z]+=/);
    expect(res.body).toContain('/app.css');
  });

  it('гостю не отдаётся шапка кабинета', async () => {
    const { db } = await seed();
    const res = await build(db).inject({ method: 'GET', url: '/' });

    // Ссылок вглубь кабинета у гостя быть не может: вести его туда некуда
    expect(res.body).not.toContain('href="/leads"');
    expect(res.body).not.toContain('action="/logout"');
  });
});
