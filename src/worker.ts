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
  type EventRow,
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

 Вся пачка идёт одной транзакцией: `takePendingEvents` держит строки блокировкой
 `FOR UPDATE SKIP LOCKED`, а блокировка живёт только до конца транзакции. Вне её
 вторая копия процесса забрала бы те же события и обработала их дважды.
 Сети внутри нет — только БД, поэтому долгой транзакция не станет.
 */
export async function runIntake(deps: WorkerDeps, now: Date): Promise<number> {
  return deps.db.transaction(async (tx) => intakeBatch(deps, tx, now));
}

async function intakeBatch(deps: WorkerDeps, tx: AppDb, now: Date): Promise<number> {
  const rows = await takePendingEvents(tx, 20);
  let handled = 0;

  for (const row of rows) {
    // Каждая строка обрабатывается в своей точке сохранения. Без неё исключение
    // на одном событии откатывало бы всю пачку — вместе с соседями, которые уже
    // отработали, — и следующий тик снова упирался бы в ту же строку. Очередь
    // вставала бы навсегда и у всех клиентов сразу, потому что она общая
    try {
      if (await handleEvent(deps, tx, row, now)) handled += 1;
    } catch {
      // Объект ошибки не логируем: в нём тело сообщения и параметры запроса (S4, S9).
      //
      // Строка закрывается, а не оставляется на следующий круг: причина
      // детерминированная — тот же payload сломает обработку и в следующий раз.
      // Если же сломана сама база, эта пометка тоже не пройдёт, и вся пачка
      // честно откатится — событие никуда не денется
      await markEventProcessed(tx, row.id);
    }
  }
  return handled;
}

/**
 * Одно событие целиком: разбор, воронки, шаг движка, исходящие, заявка.
 * Возвращает, засчитано ли событие обработанным — отброшенное по формату
 * или по троттлингу закрывается, но в счёт не идёт.
 *
 * Вложенная транзакция внутри — это `SAVEPOINT` в Postgres, а не вторая
 * транзакция: пачку по-прежнему держит одна внешняя, а откат этой строки
 * не трогает соседей и оставляет внешнюю пригодной для работы дальше.
 */
async function handleEvent(
  deps: WorkerDeps, tx: AppDb, row: EventRow, now: Date,
): Promise<boolean> {
  return tx.transaction(async (rowTx) => {
    const raw: unknown = JSON.parse(row.payloadJson);
    const parsed = StoredEvent.safeParse(raw);
    if (!parsed.success) {
      // Битую строку не разбираем повторно: иначе очередь встанет на ней навсегда
      await markEventProcessed(rowTx, row.id);
      return false;
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
      await markEventProcessed(rowTx, row.id);
      return false;
    }

    const scenarios = await loadEnabledScenarios(rowTx, row.userId);
    const before = await loadConversation(rowTx, row.userId, key);
    // Воронку запоминаем до шага: после завершения stepId станет null,
    // и по состоянию уже не понять, какая именно воронка отработала
    const runningId =
      before.stepId === null
        ? undefined
        : scenarios.find((s) => s.steps.some((st) => st.id === before.stepId))
            ?.id;

    const result = step(scenarios, before, event);
    await saveConversation(rowTx, row.userId, key, result.state);

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
      await enqueueOutbox(rowTx, row.userId, event.platform, action, delivery, now);
    }

    // Воронка дошла до конца и что-то собрала — это заявка.
    // Действия notify_operator из воронок в БД не приходят: buildScenario его не выставляет.
    if (
      before.stepId !== null &&
      result.state.stepId === null &&
      runningId !== undefined &&
      result.state.context.size > 0
    ) {
      await recordLead(rowTx, row.userId, {
        automationId: runningId,
        platform: event.platform,
        externalUserId: event.externalUserId,
        data: result.state.context,
        createdAt: now,
      });
    }

    await markEventProcessed(rowTx, row.id);
    return true;
  });
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
  const file = await getFile(deps.db, row.userId, fileId);
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
    await setAttachmentId(deps.db, row.userId, fileId, attachmentId);
  }

  return sender.sendAttachment(
    attachmentId,
    attachmentKindOf(file.mimeType),
    delivery,
    token,
  );
}

/** JSON из строки outbox. Испорченная строка — это ответ `undefined`, а не исключение. */
function parseStoredJson(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return undefined;
  }
}

/**
 * Чем закончилась строка: ушла, закрыта навсегда или отложена до `at`.
 * Отложенная держит за собой остальные сообщения того же диалога.
 */
type RowOutcome =
  | { kind: "sent" }
  | { kind: "closed" }
  | { kind: "later"; at: Date };

const SENT: RowOutcome = { kind: "sent" };
const CLOSED: RowOutcome = { kind: "closed" };

/**
 * Диалог, которому адресована строка. Сообщения одной цепочки ставятся с одной
 * адресацией, поэтому ключ у них общий. Испорченная строка ключа не имеет —
 * её закроет `deliverRow`.
 */
function threadOf(row: OutboxRow): string | undefined {
  const delivery = StoredDelivery.safeParse(parseStoredJson(row.deliveryJson));
  return delivery.success
    ? `${row.userId}:${row.platform}:${delivery.data.threadId}`
    : undefined;
}

/** функция, которая берёт готовые ответы из очереди и реально отправляет их пользователям. */
export async function runDelivery(
  deps: WorkerDeps,
  now: Date,
): Promise<number> {
  // Строки не просто выбираются, а забираются: takeDueOutbox короткой транзакцией
  // прячет их от других копий процесса на время лизинга. Сетевые вызовы ниже идут
  // уже вне транзакции — иначе откат после успешной отправки вернул бы строку
  // в очередь, и человек получил бы то же сообщение второй раз
  const rows = await takeDueOutbox(deps.db, now, deps.cfg.OUTBOX_LEASE_SEC * 1000, 20);
  let delivered = 0;
  // Диалоги, чьё сообщение ушло на повтор, и момент этого повтора. Следующие
  // сообщения того же диалога не обгоняют его, а переносятся на тот же момент:
  // иначе после временного отказа на файле вопрос «Как вас зовут?» пришёл бы
  // раньше самого файла. `seq` среди равных времён вернёт их в прежнем порядке
  const held = new Map<string, Date>();

  for (const row of rows) {
    const thread = threadOf(row);
    const heldUntil = thread === undefined ? undefined : held.get(thread);
    if (heldUntil !== undefined) {
      await deferOutbox(deps.db, row.id, heldUntil);
      continue;
    }

    try {
      const outcome = await deliverRow(deps, row, now);
      if (outcome.kind === "sent") delivered += 1;
      if (outcome.kind === "later" && thread !== undefined) held.set(thread, outcome.at);
    } catch {
      // Исключение на одной строке не должно уносить соседей: раньше оно
      // обрывало весь цикл, строка возвращалась по истечении лизинга и снова
      // обрывала его — каждую минуту, вместе с чужими сообщениями в той же пачке.
      //
      // Причина неизвестна, поэтому строка не закрывается сразу, а идёт по тем
      // же попыткам, что и сетевая ошибка: временный сбой базы переживётся,
      // а детерминированный упрётся в OUTBOX_MAX_ATTEMPTS и закроется.
      // Если сломана сама база, эта пометка тоже бросит — и прогон честно упадёт.
      // Объект ошибки не логируем: в нём тело сообщения и токен (S4, S9)
      const exhausted = row.attempts + 1 >= deps.cfg.OUTBOX_MAX_ATTEMPTS;
      const retryAt = exhausted ? null : backoff(now, row.attempts + 1);
      await markOutboxFailed(deps.db, row.id, "внутренняя ошибка доставки", retryAt);
      if (retryAt !== null && thread !== undefined) held.set(thread, retryAt);
    }
  }
  return delivered;
}

/** Одна строка outbox. */
async function deliverRow(
  deps: WorkerDeps,
  row: OutboxRow,
  now: Date,
): Promise<RowOutcome> {
  const sender = deps.senders.get(row.platform);
  if (sender === undefined) {
    await markOutboxFailed(deps.db, row.id, "платформа не подключена", null);
    return CLOSED;
  }

  const account = await getAccountTokenForPlatform(
    deps.db,
    row.userId,
    row.platform,
    deps.cfg.CREDENTIALS_ENC_KEY,
  );
  if (account === undefined) {
    // Строка закрывается навсегда: без токена её не отправит ни одна повторная
    // попытка, а вечные ретраи забили бы очередь всех остальных клиентов
    await markOutboxFailed(deps.db, row.id, "аккаунт не подключён", null);
    return CLOSED;
  }

  const action = StoredAction.safeParse(parseStoredJson(row.actionJson));
  const delivery = StoredDelivery.safeParse(parseStoredJson(row.deliveryJson));
  if (!action.success || !delivery.success) {
    await markOutboxFailed(deps.db, row.id, "строка outbox повреждена", null);
    return CLOSED;
  }

  const outgoing: OutgoingAction = action.data;
  const target: DeliveryContext = delivery.data;

  // S20: троттлинг на клиента — переносим время, счётчик попыток не растёт
  if (
    deps.clientThrottle !== undefined &&
    !deps.clientThrottle.allow(row.userId, now)
  ) {
    const at = new Date(now.getTime() + 10_000);
    await deferOutbox(deps.db, row.id, at);
    return { kind: "later", at };
  }

  // 24-часовое окно Meta для Instagram DM: если окно истекло, не ретраим
  if (
    row.platform === "instagram" &&
    outgoing.type !== "reply_comment" &&
    outgoing.type !== "dm_the_commenter"
  ) {
    const conv = await loadConversation(deps.db, row.userId, {
      platform: row.platform,
      externalThreadId: target.threadId,
      externalUserId: target.userId ?? target.threadId,
    });
    if (
      conv.lastUserMessageAt !== null &&
      now.getTime() - conv.lastUserMessageAt.getTime() > 24 * HOUR
    ) {
      await markOutboxFailed(
        deps.db,
        row.id,
        "Истекло 24-часовое окно ответа",
        null,
      );
      return CLOSED;
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
    await markOutboxSent(deps.db, row.id);
    return SENT;
  }

  // Исчерпанные попытки закрывают строку даже при повторяемой ошибке:
  // иначе недоступный аккаунт крутится в очереди бесконечно
  const exhausted = row.attempts + 1 >= deps.cfg.OUTBOX_MAX_ATTEMPTS;
  const retryAt = result.retry && !exhausted ? backoff(now, row.attempts + 1) : null;
  await markOutboxFailed(deps.db, row.id, result.reason, retryAt);
  return retryAt === null ? CLOSED : { kind: "later", at: retryAt };
}
