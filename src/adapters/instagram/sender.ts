import type { DeliveryContext, OutgoingAction, Platform } from '../../core/types.js';
import type { AccountEvents, SendResult, WebhookSource } from '../types.js';
import { parseInstagramWebhook } from './webhook.js';

const GRAPH_BASE = 'https://graph.instagram.com';
const GRAPH_VERSION = 'v23.0';

/**
 * Идентификаторы Instagram — только цифры. Проверка нужна не для красоты:
 * id приходит из тела вебхука и попадает в путь URL, а «../../me/messages»
 * в пути меняет вызываемый эндпоинт. Выражение линейное, без вложенных
 * повторений — запрет регулярных выражений из S7 касается триггеров клиента.
 */
const NUMERIC_ID = /^[0-9]{1,32}$/;

export type FetchFn = (url: string, init: RequestInit) => Promise<Response>;

interface Deps {
  fetchFn?: FetchFn;
  maxTextLength: number;
}

interface GraphRequest {
  path: string;
  body: Record<string, unknown>;
}

export class InstagramAdapter implements WebhookSource {
  readonly platform: Platform = 'instagram';
  private readonly fetchFn: FetchFn;
  private readonly maxTextLength: number;

  constructor(deps: Deps) {
    this.fetchFn = deps.fetchFn ?? ((url, init) => fetch(url, init));
    this.maxTextLength = deps.maxTextLength;
  }

  parseWebhook(body: unknown): AccountEvents[] {
    return parseInstagramWebhook(body, this.maxTextLength);
  }

  async send(
    action: OutgoingAction, delivery: DeliveryContext, token: string,
  ): Promise<SendResult> {
    const request = buildRequest(action, delivery);
    if (request === undefined) {
      return { ok: false, retry: false, reason: 'некорректный идентификатор' };
    }
    if (request === null) return { ok: true };

    return this.post(request.path, request.body, token);
  }

  private async post(path: string, payload: unknown, token: string): Promise<SendResult> {
    let response: Response;
    try {
      response = await this.fetchFn(`${GRAPH_BASE}/${GRAPH_VERSION}/${path}`, {
        method: 'POST',
        // S9: токен заголовком, а не в строке запроса — строка запроса
        // оседает в логах прокси и в отчётах об ошибках
        headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
        body: JSON.stringify(payload),
      });
    } catch {
      // S9: текст сетевой ошибки не попадает в reason — там адреса и порты,
      // а reason показывается клиенту в кабинете
      return { ok: false, retry: true, reason: 'сетевая ошибка' };
    }

    if (response.ok) return { ok: true };

    // 429 и 5xx пройдут позже; осмысленный 4xx повторять бессмысленно
    const retry = response.status === 429 || response.status >= 500;
    return { ok: false, retry, reason: `HTTP ${response.status}` };
  }
}

/**
 * undefined — идентификатор не прошёл проверку, наружу не идём.
 * null — действие вообще не требует сетевого вызова.
 */
function buildRequest(
  action: OutgoingAction, delivery: DeliveryContext,
): GraphRequest | undefined | null {
  switch (action.type) {
    case 'reply_comment': {
      const commentId = safeId(delivery.commentId);
      if (commentId === undefined) return undefined;
      return { path: `${commentId}/replies`, body: { message: action.text } };
    }
    case 'dm_the_commenter': {
      const commentId = safeId(delivery.commentId);
      if (commentId === undefined) return undefined;
      return {
        path: 'me/messages',
        body: { recipient: { comment_id: commentId }, message: { text: action.text } },
      };
    }
    case 'send_text': {
      const threadId = safeId(delivery.threadId);
      if (threadId === undefined) return undefined;
      return {
        path: 'me/messages',
        body: { recipient: { id: threadId }, message: { text: action.text } },
      };
    }
    case 'send_buttons': {
      const threadId = safeId(delivery.threadId);
      if (threadId === undefined) return undefined;
      return {
        path: 'me/messages',
        body: {
          recipient: { id: threadId },
          message: {
            text: action.text,
            quick_replies: action.buttons.map((b) => ({
              content_type: 'text', title: b.label, payload: b.payload,
            })),
          },
        },
      };
    }
    case 'notify_operator':
      // Уведомлений оператору в этом продукте нет: заявку пишет воркер в таблицу leads
      return null;
  }
}

function safeId(value: string | undefined): string | undefined {
  if (value === undefined || !NUMERIC_ID.test(value)) return undefined;
  return encodeURIComponent(value);
}
