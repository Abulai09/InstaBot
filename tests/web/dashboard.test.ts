import Fastify, { type FastifyInstance } from 'fastify';
import { describe, expect, it } from 'vitest';
import { createTestDb } from '../storage/helpers.js';
import { createUser } from '../../src/storage/queries/users.js';
import { createAutomation, listAutomations } from '../../src/storage/queries/automations.js';
import { createSession } from '../../src/storage/queries/sessions.js';
import { loadConfig } from '../../src/config.js';
import { ReplyThrottle } from '../../src/core/throttle.js';
import { csrfToken } from '../../src/web/csrf.js';
import { registerFormParser } from '../../src/web/http.js';
import { registerDashboardRoutes } from '../../src/web/routes/dashboard.js';
import type { AppDb } from '../../src/storage/db.js';

const SECRET = 'a'.repeat(32);
const NOW = new Date('2026-09-01T12:00:00Z');
const DAY = 86_400_000;

function config() {
  return loadConfig({
    DATABASE_URL: 'postgresql://u:p@localhost:5432/test',
    META_APP_SECRET: 's', META_VERIFY_TOKEN: 'v',
    CREDENTIALS_ENC_KEY: 'a'.repeat(64), SESSION_SECRET: SECRET,
    PUBLIC_BASE_URL: 'https://bot.example.com',
  } as unknown as NodeJS.ProcessEnv);
}

function build(db: AppDb): FastifyInstance {
  const cfg = config();
  const app = Fastify();
  registerFormParser(app);
  registerDashboardRoutes(app, { db, cfg, throttle: new ReplyThrottle(5) });
  return app;
}

async function login(db: AppDb, userId: string) {
  // Сессия выдаётся от текущего момента: маршрут проверяет срок по реальному
  // времени (`new Date()` внутри `currentSession`), и фиксированная дата
  // протухает через неделю после написания теста
  const token = await createSession(db, userId, new Date(), 7 * DAY);
  return { cookie: `sid=${token}`, csrf: csrfToken(token, SECRET) };
}

async function seed() {
  const db = await createTestDb();
  const a = await createUser(db, { email: 'a@a.a', passwordHash: 'x' });
  const b = await createUser(db, { email: 'b@b.b', passwordHash: 'x' });
  const aAutomation = await createAutomation(db, a, {
    name: 'Прайс A', triggerType: 'contains', triggerValue: 'цена', steps: [{ say: 'Ответ A' }],
  });
  const bAutomation = await createAutomation(db, b, {
    name: 'Прайс B', triggerType: 'contains', triggerValue: 'цена', steps: [{ say: 'Ответ B' }],
  });
  return { db, a, b, aAutomation, bAutomation };
}

describe('кабинет', () => {
  it('без сессии уводит на форму входа', async () => {
    const { db } = await seed();
    const res = await build(db).inject({ method: 'GET', url: '/' });
    expect(res.statusCode).toBe(303);
    expect(res.headers.location).toBe('/login');
  });

  it('S11: показывает только свои воронки', async () => {
    const { db, a } = await seed();
    const res = await build(db).inject({ method: 'GET', url: '/', headers: { cookie: (await login(db, a)).cookie } });

    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('Прайс A');
    expect(res.body).not.toContain('Прайс B');
  });

  it('S21: имя воронки со скриптом выводится текстом', async () => {
    const db = await createTestDb();
    const userId = await createUser(db, { email: 'x@x.x', passwordHash: 'x' });
    await createAutomation(db, userId, {
      name: '<script>alert(1)</script>', triggerType: 'contains', triggerValue: 'ц',
      steps: [{ say: 'Ответ' }],
    });

    const res = await build(db).inject({
      method: 'GET', url: '/', headers: { cookie: (await login(db, userId)).cookie },
    });

    expect(res.body).not.toContain('<script>alert(1)</script>');
    expect(res.body).toContain('&lt;script&gt;');
  });

  it('переключатель выключает воронку', async () => {
    const { db, a, aAutomation } = await seed();
    const { cookie, csrf } = await login(db, a);

    const res = await build(db).inject({
      method: 'POST', url: `/automations/${aAutomation}/toggle`,
      headers: { cookie, 'content-type': 'application/x-www-form-urlencoded' },
      payload: new URLSearchParams({ enabled: 'false', csrf }).toString(),
    });

    expect(res.statusCode).toBe(303);
    expect((await listAutomations(db, a))[0]?.enabled).toBe(false);
  });

  it('S15: без CSRF-токена переключатель отвечает 403 и ничего не меняет', async () => {
    const { db, a, aAutomation } = await seed();
    const { cookie } = await login(db, a);

    const res = await build(db).inject({
      method: 'POST', url: `/automations/${aAutomation}/toggle`,
      headers: { cookie, 'content-type': 'application/x-www-form-urlencoded' },
      payload: new URLSearchParams({ enabled: 'false' }).toString(),
    });

    expect(res.statusCode).toBe(403);
    expect((await listAutomations(db, a))[0]?.enabled).toBe(true);
  });

  it('S15: токен чужой сессии не подходит', async () => {
    const { db, a, b, aAutomation } = await seed();
    const { cookie } = await login(db, a);
    const foreign = (await login(db, b)).csrf;

    const res = await build(db).inject({
      method: 'POST', url: `/automations/${aAutomation}/toggle`,
      headers: { cookie, 'content-type': 'application/x-www-form-urlencoded' },
      payload: new URLSearchParams({ enabled: 'false', csrf: foreign }).toString(),
    });

    expect(res.statusCode).toBe(403);
  });

  it('S11: клиент B не выключает воронку клиента A', async () => {
    const { db, a, b, aAutomation } = await seed();
    const { cookie, csrf } = await login(db, b);

    const res = await build(db).inject({
      method: 'POST', url: `/automations/${aAutomation}/toggle`,
      headers: { cookie, 'content-type': 'application/x-www-form-urlencoded' },
      payload: new URLSearchParams({ enabled: 'false', csrf }).toString(),
    });

    // Ответ такой же, как для своей воронки: разный ответ выдал бы,
    // что такая воронка существует
    expect(res.statusCode).toBe(303);
    expect((await listAutomations(db, a))[0]?.enabled).toBe(true);
  });

  it('S14: user_id в теле формы не меняет владельца', async () => {
    const { db, a, b, aAutomation } = await seed();
    const { cookie, csrf } = await login(db, b);

    await build(db).inject({
      method: 'POST', url: `/automations/${aAutomation}/toggle`,
      headers: { cookie, 'content-type': 'application/x-www-form-urlencoded' },
      payload: new URLSearchParams({ enabled: 'false', csrf, user_id: a }).toString(),
    });

    expect((await listAutomations(db, a))[0]?.enabled).toBe(true);
  });

  it('воронка без шагов помечена черновиком и не предлагает включение', async () => {
    const db = await createTestDb();
    const userId = await createUser(db, { email: 'x@x.x', passwordHash: 'x' });
    await createAutomation(db, userId, {
      name: 'Черновик', triggerType: 'contains', triggerValue: 'ц', steps: [],
    });

    const res = await build(db).inject({
      method: 'GET', url: '/', headers: { cookie: (await login(db, userId)).cookie },
    });

    expect(res.body).toContain('черновик');
    expect(res.body).not.toContain('Выключить');
  });

  it('в списке есть ссылки на правку и на создание', async () => {
    const { db, a, aAutomation } = await seed();

    const res = await build(db).inject({
      method: 'GET', url: '/', headers: { cookie: (await login(db, a)).cookie },
    });

    expect(res.body).toContain(`/automations/${aAutomation}`);
    expect(res.body).toContain('/automations/new');
  });

  it('отображает ошибки доставки при их наличии', async () => {
    const { db, a } = await seed();
    const { enqueueOutbox, markOutboxFailed } = await import('../../src/storage/queries/runtime.js');
    const outboxId = await enqueueOutbox(db, a, 'instagram', { type: 'send_text', text: 'hi' }, { threadId: 't1' });
    await markOutboxFailed(db, outboxId, 'Истекло 24-часовое окно ответа', null);

    const res = await build(db).inject({
      method: 'GET', url: '/', headers: { cookie: (await login(db, a)).cookie },
    });

    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('Ошибки доставки');
    expect(res.body).toContain('Истекло 24-часовое окно ответа');
    expect(res.body).toContain('instagram');
  });
});
