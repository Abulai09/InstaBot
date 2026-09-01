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
  | { type: "dm_the_commenter"; text: string }
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
