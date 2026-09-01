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

/** `file` — документ (PDF), `image` — картинка. Тип обязан совпасть с тем,
 * под которым файл выгружали: платформа проверяет это при отправке. */
export type AttachmentKind = 'file' | 'image';

export interface AttachmentUpload {
  bytes: Buffer;
  mimeType: string;
  /** Имя для платформы. На наш диск оно не попадает — там имя сгенерировано (S16). */
  filename: string;
}

export type UploadResult =
  | { ok: true; attachmentId: string }
  | { ok: false; retry: boolean; reason: string };

/**
 * Отдельный интерфейс, а не метод `MessageSender`: у TikTok нет директа вообще,
 * значит нет и вложений. Обязательный метод заставил бы его адаптер писать
 * заглушку, которая всегда падает, — а так он просто не реализует интерфейс.
 */
export interface AttachmentSender {
  /** Выгрузка один раз на файл: дальше все отправки идут по идентификатору. */
  uploadAttachment(file: AttachmentUpload, token: string): Promise<UploadResult>;
  sendAttachment(
    attachmentId: string,
    kind: AttachmentKind,
    delivery: DeliveryContext,
    token: string,
  ): Promise<SendResult>;
}

/** PDF платформа принимает как документ, картинку — как изображение. */
export function attachmentKindOf(mimeType: string): AttachmentKind {
  return mimeType.startsWith('image/') ? 'image' : 'file';
}

export function supportsAttachments<T extends MessageSender>(
  sender: T,
): sender is T & AttachmentSender {
  return 'uploadAttachment' in sender && 'sendAttachment' in sender;
}
