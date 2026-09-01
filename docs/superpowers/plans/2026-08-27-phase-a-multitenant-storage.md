# Фаза A — мультитенантное хранилище

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** База, в которой данные каждого клиента сервиса физически недостижимы для остальных, и зашифрованное хранение токенов платформ.

**Architecture:** SQLite через Drizzle. Каждая таблица клиентских данных содержит `user_id`; слой запросов принимает `userId` первым аргументом, так что запрос без владельца невозможно написать. Токены платформ шифруются AES-256-GCM на ключе из окружения. Ядро (`src/core/`) не затрагивается.

**Tech Stack:** TypeScript ESM, better-sqlite3 13, drizzle-orm 0.45, drizzle-kit 0.31, Zod 4, vitest 4, Node >= 20.

**Spec:** `docs/superpowers/specs/2026-08-27-saas-comment-to-dm-design.md`

## Global Constraints

- `src/core/` не содержит слов `instagram`, `tiktok`, `meta`, `fastify`, `drizzle`, `fetch(`, `process.env`, `import(`. Исключение — union `Platform` в `core/types.ts`. Проверяет `tests/core/purity.test.ts`.
- В `src/` запрещены `any`, `as unknown as`, `!` (non-null assertion). `tsconfig` строгий, включая `noUncheckedIndexedAccess`.
- `process.env` читается только в `src/config.ts`. Новая переменная окружения — три синхронные правки: `EnvSchema`, `.env.example`, тест в `tests/config.test.ts`.
- ESM: относительные импорты пишутся с расширением `.js`. Проверяет `tests/esm-imports.test.ts`.
- Секреты и ПД не логируются выше уровня `debug` (S9, S10).
- Тест пишется до реализации. Каждая задача заканчивается коммитом. Сообщения коммитов и комментарии — на русском.
- Контрольная точка фазы: `npm test`, затем `npm run typecheck`, затем `npm audit`.

---

## Task A1: Конфигурация под многопользовательский режим

Токен Instagram больше не общий: он свой у каждого клиента и лежит в БД зашифрованным. Уведомления оператору заменены таблицей заявок. Обе переменные уходят из окружения.

**Files:**
- Modify: `src/config.ts`, `.env.example`
- Test: `tests/config.test.ts`

**Interfaces:**
- Consumes: ничего
- Produces: `Config` без полей `IG_PAGE_ACCESS_TOKEN`, `OPERATOR_TELEGRAM_BOT_TOKEN`, `OPERATOR_TELEGRAM_CHAT_ID`

- [x] **Step 1: Переписать тест конфигурации**

В `tests/config.test.ts` заменить объект `valid` и добавить тест:

```ts
const valid = {
  META_APP_SECRET: 'app-secret',
  META_VERIFY_TOKEN: 'verify-token',
  CREDENTIALS_ENC_KEY: 'a'.repeat(64),
} as unknown as NodeJS.ProcessEnv;

it('не требует общий токен Instagram: он свой у каждого клиента и лежит в БД', () => {
  const cfg = loadConfig(valid);
  expect(Object.keys(cfg)).not.toContain('IG_PAGE_ACCESS_TOKEN');
});
```

- [x] **Step 2: Запустить тест, убедиться что падает**

Run: `npx vitest run tests/config.test.ts`
Expected: FAIL — `IG_PAGE_ACCESS_TOKEN` всё ещё обязателен, `loadConfig(valid)` бросает исключение.

- [x] **Step 3: Убрать переменные из схемы**

В `src/config.ts` удалить три строки: `IG_PAGE_ACCESS_TOKEN`, `OPERATOR_TELEGRAM_BOT_TOKEN`, `OPERATOR_TELEGRAM_CHAT_ID`. Остальное не трогать.

- [x] **Step 4: Убрать те же переменные из `.env.example`**

Удалить строку `IG_PAGE_ACCESS_TOKEN=` и блок `# Уведомление оператора (необязательно)` целиком.

- [x] **Step 5: Запустить тесты**

Run: `npm test`
Expected: PASS — все тесты, включая старые.

- [x] **Step 6: Коммит**

```bash
git add src/config.ts .env.example tests/config.test.ts
git commit -m "refactor(config): токены платформ переезжают в БД, убраны из окружения"
```

---

## Task A2: Шифрование секретов (S4)

**Files:**
- Create: `src/storage/crypto.ts`
- Test: `tests/storage/crypto.test.ts`

**Interfaces:**
- Consumes: ничего
- Produces: `encryptSecret(plain: string, keyHex: string): string`, `decryptSecret(packed: string, keyHex: string): string`

GCM выбран вместо CBC потому, что аутентифицирует шифротекст: подменённые байты обнаруживаются при расшифровке, а не превращаются в мусор, который код примет за токен.

- [x] **Step 1: Написать падающий тест**

`tests/storage/crypto.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { encryptSecret, decryptSecret } from '../../src/storage/crypto.js';

const key = 'a'.repeat(64);
const other = 'b'.repeat(64);

describe('шифрование секретов', () => {
  it('расшифровывает то же, что зашифровало', () => {
    const packed = encryptSecret('EAAG-token-123', key);
    expect(decryptSecret(packed, key)).toBe('EAAG-token-123');
  });

  it('S4: два шифрования одного текста дают разный результат', () => {
    expect(encryptSecret('one', key)).not.toBe(encryptSecret('one', key));
  });

  it('S4: подменённый шифротекст не расшифровывается', () => {
    const raw = Buffer.from(encryptSecret('one', key), 'base64');
    const last = raw[raw.length - 1];
    if (last === undefined) throw new Error('пустой шифротекст');
    raw[raw.length - 1] = last ^ 0xff;
    expect(() => decryptSecret(raw.toString('base64'), key)).toThrow();
  });

  it('S4: чужой ключ не расшифровывает', () => {
    const packed = encryptSecret('one', key);
    expect(() => decryptSecret(packed, other)).toThrow();
  });

  it('отвергает ключ неверной длины', () => {
    expect(() => encryptSecret('one', 'abcd')).toThrow(/ключ/i);
  });

  it('отвергает обрезанный шифротекст', () => {
    expect(() => decryptSecret('AAAA', key)).toThrow();
  });
});
```

- [x] **Step 2: Запустить тест, убедиться что падает**

Run: `npx vitest run tests/storage/crypto.test.ts`
Expected: FAIL — модуль не найден.

- [x] **Step 3: Реализовать `src/storage/crypto.ts`**

```ts
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

/** GCM работает с 96-битным IV — это рекомендованный размер, не произвольный. */
const IV_LENGTH = 12;
/** Длина тега аутентификации GCM. */
const TAG_LENGTH = 16;
/** AES-256 требует ровно 32 байта ключа, то есть 64 hex-символа. */
const KEY_LENGTH = 32;

function toKey(keyHex: string): Buffer {
  const key = Buffer.from(keyHex, 'hex');
  if (key.length !== KEY_LENGTH) {
    // Ни в коем случае не печатаем сам ключ (S10)
    throw new Error(`Ключ шифрования должен быть ${KEY_LENGTH} байт в hex`);
  }
  return key;
}

/** Возвращает base64 от склейки IV + тег + шифротекст. */
export function encryptSecret(plain: string, keyHex: string): string {
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv('aes-256-gcm', toKey(keyHex), iv);
  const body = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), body]).toString('base64');
}

export function decryptSecret(packed: string, keyHex: string): string {
  const raw = Buffer.from(packed, 'base64');
  if (raw.length <= IV_LENGTH + TAG_LENGTH) {
    throw new Error('Повреждённый шифротекст');
  }
  const iv = raw.subarray(0, IV_LENGTH);
  const tag = raw.subarray(IV_LENGTH, IV_LENGTH + TAG_LENGTH);
  const body = raw.subarray(IV_LENGTH + TAG_LENGTH);

  const decipher = createDecipheriv('aes-256-gcm', toKey(keyHex), iv);
  // Если тег не сойдётся, final() бросит исключение — это и есть проверка подлинности
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(body), decipher.final()]).toString('utf8');
}
```

- [x] **Step 4: Запустить тест, убедиться что проходит**

Run: `npx vitest run tests/storage/crypto.test.ts`
Expected: PASS, 6 тестов.

- [x] **Step 5: Коммит**

```bash
git add src/storage/crypto.ts tests/storage/crypto.test.ts
git commit -m "feat(storage): шифрование секретов AES-256-GCM"
```

---

## Task A3: Схема БД, подключение и миграции

**Files:**
- Create: `src/storage/schema.ts`, `src/storage/db.ts`, `drizzle.config.ts`, `tests/storage/helpers.ts`
- Test: `tests/storage/schema.test.ts`

**Interfaces:**
- Consumes: ничего
- Produces: таблицы `users`, `platformAccounts`, `automations`, `automationSteps`, `files`, `leads`, `conversations`, `eventQueue`, `processedEvents`, `outbox`, `sessions`; `openDb(url: string): AppDb`; тип `AppDb`; `createTestDb(): AppDb` из хелперов

- [x] **Step 1: Написать падающий тест**

`tests/storage/schema.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { eq } from 'drizzle-orm';
import { createTestDb } from './helpers.js';
import { users, automations, processedEvents } from '../../src/storage/schema.js';

describe('схема БД', () => {
  it('хранит клиента и его воронку', () => {
    const db = createTestDb();
    db.insert(users).values({ id: 'u1', email: 'a@b.c', passwordHash: 'x', role: 'client' }).run();
    db.insert(automations).values({
      id: 'a1', userId: 'u1', name: 'Прайс', triggerType: 'contains', triggerValue: 'цена',
    }).run();

    const rows = db.select().from(automations).where(eq(automations.userId, 'u1')).all();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.enabled).toBe(true);
  });

  it('не даёт создать воронку несуществующему клиенту', () => {
    const db = createTestDb();
    expect(() =>
      db.insert(automations).values({
        id: 'a1', userId: 'ghost', name: 'x', triggerType: 'exact', triggerValue: 'y',
      }).run(),
    ).toThrow();
  });

  it('дедупликация: один dedupeKey нельзя записать дважды', () => {
    const db = createTestDb();
    db.insert(users).values({ id: 'u1', email: 'a@b.c', passwordHash: 'x', role: 'client' }).run();
    const row = { id: 'p1', userId: 'u1', dedupeKey: 'k1' };
    db.insert(processedEvents).values(row).run();
    expect(() => db.insert(processedEvents).values({ ...row, id: 'p2' }).run()).toThrow();
  });
});
```

- [x] **Step 2: Запустить тест, убедиться что падает**

Run: `npx vitest run tests/storage/schema.test.ts`
Expected: FAIL — модули не найдены.

- [x] **Step 3: Реализовать `src/storage/schema.ts`**

```ts
import { sqliteTable, text, integer, index, uniqueIndex } from 'drizzle-orm/sqlite-core';

/** Клиент сервиса. `owner` — владелец сервиса, у него доступ к админке. */
export const users = sqliteTable('users', {
  id: text('id').primaryKey(),
  email: text('email').notNull(),
  passwordHash: text('password_hash').notNull(),
  role: text('role', { enum: ['client', 'owner'] }).notNull().default('client'),
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

export const automationSteps = sqliteTable('automation_steps', {
  id: text('id').primaryKey(),
  automationId: text('automation_id').notNull().references(() => automations.id, { onDelete: 'cascade' }),
  position: integer('position').notNull(),
  say: text('say').notNull(),
  fileId: text('file_id').references(() => files.id, { onDelete: 'set null' }),
  saveReplyAs: text('save_reply_as'),
  buttonsJson: text('buttons_json'),
}, (t) => [index('automation_steps_automation_idx').on(t.automationId, t.position)]);

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
  uniqueIndex('conversations_thread_idx').on(t.userId, t.platform, t.externalThreadId, t.externalUserId),
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
```

- [x] **Step 4: Реализовать `src/storage/db.ts`**

```ts
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';

export type AppDb = BetterSQLite3Database<Record<string, never>>;

/**
 * `foreign_keys` в SQLite выключен по умолчанию — без этой строки внешние ключи
 * из схемы не проверяются вообще, и «воронка несуществующего клиента» пройдёт молча.
 */
export function openDb(url: string): AppDb {
  const sqlite = new Database(url);
  sqlite.pragma('journal_mode = WAL');
  sqlite.pragma('foreign_keys = ON');
  return drizzle(sqlite);
}
```

- [x] **Step 5: Создать `drizzle.config.ts` и сгенерировать миграции**

```ts
import type { Config } from 'drizzle-kit';

export default {
  schema: './src/storage/schema.ts',
  out: './drizzle',
  dialect: 'sqlite',
} satisfies Config;
```

Run: `npx drizzle-kit generate`
Expected: появляется каталог `drizzle/` с файлом `0000_*.sql`.

- [x] **Step 6: Создать `tests/storage/helpers.ts`**

```ts
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import type { AppDb } from '../../src/storage/db.js';

/** База в памяти со свежей схемой: каждый тест получает свою, изоляция бесплатна. */
export function createTestDb(): AppDb {
  const sqlite = new Database(':memory:');
  sqlite.pragma('foreign_keys = ON');
  const db = drizzle(sqlite);
  migrate(db, { migrationsFolder: './drizzle' });
  return db;
}
```

- [x] **Step 7: Запустить тест, убедиться что проходит**

Run: `npx vitest run tests/storage/schema.test.ts`
Expected: PASS, 3 теста.

- [x] **Step 8: Коммит**

```bash
git add src/storage/schema.ts src/storage/db.ts drizzle.config.ts drizzle/ tests/storage/
git commit -m "feat(storage): схема БД с владельцем у каждой записи"
```

---

## Task A4: Клиенты и подключённые аккаунты

**Files:**
- Create: `src/storage/queries/users.ts`, `src/storage/queries/accounts.ts`
- Test: `tests/storage/queries/accounts.test.ts`

**Interfaces:**
- Consumes: `AppDb`, таблицы из Task A3; `encryptSecret`, `decryptSecret` из Task A2
- Produces:
  - `createUser(db, input: { email: string; passwordHash: string; role?: 'client' | 'owner' }): string`
  - `findUserByEmail(db, email: string): UserRow | undefined`
  - `connectAccount(db, userId: string, input: { platform: Platform; externalAccountId: string; token: string }, keyHex: string): string`
  - `listAccounts(db, userId: string): AccountRow[]`
  - `getAccountToken(db, userId: string, accountId: string, keyHex: string): string | undefined`
  - `resolveAccountOwner(db, platform: Platform, externalAccountId: string): { userId: string; accountId: string } | undefined`

`resolveAccountOwner` — единственная функция слоя без `userId` на входе: она как раз его и находит по внешнему идентификатору из вебхука. Это осознанное исключение, а не забытая фильтрация.

- [x] **Step 1: Написать падающий тест**

`tests/storage/queries/accounts.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { createTestDb } from '../helpers.js';
import { createUser } from '../../../src/storage/queries/users.js';
import {
  connectAccount, listAccounts, getAccountToken, resolveAccountOwner,
} from '../../../src/storage/queries/accounts.js';

const key = 'a'.repeat(64);

function twoClients() {
  const db = createTestDb();
  const a = createUser(db, { email: 'a@x.c', passwordHash: 'h' });
  const b = createUser(db, { email: 'b@x.c', passwordHash: 'h' });
  return { db, a, b };
}

describe('подключённые аккаунты', () => {
  it('сохраняет токен и отдаёт его обратно', () => {
    const { db, a } = twoClients();
    const id = connectAccount(db, a, { platform: 'instagram', externalAccountId: 'ig1', token: 'EAAG-1' }, key);
    expect(getAccountToken(db, a, id, key)).toBe('EAAG-1');
  });

  it('S4: токен не хранится открытым текстом', () => {
    const { db, a } = twoClients();
    connectAccount(db, a, { platform: 'instagram', externalAccountId: 'ig1', token: 'EAAG-1' }, key);
    const [row] = listAccounts(db, a);
    expect(row?.tokenEncrypted).not.toContain('EAAG-1');
  });

  it('S11: клиент не видит чужие аккаунты в списке', () => {
    const { db, a, b } = twoClients();
    connectAccount(db, a, { platform: 'instagram', externalAccountId: 'ig1', token: 't' }, key);
    expect(listAccounts(db, b)).toEqual([]);
  });

  it('S11: клиент не достаёт чужой токен по id', () => {
    const { db, a, b } = twoClients();
    const id = connectAccount(db, a, { platform: 'instagram', externalAccountId: 'ig1', token: 't' }, key);
    expect(getAccountToken(db, b, id, key)).toBeUndefined();
  });

  it('S17: находит владельца по внешнему id аккаунта', () => {
    const { db, a } = twoClients();
    const id = connectAccount(db, a, { platform: 'instagram', externalAccountId: 'ig1', token: 't' }, key);
    expect(resolveAccountOwner(db, 'instagram', 'ig1')).toEqual({ userId: a, accountId: id });
  });

  it('S17: неизвестный аккаунт не имеет владельца', () => {
    const { db } = twoClients();
    expect(resolveAccountOwner(db, 'instagram', 'ghost')).toBeUndefined();
  });
});
```

- [x] **Step 2: Запустить тест, убедиться что падает**

Run: `npx vitest run tests/storage/queries/accounts.test.ts`
Expected: FAIL — модули не найдены.

- [x] **Step 3: Реализовать `src/storage/queries/users.ts`**

```ts
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import type { AppDb } from '../db.js';
import { users } from '../schema.js';

export type UserRow = typeof users.$inferSelect;

export function createUser(
  db: AppDb,
  input: { email: string; passwordHash: string; role?: 'client' | 'owner' },
): string {
  const id = randomUUID();
  db.insert(users).values({
    id,
    email: input.email,
    passwordHash: input.passwordHash,
    role: input.role ?? 'client',
  }).run();
  return id;
}

export function findUserByEmail(db: AppDb, email: string): UserRow | undefined {
  return db.select().from(users).where(eq(users.email, email)).all()[0];
}
```

- [x] **Step 4: Реализовать `src/storage/queries/accounts.ts`**

```ts
import { randomUUID } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import type { Platform } from '../../core/types.js';
import type { AppDb } from '../db.js';
import { platformAccounts } from '../schema.js';
import { decryptSecret, encryptSecret } from '../crypto.js';

export type AccountRow = typeof platformAccounts.$inferSelect;

export function connectAccount(
  db: AppDb,
  userId: string,
  input: { platform: Platform; externalAccountId: string; token: string },
  keyHex: string,
): string {
  const id = randomUUID();
  db.insert(platformAccounts).values({
    id,
    userId,
    platform: input.platform,
    externalAccountId: input.externalAccountId,
    tokenEncrypted: encryptSecret(input.token, keyHex),
  }).run();
  return id;
}

export function listAccounts(db: AppDb, userId: string): AccountRow[] {
  return db.select().from(platformAccounts).where(eq(platformAccounts.userId, userId)).all();
}

/**
 * S11: владелец входит в условие выборки, а не проверяется отдельным `if` после неё.
 * Чужой id просто не находит строку.
 */
export function getAccountToken(
  db: AppDb,
  userId: string,
  accountId: string,
  keyHex: string,
): string | undefined {
  const row = db.select().from(platformAccounts)
    .where(and(eq(platformAccounts.id, accountId), eq(platformAccounts.userId, userId)))
    .all()[0];
  return row === undefined ? undefined : decryptSecret(row.tokenEncrypted, keyHex);
}

/**
 * S17: единственный вход без userId — здесь он и определяется, по внешнему
 * идентификатору аккаунта из вебхука. Не нашли — событие отбрасывается.
 */
export function resolveAccountOwner(
  db: AppDb,
  platform: Platform,
  externalAccountId: string,
): { userId: string; accountId: string } | undefined {
  const row = db.select().from(platformAccounts)
    .where(and(
      eq(platformAccounts.platform, platform),
      eq(platformAccounts.externalAccountId, externalAccountId),
    ))
    .all()[0];
  return row === undefined ? undefined : { userId: row.userId, accountId: row.id };
}
```

- [x] **Step 5: Запустить тест, убедиться что проходит**

Run: `npx vitest run tests/storage/queries/accounts.test.ts`
Expected: PASS, 6 тестов.

- [x] **Step 6: Коммит**

```bash
git add src/storage/queries/ tests/storage/queries/
git commit -m "feat(storage): клиенты, подключённые аккаунты, поиск владельца вебхука"
```

---

## Task A5: Воронки и сборка `Scenario`

**Files:**
- Create: `src/storage/queries/automations.ts`
- Modify: `src/core/scenario.ts` — экспорт `ScenarioSchema`, новые `ScenarioDraft` и `buildScenario`
- Test: `tests/storage/queries/automations.test.ts`, `tests/core/scenario.test.ts`

**Interfaces:**
- Consumes: `AppDb`, таблицы `automations`, `automationSteps`; `buildScenario`, `ScenarioDraft`, `Scenario` из `core/scenario.ts`
- Produces:
  - `createAutomation(db, userId, input: { name: string; triggerType: 'exact' | 'contains' | 'starts_with'; triggerValue: string; steps: NewStep[] }): string`
  - `listAutomations(db, userId): AutomationRow[]`
  - `getAutomation(db, userId, automationId): { automation: AutomationRow; steps: StepRow[] } | undefined`
  - `loadEnabledScenarios(db, userId): Scenario[]`
  - тип `NewStep = { say: string; saveReplyAs?: string; buttons?: { label: string; payload: string }[] }`

Порядок шагов задаёт `position`; поле `next` в `Scenario` вычисляется как «следующий по порядку». Клиент не должен вручную связывать шаги — форма линейная.

- [x] **Step 1: Написать падающий тест**

`tests/storage/queries/automations.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { createTestDb } from '../helpers.js';
import { createUser } from '../../../src/storage/queries/users.js';
import {
  createAutomation, listAutomations, getAutomation, loadEnabledScenarios,
} from '../../../src/storage/queries/automations.js';

function seed() {
  const db = createTestDb();
  const a = createUser(db, { email: 'a@x.c', passwordHash: 'h' });
  const b = createUser(db, { email: 'b@x.c', passwordHash: 'h' });
  const id = createAutomation(db, a, {
    name: 'Прайс',
    triggerType: 'contains',
    triggerValue: 'цена',
    steps: [
      { say: 'Какой товар?', saveReplyAs: 'product' },
      { say: 'Оставьте номер', saveReplyAs: 'phone' },
      { say: 'Спасибо!' },
    ],
  });
  return { db, a, b, id };
}

describe('воронки', () => {
  it('сохраняет шаги в заданном порядке', () => {
    const { db, a, id } = seed();
    const found = getAutomation(db, a, id);
    expect(found?.steps.map((s) => s.say)).toEqual(['Какой товар?', 'Оставьте номер', 'Спасибо!']);
  });

  it('собирает Scenario, связывая шаги по порядку', () => {
    const { db, a } = seed();
    const [scenario] = loadEnabledScenarios(db, a);
    expect(scenario?.trigger).toEqual({ type: 'contains', value: 'цена' });
    expect(scenario?.steps).toHaveLength(3);
    expect(scenario?.steps[0]?.next).toBe(scenario?.steps[1]?.id);
    expect(scenario?.steps[2]?.next).toBeUndefined();
  });

  it('S11: чужая воронка не видна в списке', () => {
    const { db, b } = seed();
    expect(listAutomations(db, b)).toEqual([]);
  });

  it('S11: чужую воронку нельзя достать по id', () => {
    const { db, b, id } = seed();
    expect(getAutomation(db, b, id)).toBeUndefined();
  });

  it('S11: чужие воронки не попадают в исполняемые сценарии', () => {
    const { db, b } = seed();
    expect(loadEnabledScenarios(db, b)).toEqual([]);
  });

  it('S6: имя переменной __proto__ отвергается при сборке сценария', () => {
    const db = createTestDb();
    const u = createUser(db, { email: 'c@x.c', passwordHash: 'h' });
    createAutomation(db, u, {
      name: 'x', triggerType: 'exact', triggerValue: 'x',
      steps: [{ say: 'привет', saveReplyAs: '__proto__' }],
    });
    expect(() => loadEnabledScenarios(db, u)).toThrow();
  });
});
```

- [x] **Step 2: Запустить тест, убедиться что падает**

Run: `npx vitest run tests/storage/queries/automations.test.ts`
Expected: FAIL — модуль не найден.

- [x] **Step 3: Перенести правило «линейной цепочки» в ядро**

«Следующий шаг — это следующий по порядку» — бизнес-правило, а не деталь хранения:
мы сознательно решили, что воронка линейная. В `storage/` его нельзя протестировать
без БД, поэтому оно живёт в ядре, а хранилище только подаёт данные.

В `src/core/scenario.ts` сделать `ScenarioSchema` экспортируемой и добавить в конец файла:

```ts
/** Черновик воронки: то, что дал пользователь, до связывания шагов и валидации. */
export interface ScenarioDraft {
  id: string;
  trigger: { type: string; value: string };
  steps: {
    id: string;
    say: string;
    saveReplyAs?: string | null;
    buttons?: unknown;
  }[];
}

/**
 * Собирает исполняемый `Scenario` из черновика: связывает шаги по порядку
 * (воронка линейная — ветвлений в v1 нет) и валидирует результат той же схемой,
 * что и YAML. Чистая функция: ни БД, ни сети.
 */
export function buildScenario(draft: ScenarioDraft): Scenario {
  const raw = {
    id: draft.id,
    trigger: draft.trigger,
    steps: draft.steps.map((step, i) => {
      const following = draft.steps[i + 1];
      return {
        id: step.id,
        say: step.say,
        ...(step.saveReplyAs === null || step.saveReplyAs === undefined
          ? {}
          : { save_reply_as: step.saveReplyAs }),
        ...(following === undefined ? {} : { next: following.id }),
        ...(step.buttons === undefined ? {} : { buttons: step.buttons }),
      };
    }),
  };
  return ScenarioSchema.parse(raw);
}
```

Добавить тест в `tests/core/scenario.test.ts`:

```ts
import { buildScenario } from '../../src/core/scenario.js';

describe('buildScenario', () => {
  it('связывает шаги по порядку, последний остаётся без next', () => {
    const s = buildScenario({
      id: 'a1',
      trigger: { type: 'contains', value: 'цена' },
      steps: [
        { id: 's1', say: 'Какой товар?', saveReplyAs: 'product' },
        { id: 's2', say: 'Спасибо!' },
      ],
    });
    expect(s.steps[0]?.next).toBe('s2');
    expect(s.steps[1]?.next).toBeUndefined();
  });

  it('S6: отвергает __proto__ как имя переменной', () => {
    expect(() => buildScenario({
      id: 'a1',
      trigger: { type: 'exact', value: 'x' },
      steps: [{ id: 's1', say: 'привет', saveReplyAs: '__proto__' }],
    })).toThrow();
  });
});
```

- [x] **Step 4: Реализовать `src/storage/queries/automations.ts`**

```ts
import { randomUUID } from 'node:crypto';
import { and, asc, eq, inArray } from 'drizzle-orm';
import { buildScenario, type Scenario, type ScenarioDraft } from '../../core/scenario.js';
import type { AppDb } from '../db.js';
import { automations, automationSteps } from '../schema.js';

export type AutomationRow = typeof automations.$inferSelect;
export type StepRow = typeof automationSteps.$inferSelect;

export interface NewStep {
  say: string;
  saveReplyAs?: string;
  buttons?: { label: string; payload: string }[];
}

export function createAutomation(
  db: AppDb,
  userId: string,
  input: {
    name: string;
    triggerType: 'exact' | 'contains' | 'starts_with';
    triggerValue: string;
    steps: NewStep[];
  },
): string {
  const id = randomUUID();
  db.insert(automations).values({
    id,
    userId,
    name: input.name,
    triggerType: input.triggerType,
    triggerValue: input.triggerValue,
  }).run();

  input.steps.forEach((step, position) => {
    db.insert(automationSteps).values({
      id: randomUUID(),
      automationId: id,
      position,
      say: step.say,
      saveReplyAs: step.saveReplyAs ?? null,
      buttonsJson: step.buttons === undefined ? null : JSON.stringify(step.buttons),
    }).run();
  });
  return id;
}

export function listAutomations(db: AppDb, userId: string): AutomationRow[] {
  return db.select().from(automations).where(eq(automations.userId, userId)).all();
}

export function getAutomation(
  db: AppDb,
  userId: string,
  automationId: string,
): { automation: AutomationRow; steps: StepRow[] } | undefined {
  const automation = db.select().from(automations)
    .where(and(eq(automations.id, automationId), eq(automations.userId, userId)))
    .all()[0];
  if (automation === undefined) return undefined;

  const steps = db.select().from(automationSteps)
    .where(eq(automationSteps.automationId, automation.id))
    .orderBy(asc(automationSteps.position))
    .all();
  return { automation, steps };
}

/** Строка БД -> черновик для ядра. Здесь только перекладывание полей, без правил. */
function toDraft(automation: AutomationRow, steps: StepRow[]): ScenarioDraft {
  return {
    id: automation.id,
    trigger: { type: automation.triggerType, value: automation.triggerValue },
    steps: steps.map((step) => ({
      id: step.id,
      say: step.say,
      saveReplyAs: step.saveReplyAs,
      buttons: step.buttonsJson === null ? undefined : JSON.parse(step.buttonsJson),
    })),
  };
}

/**
 * Загружает воронки одним запросом за воронками и одним за всеми их шагами.
 * Запрос на каждую воронку отдельно (N+1) здесь недопустим: функция вызывается
 * на каждое входящее сообщение.
 */
export function loadEnabledScenarios(db: AppDb, userId: string): Scenario[] {
  const rows = db.select().from(automations)
    .where(and(eq(automations.userId, userId), eq(automations.enabled, true)))
    .all();
  if (rows.length === 0) return [];

  const allSteps = db.select().from(automationSteps)
    .where(inArray(automationSteps.automationId, rows.map((r) => r.id)))
    .orderBy(asc(automationSteps.position))
    .all();

  const byAutomation = new Map<string, StepRow[]>();
  for (const step of allSteps) {
    const bucket = byAutomation.get(step.automationId);
    if (bucket === undefined) byAutomation.set(step.automationId, [step]);
    else bucket.push(step);
  }

  return rows.map((automation) => buildScenario(toDraft(automation, byAutomation.get(automation.id) ?? [])));
}
```

- [x] **Step 5: Запустить тест, убедиться что проходит**

Run: `npx vitest run tests/storage/queries/automations.test.ts`
Expected: PASS, 6 тестов.

- [x] **Step 6: Коммит**

```bash
git add src/storage/queries/automations.ts src/core/scenario.ts tests/storage/queries/automations.test.ts
git commit -m "feat(storage): воронки в БД и сборка Scenario из строк"
```

---

## Task A6: Заявки

**Files:**
- Create: `src/storage/queries/leads.ts`
- Test: `tests/storage/queries/leads.test.ts`

**Interfaces:**
- Consumes: `AppDb`, таблица `leads`
- Produces:
  - `recordLead(db, userId, input: { automationId: string; platform: Platform; externalUserId: string; data: Map<string, string> }): string`
  - `listLeads(db, userId, limit?: number): LeadRow[]`
  - `leadData(row: LeadRow): Map<string, string>`

`Map` на входе и на выходе — тот же тип, что в `ConversationState` (S6). В БД сериализуется в JSON.

- [x] **Step 1: Написать падающий тест**

`tests/storage/queries/leads.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { createTestDb } from '../helpers.js';
import { createUser } from '../../../src/storage/queries/users.js';
import { createAutomation } from '../../../src/storage/queries/automations.js';
import { recordLead, listLeads, leadData } from '../../../src/storage/queries/leads.js';

function seed() {
  const db = createTestDb();
  const a = createUser(db, { email: 'a@x.c', passwordHash: 'h' });
  const b = createUser(db, { email: 'b@x.c', passwordHash: 'h' });
  const automationId = createAutomation(db, a, {
    name: 'x', triggerType: 'exact', triggerValue: 'x', steps: [{ say: 'привет' }],
  });
  recordLead(db, a, {
    automationId, platform: 'instagram', externalUserId: 'ig-user-1',
    data: new Map([['phone', '+7 999 111 22 33']]),
  });
  return { db, a, b };
}

describe('заявки', () => {
  it('сохраняет и отдаёт собранные ответы', () => {
    const { db, a } = seed();
    const [row] = listLeads(db, a);
    expect(row).toBeDefined();
    if (row === undefined) return;
    expect(leadData(row).get('phone')).toBe('+7 999 111 22 33');
  });

  it('S11: чужие заявки не видны', () => {
    const { db, b } = seed();
    expect(listLeads(db, b)).toEqual([]);
  });

  it('S6: ключ __proto__ из данных не портит прототип', () => {
    const { db, a } = seed();
    const automationId = createAutomation(db, a, {
      name: 'y', triggerType: 'exact', triggerValue: 'y', steps: [{ say: 'привет' }],
    });
    recordLead(db, a, {
      automationId, platform: 'instagram', externalUserId: 'ig-2',
      data: new Map([['__proto__', 'сломай меня']]),
    });
    const rows = listLeads(db, a);
    const target = rows.find((r) => r.externalUserId === 'ig-2');
    expect(target).toBeDefined();
    if (target === undefined) return;
    expect(leadData(target).get('__proto__')).toBe('сломай меня');
    expect(Object.prototype.toString.call({})).toBe('[object Object]');
  });
});
```

- [x] **Step 2: Запустить тест, убедиться что падает**

Run: `npx vitest run tests/storage/queries/leads.test.ts`
Expected: FAIL — модуль не найден.

- [x] **Step 3: Реализовать `src/storage/queries/leads.ts`**

```ts
import { randomUUID } from 'node:crypto';
import { desc, eq } from 'drizzle-orm';
import { z } from 'zod';
import type { Platform } from '../../core/types.js';
import type { AppDb } from '../db.js';
import { leads } from '../schema.js';

export type LeadRow = typeof leads.$inferSelect;

/** Валидируем даже свой собственный JSON: строка в БД могла быть изменена вручную. */
const DataSchema = z.record(z.string(), z.string());

export function recordLead(
  db: AppDb,
  userId: string,
  input: {
    automationId: string;
    platform: Platform;
    externalUserId: string;
    data: Map<string, string>;
  },
): string {
  const id = randomUUID();
  db.insert(leads).values({
    id,
    userId,
    automationId: input.automationId,
    platform: input.platform,
    externalUserId: input.externalUserId,
    dataJson: JSON.stringify(Object.fromEntries(input.data)),
  }).run();
  return id;
}

export function listLeads(db: AppDb, userId: string, limit = 100): LeadRow[] {
  return db.select().from(leads)
    .where(eq(leads.userId, userId))
    .orderBy(desc(leads.createdAt))
    .limit(limit)
    .all();
}

/** S6: наружу отдаём Map — ключи пришли от пользователя, литерал им доверять нельзя. */
export function leadData(row: LeadRow): Map<string, string> {
  const parsed: unknown = JSON.parse(row.dataJson);
  return new Map(Object.entries(DataSchema.parse(parsed)));
}
```

- [x] **Step 4: Запустить тест, убедиться что проходит**

Run: `npx vitest run tests/storage/queries/leads.test.ts`
Expected: PASS, 3 теста.

- [x] **Step 5: Коммит**

```bash
git add src/storage/queries/leads.ts tests/storage/queries/leads.test.ts
git commit -m "feat(storage): заявки клиента"
```

---

## Task A7: Диалоги, очередь и outbox

**Files:**
- Create: `src/storage/queries/runtime.ts`
- Test: `tests/storage/queries/runtime.test.ts`

**Interfaces:**
- Consumes: `AppDb`, таблицы `conversations`, `eventQueue`, `processedEvents`, `outbox`; `ConversationState`, `emptyState` из `core/types.ts`
- Produces:
  - `markEventSeen(db, userId, dedupeKey: string): boolean` — `false`, если событие уже было
  - `enqueueEvent(db, userId, platform: Platform, payload: unknown): string`
  - `takePendingEvents(db, limit?: number): EventRow[]`
  - `markEventProcessed(db, eventId: string): void`
  - `loadConversation(db, userId, key: ThreadKey): ConversationState`
  - `saveConversation(db, userId, key: ThreadKey, state: ConversationState): void`
  - `enqueueOutbox(db, userId, platform, action: OutgoingAction, delivery: DeliveryContext): string`
  - тип `ThreadKey = { platform: Platform; externalThreadId: string; externalUserId: string }`

`takePendingEvents` — единственная функция без `userId`: воркер обрабатывает очередь всех клиентов, но `userId` уже записан в каждой строке и дальше едет вместе с событием.

- [x] **Step 1: Написать падающий тест**

`tests/storage/queries/runtime.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { eq } from 'drizzle-orm';
import { createTestDb } from '../helpers.js';
import { outbox } from '../../../src/storage/schema.js';
import { createUser } from '../../../src/storage/queries/users.js';
import {
  markEventSeen, enqueueEvent, takePendingEvents, markEventProcessed,
  loadConversation, saveConversation, enqueueOutbox,
} from '../../../src/storage/queries/runtime.js';

const key = { platform: 'instagram', externalThreadId: 't1', externalUserId: 'u-ext' } as const;

function seed() {
  const db = createTestDb();
  const a = createUser(db, { email: 'a@x.c', passwordHash: 'h' });
  const b = createUser(db, { email: 'b@x.c', passwordHash: 'h' });
  return { db, a, b };
}

describe('очередь и диалоги', () => {
  it('дедупликация: второе появление того же ключа отвергается', () => {
    const { db, a } = seed();
    expect(markEventSeen(db, a, 'k1')).toBe(true);
    expect(markEventSeen(db, a, 'k1')).toBe(false);
  });

  it('очередь отдаёт необработанные события и закрывает их', () => {
    const { db, a } = seed();
    const id = enqueueEvent(db, a, 'instagram', { text: 'цена' });
    expect(takePendingEvents(db)).toHaveLength(1);
    markEventProcessed(db, id);
    expect(takePendingEvents(db)).toEqual([]);
  });

  it('новый диалог начинается с пустого состояния', () => {
    const { db, a } = seed();
    const state = loadConversation(db, a, key);
    expect(state.stepId).toBeNull();
    expect(state.context.size).toBe(0);
  });

  it('сохраняет и восстанавливает состояние диалога', () => {
    const { db, a } = seed();
    saveConversation(db, a, key, {
      stepId: 'ask_phone',
      context: new Map([['product', 'кроссовки']]),
      lastUserMessageAt: new Date('2026-08-27T10:00:00Z'),
    });
    const state = loadConversation(db, a, key);
    expect(state.stepId).toBe('ask_phone');
    expect(state.context.get('product')).toBe('кроссовки');
  });

  it('S11: диалог другого клиента с тем же тредом — отдельная запись', () => {
    const { db, a, b } = seed();
    saveConversation(db, a, key, {
      stepId: 'ask_phone', context: new Map(), lastUserMessageAt: null,
    });
    expect(loadConversation(db, b, key).stepId).toBeNull();
  });

  it('складывает исходящее действие в outbox неотправленным', () => {
    const { db, a } = seed();
    const id = enqueueOutbox(db, a, 'instagram',
      { type: 'send_text', text: 'привет' },
      { threadId: 't1', userId: 'u-ext' });

    const row = db.select().from(outbox).where(eq(outbox.id, id)).all()[0];
    expect(row?.attempts).toBe(0);
    expect(row?.sentAt).toBeNull();
    expect(row?.userId).toBe(a);
  });
});
```

- [x] **Step 2: Запустить тест, убедиться что падает**

Run: `npx vitest run tests/storage/queries/runtime.test.ts`
Expected: FAIL — модуль не найден.

- [x] **Step 3: Реализовать `src/storage/queries/runtime.ts`**

```ts
import { randomUUID } from 'node:crypto';
import { and, asc, eq, isNull } from 'drizzle-orm';
import { z } from 'zod';
import { emptyState, type ConversationState, type DeliveryContext, type OutgoingAction, type Platform } from '../../core/types.js';
import type { AppDb } from '../db.js';
import { conversations, eventQueue, outbox, processedEvents } from '../schema.js';

export type EventRow = typeof eventQueue.$inferSelect;

export interface ThreadKey {
  platform: Platform;
  externalThreadId: string;
  externalUserId: string;
}

const ContextSchema = z.record(z.string(), z.string());

/**
 * Обе платформы доставляют события at-least-once. Уникальный индекс по dedupeKey —
 * это и есть защита: вторая вставка падает, и мы возвращаем false вместо повторной обработки.
 */
export function markEventSeen(db: AppDb, userId: string, dedupeKey: string): boolean {
  try {
    db.insert(processedEvents).values({ id: randomUUID(), userId, dedupeKey }).run();
    return true;
  } catch {
    // Единственная ожидаемая причина — нарушение UNIQUE, то есть повтор
    return false;
  }
}

export function enqueueEvent(
  db: AppDb, userId: string, platform: Platform, payload: unknown,
): string {
  const id = randomUUID();
  db.insert(eventQueue).values({
    id, userId, platform, payloadJson: JSON.stringify(payload),
  }).run();
  return id;
}

export function takePendingEvents(db: AppDb, limit = 20): EventRow[] {
  return db.select().from(eventQueue)
    .where(isNull(eventQueue.processedAt))
    .orderBy(asc(eventQueue.createdAt))
    .limit(limit)
    .all();
}

export function markEventProcessed(db: AppDb, eventId: string): void {
  db.update(eventQueue).set({ processedAt: new Date() }).where(eq(eventQueue.id, eventId)).run();
}

function threadWhere(userId: string, key: ThreadKey) {
  return and(
    eq(conversations.userId, userId),
    eq(conversations.platform, key.platform),
    eq(conversations.externalThreadId, key.externalThreadId),
    eq(conversations.externalUserId, key.externalUserId),
  );
}

export function loadConversation(db: AppDb, userId: string, key: ThreadKey): ConversationState {
  const row = db.select().from(conversations).where(threadWhere(userId, key)).all()[0];
  if (row === undefined) return emptyState();

  const parsed: unknown = JSON.parse(row.contextJson);
  return {
    stepId: row.stepId,
    context: new Map(Object.entries(ContextSchema.parse(parsed))),
    lastUserMessageAt: row.lastUserMessageAt,
  };
}

export function saveConversation(
  db: AppDb, userId: string, key: ThreadKey, state: ConversationState,
): void {
  const existing = db.select().from(conversations).where(threadWhere(userId, key)).all()[0];
  const values = {
    stepId: state.stepId,
    contextJson: JSON.stringify(Object.fromEntries(state.context)),
    lastUserMessageAt: state.lastUserMessageAt,
  };

  if (existing === undefined) {
    db.insert(conversations).values({
      id: randomUUID(),
      userId,
      platform: key.platform,
      externalThreadId: key.externalThreadId,
      externalUserId: key.externalUserId,
      ...values,
    }).run();
    return;
  }
  db.update(conversations).set(values).where(eq(conversations.id, existing.id)).run();
}

export function enqueueOutbox(
  db: AppDb,
  userId: string,
  platform: Platform,
  action: OutgoingAction,
  delivery: DeliveryContext,
): string {
  const id = randomUUID();
  db.insert(outbox).values({
    id, userId, platform,
    actionJson: JSON.stringify(action),
    deliveryJson: JSON.stringify(delivery),
  }).run();
  return id;
}
```

- [x] **Step 4: Запустить тест, убедиться что проходит**

Run: `npx vitest run tests/storage/queries/runtime.test.ts`
Expected: PASS, 6 тестов.

- [x] **Step 5: Контрольная точка фазы**

```powershell
npm test; if ($?) { npm run typecheck }
npm audit
```

Expected: все тесты зелёные, typecheck без вывода, в `npm audit` нет уязвимостей уровня high и critical.

- [x] **Step 6: Коммит**

```bash
git add src/storage/queries/runtime.ts tests/storage/queries/runtime.test.ts
git commit -m "feat(storage): очередь событий, состояния диалогов, outbox"
```

---

## Что фаза A сознательно не делает

- **Не хеширует пароли.** `passwordHash` пока принимается как готовая строка; выбор argon2 или bcrypt и сам хеш — фаза D, где появляется вход (S13).
- **Трогает ядро в одном месте — и осознанно.** `ScenarioSchema` становится публичной, а рядом появляется `buildScenario`: правило «воронка линейная, следующий шаг — следующий по порядку» — это бизнес-решение, и держать его в слое доступа к данным нельзя. Ядро по-прежнему не знает ни про БД, ни про платформы.
- **Не поддерживает файлы в шагах.** Колонка `files` и `automation_steps.file_id` уже есть, но `Scenario` их не переносит: отправка файла — это новое действие `OutgoingAction`, и оно добавляется в фазе C вместе с выгрузкой в Meta. Раньше добавлять нечего исполнять.
- **Не удаляет старый план.** `docs/superpowers/plans/2026-08-26-multiplatform-chatbot.md` остаётся в истории; задачи 8, 9, 10, 12 оттуда переиспользуются в фазе B почти без изменений.

---

## Отклонения от плана при исполнении

Зафиксировано, чтобы план и код не расходились молча.

1. **`src/storage/jsonMap.ts` — новый файл, которого в плане не было.**
   План предлагал разбирать `data_json` и `context_json` через `z.record(z.string(), z.string())`.
   Проверка на живом коде показала, что Zod пересобирает объект присваиванием и ключ
   `__proto__` при этом **молча исчезает**: атаки нет (прототип цел), но данные заявки
   теряются. Разбор идёт через `Object.entries` + `Map.set`, что сохраняет ключ и
   остаётся безопасным. Функция общая для заявок и контекста диалога — одно правило,
   одна причина изменения.

2. **`markEventSeen` пробрасывает все ошибки, кроме нарушения UNIQUE.**
   В плане был `catch {} -> return false`, то есть любая ошибка вставки выдавалась за
   «событие уже видели». Тогда сломанная запись навсегда притворяется повтором,
   и событие тихо пропадает. Теперь проверяется код ошибки SQLite.

3. **Добавлена `setEnabled(db, userId, automationId, enabled)`** в `queries/automations.ts`:
   без неё нельзя проверить, что выключенная воронка не исполняется, и что чужую
   воронку выключить нельзя (S11 на UPDATE, а не только на SELECT).

4. **`recordLead` принимает необязательный `createdAt`.** Нужен тесту на порядок выдачи
   и повторной обработке очереди, где время события известно точнее, чем «сейчас».

5. **Тестов больше, чем в плане:** 42 против 34. Добавлены проверки уникальности email,
   роли по умолчанию, разделения платформ в `resolveAccountOwner`, переноса кнопок
   в сценарий, загрузки двух воронок одним запросом, обновления существующего диалога.
