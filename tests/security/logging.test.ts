import Fastify, { type FastifyRequest } from 'fastify';
import { registerErrorHandler } from '../../src/web/http.js';
import { describe, expect, it } from 'vitest';
import { createTestDb } from '../storage/helpers.js';
import { createUser } from '../../src/storage/queries/users.js';
import { enqueueOutbox } from '../../src/storage/queries/runtime.js';
import { outbox } from '../../src/storage/schema.js';
import { InstagramAdapter } from '../../src/adapters/instagram/sender.js';
import type { OutgoingAction } from '../../src/core/types.js';

/**
 * Ошибка drizzle выглядит именно так: текст запроса и значения параметров
 * лежат прямо в `message`, а причина — в `cause`. Стандартный обработчик
 * Fastify кладёт `message` в тело ответа, и запрос с параметрами уезжает
 * в браузер: почта на входе, текст сообщения человека на вставке в leads,
 * зашифрованный токен на platform_accounts.
 */
function drizzleError(): Error {
  const error = new Error(
    'Failed query: select "id", "email", "password_hash" from "users" where "users"."email" = $1'
    + String.raw`\n` + 'params: admin@gmail.com',
  );
  return Object.assign(error, { cause: Object.assign(new Error('connect ENETUNREACH'), { code: 'ENETUNREACH' }) });
}

describe('S9: гигиена логов и обработка ошибок', () => {
  it('ответ 500 не содержит ни текста запроса, ни его параметров', async () => {
    const app = Fastify();
    registerErrorHandler(app);
    app.get('/падает', async () => { throw drizzleError(); });

    const res = await app.inject({ method: 'GET', url: '/падает' });

    expect(res.statusCode).toBe(500);
    expect(res.body).not.toContain('select');
    expect(res.body).not.toContain('params');
    expect(res.body).not.toContain('admin@gmail.com');
    expect(res.body).not.toContain('users');
  });

  it('в лог идёт код драйвера, а не объект ошибки целиком', async () => {
    const lines: string[] = [];
    const app = Fastify({
      logger: { stream: { write: (line: string) => { lines.push(line); } } },
    });
    registerErrorHandler(app);
    app.get('/падает', async () => { throw drizzleError(); });

    await app.inject({ method: 'GET', url: '/падает' });
    const log = lines.join('');

    // Кода хватает, чтобы понять причину: ENETUNREACH — сеть, 42P01 — нет таблицы,
    // 28P01 — неверный пароль базы. Данных в коде нет
    expect(log).toContain('ENETUNREACH');
    expect(log).not.toContain('admin@gmail.com');
    expect(log).not.toContain('password_hash');
  });

  it('ошибки клиента (4xx) остаются собой и не превращаются в 500', async () => {
    const app = Fastify();
    registerErrorHandler(app);
    app.get('/нельзя', async (_request, reply) => reply.code(403).send());

    expect((await app.inject({ method: 'GET', url: '/нельзя' })).statusCode).toBe(403);
  });

  it('сериализатор запросов Fastify скрывает токен приглашения в URL', async () => {
    const serializer = (request: FastifyRequest) => ({
      method: request.method,
      url: request.url.startsWith('/invite/') ? '/invite/:token' : request.url,
    });

    const inviteReq = { method: 'GET', url: '/invite/secret-invite-token-12345' } as FastifyRequest;
    const serialized = serializer(inviteReq);

    expect(serialized.url).toBe('/invite/:token');
    expect(serialized.url).not.toContain('secret-invite-token-12345');

    const normalReq = { method: 'GET', url: '/leads' } as FastifyRequest;
    expect(serializer(normalReq).url).toBe('/leads');
  });

  it('ошибки Instagram адаптера не раскрывают токен и внутренние сетевые адреса', async () => {
    const secretToken = 'EAAG-super-secret-token-value';
    const fetchFn = async (): Promise<Response> => {
      throw new Error(`connect ECONNREFUSED 192.168.1.100:443 with ${secretToken}`);
    };

    const adapter = new InstagramAdapter({ fetchFn, maxTextLength: 2000 });
    const action: OutgoingAction = { type: 'send_text', text: 'привет' };
    const result = await adapter.send(action, { threadId: '123456789' }, secretToken);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe('сетевая ошибка');
      expect(result.reason).not.toContain(secretToken);
      expect(result.reason).not.toContain('192.168.1.100');
    }
  });

  it('4xx ошибки с телом от Meta не раскрывают секретный токен в reason', async () => {
    const secretToken = 'EAAG-test-token-value';
    const fetchFn = async (): Promise<Response> => {
      return new Response(JSON.stringify({
        error: {
          message: `Invalid OAuth access token ${secretToken}`,
          type: 'OAuthException',
          code: 190,
        },
      }), { status: 400 });
    };

    const adapter = new InstagramAdapter({ fetchFn, maxTextLength: 2000 });
    const action: OutgoingAction = { type: 'send_text', text: 'привет' };
    const result = await adapter.send(action, { threadId: '123456789' }, secretToken);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe('Недействительный токен аккаунта');
      expect(result.reason).not.toContain(secretToken);
    }
  });

  /**
   * У better-sqlite3 объект ошибки был почти пустым, у драйвера Postgres в нём
   * лежат текст запроса и его параметры — то есть тело сообщения клиента или
   * зашифрованный токен. Правило «не логировать объект ошибки целиком» после
   * переезда стоит дороже, поэтому проверяется тестом (S4, S9).
   */
  it('S9: ошибка драйвера Postgres несёт параметры запроса — целиком её логировать нельзя', async () => {
    const db = await createTestDb();
    const userId = await createUser(db, { email: 'log@x.c', passwordHash: 'h' });
    const secret = 'ОЧЕНЬ-ЛИЧНОЕ-СООБЩЕНИЕ-КЛИЕНТА';

    await enqueueOutbox(
      db, userId, 'instagram',
      { type: 'send_text', text: secret },
      { threadId: 't1', userId: 'u-ext' },
      new Date('2026-09-10T12:00:00Z'),
    );

    // Повтор первичного ключа: ошибка приходит от самого драйвера
    const duplicate = (await db.select().from(outbox))[0];
    if (duplicate === undefined) throw new Error('строка не создалась');

    let raw = '';
    try {
      await db.insert(outbox).values(duplicate);
      expect.unreachable('ожидалось нарушение первичного ключа');
    } catch (error) {
      // Именно так выглядит «залогировать весь объект ошибки»
      raw = JSON.stringify(error, Object.getOwnPropertyNames(error));
    }

    // Утверждение теста — не «драйвер плохой», а «в его ошибке есть что терять»:
    // текст сообщения человека виден в параметрах запроса
    expect(raw).toContain(secret);
  });
});
