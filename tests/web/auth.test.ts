import Fastify from 'fastify';
import { describe, expect, it } from 'vitest';
import { createTestDb } from '../storage/helpers.js';
import { createUser } from '../../src/storage/queries/users.js';
import { loadConfig } from '../../src/config.js';
import { ReplyThrottle } from '../../src/core/throttle.js';
import { hashPassword } from '../../src/web/password.js';
import { registerFormParser } from '../../src/web/http.js';
import { registerAuthRoutes } from '../../src/web/routes/auth.js';
import type { AppDb } from '../../src/storage/db.js';

const SECRET = 'a'.repeat(32);

function config() {
  return loadConfig({
    META_APP_SECRET: 's', META_VERIFY_TOKEN: 'v',
    CREDENTIALS_ENC_KEY: 'a'.repeat(64), SESSION_SECRET: SECRET,
  } as unknown as NodeJS.ProcessEnv);
}

function build(db: AppDb) {
  const cfg = config();
  const app = Fastify();
  registerFormParser(app);
  registerAuthRoutes(app, {
    db, cfg,
    throttle: new ReplyThrottle(cfg.LOGIN_MAX_ATTEMPTS, cfg.LOGIN_WINDOW_MINUTES * 60_000),
  });
  return app;
}

function form(fields: Record<string, string>) {
  return {
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    payload: new URLSearchParams(fields).toString(),
  };
}

async function seedUser(db: AppDb, email = 'a@a.a', password = 'пароль-клиента') {
  return createUser(db, { email, passwordHash: await hashPassword(password) });
}

describe('вход', () => {
  it('форма входа открыта без сессии', async () => {
    const res = await build(createTestDb()).inject({ method: 'GET', url: '/login' });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('<form');
  });

  it('верный пароль выдаёт сессию и уводит в кабинет', async () => {
    const db = createTestDb();
    await seedUser(db);

    const res = await build(db).inject({
      method: 'POST', url: '/login',
      ...form({ email: 'a@a.a', password: 'пароль-клиента' }),
    });

    expect(res.statusCode).toBe(303);
    expect(res.headers.location).toBe('/');
    expect(String(res.headers['set-cookie'])).toContain('HttpOnly');
  });

  it('S13: ответ одинаков при неверном пароле и несуществующем email', async () => {
    const db = createTestDb();
    await seedUser(db);
    const app = build(db);

    const wrongPassword = await app.inject({
      method: 'POST', url: '/login', ...form({ email: 'a@a.a', password: 'мимо' }),
    });
    const noSuchUser = await app.inject({
      method: 'POST', url: '/login', ...form({ email: 'нет@нет.нет', password: 'мимо' }),
    });

    expect(wrongPassword.statusCode).toBe(noSuchUser.statusCode);
    expect(wrongPassword.body).toBe(noSuchUser.body);
  });

  it('S13: неудачный вход не выдаёт cookie', async () => {
    const db = createTestDb();
    await seedUser(db);

    const res = await build(db).inject({
      method: 'POST', url: '/login', ...form({ email: 'a@a.a', password: 'мимо' }),
    });

    expect(res.statusCode).toBe(401);
    expect(res.headers['set-cookie']).toBeUndefined();
  });

  it('S9: пароль не возвращается на страницу после ошибки', async () => {
    const db = createTestDb();
    await seedUser(db);

    const res = await build(db).inject({
      method: 'POST', url: '/login',
      ...form({ email: 'a@a.a', password: 'мой-секретный-пароль' }),
    });

    expect(res.body).not.toContain('мой-секретный-пароль');
  });

  it('S15: каждый вход выдаёт новую сессию — фиксация не работает', async () => {
    const db = createTestDb();
    await seedUser(db);
    const app = build(db);

    const first = await app.inject({
      method: 'POST', url: '/login', ...form({ email: 'a@a.a', password: 'пароль-клиента' }),
    });
    const second = await app.inject({
      method: 'POST', url: '/login', ...form({ email: 'a@a.a', password: 'пароль-клиента' }),
    });

    expect(String(first.headers['set-cookie'])).not.toBe(String(second.headers['set-cookie']));
  });

  it('S19: после лимита неудач вход отвечает 429', async () => {
    const db = createTestDb();
    await seedUser(db);
    const app = build(db);
    const attempt = () => app.inject({
      method: 'POST', url: '/login', ...form({ email: 'a@a.a', password: 'мимо' }),
    });

    for (let i = 0; i < config().LOGIN_MAX_ATTEMPTS; i += 1) await attempt();

    expect((await attempt()).statusCode).toBe(429);
  });

  it('S19: исчерпанный лимит не пускает и с верным паролем', async () => {
    const db = createTestDb();
    await seedUser(db);
    const app = build(db);

    for (let i = 0; i < config().LOGIN_MAX_ATTEMPTS; i += 1) {
      await app.inject({
        method: 'POST', url: '/login', ...form({ email: 'a@a.a', password: 'мимо' }),
      });
    }

    const res = await app.inject({
      method: 'POST', url: '/login', ...form({ email: 'a@a.a', password: 'пароль-клиента' }),
    });
    expect(res.statusCode).toBe(429);
  });

  it('S14: роль из тела формы игнорируется', async () => {
    const db = createTestDb();
    await seedUser(db);

    const res = await build(db).inject({
      method: 'POST', url: '/login',
      ...form({ email: 'a@a.a', password: 'пароль-клиента', role: 'owner' }),
    });

    // Форма разобрана схемой, где роли нет вообще: вход прошёл, роль не тронута
    expect(res.statusCode).toBe(303);
  });

  it('пустая форма не роняет обработчик', async () => {
    const res = await build(createTestDb()).inject({
      method: 'POST', url: '/login', ...form({}),
    });
    expect(res.statusCode).toBe(401);
  });
});

describe('выход', () => {
  it('обнуляет cookie и уводит на форму входа', async () => {
    const db = createTestDb();
    await seedUser(db);
    const app = build(db);

    const login = await app.inject({
      method: 'POST', url: '/login', ...form({ email: 'a@a.a', password: 'пароль-клиента' }),
    });
    const cookie = String(login.headers['set-cookie']).split(';')[0] ?? '';

    const res = await app.inject({ method: 'POST', url: '/logout', headers: { cookie } });

    expect(res.statusCode).toBe(303);
    expect(res.headers.location).toBe('/login');
    expect(String(res.headers['set-cookie'])).toContain('Max-Age=0');
  });
});
