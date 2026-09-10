import { createHmac } from 'node:crypto';
import Fastify from 'fastify';
import { describe, expect, it } from 'vitest';
import { createTestDb } from '../storage/helpers.js';
import type { AppDb } from '../../src/storage/db.js';
import { createUser } from '../../src/storage/queries/users.js';
import { connectAccount } from '../../src/storage/queries/accounts.js';
import { takePendingEvents } from '../../src/storage/queries/runtime.js';
import { InstagramAdapter } from '../../src/adapters/instagram/sender.js';
import { registerWebhookRoutes } from '../../src/web/routes/webhooks.js';
import { loadConfig } from '../../src/config.js';

const KEY = 'a'.repeat(64);
const SECRET = 'app-secret';
const VERIFY = 'verify-token';

function config() {
  return loadConfig({
    DATABASE_URL: 'postgresql://u:p@localhost:5432/test',
    META_APP_SECRET: SECRET, META_VERIFY_TOKEN: VERIFY, CREDENTIALS_ENC_KEY: KEY,
    SESSION_SECRET: 'a'.repeat(32),
    PUBLIC_BASE_URL: 'https://bot.example.com',
  } as unknown as NodeJS.ProcessEnv);
}

function build(db: AppDb) {
  const app = Fastify();
  registerWebhookRoutes(app, {
    db, cfg: config(), source: new InstagramAdapter({ maxTextLength: 2000 }),
  });
  return app;
}

function signed(payload: unknown) {
  const raw = JSON.stringify(payload);
  return {
    payload: raw,
    headers: {
      'content-type': 'application/json',
      'x-hub-signature-256': 'sha256=' + createHmac('sha256', SECRET).update(raw).digest('hex'),
    },
  };
}

function commentBody(accountId: string, commentId = '17900000000000009') {
  return {
    object: 'instagram',
    entry: [{
      id: accountId, time: 1787000000,
      changes: [{
        field: 'comments',
        value: { id: commentId, text: 'цена', from: { id: '9988776655' } },
      }],
    }],
  };
}

describe('маршрут вебхука Instagram', () => {
  it('S2: GET с верным токеном возвращает challenge', async () => {
    const app = build(await createTestDb());
    const res = await app.inject({
      method: 'GET',
      url: `/webhooks/instagram?hub.mode=subscribe&hub.verify_token=${VERIFY}&hub.challenge=42`,
    });
    expect(res.statusCode).toBe(200);
    expect(res.body).toBe('42');
  });

  it('S2: GET с чужим токеном получает 403 без тела', async () => {
    const app = build(await createTestDb());
    const res = await app.inject({
      method: 'GET',
      url: '/webhooks/instagram?hub.mode=subscribe&hub.verify_token=чужой&hub.challenge=42',
    });
    expect(res.statusCode).toBe(403);
    expect(res.body).toBe('');
  });

  it('S1: событие с верной подписью попадает в очередь владельца', async () => {
    const db = await createTestDb();
    const userId = await createUser(db, { email: 'a@a.a', passwordHash: 'x' });
    await connectAccount(db, userId, { platform: 'instagram', externalAccountId: '17841400000000001', token: 'т' }, KEY);
    const app = build(db);

    const res = await app.inject({
      method: 'POST', url: '/webhooks/instagram',
      ...signed(commentBody('17841400000000001')),
    });

    expect(res.statusCode).toBe(200);
    const queued = await takePendingEvents(db);
    expect(queued).toHaveLength(1);
    expect(queued[0]?.userId).toBe(userId);
  });

  it('S1: подпись от чужого секрета даёт 403 и ничего не кладёт в очередь', async () => {
    const db = await createTestDb();
    const userId = await createUser(db, { email: 'b@b.b', passwordHash: 'x' });
    await connectAccount(db, userId, { platform: 'instagram', externalAccountId: '17841400000000001', token: 'т' }, KEY);
    const app = build(db);
    const raw = JSON.stringify(commentBody('17841400000000001'));

    const res = await app.inject({
      method: 'POST', url: '/webhooks/instagram', payload: raw,
      headers: {
        'content-type': 'application/json',
        'x-hub-signature-256': 'sha256=' + createHmac('sha256', 'чужой').update(raw).digest('hex'),
      },
    });

    expect(res.statusCode).toBe(403);
    expect(res.body).toBe('');
    expect(await takePendingEvents(db)).toHaveLength(0);
  });

  it('S1: запрос без заголовка подписи даёт 403', async () => {
    const app = build(await createTestDb());
    const res = await app.inject({
      method: 'POST', url: '/webhooks/instagram',
      payload: JSON.stringify(commentBody('17841400000000001')),
      headers: { 'content-type': 'application/json' },
    });
    expect(res.statusCode).toBe(403);
  });

  it('S17: событие неизвестного аккаунта отбрасывается, но ответ 200', async () => {
    const db = await createTestDb();
    const app = build(db);

    const res = await app.inject({
      method: 'POST', url: '/webhooks/instagram',
      ...signed(commentBody('99999999999999999')),
    });

    expect(res.statusCode).toBe(200);
    expect(await takePendingEvents(db)).toHaveLength(0);
  });

  it('S17: событие клиента A не попадает в очередь клиента B', async () => {
    const db = await createTestDb();
    const a = await createUser(db, { email: 'a2@a.a', passwordHash: 'x' });
    const b = await createUser(db, { email: 'b2@b.b', passwordHash: 'x' });
    await connectAccount(db, a, { platform: 'instagram', externalAccountId: '111', token: 'т' }, KEY);
    await connectAccount(db, b, { platform: 'instagram', externalAccountId: '222', token: 'т' }, KEY);
    const app = build(db);

    await app.inject({ method: 'POST', url: '/webhooks/instagram', ...signed(commentBody('111')) });

    const queued = await takePendingEvents(db);
    expect(queued).toHaveLength(1);
    expect(queued[0]?.userId).toBe(a);
    expect(queued.some((r) => r.userId === b)).toBe(false);
  });

  it('повторная доставка того же события не создаёт вторую запись', async () => {
    const db = await createTestDb();
    const userId = await createUser(db, { email: 'c@c.c', passwordHash: 'x' });
    await connectAccount(db, userId, { platform: 'instagram', externalAccountId: '17841400000000001', token: 'т' }, KEY);
    const app = build(db);
    const request = { method: 'POST' as const, url: '/webhooks/instagram', ...signed(commentBody('17841400000000001')) };

    await app.inject(request);
    await app.inject(request);

    expect(await takePendingEvents(db)).toHaveLength(1);
  });

  it('тело, которое не является JSON, не роняет обработчик', async () => {
    const db = await createTestDb();
    const app = build(db);
    const raw = 'не json';

    const res = await app.inject({
      method: 'POST', url: '/webhooks/instagram', payload: raw,
      headers: {
        'content-type': 'application/json',
        'x-hub-signature-256': 'sha256=' + createHmac('sha256', SECRET).update(raw).digest('hex'),
      },
    });

    expect(res.statusCode).toBe(200);
  });
});
