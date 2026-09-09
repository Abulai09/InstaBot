import Fastify, { type FastifyInstance } from 'fastify';
import { describe, expect, it } from 'vitest';
import { createTestDb } from '../storage/helpers.js';
import { createUser } from '../../src/storage/queries/users.js';
import { createAutomation } from '../../src/storage/queries/automations.js';
import { recordLead } from '../../src/storage/queries/leads.js';
import { createSession } from '../../src/storage/queries/sessions.js';
import { loadConfig } from '../../src/config.js';
import { ReplyThrottle } from '../../src/core/throttle.js';
import { registerFormParser, registerSecurityHeaders } from '../../src/web/http.js';
import { registerAuthRoutes } from '../../src/web/routes/auth.js';
import { registerDashboardRoutes } from '../../src/web/routes/dashboard.js';
import { registerLeadsRoutes } from '../../src/web/routes/leads.js';
import { registerFilesRoutes } from '../../src/web/routes/files.js';
import { registerConstructorRoutes } from '../../src/web/routes/constructor.js';
import { registerStyleRoute } from '../../src/web/routes/style.js';
import type { AppDb } from '../../src/storage/db.js';

const NOW = new Date('2026-09-01T12:00:00Z');
const DAY = 86_400_000;

function cabinet(db: AppDb): FastifyInstance {
  const cfg = loadConfig({
    META_APP_SECRET: 's', META_VERIFY_TOKEN: 'v',
    CREDENTIALS_ENC_KEY: 'a'.repeat(64), SESSION_SECRET: 'a'.repeat(32),
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
});
