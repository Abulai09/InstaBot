import Fastify, { type FastifyRequest } from 'fastify';
import { describe, expect, it } from 'vitest';
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
});
