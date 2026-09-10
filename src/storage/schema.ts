import { pgTable, text, integer, boolean, timestamp, index, uniqueIndex } from 'drizzle-orm/pg-core';

/**
 * Момент времени во всех таблицах: `timestamptz` с `mode: 'date'`.
 * На стороне TS остаётся `Date`, как было с секундами epoch в SQLite,
 * поэтому вызывающий код о смене типа не знает. Часовой пояс хранится
 * в самой колонке: облачная база и процесс могут жить в разных зонах.
 */
function moment(name: string) {
  return timestamp(name, { withTimezone: true, mode: 'date' });
}

/** Клиент сервиса. `owner` — владелец сервиса, у него доступ к админке (S12). */
export const users = pgTable('users', {
  id: text('id').primaryKey(),
  email: text('email').notNull(),
  passwordHash: text('password_hash').notNull(),
  role: text('role', { enum: ['client', 'owner'] }).notNull().default('client'),
  /**
   * Отключённый клиент: nullable timestamp, а не boolean — в проекте флаги
   * уже так выражены (`sent_at`, `processed_at`), и видно не только «отключён»,
   * но и когда. Отключение обратимо, удаления клиента в v1 нет.
   */
  disabledAt: moment('disabled_at'),
  createdAt: moment('created_at').notNull().$defaultFn(() => new Date()),
}, (t) => [uniqueIndex('users_email_idx').on(t.email)]);

/** Подключённый аккаунт платформы. Токен хранится зашифрованным (S4). */
export const platformAccounts = pgTable('platform_accounts', {
  id: text('id').primaryKey(),
  userId: text('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  platform: text('platform', { enum: ['instagram', 'tiktok'] }).notNull(),
  externalAccountId: text('external_account_id').notNull(),
  tokenEncrypted: text('token_encrypted').notNull(),
  createdAt: moment('created_at').notNull().$defaultFn(() => new Date()),
}, (t) => [
  // По этому индексу ищется владелец входящего вебхука (S17)
  uniqueIndex('platform_accounts_external_idx').on(t.platform, t.externalAccountId),
  index('platform_accounts_user_idx').on(t.userId),
]);

export const automations = pgTable('automations', {
  id: text('id').primaryKey(),
  userId: text('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  name: text('name').notNull(),
  triggerType: text('trigger_type', { enum: ['exact', 'contains', 'starts_with'] }).notNull(),
  triggerValue: text('trigger_value').notNull(),
  enabled: boolean('enabled').notNull().default(true),
  createdAt: moment('created_at').notNull().$defaultFn(() => new Date()),
}, (t) => [index('automations_user_idx').on(t.userId)]);

export const files = pgTable('files', {
  id: text('id').primaryKey(),
  userId: text('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  /** Имя, которое прислал клиент. Только для показа, никогда для пути на диске (S16). */
  originalName: text('original_name').notNull(),
  storedName: text('stored_name').notNull(),
  mimeType: text('mime_type').notNull(),
  sizeBytes: integer('size_bytes').notNull(),
  /** Идентификатор от Meta, появляется после первой выгрузки. */
  attachmentId: text('attachment_id'),
  createdAt: moment('created_at').notNull().$defaultFn(() => new Date()),
}, (t) => [index('files_user_idx').on(t.userId)]);

export const automationSteps = pgTable('automation_steps', {
  id: text('id').primaryKey(),
  automationId: text('automation_id').notNull().references(() => automations.id, { onDelete: 'cascade' }),
  position: integer('position').notNull(),
  say: text('say').notNull(),
  fileId: text('file_id').references(() => files.id, { onDelete: 'set null' }),
  saveReplyAs: text('save_reply_as'),
  buttonsJson: text('buttons_json'),
}, (t) => [index('automation_steps_automation_idx').on(t.automationId, t.position)]);

export const leads = pgTable('leads', {
  id: text('id').primaryKey(),
  userId: text('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  automationId: text('automation_id').notNull().references(() => automations.id, { onDelete: 'cascade' }),
  platform: text('platform', { enum: ['instagram', 'tiktok'] }).notNull(),
  externalUserId: text('external_user_id').notNull(),
  /** Собранные ответы: JSON-объект строка→строка. */
  dataJson: text('data_json').notNull(),
  createdAt: moment('created_at').notNull().$defaultFn(() => new Date()),
}, (t) => [index('leads_user_idx').on(t.userId, t.createdAt)]);

export const conversations = pgTable('conversations', {
  id: text('id').primaryKey(),
  userId: text('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  platform: text('platform', { enum: ['instagram', 'tiktok'] }).notNull(),
  externalThreadId: text('external_thread_id').notNull(),
  externalUserId: text('external_user_id').notNull(),
  automationId: text('automation_id').references(() => automations.id, { onDelete: 'set null' }),
  stepId: text('step_id'),
  contextJson: text('context_json').notNull().default('{}'),
  lastUserMessageAt: moment('last_user_message_at'),
}, (t) => [
  uniqueIndex('conversations_thread_idx')
    .on(t.userId, t.platform, t.externalThreadId, t.externalUserId),
]);

export const eventQueue = pgTable('event_queue', {
  id: text('id').primaryKey(),
  userId: text('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  platform: text('platform', { enum: ['instagram', 'tiktok'] }).notNull(),
  payloadJson: text('payload_json').notNull(),
  createdAt: moment('created_at').notNull().$defaultFn(() => new Date()),
  processedAt: moment('processed_at'),
}, (t) => [index('event_queue_pending_idx').on(t.processedAt, t.createdAt)]);

/** Обе платформы доставляют события at-least-once: UNIQUE — это и есть дедупликация. */
export const processedEvents = pgTable('processed_events', {
  id: text('id').primaryKey(),
  userId: text('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  dedupeKey: text('dedupe_key').notNull(),
  seenAt: moment('seen_at').notNull().$defaultFn(() => new Date()),
}, (t) => [uniqueIndex('processed_events_key_idx').on(t.dedupeKey)]);

export const outbox = pgTable('outbox', {
  id: text('id').primaryKey(),
  userId: text('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  platform: text('platform', { enum: ['instagram', 'tiktok'] }).notNull(),
  actionJson: text('action_json').notNull(),
  deliveryJson: text('delivery_json').notNull(),
  attempts: integer('attempts').notNull().default(0),
  /**
   * Момент, раньше которого строку не заберёт цикл доставки. Это же поле служит
   * лизингом при нескольких копиях процесса: забирая строку, воркер двигает
   * `nextAttemptAt` вперёд и коммитит — соседний воркер её уже не увидит,
   * а если первый упадёт, строка вернётся в работу сама, когда лизинг истечёт.
   */
  nextAttemptAt: moment('next_attempt_at').notNull().$defaultFn(() => new Date()),
  sentAt: moment('sent_at'),
  /** Осмысленный 4xx: повторять бессмысленно, показываем клиенту. */
  failedReason: text('failed_reason'),
}, (t) => [index('outbox_pending_idx').on(t.sentAt, t.nextAttemptAt)]);

export const sessions = pgTable('sessions', {
  id: text('id').primaryKey(),
  userId: text('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  expiresAt: moment('expires_at').notNull(),
  createdAt: moment('created_at').notNull().$defaultFn(() => new Date()),
}, (t) => [index('sessions_user_idx').on(t.userId)]);

/**
 * Приглашение в кабинет. `id` — sha256 от токена, ровно как в `sessions`:
 * у строки нет второго идентификатора, который можно случайно отдать наружу,
 * а дамп базы не даёт войти ни в один кабинет (S15). Сам токен существует
 * только в ссылке, которую владелец копирует.
 */
export const invites = pgTable('invites', {
  id: text('id').primaryKey(),
  userId: text('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  expiresAt: moment('expires_at').notNull(),
  usedAt: moment('used_at'),
  createdAt: moment('created_at').notNull().$defaultFn(() => new Date()),
}, (t) => [index('invites_user_idx').on(t.userId)]);
