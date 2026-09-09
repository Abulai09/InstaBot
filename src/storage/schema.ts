import { sqliteTable, text, integer, index, uniqueIndex } from 'drizzle-orm/sqlite-core';

/** Клиент сервиса. `owner` — владелец сервиса, у него доступ к админке (S12). */
export const users = sqliteTable('users', {
  id: text('id').primaryKey(),
  email: text('email').notNull(),
  passwordHash: text('password_hash').notNull(),
  role: text('role', { enum: ['client', 'owner'] }).notNull().default('client'),
  /**
   * Отключённый клиент: nullable timestamp, а не boolean — в проекте флаги
   * уже так выражены (`sent_at`, `processed_at`), и видно не только «отключён»,
   * но и когда. Отключение обратимо, удаления клиента в v1 нет.
   */
  disabledAt: integer('disabled_at', { mode: 'timestamp' }),
  createdAt: integer('created_at', { mode: 'timestamp' }).notNull().$defaultFn(() => new Date()),
}, (t) => [uniqueIndex('users_email_idx').on(t.email)]);

/** Подключённый аккаунт платформы. Токен хранится зашифрованным (S4). */
export const platformAccounts = sqliteTable('platform_accounts', {
  id: text('id').primaryKey(),
  userId: text('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  platform: text('platform', { enum: ['instagram', 'tiktok'] }).notNull(),
  externalAccountId: text('external_account_id').notNull(),
  tokenEncrypted: text('token_encrypted').notNull(),
  createdAt: integer('created_at', { mode: 'timestamp' }).notNull().$defaultFn(() => new Date()),
}, (t) => [
  // По этому индексу ищется владелец входящего вебхука (S17)
  uniqueIndex('platform_accounts_external_idx').on(t.platform, t.externalAccountId),
  index('platform_accounts_user_idx').on(t.userId),
]);

export const automations = sqliteTable('automations', {
  id: text('id').primaryKey(),
  userId: text('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  name: text('name').notNull(),
  triggerType: text('trigger_type', { enum: ['exact', 'contains', 'starts_with'] }).notNull(),
  triggerValue: text('trigger_value').notNull(),
  enabled: integer('enabled', { mode: 'boolean' }).notNull().default(true),
  createdAt: integer('created_at', { mode: 'timestamp' }).notNull().$defaultFn(() => new Date()),
}, (t) => [index('automations_user_idx').on(t.userId)]);

export const files = sqliteTable('files', {
  id: text('id').primaryKey(),
  userId: text('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  /** Имя, которое прислал клиент. Только для показа, никогда для пути на диске (S16). */
  originalName: text('original_name').notNull(),
  storedName: text('stored_name').notNull(),
  mimeType: text('mime_type').notNull(),
  sizeBytes: integer('size_bytes').notNull(),
  /** Идентификатор от Meta, появляется после первой выгрузки. */
  attachmentId: text('attachment_id'),
  createdAt: integer('created_at', { mode: 'timestamp' }).notNull().$defaultFn(() => new Date()),
}, (t) => [index('files_user_idx').on(t.userId)]);

export const automationSteps = sqliteTable('automation_steps', {
  id: text('id').primaryKey(),
  automationId: text('automation_id').notNull().references(() => automations.id, { onDelete: 'cascade' }),
  position: integer('position').notNull(),
  say: text('say').notNull(),
  fileId: text('file_id').references(() => files.id, { onDelete: 'set null' }),
  saveReplyAs: text('save_reply_as'),
  buttonsJson: text('buttons_json'),
}, (t) => [index('automation_steps_automation_idx').on(t.automationId, t.position)]);

export const leads = sqliteTable('leads', {
  id: text('id').primaryKey(),
  userId: text('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  automationId: text('automation_id').notNull().references(() => automations.id, { onDelete: 'cascade' }),
  platform: text('platform', { enum: ['instagram', 'tiktok'] }).notNull(),
  externalUserId: text('external_user_id').notNull(),
  /** Собранные ответы: JSON-объект строка→строка. */
  dataJson: text('data_json').notNull(),
  createdAt: integer('created_at', { mode: 'timestamp' }).notNull().$defaultFn(() => new Date()),
}, (t) => [index('leads_user_idx').on(t.userId, t.createdAt)]);

export const conversations = sqliteTable('conversations', {
  id: text('id').primaryKey(),
  userId: text('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  platform: text('platform', { enum: ['instagram', 'tiktok'] }).notNull(),
  externalThreadId: text('external_thread_id').notNull(),
  externalUserId: text('external_user_id').notNull(),
  automationId: text('automation_id').references(() => automations.id, { onDelete: 'set null' }),
  stepId: text('step_id'),
  contextJson: text('context_json').notNull().default('{}'),
  lastUserMessageAt: integer('last_user_message_at', { mode: 'timestamp' }),
}, (t) => [
  uniqueIndex('conversations_thread_idx')
    .on(t.userId, t.platform, t.externalThreadId, t.externalUserId),
]);

export const eventQueue = sqliteTable('event_queue', {
  id: text('id').primaryKey(),
  userId: text('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  platform: text('platform', { enum: ['instagram', 'tiktok'] }).notNull(),
  payloadJson: text('payload_json').notNull(),
  createdAt: integer('created_at', { mode: 'timestamp' }).notNull().$defaultFn(() => new Date()),
  processedAt: integer('processed_at', { mode: 'timestamp' }),
}, (t) => [index('event_queue_pending_idx').on(t.processedAt, t.createdAt)]);

/** Обе платформы доставляют события at-least-once: UNIQUE — это и есть дедупликация. */
export const processedEvents = sqliteTable('processed_events', {
  id: text('id').primaryKey(),
  userId: text('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  dedupeKey: text('dedupe_key').notNull(),
  seenAt: integer('seen_at', { mode: 'timestamp' }).notNull().$defaultFn(() => new Date()),
}, (t) => [uniqueIndex('processed_events_key_idx').on(t.dedupeKey)]);

export const outbox = sqliteTable('outbox', {
  id: text('id').primaryKey(),
  userId: text('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  platform: text('platform', { enum: ['instagram', 'tiktok'] }).notNull(),
  actionJson: text('action_json').notNull(),
  deliveryJson: text('delivery_json').notNull(),
  attempts: integer('attempts').notNull().default(0),
  nextAttemptAt: integer('next_attempt_at', { mode: 'timestamp' }).notNull().$defaultFn(() => new Date()),
  sentAt: integer('sent_at', { mode: 'timestamp' }),
  /** Осмысленный 4xx: повторять бессмысленно, показываем клиенту. */
  failedReason: text('failed_reason'),
}, (t) => [index('outbox_pending_idx').on(t.sentAt, t.nextAttemptAt)]);

export const sessions = sqliteTable('sessions', {
  id: text('id').primaryKey(),
  userId: text('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  expiresAt: integer('expires_at', { mode: 'timestamp' }).notNull(),
  createdAt: integer('created_at', { mode: 'timestamp' }).notNull().$defaultFn(() => new Date()),
}, (t) => [index('sessions_user_idx').on(t.userId)]);

/**
 * Приглашение в кабинет. `id` — sha256 от токена, ровно как в `sessions`:
 * у строки нет второго идентификатора, который можно случайно отдать наружу,
 * а дамп базы не даёт войти ни в один кабинет (S15). Сам токен существует
 * только в ссылке, которую владелец копирует.
 */
export const invites = sqliteTable('invites', {
  id: text('id').primaryKey(),
  userId: text('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  expiresAt: integer('expires_at', { mode: 'timestamp' }).notNull(),
  usedAt: integer('used_at', { mode: 'timestamp' }),
  createdAt: integer('created_at', { mode: 'timestamp' }).notNull().$defaultFn(() => new Date()),
}, (t) => [index('invites_user_idx').on(t.userId)]);
