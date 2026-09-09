import { describe, expect, it } from 'vitest';
import { TikTokAdapter } from '../../../src/adapters/tiktok/adapter.js';
import type { OutgoingAction } from '../../../src/core/types.js';

interface Call { url: string; init: RequestInit }

function spy(status = 200, payload: unknown = { code: 0, message: 'OK', data: { comments: [] } }) {
  const calls: Call[] = [];
  const fetchFn = async (url: string, init: RequestInit): Promise<Response> => {
    calls.push({ url, init });
    return new Response(JSON.stringify(payload), { status });
  };
  return { calls, fetchFn };
}

function adapterWith(fetchFn: (url: string, init: RequestInit) => Promise<Response>) {
  return new TikTokAdapter({ fetchFn, maxTextLength: 2000 });
}

describe('TikTokAdapter: опрос комментариев (pollComments)', () => {
  it('запрашивает список комментариев с заголовком Access-Token и параметром business_id', async () => {
    const { calls, fetchFn } = spy(200, {
      code: 0,
      message: 'OK',
      data: {
        comments: [
          {
            comment_id: '7200000000000000001',
            video_id: '7100000000000000001',
            user_id: '6900000000000000001',
            text: 'Какая цена?',
            create_time: 1725800000,
          },
        ],
      },
    });

    const result = await adapterWith(fetchFn).pollComments('tt-token-123', 'biz-456');

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('ожидался успех');

    expect(result.events).toHaveLength(1);
    expect(result.events[0]).toEqual({
      platform: 'tiktok',
      kind: 'comment',
      externalUserId: '6900000000000000001',
      externalThreadId: '7100000000000000001',
      externalCommentId: '7200000000000000001',
      text: 'Какая цена?',
      payload: null,
      dedupeKey: 'tiktok:comment:7200000000000000001',
      receivedAt: new Date(1725800000 * 1000),
    });

    expect(calls[0]?.url).toContain('business_id=biz-456');
    const headers = new Headers(calls[0]?.init.headers);
    expect(headers.get('access-token')).toBe('tt-token-123');
  });

  it('S9: токен не попадает в URL и в сообщение об ошибке', async () => {
    const secret = 'tt-secret-token-value';
    const fetchFn = async (): Promise<Response> => {
      throw new Error(`Connection timeout with ${secret}`);
    };

    const result = await adapterWith(fetchFn).pollComments(secret, 'biz-456');

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe('сетевая ошибка');
      expect(result.reason).not.toContain(secret);
    }
  });

  it('ошибочный статус API TikTok распознаётся как отказ', async () => {
    const { fetchFn } = spy(200, {
      code: 40001,
      message: 'Invalid access token',
    });

    const result = await adapterWith(fetchFn).pollComments('token', 'biz-456');

    expect(result).toEqual({ ok: false, retry: false, reason: 'Недействительный токен TikTok' });
  });
});

describe('TikTokAdapter: отправка ответов (send)', () => {
  it('reply_comment отправляет ответ через /business/comment/reply/', async () => {
    const { calls, fetchFn } = spy(200, { code: 0, message: 'OK' });

    const result = await adapterWith(fetchFn).send(
      { type: 'reply_comment', text: 'Спасибо за комментарий!' },
      { threadId: '7100000000000000001', commentId: '7200000000000000001' },
      'tt-token-123',
    );

    expect(result).toEqual({ ok: true });
    expect(calls[0]?.url).toBe('https://business-api.tiktok.com/open_api/v1.3/business/comment/reply/');
    expect(JSON.parse(String(calls[0]?.init.body ?? '{}'))).toEqual({
      comment_id: '7200000000000000001',
      text: 'Спасибо за комментарий!',
    });
    const headers = new Headers(calls[0]?.init.headers);
    expect(headers.get('access-token')).toBe('tt-token-123');
  });

  it('отклоняет действия директа (send_text, send_file, send_buttons, dm_the_commenter)', async () => {
    const { calls, fetchFn } = spy();
    const adapter = adapterWith(fetchFn);
    const delivery = { threadId: '7100000000000000001' };

    const sendText = await adapter.send({ type: 'send_text', text: 'в директ' }, delivery, 'токен');
    expect(sendText).toEqual({ ok: false, retry: false, reason: 'TikTok не поддерживает отправку в директ' });

    const sendFile = await adapter.send({ type: 'send_file', fileId: 'f1' }, delivery, 'токен');
    expect(sendFile).toEqual({ ok: false, retry: false, reason: 'TikTok не поддерживает отправку в директ' });

    const sendButtons = await adapter.send({ type: 'send_buttons', text: 'кнопки', buttons: [] }, delivery, 'токен');
    expect(sendButtons).toEqual({ ok: false, retry: false, reason: 'TikTok не поддерживает отправку в директ' });

    const dmCommenter = await adapter.send({ type: 'dm_the_commenter', text: 'в директ' }, delivery, 'токен');
    expect(dmCommenter).toEqual({ ok: false, retry: false, reason: 'TikTok не поддерживает отправку в директ' });

    expect(calls).toHaveLength(0);
  });

  it('notify_operator завершается успехом без сетевого запроса', async () => {
    const { calls, fetchFn } = spy();
    const result = await adapterWith(fetchFn).send(
      { type: 'notify_operator', reason: 'заявка', context: {} },
      { threadId: '7100' },
      'токен',
    );

    expect(result).toEqual({ ok: true });
    expect(calls).toHaveLength(0);
  });
});
