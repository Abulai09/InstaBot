import Fastify from 'fastify';
import type { FastifyRequest } from 'fastify';
import { describe, expect, it } from 'vitest';
import { createTestDb } from '../storage/helpers.js';
import { loadConfig } from '../../src/config.js';
import { ReplyThrottle } from '../../src/core/throttle.js';
import type { AppDb } from '../../src/storage/db.js';
import { createUser, findUserById } from '../../src/storage/queries/users.js';
import { createInvite } from '../../src/storage/queries/invites.js';
import { createSession, loadSession } from '../../src/storage/queries/sessions.js';
import { registerFormParser } from '../../src/web/http.js';
import { registerInviteRoutes } from '../../src/web/routes/invite.js';

const now = new Date('2026-09-09T12:00:00Z');
const HOUR = 3_600_000;

function config() {
  return loadConfig({
    DATABASE_URL: 'postgresql://u:p@localhost:5432/test',
    META_APP_SECRET: 's', META_VERIFY_TOKEN: 'v',
    CREDENTIALS_ENC_KEY: 'a'.repeat(64), SESSION_SECRET: 'a'.repeat(32),
    PUBLIC_BASE_URL: 'https://bot.example.com',
  } as unknown as NodeJS.ProcessEnv);
}

function build(db: AppDb, maxAttempts = 100) {
  const cfg = config();
  const app = Fastify();
  registerFormParser(app);
  registerInviteRoutes(app, { db, cfg, throttle: new ReplyThrottle(maxAttempts, 15 * 60_000) });
  return app;
}

function post(token: string, password: string) {
  return {
    method: 'POST' as const,
    url: `/invite/${token}`,
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    payload: new URLSearchParams({ password }).toString(),
  };
}

async function seedInvite(db: AppDb, ttlMs = 48 * HOUR) {
  const userId = await createUser(db, { email: 'k@k.k', passwordHash: 'заглушка' });
  return { userId, token: await createInvite(db, userId, now, ttlMs) };
}

describe('приём приглашения', () => {
  it('действующая ссылка показывает форму пароля', async () => {
    const db = await createTestDb();
    const { token } = await seedInvite(db);

    const res = await build(db).inject({ method: 'GET', url: `/invite/${token}` });

    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('type="password"');
  });

  it('GET не гасит приглашение: превью в мессенджере не сжигает ссылку', async () => {
    const db = await createTestDb();
    const { token } = await seedInvite(db);
    const app = build(db);

    await app.inject({ method: 'GET', url: `/invite/${token}` });
    const res = await app.inject(post(token, 'достаточно-длинный-пароль'));

    expect(res.statusCode).toBe(303);
  });

  it('пароль ставится, и клиент сразу в кабинете', async () => {
    const db = await createTestDb();
    const { userId, token } = await seedInvite(db);

    const res = await build(db).inject(post(token, 'достаточно-длинный-пароль'));

    expect(res.statusCode).toBe(303);
    expect(res.headers.location).toBe('/');
    expect(String(res.headers['set-cookie'])).toContain('HttpOnly');
    expect((await findUserById(db, userId))?.passwordHash).not.toBe('заглушка');
  });

  it('вторая попытка по той же ссылке не проходит', async () => {
    const db = await createTestDb();
    const { token } = await seedInvite(db);
    const app = build(db);

    await app.inject(post(token, 'достаточно-длинный-пароль'));
    const res = await app.inject(post(token, 'другой-длинный-пароль'));

    expect(res.statusCode).toBe(404);
  });

  it('протухшая ссылка не проходит', async () => {
    const db = await createTestDb();
    const userId = await createUser(db, { email: 'k@k.k', passwordHash: 'заглушка' });
    const token = await createInvite(db, userId, new Date('2026-09-01T00:00:00Z'), HOUR);

    const res = await build(db).inject({ method: 'GET', url: `/invite/${token}` });

    expect(res.statusCode).toBe(404);
  });

  it('выдуманный токен не проходит', async () => {
    const res = await build(await createTestDb()).inject({ method: 'GET', url: '/invite/vydumka' });
    expect(res.statusCode).toBe(404);
  });

  it('S15: установка пароля убивает прежние сессии клиента', async () => {
    const db = await createTestDb();
    const { userId, token } = await seedInvite(db);
    const old = await createSession(db, userId, now, 86_400_000);

    await build(db).inject(post(token, 'достаточно-длинный-пароль'));

    expect(await loadSession(db, old, now)).toBeUndefined();
  });

  it('S13: короткий пароль отвергается, приглашение остаётся живым', async () => {
    const db = await createTestDb();
    const { token } = await seedInvite(db);
    const app = build(db);

    const short = await app.inject(post(token, 'коротко'));
    expect(short.statusCode).toBe(400);

    const retry = await app.inject(post(token, 'достаточно-длинный-пароль'));
    expect(retry.statusCode).toBe(303);
  });

  it('S19: перебор токенов упирается в лимит', async () => {
    const db = await createTestDb();
    const app = build(db, 3);

    for (let i = 0; i < 3; i += 1) {
      await app.inject({ method: 'GET', url: `/invite/popytka-${i}` });
    }

    const res = await app.inject({ method: 'GET', url: '/invite/popytka-4' });
    expect(res.statusCode).toBe(429);
  });

  it('S9: пароль не возвращается на страницу после ошибки', async () => {
    const db = await createTestDb();
    const { token } = await seedInvite(db);

    const res = await build(db).inject(post(token, 'секрет'));

    expect(res.body).not.toContain('секрет');
  });

  it('S9: токен приглашения не попадает в лог', async () => {
    const db = await createTestDb();
    const { token } = await seedInvite(db);
    const lines: string[] = [];

    const app = Fastify({
      logger: {
        level: 'info',
        serializers: {
          req: (request: FastifyRequest) => ({
            method: request.method,
            url: request.url.startsWith('/invite/') ? '/invite/:token' : request.url,
          }),
        },
        stream: { write: (line: string) => { lines.push(line); } },
      },
    });
    registerFormParser(app);
    registerInviteRoutes(app, {
      db, cfg: config(), throttle: new ReplyThrottle(100, 60_000),
    });

    await app.inject({ method: 'GET', url: `/invite/${token}` });

    expect(lines.join('')).not.toContain(token);
  });
});
