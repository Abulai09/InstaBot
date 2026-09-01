import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parseInstagramWebhook } from '../../../src/adapters/instagram/webhook.js';

/**
 * Тела собраны по документации Meta, а не сняты с живого вебхука: приложения
 * Meta на момент написания ещё нет. Когда появится — заменить на настоящие
 * и перезапустить эти тесты, они контрактные.
 */
function fixture(name: string): unknown {
  return JSON.parse(readFileSync(`tests/fixtures/instagram/${name}.json`, 'utf8'));
}

const LIMIT = 2000;

describe('contract: разбор вебхука Instagram', () => {
  it('комментарий превращается в событие kind=comment с id комментария', () => {
    const parsed = parseInstagramWebhook(fixture('comment'), LIMIT);

    expect(parsed).toHaveLength(1);
    expect(parsed[0]?.externalAccountId).toBe('17841400000000001');

    const event = parsed[0]?.events[0];
    expect(event?.kind).toBe('comment');
    expect(event?.platform).toBe('instagram');
    expect(event?.text).toBe('цена');
    expect(event?.externalUserId).toBe('9988776655');
    expect(event?.externalCommentId).toBe('17900000000000009');
    expect(event?.dedupeKey).toBe('ig:comment:17900000000000009');
  });

  it('директ превращается в событие kind=direct_message', () => {
    const event = parseInstagramWebhook(fixture('direct_message'), LIMIT)[0]?.events[0];

    expect(event?.kind).toBe('direct_message');
    expect(event?.text).toBe('да');
    expect(event?.externalThreadId).toBe('9988776655');
    expect(event?.externalCommentId).toBeNull();
    expect(event?.dedupeKey).toBe('ig:msg:aWc6bWlkLjE');
  });

  it('нажатие кнопки даёт kind=button_click с payload', () => {
    const event = parseInstagramWebhook(fixture('postback'), LIMIT)[0]?.events[0];

    expect(event?.kind).toBe('button_click');
    expect(event?.payload).toBe('want_price');
    expect(event?.dedupeKey).toBe('ig:postback:aWc6bWlkLjM');
  });

  it('S3: эхо-сообщение отбрасывается до очереди', () => {
    const parsed = parseInstagramWebhook(fixture('echo'), LIMIT);
    expect(parsed.flatMap((a) => a.events)).toHaveLength(0);
  });

  it('S3: комментарий самого аккаунта отбрасывается — иначе бот отвечает себе', () => {
    const parsed = parseInstagramWebhook(fixture('self_comment'), LIMIT);
    expect(parsed.flatMap((a) => a.events)).toHaveLength(0);
  });

  it('S7: текст длиннее лимита обрезается до матчинга', () => {
    const body = fixture('comment') as {
      entry: { changes: { value: { text: string } }[] }[];
    };
    const change = body.entry[0]?.changes[0];
    if (change !== undefined) change.value.text = 'ц'.repeat(5000);

    const event = parseInstagramWebhook(body, LIMIT)[0]?.events[0];
    expect(event?.text).toHaveLength(LIMIT);
  });

  it('тело неизвестной формы не роняет разбор, а даёт пустой список', () => {
    expect(parseInstagramWebhook({ мусор: true }, LIMIT)).toEqual([]);
    expect(parseInstagramWebhook(null, LIMIT)).toEqual([]);
    expect(parseInstagramWebhook('строка', LIMIT)).toEqual([]);
  });

  it('одно тело с двумя аккаунтами разделяется по владельцам', () => {
    const a = fixture('comment') as { entry: unknown[] };
    const b = fixture('direct_message') as { entry: unknown[] };
    const merged = { object: 'instagram', entry: [...a.entry, ...b.entry] };

    expect(parseInstagramWebhook(merged, LIMIT)).toHaveLength(2);
  });

  it('поле changes, не относящееся к комментариям, игнорируется', () => {
    const body = {
      object: 'instagram',
      entry: [{
        id: '17841400000000001',
        time: 1787000000,
        changes: [{ field: 'mentions', value: { id: '1', text: 'эй', from: { id: '2' } } }],
      }],
    };

    expect(parseInstagramWebhook(body, LIMIT)[0]?.events).toHaveLength(0);
  });
});
