import { z } from "zod";
import type { Config } from "./config.js";
import { step } from "./core/engine.js";
import type { ReplyThrottle } from "./core/throttle.js";
import type {
  DeliveryContext,
  IncomingEvent,
  OutgoingAction,
  Platform,
} from "./core/types.js";
import {
  attachmentKindOf,
  supportsAttachments,
  type MessageSender,
  type SendResult,
} from "./adapters/types.js";
import type { AppDb } from "./storage/db.js";
import { getFile, readFileBytes, setAttachmentId } from "./storage/files.js";
import { getAccountTokenForPlatform } from "./storage/queries/accounts.js";
import { loadEnabledScenarios } from "./storage/queries/automations.js";
import { recordLead } from "./storage/queries/leads.js";
import {
  deferOutbox,
  enqueueOutbox,
  loadConversation,
  markEventProcessed,
  markOutboxFailed,
  markOutboxSent,
  saveConversation,
  takeDueOutbox,
  takePendingEvents,
  type OutboxRow,
} from "./storage/queries/runtime.js";

export interface WorkerDeps {
  db: AppDb;
  cfg: Config;
  senders: Map<Platform, MessageSender>;
  throttle: ReplyThrottle;
  clientThrottle?: ReplyThrottle;
}

/** тело объекта как и в каком ввиде оно приходит к нам */
const StoredEvent = z.object({
  platform: z.enum(["instagram", "tiktok"]),
  kind: z.enum(["direct_message", "comment", "button_click"]),
  externalUserId: z.string(),
  externalThreadId: z.string(),
  externalCommentId: z.string().nullable(),
  text: z.string().nullable(),
  payload: z.string().nullable(),
  dedupeKey: z.string(),
  receivedAt: z.coerce.date(),
});

/**
 берёт новые сообщения из очереди и решает, что с ними делать по правилам автоматизации
 */
export function runIntake(deps: WorkerDeps, now: Date): number {
  const rows = takePendingEvents(deps.db, 20);
  let handled = 0;

  for (const row of rows) {
    const raw: unknown = JSON.parse(row.payloadJson);
    const parsed = StoredEvent.safeParse(raw);
    if (!parsed.success) {
      // Битую строку не разбираем повторно: иначе очередь встанет на ней навсегда
      markEventProcessed(deps.db, row.id);
      continue;
    }
    const event: IncomingEvent = parsed.data;
    const key = {
      platform: event.platform,
      externalThreadId: event.externalThreadId,
      externalUserId: event.externalUserId,
    };

    // S8 и S20: ключ включает владельца — один клиент не выжигает лимит другого
    const contact = `${row.userId}:${event.platform}:${event.externalUserId}`;
    if (!deps.throttle.allow(contact, now)) {
      markEventProcessed(deps.db, row.id);
      continue;
    }

    const scenarios = loadEnabledScenarios(deps.db, row.userId);
    const before = loadConversation(deps.db, row.userId, key);
    // Воронку запоминаем до шага: после завершения stepId станет null,
    // и по состоянию уже не понять, какая именно воронка отработала
    const runningId =
      before.stepId === null
        ? undefined
        : scenarios.find((s) => s.steps.some((st) => st.id === before.stepId))
            ?.id;

    const result = step(scenarios, before, event);
    saveConversation(deps.db, row.userId, key, result.state);

    const delivery: DeliveryContext = {
      threadId: event.externalThreadId,
      userId: event.externalUserId,
      ...(event.externalCommentId === null
        ? {}
        : { commentId: event.externalCommentId }),
    };
    // Время берётся из аргумента воркера, а не из new Date(): у цикла есть
    // собственное «сейчас», и все строки одного прогона получают его же
    for (const action of result.actions) {
      enqueueOutbox(deps.db, row.userId, event.platform, action, delivery, now);
    }

    // Воронка дошла до конца и что-то собрала — это заявка.
    // Действия notify_operator из воронок в БД не приходят: buildScenario его не выставляет.
    if (
      before.stepId !== null &&
      result.state.stepId === null &&
      runningId !== undefined &&
      result.state.context.size > 0
    ) {
      recordLead(deps.db, row.userId, {
        automationId: runningId,
        platform: event.platform,
        externalUserId: event.externalUserId,
        data: result.state.context,
        createdAt: now,
      });
    }

    markEventProcessed(deps.db, row.id);
    handled += 1;
  }
  return handled;
}

const ButtonSchema = z.object({ label: z.string(), payload: z.string() });

/**
  Проверяет, что действие, которое система собирается выполнить, является допустимым и правильно заполнено.
 */
const StoredAction = z.discriminatedUnion("type", [
  z.object({ type: z.literal("send_text"), text: z.string() }),
  z.object({
    type: z.literal("send_buttons"),
    text: z.string(),
    buttons: z.array(ButtonSchema),
  }),
  z.object({ type: z.literal("reply_comment"), text: z.string() }),
  z.object({ type: z.literal("send_file"), fileId: z.string().min(1) }),
  z.object({ type: z.literal("dm_the_commenter"), text: z.string() }),
  z.object({
    type: z.literal("notify_operator"),
    reason: z.string(),
    context: z.record(z.string(), z.string()),
  }),
]);

const StoredDelivery = z.object({
  threadId: z.string(),
  commentId: z.string().optional(),
  userId: z.string().optional(),
});

const HOUR = 3_600_000;

/** функция рассчитывает, через сколько времени повторить неудачную операцию */
function backoff(now: Date, attempts: number): Date {
  return new Date(now.getTime() + Math.min(2 ** attempts * 60_000, 6 * HOUR));
}

/**
 функция, которая отправляет файл пользователю через Instagram.
 */
async function deliverFile(
  deps: WorkerDeps,
  sender: MessageSender,
  row: OutboxRow,
  fileId: string,
  delivery: DeliveryContext,
  token: string,
): Promise<SendResult> {
  if (!supportsAttachments(sender)) {
    return { ok: false, retry: false, reason: "платформа не умеет вложения" };
  }

  // S11: файл достаётся с владельцем в условии. Воронка клиента B, ссылающаяся
  // на файл клиента A, здесь не найдёт ничего — и это единственная проверка
  const file = getFile(deps.db, row.userId, fileId);
  if (file === undefined) {
    return { ok: false, retry: false, reason: "файл не найден" };
  }

  let attachmentId = file.attachmentId;
  if (attachmentId === null) {
    let bytes: Buffer;
    try {
      bytes = readFileBytes(deps.cfg.FILES_DIR, file);
    } catch {
      // Запись есть, байтов нет: повтор не поможет, строку надо закрыть
      return { ok: false, retry: false, reason: "файл не читается" };
    }

    const uploaded = await sender.uploadAttachment(
      { bytes, mimeType: file.mimeType, filename: file.originalName },
      token,
    );
    if (!uploaded.ok) return uploaded;

    // Запоминаем до отправки: выгрузка уже состоялась, и повторять её при
    // неудачной отправке значит платить за неё второй раз
    attachmentId = uploaded.attachmentId;
    setAttachmentId(deps.db, row.userId, fileId, attachmentId);
  }

  return sender.sendAttachment(
    attachmentId,
    attachmentKindOf(file.mimeType),
    delivery,
    token,
  );
}

/** функция, которая берёт готовые ответы из очереди и реально отправляет их пользователям. */
export async function runDelivery(
  deps: WorkerDeps,
  now: Date,
): Promise<number> {
  const rows = takeDueOutbox(deps.db, now, 20);
  let delivered = 0;

  for (const row of rows) {
    const sender = deps.senders.get(row.platform);
    if (sender === undefined) {
      markOutboxFailed(deps.db, row.id, "платформа не подключена", null);
      continue;
    }

    const account = getAccountTokenForPlatform(
      deps.db,
      row.userId,
      row.platform,
      deps.cfg.CREDENTIALS_ENC_KEY,
    );
    if (account === undefined) {
      // Строка закрывается навсегда: без токена её не отправит ни одна повторная
      // попытка, а вечные ретраи забили бы очередь всех остальных клиентов
      markOutboxFailed(deps.db, row.id, "аккаунт не подключён", null);
      continue;
    }

    const rawAction: unknown = JSON.parse(row.actionJson);
    const rawDelivery: unknown = JSON.parse(row.deliveryJson);
    const action = StoredAction.safeParse(rawAction);
    const delivery = StoredDelivery.safeParse(rawDelivery);
    if (!action.success || !delivery.success) {
      markOutboxFailed(deps.db, row.id, "строка outbox повреждена", null);
      continue;
    }

    const outgoing: OutgoingAction = action.data;
    const target: DeliveryContext = delivery.data;

    // S20: троттлинг на клиента — переносим время, счётчик попыток не растёт
    if (
      deps.clientThrottle !== undefined &&
      !deps.clientThrottle.allow(row.userId, now)
    ) {
      deferOutbox(deps.db, row.id, new Date(now.getTime() + 10_000));
      continue;
    }

    // 24-часовое окно Meta для Instagram DM: если окно истекло, не ретраим
    if (
      row.platform === "instagram" &&
      outgoing.type !== "reply_comment" &&
      outgoing.type !== "dm_the_commenter"
    ) {
      const conv = loadConversation(deps.db, row.userId, {
        platform: row.platform,
        externalThreadId: target.threadId,
        externalUserId: target.userId ?? target.threadId,
      });
      if (
        conv.lastUserMessageAt !== null &&
        now.getTime() - conv.lastUserMessageAt.getTime() > 24 * 3_600_000
      ) {
        markOutboxFailed(
          deps.db,
          row.id,
          "Истекло 24-часовое окно ответа",
          null,
        );
        continue;
      }
    }

    const result =
      outgoing.type === "send_file"
        ? await deliverFile(
            deps,
            sender,
            row,
            outgoing.fileId,
            target,
            account.token,
          )
        : await sender.send(outgoing, target, account.token);

    if (result.ok) {
      markOutboxSent(deps.db, row.id);
      delivered += 1;
      continue;
    }

    // Исчерпанные попытки закрывают строку даже при повторяемой ошибке:
    // иначе недоступный аккаунт крутится в очереди бесконечно
    const exhausted = row.attempts + 1 >= deps.cfg.OUTBOX_MAX_ATTEMPTS;
    markOutboxFailed(
      deps.db,
      row.id,
      result.reason,
      result.retry && !exhausted ? backoff(now, row.attempts + 1) : null,
    );
  }
  return delivered;
}
