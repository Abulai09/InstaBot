export type Platform = "instagram" | "tiktok";
export type EventKind = "direct_message" | "comment" | "button_click";

export interface IncomingEvent {
  platform: Platform;
  /** директ, комментарий или нажатие кнопки — от этого зависит способ ответа */
  kind: EventKind;
  externalUserId: string;
  externalThreadId: string;
  externalCommentId: string | null;
  text: string | null;
  payload: string | null;
  dedupeKey: string;
  receivedAt: Date;
}

export interface Button {
  label: string;
  payload: string;
}

export type OutgoingAction =
  | { type: "send_text"; text: string }
  | { type: "send_buttons"; text: string; buttons: Button[] }
  | { type: "reply_comment"; text: string }
  /** Ссылка на строку в нашей таблице файлов. Во что она превратится у платформы —
   * идентификатор вложения, ссылка — решает адаптер, ядро этого не знает. */
  | { type: "send_file"; fileId: string }
  /** Личное сообщение автору комментария, адресованное по комментарию: человек
   * боту ещё не писал, и до его ответа такое сообщение разрешено одно. */
  | { type: "dm_the_commenter"; text: string; buttons?: Button[] }
  | {
      type: "notify_operator";
      reason: string;
      context: Record<string, string>;
    };

export interface ConversationState {
  stepId: string | null;
  context: Map<string, string>;
  lastUserMessageAt: Date | null;
}

export function emptyState(): ConversationState {
  return { stepId: null, context: new Map(), lastUserMessageAt: null };
}

export interface DeliveryContext {
  threadId: string;
  commentId?: string;
  userId?: string;
}
