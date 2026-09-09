import type { DeliveryContext, OutgoingAction, Platform } from '../../core/types.js';
import { z } from 'zod';
import type {
  AccountEvents, AttachmentKind, AttachmentSender, AttachmentUpload,
  SendResult, UploadResult, WebhookSource,
} from '../types.js';
import { attachmentKindOf } from '../types.js';
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

/**
 * Ответ на выгрузку вложения. Схема строгая по одному полю: пустой или чужой
 * ответ с кодом 200 должен стать отказом, иначе в базу ляжет пустой
 * attachment_id и все получатели получат битое сообщение.
 */
const UploadResponse = z.object({ attachment_id: z.string().min(1) });

export type FetchFn = (url: string, init: RequestInit) => Promise<Response>;

interface Deps {
  fetchFn?: FetchFn;
  maxTextLength: number;
}

interface GraphRequest {
  path: string;
  body: Record<string, unknown>;
}

interface MetaErrorBody {
  error?: {
    message?: string;
    type?: string;
    code?: number;
    error_subcode?: number;
  };
}

function classifyMetaError(status: number, payload: unknown): { retry: boolean; reason: string } {
  if (status === 429 || status >= 500) {
    return { retry: true, reason: `HTTP ${status}` };
  }
  if (typeof payload === 'object' && payload !== null && 'error' in payload) {
    const err = (payload as MetaErrorBody).error;
    const code = err?.code;
    const subcode = err?.error_subcode;
    if (code === 10 || subcode === 2018001 || code === 230) {
      return { retry: false, reason: 'Истекло 24-часовое окно ответа' };
    }
    if (code === 190) {
      return { retry: false, reason: 'Недействительный токен аккаунта' };
    }
  }
  return { retry: false, reason: `HTTP ${status}` };
}

export class InstagramAdapter implements WebhookSource, AttachmentSender {
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



  /**
   * Выгрузка одна на файл: платформа возвращает идентификатор, и дальше он уходит
   * тысячам получателей без повторной передачи байт (раздел 3 спеки).
   * Тело — multipart, а не JSON: файл передаётся байтами, а не строкой.
   */
  async uploadAttachment(file: AttachmentUpload, token: string): Promise<UploadResult> {
    const form = new FormData();
    form.append('message', JSON.stringify({
      attachment: { type: attachmentKindOf(file.mimeType), payload: { is_reusable: true } },
    }));
    // Uint8Array.from, а не сам Buffer: Buffer типизирован ArrayBufferLike,
    // а Blob принимает только ArrayBuffer. Копия делается один раз на файл
    form.append(
      'filedata',
      new Blob([Uint8Array.from(file.bytes)], { type: file.mimeType }),
      file.filename,
    );

    let response: Response;
    try {
      response = await this.fetchFn(`${GRAPH_BASE}/${GRAPH_VERSION}/me/message_attachments`, {
        method: 'POST',
        // content-type не ставим: его вместе с границей частей проставит FormData
        headers: { authorization: `Bearer ${token}` },
        body: form,
      });
    } catch {
      return { ok: false, retry: true, reason: 'сетевая ошибка' };
    }

    if (!response.ok) {
      let errorPayload: unknown;
      try {
        errorPayload = await response.json();
      } catch {
        errorPayload = undefined;
      }
      const classified = classifyMetaError(response.status, errorPayload);
      return { ok: false, retry: classified.retry, reason: classified.reason };
    }

    let payload: unknown;
    try {
      payload = await response.json();
    } catch {
      return { ok: false, retry: false, reason: 'платформа вернула не JSON' };
    }

    const parsed = UploadResponse.safeParse(payload);
    if (!parsed.success) {
      // 200 без идентификатора — это отказ. Считать его успехом значит запомнить
      // пустой attachment_id и молча слать битые сообщения всем получателям
      return { ok: false, retry: false, reason: 'платформа не вернула идентификатор вложения' };
    }
    return { ok: true, attachmentId: parsed.data.attachment_id };
  }

  async sendAttachment(
    attachmentId: string, kind: AttachmentKind, delivery: DeliveryContext, token: string,
  ): Promise<SendResult> {
    const threadId = safeId(delivery.threadId);
    if (threadId === undefined) {
      return { ok: false, retry: false, reason: 'некорректный идентификатор' };
    }
    return this.post('me/messages', {
      recipient: { id: threadId },
      message: { attachment: { type: kind, payload: { attachment_id: attachmentId } } },
    }, token);
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

    let errorPayload: unknown;
    try {
      errorPayload = await response.json();
    } catch {
      errorPayload = undefined;
    }

    const classified = classifyMetaError(response.status, errorPayload);
    return { ok: false, retry: classified.retry, reason: classified.reason };
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
