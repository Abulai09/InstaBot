import { describe, expect, it } from 'vitest';
import { InstagramAdapter } from '../../../src/adapters/instagram/sender.js';
import type { OutgoingAction } from '../../../src/core/types.js';

interface Call { url: string; init: RequestInit }

function spy(status = 200, payload: unknown = { message_id: 'ok' }) {
  const calls: Call[] = [];
  const fetchFn = async (url: string, init: RequestInit): Promise<Response> => {
    calls.push({ url, init });
    return new Response(JSON.stringify(payload), { status });
  };
  return { calls, fetchFn };
}

function adapterWith(fetchFn: (url: string, init: RequestInit) => Promise<Response>) {
  return new InstagramAdapter({ fetchFn, maxTextLength: 2000 });
}

function body(call: Call | undefined): unknown {
  return JSON.parse(String(call?.init.body ?? '{}'));
}

const text: OutgoingAction = { type: 'send_text', text: 'x' };

describe('отправка в Instagram', () => {
  it('reply_comment уходит на /{comment-id}/replies', async () => {
    const { calls, fetchFn } = spy();

    const result = await adapterWith(fetchFn).send(
      { type: 'reply_comment', text: 'Прайс в директе' },
      { threadId: '9988776655', commentId: '17900000000000009' },
      'токен',
    );

    expect(result).toEqual({ ok: true });
    expect(calls[0]?.url).toBe('https://graph.instagram.com/v23.0/17900000000000009/replies');
    expect(body(calls[0])).toEqual({ message: 'Прайс в директе' });
  });

  it('send_text уходит на /me/messages с получателем по id', async () => {
    const { calls, fetchFn } = spy();

    await adapterWith(fetchFn).send(
      { type: 'send_text', text: 'привет' }, { threadId: '9988776655' }, 'токен',
    );

    expect(calls[0]?.url).toBe('https://graph.instagram.com/v23.0/me/messages');
    expect(body(calls[0])).toEqual({
      recipient: { id: '9988776655' },
      message: { text: 'привет' },
    });
  });

  it('dm_the_commenter адресуется по comment_id, а не по id пользователя', async () => {
    const { calls, fetchFn } = spy();

    await adapterWith(fetchFn).send(
      { type: 'dm_the_commenter', text: 'Держите' },
      { threadId: '9988776655', commentId: '17900000000000009' },
      'токен',
    );

    expect(body(calls[0])).toEqual({
      recipient: { comment_id: '17900000000000009' },
      message: { text: 'Держите' },
    });
  });

  it('send_buttons уходит быстрыми ответами', async () => {
    const { calls, fetchFn } = spy();

    await adapterWith(fetchFn).send(
      { type: 'send_buttons', text: 'Что интересует?', buttons: [{ label: 'Прайс', payload: 'price' }] },
      { threadId: '9988776655' },
      'токен',
    );

    expect(body(calls[0])).toEqual({
      recipient: { id: '9988776655' },
      message: {
        text: 'Что интересует?',
        quick_replies: [{ content_type: 'text', title: 'Прайс', payload: 'price' }],
      },
    });
  });

  it('S9: токен уходит заголовком, а не в строке запроса', async () => {
    const { calls, fetchFn } = spy();
    // Токены Meta — ASCII: заголовки HTTP не принимают другого
    const secret = 'IGQWRPsecret123';

    await adapterWith(fetchFn).send(text, { threadId: '9988776655' }, secret);

    expect(calls[0]?.url).not.toContain(secret);
    expect(new Headers(calls[0]?.init.headers).get('authorization')).toBe(`Bearer ${secret}`);
  });

  it('идентификатор с путём внутри не доходит до сети', async () => {
    const { calls, fetchFn } = spy();

    const result = await adapterWith(fetchFn).send(
      { type: 'reply_comment', text: 'x' },
      { threadId: '99', commentId: '../../me/messages' },
      'токен',
    );

    expect(result).toEqual({ ok: false, retry: false, reason: 'некорректный идентификатор' });
    expect(calls).toHaveLength(0);
  });

  it('5xx и 429 повторяемы, 4xx — окончательны', async () => {
    const delivery = { threadId: '9988776655' };

    expect(await adapterWith(spy(503).fetchFn).send(text, delivery, 'т'))
      .toMatchObject({ ok: false, retry: true });
    expect(await adapterWith(spy(429).fetchFn).send(text, delivery, 'т'))
      .toMatchObject({ ok: false, retry: true });
    expect(await adapterWith(spy(400).fetchFn).send(text, delivery, 'т'))
      .toMatchObject({ ok: false, retry: false });
  });

  it('классификация ошибок Meta: окно 24 часа и недействительный токен', async () => {
    const delivery = { threadId: '9988776655' };

    const winCode10 = await adapterWith(spy(400, { error: { code: 10 } }).fetchFn).send(text, delivery, 'т');
    expect(winCode10).toEqual({ ok: false, retry: false, reason: 'Истекло 24-часовое окно ответа' });

    const winSubcode = await adapterWith(spy(400, { error: { error_subcode: 2018001 } }).fetchFn).send(text, delivery, 'т');
    expect(winSubcode).toEqual({ ok: false, retry: false, reason: 'Истекло 24-часовое окно ответа' });

    const winCode230 = await adapterWith(spy(400, { error: { code: 230 } }).fetchFn).send(text, delivery, 'т');
    expect(winCode230).toEqual({ ok: false, retry: false, reason: 'Истекло 24-часовое окно ответа' });

    const badToken = await adapterWith(spy(400, { error: { code: 190 } }).fetchFn).send(text, delivery, 'т');
    expect(badToken).toEqual({ ok: false, retry: false, reason: 'Недействительный токен аккаунта' });
  });

  it('S9: обрыв сети повторяем, и текст ошибки не попадает в reason', async () => {
    const fetchFn = async (): Promise<Response> => {
      throw new Error('connect ECONNREFUSED 10.0.0.1:443');
    };

    const result = await adapterWith(fetchFn).send(text, { threadId: '99' }, 'т');

    expect(result).toEqual({ ok: false, retry: true, reason: 'сетевая ошибка' });
  });

  it('reply_comment без commentId не отправляется', async () => {
    const { calls, fetchFn } = spy();

    const result = await adapterWith(fetchFn).send(
      { type: 'reply_comment', text: 'x' }, { threadId: '99' }, 'т',
    );

    expect(result).toMatchObject({ ok: false, retry: false });
    expect(calls).toHaveLength(0);
  });

  it('notify_operator наружу не уходит — заявку пишет воркер', async () => {
    const { calls, fetchFn } = spy();

    const result = await adapterWith(fetchFn).send(
      { type: 'notify_operator', reason: 'заявка', context: {} }, { threadId: '99' }, 'т',
    );

    expect(result).toEqual({ ok: true });
    expect(calls).toHaveLength(0);
  });

  it('адаптер разбирает вебхук тем же кодом, что и webhook.ts', () => {
    const { fetchFn } = spy();
    const parsed = adapterWith(fetchFn).parseWebhook({
      object: 'instagram',
      entry: [{
        id: '17841400000000001',
        time: 1787000000,
        changes: [{ field: 'comments', value: { id: '1790', text: 'цена', from: { id: '99' } } }],
      }],
    });

    expect(parsed[0]?.events[0]?.kind).toBe('comment');
  });
});

describe('вложения', () => {
  const pdf = {
    bytes: Buffer.from('%PDF-1.7\n'),
    mimeType: 'application/pdf',
    filename: 'чеклист.pdf',
  };

  it('выгрузка уходит на /me/message_attachments и отдаёт attachment_id', async () => {
    const { calls, fetchFn } = spy(200, { attachment_id: 'att-777' });

    const result = await adapterWith(fetchFn).uploadAttachment(pdf, 'токен');

    expect(result).toEqual({ ok: true, attachmentId: 'att-777' });
    expect(calls[0]?.url).toBe('https://graph.instagram.com/v23.0/me/message_attachments');
  });

  it('токен уходит заголовком, а не в строке запроса (S9)', async () => {
    const { calls, fetchFn } = spy(200, { attachment_id: 'att-777' });

    await adapterWith(fetchFn).uploadAttachment(pdf, 'EAAG-secret-token');

    expect(calls[0]?.url).not.toContain('EAAG-secret-token');
    const headers = new Headers(calls[0]?.init.headers);
    expect(headers.get('authorization')).toBe('Bearer EAAG-secret-token');
  });

  it('ответ без attachment_id — отказ, а не молчаливый успех', async () => {
    const { fetchFn } = spy(200, { error: { message: 'что-то не так' } });

    const result = await adapterWith(fetchFn).uploadAttachment(pdf, 'токен');

    expect(result.ok).toBe(false);
  });

  it('4xx при выгрузке не повторяется, 5xx повторяется', async () => {
    const bad = await adapterWith(spy(400, {}).fetchFn).uploadAttachment(pdf, 'токен');
    const down = await adapterWith(spy(503, {}).fetchFn).uploadAttachment(pdf, 'токен');

    expect(bad).toEqual({ ok: false, retry: false, reason: 'HTTP 400' });
    expect(down).toEqual({ ok: false, retry: true, reason: 'HTTP 503' });
  });

  it('текст ошибки платформы в reason не попадает (S9)', async () => {
    const { fetchFn } = spy(400, { error: { message: 'токен EAAG-123 истёк' } });

    const result = await adapterWith(fetchFn).uploadAttachment(pdf, 'токен');

    expect(JSON.stringify(result)).not.toContain('EAAG-123');
  });

  it('отправка по attachment_id идёт на /me/messages вложением, а не текстом', async () => {
    const { calls, fetchFn } = spy();

    const result = await adapterWith(fetchFn).sendAttachment(
      'att-777', 'file', { threadId: '9988776655' }, 'токен',
    );

    expect(result).toEqual({ ok: true });
    expect(calls[0]?.url).toBe('https://graph.instagram.com/v23.0/me/messages');
    expect(body(calls[0])).toEqual({
      recipient: { id: '9988776655' },
      message: { attachment: { type: 'file', payload: { attachment_id: 'att-777' } } },
    });
  });

  it('нечисловой тред при отправке вложения наружу не выпускает', async () => {
    const { calls, fetchFn } = spy();

    const result = await adapterWith(fetchFn).sendAttachment(
      'att-777', 'file', { threadId: '../../me/messages' }, 'токен',
    );

    expect(result.ok).toBe(false);
    expect(calls).toHaveLength(0);
  });

  it('send_file до адаптера не доходит: его разворачивает цикл доставки', async () => {
    const { calls, fetchFn } = spy();

    const result = await adapterWith(fetchFn).send(
      { type: 'send_file', fileId: 'f-1' }, { threadId: '9988776655' }, 'токен',
    );

    expect(result.ok).toBe(false);
    expect(calls).toHaveLength(0);
  });
});
