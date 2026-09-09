import { z } from 'zod';
import type { DeliveryContext, IncomingEvent, OutgoingAction, Platform } from '../../core/types.js';
import type { PollingSource, SendResult } from '../types.js';

const TIKTOK_BASE = 'https://business-api.tiktok.com/open_api/v1.3';

export type FetchFn = (url: string, init: RequestInit) => Promise<Response>;

interface Deps {
  fetchFn?: FetchFn;
  maxTextLength: number;
}

const TikTokCommentSchema = z.object({
  comment_id: z.string(),
  video_id: z.string(),
  user_id: z.string(),
  text: z.string(),
  create_time: z.number(),
});

const TikTokCommentListResponse = z.object({
  code: z.number(),
  message: z.string(),
  data: z.object({
    comments: z.array(TikTokCommentSchema).optional(),
  }).optional(),
});

const TikTokReplyResponse = z.object({
  code: z.number(),
  message: z.string(),
});

function classifyTikTokError(code: number, status: number): { retry: boolean; reason: string } {
  if (status === 429 || status >= 500 || code >= 50000) {
    return { retry: true, reason: `HTTP ${status}` };
  }
  if (code === 40001 || code === 40002 || code === 40100) {
    return { retry: false, reason: 'Недействительный токен TikTok' };
  }
  return { retry: false, reason: `Ошибка TikTok API (${code})` };
}

export class TikTokAdapter implements PollingSource {
  readonly platform: Platform = 'tiktok';
  private readonly fetchFn: FetchFn;
  private readonly maxTextLength: number;

  constructor(deps: Deps) {
    this.fetchFn = deps.fetchFn ?? ((url, init) => fetch(url, init));
    this.maxTextLength = deps.maxTextLength;
  }

  async pollComments(
    token: string,
    businessId: string,
  ): Promise<{ ok: true; events: IncomingEvent[] } | { ok: false; retry: boolean; reason: string }> {
    const url = `${TIKTOK_BASE}/business/comment/list/?business_id=${encodeURIComponent(businessId)}`;

    let response: Response;
    try {
      response = await this.fetchFn(url, {
        method: 'GET',
        headers: {
          'access-token': token,
        },
      });
    } catch {
      return { ok: false, retry: true, reason: 'сетевая ошибка' };
    }

    if (!response.ok) {
      return { ok: false, retry: response.status === 429 || response.status >= 500, reason: `HTTP ${response.status}` };
    }

    let raw: unknown;
    try {
      raw = await response.json();
    } catch {
      return { ok: false, retry: false, reason: 'платформа вернула не JSON' };
    }

    const parsed = TikTokCommentListResponse.safeParse(raw);
    if (!parsed.success) {
      return { ok: false, retry: false, reason: 'некорректный формат ответа платформы' };
    }

    if (parsed.data.code !== 0) {
      const classified = classifyTikTokError(parsed.data.code, response.status);
      return { ok: false, retry: classified.retry, reason: classified.reason };
    }

    const comments = parsed.data.data?.comments ?? [];
    const events: IncomingEvent[] = comments.map((c) => ({
      platform: 'tiktok',
      kind: 'comment',
      externalUserId: c.user_id,
      externalThreadId: c.video_id,
      externalCommentId: c.comment_id,
      text: c.text.slice(0, this.maxTextLength),
      payload: null,
      dedupeKey: `tiktok:comment:${c.comment_id}`,
      receivedAt: new Date(c.create_time * 1000),
    }));

    return { ok: true, events };
  }

  async send(
    action: OutgoingAction,
    delivery: DeliveryContext,
    token: string,
  ): Promise<SendResult> {
    if (action.type === 'notify_operator') {
      return { ok: true };
    }

    if (action.type !== 'reply_comment') {
      return { ok: false, retry: false, reason: 'TikTok не поддерживает отправку в директ' };
    }

    if (delivery.commentId === undefined || delivery.commentId.length === 0) {
      return { ok: false, retry: false, reason: 'некорректный идентификатор' };
    }

    let response: Response;
    try {
      response = await this.fetchFn(`${TIKTOK_BASE}/business/comment/reply/`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'access-token': token,
        },
        body: JSON.stringify({
          comment_id: delivery.commentId,
          text: action.text,
        }),
      });
    } catch {
      return { ok: false, retry: true, reason: 'сетевая ошибка' };
    }

    if (!response.ok) {
      return { ok: false, retry: response.status === 429 || response.status >= 500, reason: `HTTP ${response.status}` };
    }

    let raw: unknown;
    try {
      raw = await response.json();
    } catch {
      return { ok: false, retry: false, reason: 'платформа вернула не JSON' };
    }

    const parsed = TikTokReplyResponse.safeParse(raw);
    if (!parsed.success) {
      return { ok: false, retry: false, reason: 'некорректный формат ответа платформы' };
    }

    if (parsed.data.code !== 0) {
      const classified = classifyTikTokError(parsed.data.code, response.status);
      return { ok: false, retry: classified.retry, reason: classified.reason };
    }

    return { ok: true };
  }
}
