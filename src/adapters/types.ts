import type {
  DeliveryContext, IncomingEvent, OutgoingAction, Platform,
} from '../core/types.js';

/**
 * Результат отправки решает судьбу строки outbox, поэтому «не получилось»
 * недостаточно: нужно знать, повторять ли. Исключением это не выразить —
 * повторяемость не свойство ошибки, а решение адаптера: только он знает,
 * что 429 у этой платформы значит «позже», а 400 — «никогда».
 */
export type SendResult =
  | { ok: true }
  | { ok: false; retry: boolean; reason: string };

export interface MessageSender {
  readonly platform: Platform;
  /** Токен передаётся аргументом: адаптер не знает про БД и не хранит секрет. */
  send(
    action: OutgoingAction,
    delivery: DeliveryContext,
    token: string,
  ): Promise<SendResult>;
}

/** Одно тело вебхука несёт события нескольких аккаунтов — значит, нескольких клиентов. */
export interface AccountEvents {
  externalAccountId: string;
  events: IncomingEvent[];
}

/**
 * Push-платформа: события приходят сами. Pull-платформы (TikTok) получат
 * отдельный интерфейс в фазе G — писать его сейчас значит завести слой
 * без единой реализации.
 */
export interface WebhookSource extends MessageSender {
  parseWebhook(body: unknown): AccountEvents[];
}
