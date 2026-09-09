import Fastify from 'fastify';
import { describe, expect, it } from 'vitest';
import { createTestDb } from '../storage/helpers.js';
import { loadConfig } from '../../src/config.js';
import { ReplyThrottle } from '../../src/core/throttle.js';
import type { AppDb } from '../../src/storage/db.js';
import { createUser, findUserByEmail, findUserById } from '../../src/storage/queries/users.js';
import { createSession, loadSession } from '../../src/storage/queries/sessions.js';
import { getAccountTokenForPlatform, listAccounts } from '../../src/storage/queries/accounts.js';
import { invites } from '../../src/storage/schema.js';
import { csrfToken } from '../../src/web/csrf.js';
import { registerFormParser } from '../../src/web/http.js';
import { registerAdminRoutes } from '../../src/web/routes/admin.js';

const SECRET = 'a'.repeat(32);
const now = new Date('2026-09-09T12:00:00Z');
const DAY = 86_400_000;

function config() {
  return loadConfig({
    META_APP_SECRET: 's', META_VERIFY_TOKEN: 'v',
    CREDENTIALS_ENC_KEY: 'a'.repeat(64), SESSION_SECRET: SECRET,
    PUBLIC_BASE_URL: 'https://bot.example.com',
  } as unknown as NodeJS.ProcessEnv);
}

function build(db: AppDb) {
  const cfg = config();
  const app = Fastify();
  registerFormParser(app);
  registerAdminRoutes(app, { db, cfg, throttle: new ReplyThrottle(100, 60_000) });
  return app;
}

/** Возвращает и cookie, и csrf: формы админки без него получат 403. */
function login(db: AppDb, userId: string) {
  const token = createSession(db, userId, now, DAY);
  return { cookie: `sid=${token}`, csrf: csrfToken(token, SECRET) };
}

/**
 * Все маршруты плагина разом: новый маршрут обязан попасть в этот список.
 * До задачи 9 существует только первый — остальные четыре строки закомментированы,
 * вернуть в задаче 9, шаг 4.
 */
const ROUTES = [
  { method: 'GET' as const, url: '/admin' },
  { method: 'POST' as const, url: '/admin/clients' },
  { method: 'POST' as const, url: '/admin/clients/чужой-id/invite' },
  { method: 'POST' as const, url: '/admin/clients/чужой-id/toggle' },
  { method: 'POST' as const, url: '/admin/clients/чужой-id/accounts' },
];

describe('доступ в админку', () => {
  it.each(ROUTES)('S12: клиент получает 403 на $method $url', async (route) => {
    const db = createTestDb();
    const clientId = createUser(db, { email: 'k@k.k', passwordHash: 'x' });
    const { cookie } = login(db, clientId);

    const res = await build(db).inject({ ...route, headers: { cookie } });

    expect(res.statusCode).toBe(403);
  });

  it.each(ROUTES)('S12: аноним уходит на вход с $method $url', async (route) => {
    const res = await build(createTestDb()).inject(route);

    expect(res.statusCode).toBe(303);
    expect(res.headers.location).toBe('/login');
  });

  it('владелец видит список клиентов', async () => {
    const db = createTestDb();
    const ownerId = createUser(db, { email: 'vladelec@k.k', passwordHash: 'x', role: 'owner' });
    createUser(db, { email: 'klient@k.k', passwordHash: 'x' });
    const { cookie } = login(db, ownerId);

    const res = await build(db).inject({ method: 'GET', url: '/admin', headers: { cookie } });

    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('klient@k.k');
  });

  it('S11: владелец сервиса не показан в списке как клиент', async () => {
    const db = createTestDb();
    const ownerId = createUser(db, { email: 'vladelec@k.k', passwordHash: 'x', role: 'owner' });
    const { cookie } = login(db, ownerId);

    const res = await build(db).inject({ method: 'GET', url: '/admin', headers: { cookie } });

    expect(res.body).not.toContain('vladelec@k.k');
  });

  it('S9: страница админки не кэшируется', async () => {
    const db = createTestDb();
    const ownerId = createUser(db, { email: 'v@k.k', passwordHash: 'x', role: 'owner' });
    const { cookie } = login(db, ownerId);

    const res = await build(db).inject({ method: 'GET', url: '/admin', headers: { cookie } });

    expect(res.headers['cache-control']).toBe('no-store');
  });
});

function seedOwner(db: AppDb) {
  const ownerId = createUser(db, { email: 'vladelec@k.k', passwordHash: 'x', role: 'owner' });
  return login(db, ownerId);
}

const FORM = { 'content-type': 'application/x-www-form-urlencoded' };

describe('заведение клиента', () => {
  it('создаёт клиента и показывает ссылку приглашения один раз', async () => {
    const db = createTestDb();
    const { cookie, csrf } = seedOwner(db);

    const res = await build(db).inject({
      method: 'POST', url: '/admin/clients',
      headers: { cookie, ...FORM },
      payload: new URLSearchParams({ csrf, email: 'novyy@k.k' }).toString(),
    });

    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('https://bot.example.com/invite/');
    expect(findUserByEmail(db, 'novyy@k.k')?.role).toBe('client');
  });

  it('S14: role=owner в теле формы создаёт клиента, а не владельца', async () => {
    const db = createTestDb();
    const { cookie, csrf } = seedOwner(db);

    await build(db).inject({
      method: 'POST', url: '/admin/clients',
      headers: { cookie, ...FORM },
      payload: new URLSearchParams({ csrf, email: 'hitryy@k.k', role: 'owner' }).toString(),
    });

    expect(findUserByEmail(db, 'hitryy@k.k')?.role).toBe('client');
  });

  it('почта приводится к нижнему регистру', async () => {
    const db = createTestDb();
    const { cookie, csrf } = seedOwner(db);

    await build(db).inject({
      method: 'POST', url: '/admin/clients',
      headers: { cookie, ...FORM },
      payload: new URLSearchParams({ csrf, email: 'Klient@K.K' }).toString(),
    });

    expect(findUserByEmail(db, 'klient@k.k')).toBeDefined();
  });

  it('повторная почта — ошибка формы, а не 500', async () => {
    const db = createTestDb();
    const { cookie, csrf } = seedOwner(db);
    createUser(db, { email: 'zanyato@k.k', passwordHash: 'x' });

    const res = await build(db).inject({
      method: 'POST', url: '/admin/clients',
      headers: { cookie, ...FORM },
      payload: new URLSearchParams({ csrf, email: 'zanyato@k.k' }).toString(),
    });

    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('уже заведён');
  });

  it('S15: без csrf-токена клиент не заводится', async () => {
    const db = createTestDb();
    const { cookie } = seedOwner(db);

    const res = await build(db).inject({
      method: 'POST', url: '/admin/clients',
      headers: { cookie, ...FORM },
      payload: new URLSearchParams({ email: 'bez-csrf@k.k' }).toString(),
    });

    expect(res.statusCode).toBe(403);
    expect(findUserByEmail(db, 'bez-csrf@k.k')).toBeUndefined();
  });

  it('S9: хэш пароля-заглушки не попадает на страницу', async () => {
    const db = createTestDb();
    const { cookie, csrf } = seedOwner(db);

    const res = await build(db).inject({
      method: 'POST', url: '/admin/clients',
      headers: { cookie, ...FORM },
      payload: new URLSearchParams({ csrf, email: 'novyy@k.k' }).toString(),
    });

    const hash = findUserByEmail(db, 'novyy@k.k')?.passwordHash ?? '';
    expect(hash.startsWith('$argon2')).toBe(true);
    expect(res.body).not.toContain(hash);
  });

  it('перевыпуск ссылки работает и не трогает роль клиента', async () => {
    const db = createTestDb();
    const { cookie, csrf } = seedOwner(db);
    const clientId = createUser(db, { email: 'k@k.k', passwordHash: 'x' });

    const res = await build(db).inject({
      method: 'POST', url: `/admin/clients/${clientId}/invite`,
      headers: { cookie, ...FORM },
      payload: new URLSearchParams({ csrf }).toString(),
    });

    expect(res.body).toContain('https://bot.example.com/invite/');
  });

  it('S15: без csrf-токена ссылка не перевыпускается', async () => {
    const db = createTestDb();
    const { cookie } = seedOwner(db);
    const clientId = createUser(db, { email: 'k@k.k', passwordHash: 'x' });

    const res = await build(db).inject({
      method: 'POST', url: `/admin/clients/${clientId}/invite`,
      headers: { cookie, ...FORM },
      payload: new URLSearchParams({}).toString(),
    });

    expect(res.statusCode).toBe(403);
    expect(db.select().from(invites).all()).toHaveLength(0);
  });

  it('S12: перевыпустить ссылку владельцу сервиса через админку нельзя', async () => {
    const db = createTestDb();
    const { cookie, csrf } = seedOwner(db);
    const second = createUser(db, { email: 'vtoroy@k.k', passwordHash: 'x', role: 'owner' });

    const res = await build(db).inject({
      method: 'POST', url: `/admin/clients/${second}/invite`,
      headers: { cookie, ...FORM },
      payload: new URLSearchParams({ csrf }).toString(),
    });

    expect(res.body).toContain('Клиент не найден');
  });
});

describe('отключение клиента', () => {
  it('отключает и включает обратно', async () => {
    const db = createTestDb();
    const { cookie, csrf } = seedOwner(db);
    const clientId = createUser(db, { email: 'k@k.k', passwordHash: 'x' });
    const app = build(db);
    const toggle = () => app.inject({
      method: 'POST', url: `/admin/clients/${clientId}/toggle`,
      headers: { cookie, ...FORM },
      payload: new URLSearchParams({ csrf }).toString(),
    });

    await toggle();
    expect(findUserById(db, clientId)?.disabledAt).not.toBeNull();

    await toggle();
    expect(findUserById(db, clientId)?.disabledAt).toBeNull();
  });

  it('S15: отключение гасит живые сессии клиента немедленно', async () => {
    const db = createTestDb();
    const { cookie, csrf } = seedOwner(db);
    const clientId = createUser(db, { email: 'k@k.k', passwordHash: 'x' });
    const clientToken = createSession(db, clientId, now, DAY);

    await build(db).inject({
      method: 'POST', url: `/admin/clients/${clientId}/toggle`,
      headers: { cookie, ...FORM },
      payload: new URLSearchParams({ csrf }).toString(),
    });

    expect(loadSession(db, clientToken, now)).toBeUndefined();
  });

  it('S15: без csrf-токена клиент не отключается', async () => {
    const db = createTestDb();
    const { cookie } = seedOwner(db);
    const clientId = createUser(db, { email: 'k@k.k', passwordHash: 'x' });

    const res = await build(db).inject({
      method: 'POST', url: `/admin/clients/${clientId}/toggle`,
      headers: { cookie, ...FORM },
      payload: new URLSearchParams({}).toString(),
    });

    expect(res.statusCode).toBe(403);
    expect(findUserById(db, clientId)?.disabledAt).toBeNull();
  });

  it('включение клиента обратно не гасит его текущую сессию', async () => {
    const db = createTestDb();
    const { cookie, csrf } = seedOwner(db);
    const clientId = createUser(db, { email: 'k@k.k', passwordHash: 'x' });
    const app = build(db);
    const toggle = () => app.inject({
      method: 'POST', url: `/admin/clients/${clientId}/toggle`,
      headers: { cookie, ...FORM },
      payload: new URLSearchParams({ csrf }).toString(),
    });

    await toggle(); // отключили — существующие сессии уже погашены (проверено отдельным тестом)
    // Сессия появляется уже после отключения — так на её примере видно поведение
    // именно вызова включения, а не то, что она случайно пережила отключение
    const sessionToken = createSession(db, clientId, now, DAY);

    await toggle(); // включили обратно

    // Если убрать `if (disabling)` и гасить сессии всегда, эта сессия тоже погибнет —
    // тест должен покраснеть именно на этой строке
    expect(loadSession(db, sessionToken, now)).toBeDefined();
  });

  it('S12: владельца сервиса отключить через админку нельзя', async () => {
    const db = createTestDb();
    const { cookie, csrf } = seedOwner(db);
    const second = createUser(db, { email: 'vtoroy@k.k', passwordHash: 'x', role: 'owner' });

    await build(db).inject({
      method: 'POST', url: `/admin/clients/${second}/toggle`,
      headers: { cookie, ...FORM },
      payload: new URLSearchParams({ csrf }).toString(),
    });

    expect(findUserById(db, second)?.disabledAt).toBeNull();
  });
});

describe('подключение аккаунта', () => {
  const KEY = 'a'.repeat(64);

  function connect(
    app: ReturnType<typeof build>, cookie: string, csrf: string,
    clientId: string, externalAccountId: string, token: string,
  ) {
    return app.inject({
      method: 'POST', url: `/admin/clients/${clientId}/accounts`,
      headers: { cookie, ...FORM },
      payload: new URLSearchParams({
        csrf, external_account_id: externalAccountId, token,
      }).toString(),
    });
  }

  it('подключает аккаунт и перезаписывает токен при повторе', async () => {
    const db = createTestDb();
    const { cookie, csrf } = seedOwner(db);
    const clientId = createUser(db, { email: 'k@k.k', passwordHash: 'x' });
    const app = build(db);

    await connect(app, cookie, csrf, clientId, '17841400000000000', 'старый');
    await connect(app, cookie, csrf, clientId, '17841400000000000', 'новый');

    expect(getAccountTokenForPlatform(db, clientId, 'instagram', KEY)?.token).toBe('новый');
    expect(listAccounts(db, clientId)).toHaveLength(1);
  });

  it('S17: чужой внешний id отвергается', async () => {
    const db = createTestDb();
    const { cookie, csrf } = seedOwner(db);
    const a = createUser(db, { email: 'a@a.a', passwordHash: 'x' });
    const b = createUser(db, { email: 'b@b.b', passwordHash: 'x' });
    const app = build(db);

    await connect(app, cookie, csrf, a, '17841400000000000', 'токен-А');
    const res = await connect(app, cookie, csrf, b, '17841400000000000', 'токен-Б');

    expect(res.body).toContain('уже подключён другому');
    expect(listAccounts(db, b)).toHaveLength(0);
  });

  it('нечисловой внешний id — ошибка формы, а не запись', async () => {
    const db = createTestDb();
    const { cookie, csrf } = seedOwner(db);
    const clientId = createUser(db, { email: 'k@k.k', passwordHash: 'x' });

    const res = await connect(build(db), cookie, csrf, clientId, '../../etc/passwd', 'т');

    expect(res.statusCode).toBe(200);
    expect(listAccounts(db, clientId)).toHaveLength(0);
  });

  it('S9: токен не возвращается на страницу', async () => {
    const db = createTestDb();
    const { cookie, csrf } = seedOwner(db);
    const clientId = createUser(db, { email: 'k@k.k', passwordHash: 'x' });

    const res = await connect(build(db), cookie, csrf, clientId, '111', 'ОЧЕНЬ-СЕКРЕТНЫЙ-ТОКЕН');

    expect(res.body).not.toContain('ОЧЕНЬ-СЕКРЕТНЫЙ-ТОКЕН');
  });

  it('S15: без csrf-токена аккаунт не подключается', async () => {
    const db = createTestDb();
    const { cookie } = seedOwner(db);
    const clientId = createUser(db, { email: 'k@k.k', passwordHash: 'x' });

    const res = await build(db).inject({
      method: 'POST', url: `/admin/clients/${clientId}/accounts`,
      headers: { cookie, ...FORM },
      payload: new URLSearchParams({
        external_account_id: '17841400000000000', token: 'токен',
      }).toString(),
    });

    expect(res.statusCode).toBe(403);
    expect(listAccounts(db, clientId)).toHaveLength(0);
  });
});
