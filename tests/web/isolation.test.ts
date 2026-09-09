import Fastify, { type FastifyInstance } from 'fastify';
import { describe, expect, it } from 'vitest';
import { createTestDb } from '../storage/helpers.js';
import { createUser } from '../../src/storage/queries/users.js';
import { createAutomation } from '../../src/storage/queries/automations.js';
import { recordLead } from '../../src/storage/queries/leads.js';
import { enqueueOutbox, markOutboxFailed } from '../../src/storage/queries/runtime.js';
import { createSession } from '../../src/storage/queries/sessions.js';
import { loadConfig } from '../../src/config.js';
import { ReplyThrottle } from '../../src/core/throttle.js';
import { registerFormParser, registerSecurityHeaders } from '../../src/web/http.js';
import { registerAuthRoutes } from '../../src/web/routes/auth.js';
import { registerDashboardRoutes } from '../../src/web/routes/dashboard.js';
import { registerLeadsRoutes } from '../../src/web/routes/leads.js';
import { registerFilesRoutes } from '../../src/web/routes/files.js';
import { registerConstructorRoutes } from '../../src/web/routes/constructor.js';
import { registerAdminRoutes } from '../../src/web/routes/admin.js';
import { registerInviteRoutes } from '../../src/web/routes/invite.js';
import { registerStyleRoute } from '../../src/web/routes/style.js';
import type { AppDb } from '../../src/storage/db.js';

const NOW = new Date('2026-09-01T12:00:00Z');
const DAY = 86_400_000;

function cabinet(db: AppDb): FastifyInstance {
  const cfg = loadConfig({
    META_APP_SECRET: 's', META_VERIFY_TOKEN: 'v',
    CREDENTIALS_ENC_KEY: 'a'.repeat(64), SESSION_SECRET: 'a'.repeat(32),
    PUBLIC_BASE_URL: 'https://bot.example.com',
  } as unknown as NodeJS.ProcessEnv);
  const app = Fastify();
  const deps = { db, cfg, throttle: new ReplyThrottle(cfg.LOGIN_MAX_ATTEMPTS, 900_000) };

  registerFormParser(app);
  registerSecurityHeaders(app, false);
  registerAuthRoutes(app, deps);
  registerDashboardRoutes(app, deps);
  registerLeadsRoutes(app, deps);
  registerFilesRoutes(app, deps);
  registerConstructorRoutes(app, deps);
  registerAdminRoutes(app, deps);
  registerInviteRoutes(app, deps);
  registerStyleRoute(app);
  return app;
}

function seedClient(db: AppDb, email: string, marker: string) {
  const userId = createUser(db, { email, passwordHash: 'x' });
  const automationId = createAutomation(db, userId, {
    name: `Воронка ${marker}`, triggerType: 'contains', triggerValue: 'цена',
    steps: [{ say: `Ответ ${marker}` }],
  });
  recordLead(db, userId, {
    automationId, platform: 'instagram', externalUserId: `внешний-${marker}`,
    data: new Map([['name', `Имя ${marker}`]]), createdAt: NOW,
  });
  // Сессия выдаётся от текущего момента: маршрут проверяет срок по реальному
  // времени (`new Date()` внутри `currentSession`), и фиксированная дата
  // протухает через неделю после написания теста
  return { userId, automationId, cookie: `sid=${createSession(db, userId, new Date(), 7 * DAY)}` };
}

describe('S11: два клиента в одной базе', () => {
  it('ни один маршрут кабинета не отдаёт чужое', async () => {
    const db = createTestDb();
    const a = seedClient(db, 'a@a.a', 'A');
    seedClient(db, 'b@b.b', 'B');
    const app = cabinet(db);

    for (const url of ['/', '/leads', '/leads.csv']) {
      const res = await app.inject({ method: 'GET', url, headers: { cookie: a.cookie } });
      expect(res.statusCode, url).toBe(200);
      expect(res.body, url).not.toContain('Воронка B');
      expect(res.body, url).not.toContain('Имя B');
    }
  });

  it('S22: заголовки безопасности стоят на страницах кабинета', async () => {
    const db = createTestDb();
    const a = seedClient(db, 'a@a.a', 'A');

    const res = await cabinet(db).inject({ method: 'GET', url: '/', headers: { cookie: a.cookie } });

    expect(res.headers['x-frame-options']).toBe('DENY');
    expect(res.headers['content-security-policy']).toBeDefined();
  });

  it('S11: страница чужой воронки не открывается', async () => {
    const db = createTestDb();
    const a = seedClient(db, 'a@a.a', 'A');
    const b = seedClient(db, 'b@b.b', 'B');
    const app = cabinet(db);

    const res = await app.inject({
      method: 'GET', url: `/automations/${b.automationId}`, headers: { cookie: a.cookie },
    });

    expect(res.statusCode).toBe(404);
  });

  it('S11: списки файлов, воронок и страница правки не показывают чужое', async () => {
    const db = createTestDb();
    const a = seedClient(db, 'a@a.a', 'A');
    seedClient(db, 'b@b.b', 'B');
    const app = cabinet(db);

    for (const url of ['/', '/files', `/automations/${a.automationId}`]) {
      const res = await app.inject({ method: 'GET', url, headers: { cookie: a.cookie } });
      expect(res.statusCode, url).toBe(200);
      expect(res.body, url).not.toContain('Воронка B');
      expect(res.body, url).not.toContain('Имя B');
    }
  });

  it('S12: владелец видит обоих клиентов, клиент не видит админку', async () => {
    const db = createTestDb();
    const ownerId = createUser(db, { email: 'vladelec@k.k', passwordHash: 'x', role: 'owner' });
    createUser(db, { email: 'client-a@k.k', passwordHash: 'x' });
    const b = createUser(db, { email: 'client-b@k.k', passwordHash: 'x' });
    const app = cabinet(db);

    const ownerCookie = `sid=${createSession(db, ownerId, new Date(), 86_400_000)}`;
    const clientCookie = `sid=${createSession(db, b, new Date(), 86_400_000)}`;

    const asOwner = await app.inject({
      method: 'GET', url: '/admin', headers: { cookie: ownerCookie },
    });
    const asClient = await app.inject({
      method: 'GET', url: '/admin', headers: { cookie: clientCookie },
    });

    expect(asOwner.body).toContain('client-a@k.k');
    expect(asOwner.body).toContain('client-b@k.k');
    expect(asClient.statusCode).toBe(403);
  });

  it('ссылка на админку показана владельцу и не показана клиенту', async () => {
    const db = createTestDb();
    const ownerId = createUser(db, { email: 'vladelec@k.k', passwordHash: 'x', role: 'owner' });
    const clientId = createUser(db, { email: 'klient@k.k', passwordHash: 'x' });
    const app = cabinet(db);

    const asOwner = await app.inject({
      method: 'GET', url: '/',
      headers: { cookie: `sid=${createSession(db, ownerId, new Date(), 86_400_000)}` },
    });
    const asClient = await app.inject({
      method: 'GET', url: '/',
      headers: { cookie: `sid=${createSession(db, clientId, new Date(), 86_400_000)}` },
    });

    expect(asOwner.body).toContain('href="/admin"');
    expect(asClient.body).not.toContain('href="/admin"');
  });

  it('S11: клиент видит только свои ошибки доставки на дашборде', async () => {
    const db = createTestDb();
    const a = seedClient(db, 'a-err@a.a', 'A');
    const b = seedClient(db, 'b-err@b.b', 'B');
    const app = cabinet(db);

    const errA = enqueueOutbox(db, a.userId, 'instagram', { type: 'send_text', text: 'A' }, { threadId: 't1' });
    const errB = enqueueOutbox(db, b.userId, 'instagram', { type: 'send_text', text: 'B' }, { threadId: 't2' });
    markOutboxFailed(db, errA, 'Истекло 24-часовое окно ответа клиента A', null);
    markOutboxFailed(db, errB, 'Ошибка токена клиента B', null);

    const resA = await app.inject({ method: 'GET', url: '/', headers: { cookie: a.cookie } });
    expect(resA.statusCode).toBe(200);
    expect(resA.body).toContain('Истекло 24-часовое окно ответа клиента A');
    expect(resA.body).not.toContain('Ошибка токена клиента B');

    const resB = await app.inject({ method: 'GET', url: '/', headers: { cookie: b.cookie } });
    expect(resB.statusCode).toBe(200);
    expect(resB.body).toContain('Ошибка токена клиента B');
    expect(resB.body).not.toContain('Истекло 24-часовое окно ответа клиента A');
  });
});

