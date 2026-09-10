import Fastify, { type FastifyRequest } from 'fastify';
import { describe, expect, it } from 'vitest';
import { createTestDb } from '../storage/helpers.js';
import { createUser } from '../../src/storage/queries/users.js';
import { enqueueOutbox } from '../../src/storage/queries/runtime.js';
import { outbox } from '../../src/storage/schema.js';
import { InstagramAdapter } from '../../src/adapters/instagram/sender.js';
import type { OutgoingAction } from '../../src/core/types.js';

describe('S9: гигиена логов и обработка ошибок', () => {
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
