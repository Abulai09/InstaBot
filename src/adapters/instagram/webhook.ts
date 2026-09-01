import { z } from 'zod';
import type { IncomingEvent } from '../../core/types.js';
import type { AccountEvents } from '../types.js';

const Party = z.object({ id: z.string().min(1) });

const MessagingSchema = z.object({
  sender: Party,
  recipient: Party,
  timestamp: z.number().optional(),
  message: z.object({
    mid: z.string().min(1),
    text: z.string().optional(),
    is_echo: z.boolean().optional(),
  }).optional(),
  postback: z.object({
    mid: z.string().min(1),
    payload: z.string(),
    title: z.string().optional(),
  }).optional(),
});

const ChangeSchema = z.object({
  field: z.string(),
  value: z.object({
    id: z.string().min(1),
    text: z.string().optional(),
    from: Party,
  }),
});

const EntrySchema = z.object({
  id: z.string().min(1),
  time: z.number().optional(),
  messaging: z.array(MessagingSchema).optional(),
  changes: z.array(ChangeSchema).optional(),
});

const BodySchema = z.object({
  object: z.string(),
  entry: z.array(EntrySchema),
});

/** S7: длинный текст обрезается здесь, на границе, а не в ядре. */
function clamp(text: string | undefined, max: number): string | null {
  if (text === undefined) return null;
  return text.slice(0, max);
}

function at(ms: number | undefined, seconds: number | undefined): Date {
  if (ms !== undefined) return new Date(ms);
  if (seconds !== undefined) return new Date(seconds * 1000);
  return new Date();
}

/**
 * Тело пришло из внешней сети: подпись доказывает отправителя, но не форму.
 * Тело неизвестной формы даёт пустой список, а не исключение — иначе одна
 * непонятная нам новинка Meta положила бы приём событий всех клиентов сразу.
 */
export function parseInstagramWebhook(body: unknown, maxTextLength: number): AccountEvents[] {
  const parsed = BodySchema.safeParse(body);
  if (!parsed.success) return [];

  const result: AccountEvents[] = [];

  for (const entry of parsed.data.entry) {
    const accountId = entry.id;
    const events: IncomingEvent[] = [];

    for (const item of entry.messaging ?? []) {
      // S3: эхо — наше же сообщение, вернувшееся вебхуком. Обработать его
      // значит ответить самому себе и зациклиться, выжигая лимиты клиента
      if (item.message?.is_echo === true) continue;
      if (item.sender.id === accountId) continue;

      const when = at(item.timestamp, entry.time);

      if (item.postback !== undefined) {
        events.push({
          platform: 'instagram',
          kind: 'button_click',
          externalUserId: item.sender.id,
          externalThreadId: item.sender.id,
          externalCommentId: null,
          text: clamp(item.postback.title, maxTextLength),
          payload: item.postback.payload,
          dedupeKey: `ig:postback:${item.postback.mid}`,
          receivedAt: when,
        });
        continue;
      }

      if (item.message !== undefined) {
        events.push({
          platform: 'instagram',
          kind: 'direct_message',
          externalUserId: item.sender.id,
          externalThreadId: item.sender.id,
          externalCommentId: null,
          text: clamp(item.message.text, maxTextLength),
          payload: null,
          dedupeKey: `ig:msg:${item.message.mid}`,
          receivedAt: when,
        });
      }
    }

    for (const change of entry.changes ?? []) {
      if (change.field !== 'comments') continue;
      // S3 для комментариев: свой же комментарий под своим постом
      if (change.value.from.id === accountId) continue;

      events.push({
        platform: 'instagram',
        kind: 'comment',
        externalUserId: change.value.from.id,
        externalThreadId: change.value.from.id,
        externalCommentId: change.value.id,
        text: clamp(change.value.text, maxTextLength),
        payload: null,
        dedupeKey: `ig:comment:${change.value.id}`,
        receivedAt: at(undefined, entry.time),
      });
    }

    result.push({ externalAccountId: accountId, events });
  }
  return result;
}
