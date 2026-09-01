# Фаза B — Instagram сквозняком

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Комментарий живого человека под постом клиента доходит до движка и возвращается ответом в комментарий и сообщением в директ — через проверенную подпись, очередь и outbox с ретраями.

**Architecture:** Вебхук Meta принимает один HTTP-обработчик: проверяет подпись от сырых байт, определяет владельца по id аккаунта-получателя, кладёт событие в `event_queue` и отвечает `200`. Дальше работают два независимых цикла воркера: `intake` (очередь → `step()` → `outbox`) без сети и `delivery` (`outbox` → Graph API) с экспоненциальной задержкой. Ядро не меняется. Файлы в директ — фаза C, кабинет — фаза D.

**Tech Stack:** TypeScript ESM, Fastify 5, better-sqlite3 13, drizzle-orm 0.45, Zod 4, vitest 4, Node >= 20. Новых зависимостей фаза не добавляет.

**Spec:** `docs/superpowers/specs/2026-08-27-saas-comment-to-dm-design.md`

## Global Constraints

- `src/core/` не содержит слов `instagram`, `tiktok`, `meta`, `fastify`, `drizzle`, `fetch(`, `process.env`, `import(`. Исключение — union `Platform` в `core/types.ts`. Проверяет `tests/core/purity.test.ts`. **В этой фазе ядро не трогается вообще.**
- В `src/` запрещены `any`, `as unknown as`, `!` (non-null assertion). `tsconfig` строгий, включая `noUncheckedIndexedAccess`.
- `process.env` читается только в `src/config.ts`. Новая переменная окружения — три синхронные правки: `EnvSchema`, `.env.example`, тест в `tests/config.test.ts`.
- ESM: относительные импорты пишутся с расширением `.js`. Проверяет `tests/esm-imports.test.ts`.
- Владелец — первый аргумент в `src/storage/queries/`. Исключения только те, что уже задокументированы в коде, плюс новое из задачи B1 (комментарий обязателен).
- Секреты и ПД не логируются выше уровня `debug` (S9, S10). Токен доступа не логируется никогда и ни на каком уровне.
- Тест пишется до реализации. Каждая задача заканчивается коммитом. Сообщения коммитов и комментарии — на русском.
- Контрольная точка фазы: `npm test`, затем `npm run typecheck`, затем `npm audit`.
- Оболочка — Windows PowerShell 5.1: `&&` в консоли даёт синтаксическую ошибку, контрольная точка пишется как `npm test; if ($?) { npm run typecheck }`.

## Карта файлов

| Файл | Ответственность |
|---|---|
| `src/storage/queries/runtime.ts` *(правка)* | + разгребание `outbox`: взять готовые, пометить отправленным, пометить неудачей |
| `src/storage/queries/accounts.ts` *(правка)* | + токен аккаунта по владельцу и платформе (воркеру не известен `accountId`) |
| `src/adapters/types.ts` | два узких интерфейса: `MessageSender`, `WebhookSource` |
| `src/adapters/instagram/signature.ts` | S1 подпись тела, S2 GET-хендшейк — только криптография, ничего больше |
| `src/adapters/instagram/webhook.ts` | тело Meta → `IncomingEvent[]` по аккаунтам, S3 отсев эха |
| `src/adapters/instagram/sender.ts` | `OutgoingAction` → вызов Graph API, классификация ошибок |
| `src/worker.ts` | два цикла: `intake` и `delivery`; троттлинг S8, запись заявок |
| `src/web/routes/webhooks.ts` | HTTP-обвес: сырое тело, подпись, владелец, очередь, `200` |
| `src/server.ts` | сборка процесса: конфиг, БД, Fastify, таймер воркера |
| `scripts/seed.ts` | посев клиента, аккаунта и одной воронки — до появления кабинета |
| `tests/fixtures/instagram/*.json` | тела вебхуков для контрактных тестов |

Воркер и сервер лежат в корне `src/`, а не в одном из четырёх слоёв, потому что они —
composition root: место, где слои соединяются. Слой не может собирать сам себя.

---

## Task B1: Разгребание outbox

Фаза A завела таблицу `outbox` с колонками `attempts`, `next_attempt_at`, `sent_at`,
`failed_reason` и функцию `enqueueOutbox`, но не завела ни одной функции, которая
эту таблицу читает. Без них цикл доставки написать не из чего.

**Files:**
- Modify: `src/storage/queries/runtime.ts`
- Modify: `src/storage/queries/accounts.ts`
- Test: `tests/storage/queries/runtime.test.ts`, `tests/storage/queries/accounts.test.ts`

**Interfaces:**
- Consumes: `AppDb` из `src/storage/db.ts`, таблица `outbox` из `src/storage/schema.ts`, `createTestDb()` из `tests/storage/helpers.ts`
- Produces:
  - `export type OutboxRow = typeof outbox.$inferSelect`
  - `takeDueOutbox(db: AppDb, now: Date, limit?: number): OutboxRow[]`
  - `markOutboxSent(db: AppDb, id: string): void`
  - `markOutboxFailed(db: AppDb, id: string, reason: string, nextAttemptAt: Date | null): void`
  - `getAccountTokenForPlatform(db: AppDb, userId: string, platform: Platform, keyHex: string): { accountId: string; token: string } | undefined`

- [x] **Step 1: Написать падающий тест**

В `tests/storage/queries/runtime.test.ts` добавить блок:

```ts
describe('outbox: разгребание', () => {
  it('берёт только те, чьё время пришло и которые ещё не отправлены', () => {
    const db = createTestDb();
    const userId = createUser(db, { email: 'a@a.a', passwordHash: 'x' });
    const now = new Date('2026-08-28T12:00:00Z');
    const later = new Date('2026-08-28T13:00:00Z');

    const due = enqueueOutbox(db, userId, 'instagram', { type: 'send_text', text: 'да' }, { threadId: 't1' });
    const sent = enqueueOutbox(db, userId, 'instagram', { type: 'send_text', text: 'уже ушло' }, { threadId: 't2' });
    const notYet = enqueueOutbox(db, userId, 'instagram', { type: 'send_text', text: 'потом' }, { threadId: 't3' });

    markOutboxSent(db, sent);
    markOutboxFailed(db, notYet, 'сеть', later);

    const rows = takeDueOutbox(db, now);
    expect(rows.map((r) => r.id)).toEqual([due]);
  });

  it('markOutboxFailed без времени следующей попытки закрывает строку навсегда', () => {
    const db = createTestDb();
    const userId = createUser(db, { email: 'b@b.b', passwordHash: 'x' });
    const id = enqueueOutbox(db, userId, 'instagram', { type: 'send_text', text: 'плохой запрос' }, { threadId: 't1' });

    markOutboxFailed(db, id, 'HTTP 400', null);

    expect(takeDueOutbox(db, new Date('2030-01-01T00:00:00Z'))).toHaveLength(0);
  });

  it('каждая неудача увеличивает attempts', () => {
    const db = createTestDb();
    const userId = createUser(db, { email: 'c@c.c', passwordHash: 'x' });
    const id = enqueueOutbox(db, userId, 'instagram', { type: 'send_text', text: 'ретрай' }, { threadId: 't1' });
    const past = new Date('2020-01-01T00:00:00Z');

    markOutboxFailed(db, id, 'сеть', past);
    markOutboxFailed(db, id, 'сеть', past);

    const row = takeDueOutbox(db, new Date('2026-08-28T12:00:00Z'))[0];
    expect(row?.attempts).toBe(2);
  });

  it('S11: воркер видит строки обоих клиентов, но владелец едет в строке', () => {
    const db = createTestDb();
    const a = createUser(db, { email: 'a2@a.a', passwordHash: 'x' });
    const b = createUser(db, { email: 'b2@b.b', passwordHash: 'x' });
    enqueueOutbox(db, a, 'instagram', { type: 'send_text', text: 'A' }, { threadId: 't1' });
    enqueueOutbox(db, b, 'instagram', { type: 'send_text', text: 'B' }, { threadId: 't2' });

    const rows = takeDueOutbox(db, new Date('2026-08-28T12:00:00Z'));
    expect(new Set(rows.map((r) => r.userId))).toEqual(new Set([a, b]));
  });
});
```

В `tests/storage/queries/accounts.test.ts` добавить:

```ts
it('S11: токен по платформе достаётся только своему владельцу', () => {
  const db = createTestDb();
  const a = createUser(db, { email: 'own@a.a', passwordHash: 'x' });
  const b = createUser(db, { email: 'other@b.b', passwordHash: 'x' });
  connectAccount(db, a, { platform: 'instagram', externalAccountId: '178414001', token: 'секрет-A' }, KEY);

  expect(getAccountTokenForPlatform(db, a, 'instagram', KEY)?.token).toBe('секрет-A');
  expect(getAccountTokenForPlatform(db, b, 'instagram', KEY)).toBeUndefined();
});
```

Импорты новых функций дописать в существующие строки `import` обоих файлов.

- [x] **Step 2: Запустить тест, убедиться что падает**

Run: `npx vitest run tests/storage/queries/`
Expected: FAIL — `takeDueOutbox is not a function`, `getAccountTokenForPlatform is not a function`.

- [x] **Step 3: Реализовать функции outbox**

В `src/storage/queries/runtime.ts` расширить импорт до
`import { and, asc, eq, isNull, lte, sql } from 'drizzle-orm';` и дописать в конец файла:

```ts
export type OutboxRow = typeof outbox.$inferSelect;

/**
 * Без userId по той же причине, что и takePendingEvents: цикл доставки
 * разгребает исходящие всех клиентов, владелец уже записан в строке
 * и едет вместе с действием до самой отправки.
 */
export function takeDueOutbox(db: AppDb, now: Date, limit = 20): OutboxRow[] {
  return db.select().from(outbox)
    .where(and(isNull(outbox.sentAt), isNull(outbox.failedReason), lte(outbox.nextAttemptAt, now)))
    .orderBy(asc(outbox.nextAttemptAt))
    .limit(limit)
    .all();
}

/** id взят из строки, которую вернул takeDueOutbox — снаружи он не приходит. */
export function markOutboxSent(db: AppDb, id: string): void {
  db.update(outbox).set({ sentAt: new Date() }).where(eq(outbox.id, id)).run();
}

/**
 * nextAttemptAt === null — осмысленный отказ платформы: повторять бессмысленно,
 * строка закрывается и позже показывается клиенту в кабинете.
 * Иначе это временная ошибка: увеличиваем счётчик и откладываем.
 */
export function markOutboxFailed(
  db: AppDb, id: string, reason: string, nextAttemptAt: Date | null,
): void {
  db.update(outbox)
    .set({
      attempts: sql`${outbox.attempts} + 1`,
      ...(nextAttemptAt === null ? { failedReason: reason } : { nextAttemptAt }),
    })
    .where(eq(outbox.id, id))
    .run();
}
```

В `src/storage/queries/accounts.ts` дописать:

```ts
/**
 * S11: владелец в условии выборки. Воркеру известен только userId из строки outbox,
 * а не accountId — в v1 у клиента один аккаунт на платформу.
 */
export function getAccountTokenForPlatform(
  db: AppDb, userId: string, platform: Platform, keyHex: string,
): { accountId: string; token: string } | undefined {
  const row = db.select().from(platformAccounts)
    .where(and(eq(platformAccounts.userId, userId), eq(platformAccounts.platform, platform)))
    .all()[0];
  return row === undefined
    ? undefined
    : { accountId: row.id, token: decryptSecret(row.tokenEncrypted, keyHex) };
}
```

- [x] **Step 4: Запустить тест, убедиться что проходит**

Run: `npx vitest run tests/storage/queries/`
Expected: PASS.

- [x] **Step 5: Обновить CLAUDE.md**

В разделе «Обязательные правила», пункт «Владелец — первый аргумент»: заменить
«Два осознанных исключения» на «Три осознанных исключения» и добавить `takeDueOutbox`
рядом с `takePendingEvents`.

- [ ] **Step 6: Коммит**

```bash
git add src/storage/queries/runtime.ts src/storage/queries/accounts.ts tests/storage/queries/ CLAUDE.md
git commit -m "feat(storage): разгребание outbox и токен аккаунта по платформе"
```

---

## Task B2: Интерфейсы адаптеров

Два узких интерфейса вместо одного широкого: платформы отличаются способом
приёма событий (Instagram — push, TikTok — pull), но не способом отправки.
`PollingSource` в этой фазе не пишется: у него не будет реализации до фазы G,
а интерфейс без реализации — лишний слой.

**Files:**
- Create: `src/adapters/types.ts`
- Test: отдельного теста нет, проверяется `npm run typecheck`

**Interfaces:**
- Consumes: `IncomingEvent`, `OutgoingAction`, `DeliveryContext`, `Platform` из `src/core/types.js`
- Produces: `SendResult`, `MessageSender`, `AccountEvents`, `WebhookSource`

- [x] **Step 1: Создать `src/adapters/types.ts`**

```ts
import type {
  DeliveryContext, IncomingEvent, OutgoingAction, Platform,
} from '../core/types.js';

/**
 * Результат отправки решает судьбу строки outbox, поэтому «не получилось»
 * недостаточно: нужно знать, повторять ли. Исключением это выразить нельзя —
 * повторяемость не свойство ошибки, а решение адаптера.
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

export interface WebhookSource extends MessageSender {
  parseWebhook(body: unknown): AccountEvents[];
}
```

- [x] **Step 2: Проверить типы**

Run: `npm run typecheck`
Expected: без ошибок.

- [ ] **Step 3: Коммит**

```bash
git add src/adapters/types.ts
git commit -m "feat(adapters): интерфейсы MessageSender и WebhookSource"
```

---

## Task B3: Подпись Meta и GET-хендшейк (S1, S2)

Самая критичная задача фазы. Без верной проверки подписи любой человек в интернете
шлёт нам события от имени любого клиента: чужие ответы в чужие директы, ложные заявки,
выжигание лимитов API. Ошибка здесь не «баг», а открытая дверь.

**Files:**
- Create: `src/adapters/instagram/signature.ts`
- Test: `tests/adapters/instagram/signature.test.ts`

**Interfaces:**
- Consumes: `node:crypto`
- Produces:
  - `verifySignature(rawBody: Buffer, header: string | undefined, appSecret: string): boolean`
  - `verifyHandshake(query: Record<string, unknown>, verifyToken: string): string | undefined`

- [x] **Step 1: Написать падающий тест**

`tests/adapters/instagram/signature.test.ts`:

```ts
import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { verifyHandshake, verifySignature } from '../../../src/adapters/instagram/signature.js';

const SECRET = 'app-secret-для-тестов';
const body = Buffer.from(JSON.stringify({ object: 'instagram', entry: [] }), 'utf8');
const valid = 'sha256=' + createHmac('sha256', SECRET).update(body).digest('hex');

describe('S1: подпись вебхука', () => {
  it('принимает подпись, посчитанную от тех же байт', () => {
    expect(verifySignature(body, valid, SECRET)).toBe(true);
  });

  it('отвергает подпись от другого секрета', () => {
    const foreign = 'sha256=' + createHmac('sha256', 'чужой').update(body).digest('hex');
    expect(verifySignature(body, foreign, SECRET)).toBe(false);
  });

  it('отвергает подпись от изменённого тела', () => {
    const tampered = Buffer.from(JSON.stringify({ object: 'instagram', entry: [1] }), 'utf8');
    expect(verifySignature(tampered, valid, SECRET)).toBe(false);
  });

  it('отвергает отсутствующий, пустой и обрезанный заголовок', () => {
    expect(verifySignature(body, undefined, SECRET)).toBe(false);
    expect(verifySignature(body, '', SECRET)).toBe(false);
    expect(verifySignature(body, valid.slice(0, 20), SECRET)).toBe(false);
  });

  it('отвергает заголовок без префикса sha256= и с чужим алгоритмом', () => {
    expect(verifySignature(body, valid.replace('sha256=', ''), SECRET)).toBe(false);
    expect(verifySignature(body, valid.replace('sha256=', 'sha1='), SECRET)).toBe(false);
  });

  it('не падает на заголовке, который не является hex', () => {
    expect(verifySignature(body, 'sha256=зззз', SECRET)).toBe(false);
  });
});

describe('S2: GET-хендшейк', () => {
  const TOKEN = 'verify-token';

  it('возвращает challenge при совпадении токена', () => {
    const q = { 'hub.mode': 'subscribe', 'hub.verify_token': TOKEN, 'hub.challenge': '1158201444' };
    expect(verifyHandshake(q, TOKEN)).toBe('1158201444');
  });

  it('возвращает undefined при чужом токене', () => {
    const q = { 'hub.mode': 'subscribe', 'hub.verify_token': 'чужой', 'hub.challenge': '1158201444' };
    expect(verifyHandshake(q, TOKEN)).toBeUndefined();
  });

  it('возвращает undefined при mode не subscribe и при отсутствии полей', () => {
    expect(verifyHandshake({ 'hub.mode': 'unsubscribe', 'hub.verify_token': TOKEN, 'hub.challenge': '1' }, TOKEN)).toBeUndefined();
    expect(verifyHandshake({}, TOKEN)).toBeUndefined();
  });
});
```

- [x] **Step 2: Запустить тест, убедиться что падает**

Run: `npx vitest run tests/adapters/instagram/signature.test.ts`
Expected: FAIL — модуль не найден.

- [x] **Step 3: Реализовать `src/adapters/instagram/signature.ts`**

```ts
import { createHmac, timingSafeEqual } from 'node:crypto';

const PREFIX = 'sha256=';

/**
 * S1. Подпись считается от сырых байт тела: JSON.stringify(разобранного тела)
 * даёт другую строку — другой порядок ключей, другие пробелы — и подпись не сойдётся.
 *
 * Сравнение только timingSafeEqual: обычное === выходит на первом различии,
 * и по времени ответа подпись подбирается побайтно.
 * timingSafeEqual бросает на буферах разной длины, поэтому длина проверяется
 * заранее — сама длина секретом не является.
 */
export function verifySignature(
  rawBody: Buffer, header: string | undefined, appSecret: string,
): boolean {
  if (header === undefined || !header.startsWith(PREFIX)) return false;

  const received = Buffer.from(header.slice(PREFIX.length), 'hex');
  const expected = createHmac('sha256', appSecret).update(rawBody).digest();
  if (received.length !== expected.length) return false;

  return timingSafeEqual(received, expected);
}

/**
 * S2. Токен из строки запроса сравнивается constant-time по той же причине,
 * что и подпись. Challenge возвращается только после совпадения — иначе адрес
 * превращается в отражатель произвольного текста.
 */
export function verifyHandshake(
  query: Record<string, unknown>, verifyToken: string,
): string | undefined {
  const mode = query['hub.mode'];
  const token = query['hub.verify_token'];
  const challenge = query['hub.challenge'];

  if (mode !== 'subscribe') return undefined;
  if (typeof token !== 'string' || typeof challenge !== 'string') return undefined;

  const received = Buffer.from(token, 'utf8');
  const expected = Buffer.from(verifyToken, 'utf8');
  if (received.length !== expected.length) return undefined;
  if (!timingSafeEqual(received, expected)) return undefined;

  return challenge;
}
```

- [x] **Step 4: Запустить тест, убедиться что проходит**

Run: `npx vitest run tests/adapters/instagram/signature.test.ts`
Expected: PASS, 9 тестов.

- [ ] **Step 5: Коммит**

```bash
git add src/adapters/instagram/signature.ts tests/adapters/instagram/signature.test.ts
git commit -m "feat(instagram): проверка подписи вебхука и GET-хендшейк (S1, S2)"
```

---

## Task B4: Разбор тела вебхука и отсев эха (S3)

Тело вебхука — данные из внешней сети. Подпись доказывает, что их прислала Meta,
но не то, что их форма именно такая, какую мы ждём. Поэтому тело валидируется
Zod-схемой, а не читается напрямую по полям.

Эхо отсеивается **до очереди**, а не в воркере: событие «мы сами написали» не должно
доживать до места, где кто-то может его обработать. Иначе бот отвечает сам себе
и уходит в бесконечную петлю, выжигая лимиты клиента за минуты.

**Files:**
- Create: `src/adapters/instagram/webhook.ts`
- Create: `tests/fixtures/instagram/comment.json`, `direct_message.json`, `echo.json`, `postback.json`, `self_comment.json`
- Test: `tests/adapters/instagram/webhook.test.ts`

**Interfaces:**
- Consumes: `AccountEvents` из `src/adapters/types.js`, `IncomingEvent` из `src/core/types.js`, `zod`
- Produces: `parseInstagramWebhook(body: unknown, maxTextLength: number): AccountEvents[]`

- [x] **Step 1: Создать фикстуры**

`tests/fixtures/instagram/comment.json` — комментарий постороннего человека:

```json
{
  "object": "instagram",
  "entry": [
    {
      "id": "17841400000000001",
      "time": 1787000000,
      "changes": [
        {
          "field": "comments",
          "value": {
            "id": "17900000000000009",
            "text": "цена",
            "from": { "id": "9988776655", "username": "kto_to" },
            "media": { "id": "18000000000000003" }
          }
        }
      ]
    }
  ]
}
```

`tests/fixtures/instagram/direct_message.json`:

```json
{
  "object": "instagram",
  "entry": [
    {
      "id": "17841400000000001",
      "time": 1787000001,
      "messaging": [
        {
          "sender": { "id": "9988776655" },
          "recipient": { "id": "17841400000000001" },
          "timestamp": 1787000001000,
          "message": { "mid": "aWc6bWlkLjE", "text": "да" }
        }
      ]
    }
  ]
}
```

`tests/fixtures/instagram/echo.json` — наше собственное сообщение, вернувшееся вебхуком:

```json
{
  "object": "instagram",
  "entry": [
    {
      "id": "17841400000000001",
      "time": 1787000002,
      "messaging": [
        {
          "sender": { "id": "17841400000000001" },
          "recipient": { "id": "9988776655" },
          "timestamp": 1787000002000,
          "message": { "mid": "aWc6bWlkLjI", "text": "Держите чеклист", "is_echo": true }
        }
      ]
    }
  ]
}
```

`tests/fixtures/instagram/postback.json` — нажатие кнопки:

```json
{
  "object": "instagram",
  "entry": [
    {
      "id": "17841400000000001",
      "time": 1787000003,
      "messaging": [
        {
          "sender": { "id": "9988776655" },
          "recipient": { "id": "17841400000000001" },
          "timestamp": 1787000003000,
          "postback": { "mid": "aWc6bWlkLjM", "title": "Хочу прайс", "payload": "want_price" }
        }
      ]
    }
  ]
}
```

`tests/fixtures/instagram/self_comment.json` — комментарий самого владельца аккаунта:

```json
{
  "object": "instagram",
  "entry": [
    {
      "id": "17841400000000001",
      "time": 1787000004,
      "changes": [
        {
          "field": "comments",
          "value": {
            "id": "17900000000000011",
            "text": "спасибо за вопрос",
            "from": { "id": "17841400000000001", "username": "shop" },
            "media": { "id": "18000000000000003" }
          }
        }
      ]
    }
  ]
}
```

Первой строкой каждого файла в комментарии к тесту отметить: тела собраны
по документации Meta, а не сняты с живого вебхука. Когда появится приложение —
заменить на настоящие и перезапустить контрактные тесты.

- [x] **Step 2: Написать падающий тест**

`tests/adapters/instagram/webhook.test.ts`:

```ts
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parseInstagramWebhook } from '../../../src/adapters/instagram/webhook.js';

/** Тела собраны по документации Meta, а не сняты с живого вебхука. */
function fixture(name: string): unknown {
  return JSON.parse(readFileSync(`tests/fixtures/instagram/${name}.json`, 'utf8'));
}

const LIMIT = 2000;

describe('contract: разбор вебхука Instagram', () => {
  it('комментарий превращается в событие kind=comment с id комментария', () => {
    const parsed = parseInstagramWebhook(fixture('comment'), LIMIT);

    expect(parsed).toHaveLength(1);
    expect(parsed[0]?.externalAccountId).toBe('17841400000000001');

    const event = parsed[0]?.events[0];
    expect(event?.kind).toBe('comment');
    expect(event?.platform).toBe('instagram');
    expect(event?.text).toBe('цена');
    expect(event?.externalUserId).toBe('9988776655');
    expect(event?.externalCommentId).toBe('17900000000000009');
    expect(event?.dedupeKey).toBe('ig:comment:17900000000000009');
  });

  it('директ превращается в событие kind=direct_message', () => {
    const event = parseInstagramWebhook(fixture('direct_message'), LIMIT)[0]?.events[0];

    expect(event?.kind).toBe('direct_message');
    expect(event?.text).toBe('да');
    expect(event?.externalThreadId).toBe('9988776655');
    expect(event?.externalCommentId).toBeNull();
    expect(event?.dedupeKey).toBe('ig:msg:aWc6bWlkLjE');
  });

  it('нажатие кнопки даёт kind=button_click с payload', () => {
    const event = parseInstagramWebhook(fixture('postback'), LIMIT)[0]?.events[0];

    expect(event?.kind).toBe('button_click');
    expect(event?.payload).toBe('want_price');
    expect(event?.dedupeKey).toBe('ig:postback:aWc6bWlkLjM');
  });

  it('S3: эхо-сообщение отбрасывается до очереди', () => {
    const parsed = parseInstagramWebhook(fixture('echo'), LIMIT);
    expect(parsed.flatMap((a) => a.events)).toHaveLength(0);
  });

  it('S3: комментарий самого аккаунта отбрасывается — иначе бот отвечает себе', () => {
    const parsed = parseInstagramWebhook(fixture('self_comment'), LIMIT);
    expect(parsed.flatMap((a) => a.events)).toHaveLength(0);
  });

  it('S7: текст длиннее лимита обрезается до матчинга', () => {
    const body = fixture('comment');
    const long = 'ц'.repeat(5000);
    const typed = body as { entry: { changes: { value: { text: string } }[] }[] };
    const change = typed.entry[0]?.changes[0];
    if (change !== undefined) change.value.text = long;

    const event = parseInstagramWebhook(body, LIMIT)[0]?.events[0];
    expect(event?.text).toHaveLength(LIMIT);
  });

  it('тело неизвестной формы не роняет разбор, а даёт пустой список', () => {
    expect(parseInstagramWebhook({ мусор: true }, LIMIT)).toEqual([]);
    expect(parseInstagramWebhook(null, LIMIT)).toEqual([]);
    expect(parseInstagramWebhook('строка', LIMIT)).toEqual([]);
  });

  it('одно тело с двумя аккаунтами разделяется по владельцам', () => {
    const a = fixture('comment') as { entry: unknown[] };
    const b = fixture('direct_message') as { entry: unknown[] };
    const merged = { object: 'instagram', entry: [...a.entry, ...b.entry] };

    const parsed = parseInstagramWebhook(merged, LIMIT);
    expect(parsed).toHaveLength(2);
  });
});
```

- [x] **Step 3: Запустить тест, убедиться что падает**

Run: `npx vitest run tests/adapters/instagram/webhook.test.ts`
Expected: FAIL — модуль не найден.

- [x] **Step 4: Реализовать `src/adapters/instagram/webhook.ts`**

```ts
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
 * непонятная нам новинка Meta положила бы приём событий всех клиентов.
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
      // значит ответить самому себе и зациклиться.
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
      // S3 для комментариев: свой же комментарий под своим постом.
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
```

- [x] **Step 5: Запустить тест, убедиться что проходит**

Run: `npx vitest run tests/adapters/instagram/webhook.test.ts`
Expected: PASS, 8 тестов.

- [ ] **Step 6: Коммит**

```bash
git add src/adapters/instagram/webhook.ts tests/adapters/instagram/webhook.test.ts tests/fixtures/instagram/
git commit -m "feat(instagram): разбор вебхука и отсев эха (S3)"
```

---

## Task B5: Отправка в Graph API

Здесь данные идут в обратную сторону: наружу, от имени клиента, с его токеном.
Два требования безопасности сходятся в одной функции.

**Первое.** `comment-id` приходит из тела вебхука, то есть снаружи, и попадает
в путь URL. Идентификатор вида `../../me/messages` меняет вызываемый эндпоинт.
Поэтому базовый адрес — константа, каждый внешний id проверяется на формат
и кодируется `encodeURIComponent`.

**Второе.** Токен уходит заголовком `Authorization`, а не параметром строки запроса:
строка запроса оседает в логах прокси и в отчётах об ошибках, заголовок — нет.

**Files:**
- Create: `src/adapters/instagram/sender.ts`
- Test: `tests/adapters/instagram/sender.test.ts`

**Interfaces:**
- Consumes: `MessageSender`, `WebhookSource`, `SendResult`, `AccountEvents` из `src/adapters/types.js`; `parseInstagramWebhook` из `./webhook.js`
- Produces:
  - `type FetchFn = (url: string, init: RequestInit) => Promise<Response>`
  - `class InstagramAdapter implements WebhookSource` с конструктором `(deps: { fetchFn?: FetchFn; maxTextLength: number })`

- [x] **Step 1: Написать падающий тест**

`tests/adapters/instagram/sender.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { InstagramAdapter } from '../../../src/adapters/instagram/sender.js';

interface Call { url: string; init: RequestInit }

function spy(status = 200, payload: unknown = { message_id: 'ok' }) {
  const calls: Call[] = [];
  const fetchFn = async (url: string, init: RequestInit): Promise<Response> => {
    calls.push({ url, init });
    return new Response(JSON.stringify(payload), { status });
  };
  return { calls, fetchFn };
}

function body(call: Call | undefined): Record<string, unknown> {
  return JSON.parse(String(call?.init.body ?? '{}'));
}

describe('отправка в Instagram', () => {
  it('reply_comment уходит на /{comment-id}/replies', async () => {
    const { calls, fetchFn } = spy();
    const adapter = new InstagramAdapter({ fetchFn, maxTextLength: 2000 });

    const result = await adapter.send(
      { type: 'reply_comment', text: 'Прайс в директе' },
      { threadId: '9988776655', commentId: '17900000000000009' },
      'токен',
    );

    expect(result).toEqual({ ok: true });
    expect(calls[0]?.url).toBe('https://graph.instagram.com/v23.0/17900000000000009/replies');
    expect(body(calls[0])).toEqual({ message: 'Прайс в директе' });
  });

  it('send_text уходит на /me/messages с получателем по id', async () => {
    const { calls, fetchFn } = spy();
    const adapter = new InstagramAdapter({ fetchFn, maxTextLength: 2000 });

    await adapter.send({ type: 'send_text', text: 'привет' }, { threadId: '9988776655' }, 'токен');

    expect(calls[0]?.url).toBe('https://graph.instagram.com/v23.0/me/messages');
    expect(body(calls[0])).toEqual({
      recipient: { id: '9988776655' },
      message: { text: 'привет' },
    });
  });

  it('dm_the_commenter адресуется по comment_id, а не по id пользователя', async () => {
    const { calls, fetchFn } = spy();
    const adapter = new InstagramAdapter({ fetchFn, maxTextLength: 2000 });

    await adapter.send(
      { type: 'dm_the_commenter', text: 'Держите' },
      { threadId: '9988776655', commentId: '17900000000000009' },
      'токен',
    );

    expect(body(calls[0])).toEqual({
      recipient: { comment_id: '17900000000000009' },
      message: { text: 'Держите' },
    });
  });

  it('send_buttons уходит быстрыми ответами', async () => {
    const { calls, fetchFn } = spy();
    const adapter = new InstagramAdapter({ fetchFn, maxTextLength: 2000 });

    await adapter.send(
      { type: 'send_buttons', text: 'Что интересует?', buttons: [{ label: 'Прайс', payload: 'price' }] },
      { threadId: '9988776655' },
      'токен',
    );

    expect(body(calls[0])).toEqual({
      recipient: { id: '9988776655' },
      message: {
        text: 'Что интересует?',
        quick_replies: [{ content_type: 'text', title: 'Прайс', payload: 'price' }],
      },
    });
  });

  it('токен уходит заголовком, а не в строке запроса', async () => {
    const { calls, fetchFn } = spy();
    const adapter = new InstagramAdapter({ fetchFn, maxTextLength: 2000 });

    await adapter.send({ type: 'send_text', text: 'привет' }, { threadId: '9988776655' }, 'секретный-токен');

    expect(calls[0]?.url).not.toContain('секретный-токен');
    const headers = new Headers(calls[0]?.init.headers);
    expect(headers.get('authorization')).toBe('Bearer секретный-токен');
  });

  it('идентификатор с путём внутри не доходит до сети', async () => {
    const { calls, fetchFn } = spy();
    const adapter = new InstagramAdapter({ fetchFn, maxTextLength: 2000 });

    const result = await adapter.send(
      { type: 'reply_comment', text: 'x' },
      { threadId: '99', commentId: '../../me/messages' },
      'токен',
    );

    expect(result).toEqual({ ok: false, retry: false, reason: 'некорректный идентификатор' });
    expect(calls).toHaveLength(0);
  });

  it('5xx и 429 помечаются как повторяемые, 4xx — как окончательные', async () => {
    const adapter5 = new InstagramAdapter({ fetchFn: spy(503).fetchFn, maxTextLength: 2000 });
    const adapter429 = new InstagramAdapter({ fetchFn: spy(429).fetchFn, maxTextLength: 2000 });
    const adapter400 = new InstagramAdapter({ fetchFn: spy(400).fetchFn, maxTextLength: 2000 });
    const delivery = { threadId: '9988776655' };
    const action = { type: 'send_text', text: 'x' } as const;

    expect(await adapter5.send(action, delivery, 'т')).toMatchObject({ ok: false, retry: true });
    expect(await adapter429.send(action, delivery, 'т')).toMatchObject({ ok: false, retry: true });
    expect(await adapter400.send(action, delivery, 'т')).toMatchObject({ ok: false, retry: false });
  });

  it('обрыв сети — повторяемая ошибка, и текст ошибки не попадает в reason', async () => {
    const fetchFn = async (): Promise<Response> => {
      throw new Error('connect ECONNREFUSED 10.0.0.1:443');
    };
    const adapter = new InstagramAdapter({ fetchFn, maxTextLength: 2000 });

    const result = await adapter.send({ type: 'send_text', text: 'x' }, { threadId: '99' }, 'т');

    expect(result).toEqual({ ok: false, retry: true, reason: 'сетевая ошибка' });
  });

  it('reply_comment без commentId не отправляется', async () => {
    const { calls, fetchFn } = spy();
    const adapter = new InstagramAdapter({ fetchFn, maxTextLength: 2000 });

    const result = await adapter.send({ type: 'reply_comment', text: 'x' }, { threadId: '99' }, 'т');

    expect(result).toMatchObject({ ok: false, retry: false });
    expect(calls).toHaveLength(0);
  });

  it('notify_operator наружу не уходит — заявку пишет воркер', async () => {
    const { calls, fetchFn } = spy();
    const adapter = new InstagramAdapter({ fetchFn, maxTextLength: 2000 });

    const result = await adapter.send(
      { type: 'notify_operator', reason: 'заявка', context: {} },
      { threadId: '99' },
      'т',
    );

    expect(result).toEqual({ ok: true });
    expect(calls).toHaveLength(0);
  });
});
```

- [x] **Step 2: Запустить тест, убедиться что падает**

Run: `npx vitest run tests/adapters/instagram/sender.test.ts`
Expected: FAIL — модуль не найден.

- [x] **Step 3: Реализовать `src/adapters/instagram/sender.ts`**

```ts
import type { DeliveryContext, OutgoingAction, Platform } from '../../core/types.js';
import type { AccountEvents, SendResult, WebhookSource } from '../types.js';
import { parseInstagramWebhook } from './webhook.js';

const GRAPH_BASE = 'https://graph.instagram.com';
const GRAPH_VERSION = 'v23.0';

/**
 * Идентификаторы Instagram — только цифры. Проверка нужна не для красоты:
 * id приходит из тела вебхука и попадает в путь URL, а "../../me/messages"
 * в пути меняет вызываемый эндпоинт. Регулярное выражение линейное,
 * без вложенных повторений — запрет из S7 касается триггеров пользователя.
 */
const NUMERIC_ID = /^[0-9]{1,32}$/;

export type FetchFn = (url: string, init: RequestInit) => Promise<Response>;

interface Deps {
  fetchFn?: FetchFn;
  maxTextLength: number;
}

export class InstagramAdapter implements WebhookSource {
  readonly platform: Platform = 'instagram';
  private readonly fetchFn: FetchFn;
  private readonly maxTextLength: number;

  constructor(deps: Deps) {
    this.fetchFn = deps.fetchFn ?? ((url, init) => fetch(url, init));
    this.maxTextLength = deps.maxTextLength;
  }

  parseWebhook(body: unknown): AccountEvents[] {
    return parseInstagramWebhook(body, this.maxTextLength);
  }

  async send(
    action: OutgoingAction, delivery: DeliveryContext, token: string,
  ): Promise<SendResult> {
    const request = buildRequest(action, delivery);
    if (request === undefined) {
      return { ok: false, retry: false, reason: 'некорректный идентификатор' };
    }
    if (request === null) return { ok: true };

    return this.post(request.path, request.body, token);
  }

  private async post(
    path: string, payload: unknown, token: string,
  ): Promise<SendResult> {
    let response: Response;
    try {
      response = await this.fetchFn(`${GRAPH_BASE}/${GRAPH_VERSION}/${path}`, {
        method: 'POST',
        // S9: токен заголовком, а не в строке запроса — строка запроса
        // оседает в логах прокси и в отчётах об ошибках
        headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
        body: JSON.stringify(payload),
      });
    } catch {
      // Текст сетевой ошибки не попадает в reason: он содержит адреса и порты,
      // а reason показывается клиенту в кабинете (S9)
      return { ok: false, retry: true, reason: 'сетевая ошибка' };
    }

    if (response.ok) return { ok: true };

    const retry = response.status === 429 || response.status >= 500;
    return { ok: false, retry, reason: `HTTP ${response.status}` };
  }
}

interface GraphRequest {
  path: string;
  body: Record<string, unknown>;
}

/**
 * undefined — идентификатор не прошёл проверку, наружу не идём.
 * null — действие вообще не требует сетевого вызова.
 */
function buildRequest(
  action: OutgoingAction, delivery: DeliveryContext,
): GraphRequest | undefined | null {
  switch (action.type) {
    case 'reply_comment': {
      const commentId = safeId(delivery.commentId);
      if (commentId === undefined) return undefined;
      return { path: `${commentId}/replies`, body: { message: action.text } };
    }
    case 'dm_the_commenter': {
      const commentId = safeId(delivery.commentId);
      if (commentId === undefined) return undefined;
      return {
        path: 'me/messages',
        body: { recipient: { comment_id: commentId }, message: { text: action.text } },
      };
    }
    case 'send_text': {
      const threadId = safeId(delivery.threadId);
      if (threadId === undefined) return undefined;
      return {
        path: 'me/messages',
        body: { recipient: { id: threadId }, message: { text: action.text } },
      };
    }
    case 'send_buttons': {
      const threadId = safeId(delivery.threadId);
      if (threadId === undefined) return undefined;
      return {
        path: 'me/messages',
        body: {
          recipient: { id: threadId },
          message: {
            text: action.text,
            quick_replies: action.buttons.map((b) => ({
              content_type: 'text', title: b.label, payload: b.payload,
            })),
          },
        },
      };
    }
    case 'notify_operator':
      // Уведомлений оператору в этом продукте нет: заявку пишет воркер в таблицу leads
      return null;
  }
}

function safeId(value: string | undefined): string | undefined {
  if (value === undefined || !NUMERIC_ID.test(value)) return undefined;
  return encodeURIComponent(value);
}
```

- [x] **Step 4: Запустить тест, убедиться что проходит**

Run: `npx vitest run tests/adapters/instagram/sender.test.ts`
Expected: PASS, 10 тестов.

- [ ] **Step 5: Коммит**

```bash
git add src/adapters/instagram/sender.ts tests/adapters/instagram/sender.test.ts
git commit -m "feat(instagram): отправка в Graph API с проверкой идентификаторов"
```

---

## Task B6: Воркер — два цикла

Здесь встречаются все части. Ключевое решение — **два независимых цикла**, а не один:

```
intake:   event_queue → step() → outbox     без сети, потому не может «застрять»
delivery: outbox → adapter.send()           сеть, ретраи, экспоненциальная задержка
```

Если слить их в один, обрыв сети при отправке откатит и обработку события: диалог
не сдвинется, а при повторе шаг воронки выполнится дважды. Разделённые, они дают
простое правило — событие обрабатывается ровно один раз, отправка повторяется
столько раз, сколько нужно.

Заявка пишется **по завершению воронки**, а не по действию `notify_operator`:
`buildScenario` это поле не выставляет, значит из воронок в БД такое действие
прийти не может. Признак завершения — `stepId` стал `null`, а контекст не пуст.

**Files:**
- Create: `src/worker.ts`
- Modify: `src/config.ts`, `.env.example`, `tests/config.test.ts`
- Test: `tests/worker.test.ts`

**Interfaces:**
- Consumes: `takePendingEvents`, `markEventProcessed`, `loadConversation`, `saveConversation`, `enqueueOutbox`, `takeDueOutbox`, `markOutboxSent`, `markOutboxFailed` из `src/storage/queries/runtime.js`; `getAccountTokenForPlatform` из `src/storage/queries/accounts.js`; `loadEnabledScenarios` из `src/storage/queries/automations.js`; `recordLead` из `src/storage/queries/leads.js`; `step` из `src/core/engine.js`; `ReplyThrottle` из `src/core/throttle.js`; `MessageSender` из `src/adapters/types.js`
- Produces:
  - `interface WorkerDeps { db: AppDb; cfg: Config; senders: Map<Platform, MessageSender>; throttle: ReplyThrottle }`
  - `runIntake(deps: WorkerDeps, now: Date): number` — сколько событий обработано
  - `runDelivery(deps: WorkerDeps, now: Date): Promise<number>` — сколько строк доставлено

- [x] **Step 1: Добавить переменные окружения**

В `src/config.ts`, в `EnvSchema`, после `MAX_INCOMING_TEXT_LENGTH`:

```ts
  WORKER_INTERVAL_MS: z.coerce.number().int().positive().default(2000),
  OUTBOX_MAX_ATTEMPTS: z.coerce.number().int().positive().default(8),
```

В `.env.example` в конец:

```
WORKER_INTERVAL_MS=2000
OUTBOX_MAX_ATTEMPTS=8
```

В `tests/config.test.ts` добавить:

```ts
it('подставляет значения по умолчанию для настроек воркера', () => {
  const cfg = loadConfig(valid);
  expect(cfg.WORKER_INTERVAL_MS).toBe(2000);
  expect(cfg.OUTBOX_MAX_ATTEMPTS).toBe(8);
});
```

`valid` — существующая константа в начале `tests/config.test.ts`.

- [x] **Step 2: Написать падающий тест**

`tests/worker.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { createTestDb } from './storage/helpers.js';
import { createUser } from '../src/storage/queries/users.js';
import { connectAccount } from '../src/storage/queries/accounts.js';
import { createAutomation } from '../src/storage/queries/automations.js';
import { enqueueEvent, takeDueOutbox } from '../src/storage/queries/runtime.js';
import { listLeads, leadData } from '../src/storage/queries/leads.js';
import { ReplyThrottle } from '../src/core/throttle.js';
import { loadConfig } from '../src/config.js';
import { runDelivery, runIntake, type WorkerDeps } from '../src/worker.js';
import type { DeliveryContext, OutgoingAction, Platform } from '../src/core/types.js';
import type { MessageSender, SendResult } from '../src/adapters/types.js';

const KEY = 'a'.repeat(64);

function config() {
  return loadConfig({
    META_APP_SECRET: 's', META_VERIFY_TOKEN: 'v', CREDENTIALS_ENC_KEY: KEY,
  } as unknown as NodeJS.ProcessEnv);
}

interface Sent { action: OutgoingAction; delivery: DeliveryContext; token: string }

class FakeSender implements MessageSender {
  readonly platform: Platform = 'instagram';
  readonly sent: Sent[] = [];
  constructor(private readonly answer: SendResult = { ok: true }) {}

  async send(action: OutgoingAction, delivery: DeliveryContext, token: string): Promise<SendResult> {
    this.sent.push({ action, delivery, token });
    return this.answer;
  }
}

function deps(db: ReturnType<typeof createTestDb>, sender: MessageSender): WorkerDeps {
  const cfg = config();
  return {
    db, cfg,
    senders: new Map<Platform, MessageSender>([['instagram', sender]]),
    throttle: new ReplyThrottle(cfg.THROTTLE_MAX_REPLIES_PER_MINUTE),
  };
}

function comment(text: string, commentId = '17900000000000009') {
  return {
    platform: 'instagram', kind: 'comment',
    externalUserId: '9988776655', externalThreadId: '9988776655',
    externalCommentId: commentId, text, payload: null,
    dedupeKey: `ig:comment:${commentId}`,
    receivedAt: new Date('2026-08-28T12:00:00Z').toISOString(),
  };
}

const NOW = new Date('2026-08-28T12:00:01Z');

describe('intake: очередь → движок → outbox', () => {
  it('комментарий с ключевым словом превращается в исходящее действие', () => {
    const db = createTestDb();
    const userId = createUser(db, { email: 'a@a.a', passwordHash: 'x' });
    createAutomation(db, userId, {
      name: 'Прайс', triggerType: 'contains', triggerValue: 'цена',
      steps: [{ say: 'Отправил прайс в директ' }],
    });
    enqueueEvent(db, userId, 'instagram', comment('сколько цена?'));

    expect(runIntake(deps(db, new FakeSender()), NOW)).toBe(1);

    const rows = takeDueOutbox(db, NOW);
    expect(rows).toHaveLength(1);
    expect(JSON.parse(rows[0]?.actionJson ?? '{}')).toEqual({
      type: 'reply_comment', text: 'Отправил прайс в директ',
    });
    expect(JSON.parse(rows[0]?.deliveryJson ?? '{}')).toMatchObject({
      threadId: '9988776655', commentId: '17900000000000009',
    });
  });

  it('событие обрабатывается один раз: повторный прогон ничего не добавляет', () => {
    const db = createTestDb();
    const userId = createUser(db, { email: 'b@b.b', passwordHash: 'x' });
    createAutomation(db, userId, {
      name: 'Прайс', triggerType: 'contains', triggerValue: 'цена',
      steps: [{ say: 'Ответ' }],
    });
    enqueueEvent(db, userId, 'instagram', comment('цена'));

    runIntake(deps(db, new FakeSender()), NOW);
    expect(runIntake(deps(db, new FakeSender()), NOW)).toBe(0);
    expect(takeDueOutbox(db, NOW)).toHaveLength(1);
  });

  it('S11: воронка клиента A не срабатывает на событие клиента B', () => {
    const db = createTestDb();
    const a = createUser(db, { email: 'a2@a.a', passwordHash: 'x' });
    const b = createUser(db, { email: 'b2@b.b', passwordHash: 'x' });
    createAutomation(db, a, {
      name: 'Прайс A', triggerType: 'contains', triggerValue: 'цена',
      steps: [{ say: 'Ответ A' }],
    });
    enqueueEvent(db, b, 'instagram', comment('цена'));

    runIntake(deps(db, new FakeSender()), NOW);

    expect(takeDueOutbox(db, NOW)).toHaveLength(0);
  });

  it('S8: сверх лимита в минуту события до движка не доходят', () => {
    const db = createTestDb();
    const userId = createUser(db, { email: 'c@c.c', passwordHash: 'x' });
    createAutomation(db, userId, {
      name: 'Прайс', triggerType: 'contains', triggerValue: 'цена',
      steps: [{ say: 'Ответ' }],
    });
    const worker = deps(db, new FakeSender());
    const limit = worker.cfg.THROTTLE_MAX_REPLIES_PER_MINUTE;

    // Все события — от одного контакта: троттлинг считает именно по контакту
    for (let i = 0; i <= limit; i += 1) {
      enqueueEvent(db, userId, 'instagram', comment('цена', `1790000000000${i}`));
    }

    // Число обработанных, а не число действий: диалог после первого события
    // уходит в конец воронки и новых действий не порождает
    expect(runIntake(worker, NOW)).toBe(limit);
  });

  it('завершённая воронка со собранными ответами пишет заявку', () => {
    const db = createTestDb();
    const userId = createUser(db, { email: 'd@d.d', passwordHash: 'x' });
    const automationId = createAutomation(db, userId, {
      name: 'Заявка', triggerType: 'contains', triggerValue: 'запись',
      steps: [
        { say: 'Как вас зовут?', saveReplyAs: 'name' },
        { say: 'Спасибо, записал' },
      ],
    });
    const worker = deps(db, new FakeSender());

    enqueueEvent(db, userId, 'instagram', comment('хочу запись', '17900000000000001'));
    runIntake(worker, NOW);
    enqueueEvent(db, userId, 'instagram', { ...comment('Абылай', '17900000000000002'), kind: 'direct_message', externalCommentId: null });
    runIntake(worker, NOW);
    enqueueEvent(db, userId, 'instagram', { ...comment('ок', '17900000000000003'), kind: 'direct_message', externalCommentId: null });
    runIntake(worker, NOW);

    const leads = listLeads(db, userId);
    expect(leads).toHaveLength(1);

    const lead = leads[0];
    if (lead === undefined) throw new Error('заявка не записана');
    expect(lead.automationId).toBe(automationId);
    expect(leadData(lead).get('name')).toBe('Абылай');
  });
});

describe('delivery: outbox → адаптер', () => {
  it('успешная отправка закрывает строку и несёт токен клиента', async () => {
    const db = createTestDb();
    const userId = createUser(db, { email: 'e@e.e', passwordHash: 'x' });
    connectAccount(db, userId, { platform: 'instagram', externalAccountId: '17841400000000001', token: 'токен-клиента' }, KEY);
    createAutomation(db, userId, {
      name: 'Прайс', triggerType: 'contains', triggerValue: 'цена', steps: [{ say: 'Ответ' }],
    });
    enqueueEvent(db, userId, 'instagram', comment('цена'));

    const sender = new FakeSender();
    const worker = deps(db, sender);
    runIntake(worker, NOW);

    expect(await runDelivery(worker, NOW)).toBe(1);
    expect(sender.sent[0]?.token).toBe('токен-клиента');
    expect(takeDueOutbox(db, NOW)).toHaveLength(0);
  });

  it('повторяемая ошибка откладывает строку, а не теряет её', async () => {
    const db = createTestDb();
    const userId = createUser(db, { email: 'f@f.f', passwordHash: 'x' });
    connectAccount(db, userId, { platform: 'instagram', externalAccountId: '17841400000000002', token: 'т' }, KEY);
    createAutomation(db, userId, {
      name: 'Прайс', triggerType: 'contains', triggerValue: 'цена', steps: [{ say: 'Ответ' }],
    });
    enqueueEvent(db, userId, 'instagram', comment('цена'));

    const worker = deps(db, new FakeSender({ ok: false, retry: true, reason: 'HTTP 503' }));
    runIntake(worker, NOW);
    await runDelivery(worker, NOW);

    expect(takeDueOutbox(db, NOW)).toHaveLength(0);
    const later = new Date(NOW.getTime() + 10 * 60_000);
    expect(takeDueOutbox(db, later)).toHaveLength(1);
  });

  it('окончательная ошибка закрывает строку с причиной', async () => {
    const db = createTestDb();
    const userId = createUser(db, { email: 'g@g.g', passwordHash: 'x' });
    connectAccount(db, userId, { platform: 'instagram', externalAccountId: '17841400000000003', token: 'т' }, KEY);
    createAutomation(db, userId, {
      name: 'Прайс', triggerType: 'contains', triggerValue: 'цена', steps: [{ say: 'Ответ' }],
    });
    enqueueEvent(db, userId, 'instagram', comment('цена'));

    const worker = deps(db, new FakeSender({ ok: false, retry: false, reason: 'HTTP 400' }));
    runIntake(worker, NOW);
    await runDelivery(worker, NOW);

    const far = new Date('2030-01-01T00:00:00Z');
    expect(takeDueOutbox(db, far)).toHaveLength(0);
  });

  it('без подключённого аккаунта строка закрывается, а не висит вечно', async () => {
    const db = createTestDb();
    const userId = createUser(db, { email: 'h@h.h', passwordHash: 'x' });
    createAutomation(db, userId, {
      name: 'Прайс', triggerType: 'contains', triggerValue: 'цена', steps: [{ say: 'Ответ' }],
    });
    enqueueEvent(db, userId, 'instagram', comment('цена'));

    const sender = new FakeSender();
    const worker = deps(db, sender);
    runIntake(worker, NOW);
    await runDelivery(worker, NOW);

    expect(sender.sent).toHaveLength(0);
    expect(takeDueOutbox(db, new Date('2030-01-01T00:00:00Z'))).toHaveLength(0);
  });

  it('S11: клиенту A уходит его токен, клиенту B — его', async () => {
    const db = createTestDb();
    const a = createUser(db, { email: 'a3@a.a', passwordHash: 'x' });
    const b = createUser(db, { email: 'b3@b.b', passwordHash: 'x' });
    connectAccount(db, a, { platform: 'instagram', externalAccountId: '111', token: 'токен-A' }, KEY);
    connectAccount(db, b, { platform: 'instagram', externalAccountId: '222', token: 'токен-B' }, KEY);
    for (const id of [a, b]) {
      createAutomation(db, id, {
        name: 'Прайс', triggerType: 'contains', triggerValue: 'цена', steps: [{ say: `Ответ ${id}` }],
      });
    }
    enqueueEvent(db, a, 'instagram', comment('цена', '17900000000000021'));
    enqueueEvent(db, b, 'instagram', comment('цена', '17900000000000022'));

    const sender = new FakeSender();
    const worker = deps(db, sender);
    runIntake(worker, NOW);
    await runDelivery(worker, NOW);

    expect(new Set(sender.sent.map((s) => s.token))).toEqual(new Set(['токен-A', 'токен-B']));
  });
});
```

- [x] **Step 3: Запустить тест, убедиться что падает**

Run: `npx vitest run tests/worker.test.ts`
Expected: FAIL — модуль `src/worker.js` не найден.

- [x] **Step 4: Реализовать `src/worker.ts`**

```ts
import { z } from 'zod';
import type { Config } from './config.js';
import { step } from './core/engine.js';
import type { ReplyThrottle } from './core/throttle.js';
import type {
  DeliveryContext, IncomingEvent, OutgoingAction, Platform,
} from './core/types.js';
import type { MessageSender } from './adapters/types.js';
import type { AppDb } from './storage/db.js';
import { getAccountTokenForPlatform } from './storage/queries/accounts.js';
import { loadEnabledScenarios } from './storage/queries/automations.js';
import { recordLead } from './storage/queries/leads.js';
import {
  loadConversation, markEventProcessed, markOutboxFailed, markOutboxSent,
  saveConversation, takeDueOutbox, takePendingEvents, enqueueOutbox,
} from './storage/queries/runtime.js';

export interface WorkerDeps {
  db: AppDb;
  cfg: Config;
  senders: Map<Platform, MessageSender>;
  throttle: ReplyThrottle;
}

/** Дата не переживает JSON. Схема заодно ловит порчу строки в БД. */
const StoredEvent = z.object({
  platform: z.enum(['instagram', 'tiktok']),
  kind: z.enum(['direct_message', 'comment', 'button_click']),
  externalUserId: z.string(),
  externalThreadId: z.string(),
  externalCommentId: z.string().nullable(),
  text: z.string().nullable(),
  payload: z.string().nullable(),
  dedupeKey: z.string(),
  receivedAt: z.coerce.date(),
});

/**
 * Цикл приёма: без сети и без await. Поэтому он не может застрять на медленном
 * ответе Meta и не откатывает состояние диалога из-за обрыва связи.
 */
export function runIntake(deps: WorkerDeps, now: Date): number {
  const rows = takePendingEvents(deps.db, 20);
  let handled = 0;

  for (const row of rows) {
    const parsed = StoredEvent.safeParse(JSON.parse(row.payloadJson));
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
    const runningId = before.stepId === null
      ? undefined
      : scenarios.find((s) => s.steps.some((st) => st.id === before.stepId))?.id;

    const result = step(scenarios, before, event);
    saveConversation(deps.db, row.userId, key, result.state);

    const delivery: DeliveryContext = {
      threadId: event.externalThreadId,
      userId: event.externalUserId,
      ...(event.externalCommentId === null ? {} : { commentId: event.externalCommentId }),
    };
    for (const action of result.actions) {
      enqueueOutbox(deps.db, row.userId, event.platform, action, delivery);
    }

    // Воронка дошла до конца и что-то собрала — это заявка.
    // Действия notify_operator из воронок в БД не приходят: buildScenario его не выставляет.
    if (
      before.stepId !== null && result.state.stepId === null &&
      runningId !== undefined && result.state.context.size > 0
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

const HOUR = 3_600_000;

/** Экспоненциальная задержка с потолком: минута, две, четыре… но не дольше шести часов. */
function backoff(now: Date, attempts: number): Date {
  return new Date(now.getTime() + Math.min(2 ** attempts * 60_000, 6 * HOUR));
}

/** Цикл доставки: единственное место в системе, которое ходит в сеть. */
export async function runDelivery(deps: WorkerDeps, now: Date): Promise<number> {
  const rows = takeDueOutbox(deps.db, now, 20);
  let delivered = 0;

  for (const row of rows) {
    const sender = deps.senders.get(row.platform);
    if (sender === undefined) {
      markOutboxFailed(deps.db, row.id, 'платформа не подключена', null);
      continue;
    }

    const account = getAccountTokenForPlatform(
      deps.db, row.userId, row.platform, deps.cfg.CREDENTIALS_ENC_KEY,
    );
    if (account === undefined) {
      markOutboxFailed(deps.db, row.id, 'аккаунт не подключён', null);
      continue;
    }

    const action: OutgoingAction = JSON.parse(row.actionJson);
    const delivery: DeliveryContext = JSON.parse(row.deliveryJson);
    const result = await sender.send(action, delivery, account.token);

    if (result.ok) {
      markOutboxSent(deps.db, row.id);
      delivered += 1;
      continue;
    }

    const exhausted = row.attempts + 1 >= deps.cfg.OUTBOX_MAX_ATTEMPTS;
    markOutboxFailed(
      deps.db, row.id, result.reason,
      result.retry && !exhausted ? backoff(now, row.attempts + 1) : null,
    );
  }
  return delivered;
}
```

- [x] **Step 5: Запустить тесты, убедиться что проходят**

Run: `npx vitest run tests/worker.test.ts tests/config.test.ts`
Expected: PASS.

- [ ] **Step 6: Коммит**

```bash
git add src/worker.ts src/config.ts .env.example tests/worker.test.ts tests/config.test.ts
git commit -m "feat(worker): циклы приёма и доставки, троттлинг и заявки"
```

---

## Task B7: HTTP-маршрут вебхука, сборка процесса и посев

Обработчик обязан ответить быстро: Meta отключает медленные приложения. Поэтому
он делает ровно четыре вещи — проверяет подпись, находит владельца, кладёт
в очередь, отвечает `200`. Ни движка, ни сети внутри него нет.

**Два решения по безопасности.**

Событие для неизвестного аккаунта отбрасывается, но ответ всё равно `200`.
Другой код на «знаю такой аккаунт» и «не знаю» позволяет снаружи перебрать,
кто у нас клиент; вдобавок Meta на 4xx повторяет доставку бесконечно.

Лимит размера тела задаётся явно: без него тело на сотню мегабайт съедает память
ещё до того, как мы проверим подпись.

**Files:**
- Create: `src/web/routes/webhooks.ts`, `src/server.ts`, `scripts/seed.ts`
- Test: `tests/web/webhooks.test.ts`

**Interfaces:**
- Consumes: `verifySignature`, `verifyHandshake` из `src/adapters/instagram/signature.js`; `InstagramAdapter` из `src/adapters/instagram/sender.js`; `resolveAccountOwner` из `src/storage/queries/accounts.js`; `markEventSeen`, `enqueueEvent` из `src/storage/queries/runtime.js`
- Produces:
  - `registerWebhookRoutes(app: FastifyInstance, deps: { db: AppDb; cfg: Config; source: WebhookSource }): void`
  - `buildServer(deps): FastifyInstance`

- [x] **Step 1: Написать падающий тест**

`tests/web/webhooks.test.ts`:

```ts
import { createHmac } from 'node:crypto';
import Fastify from 'fastify';
import { describe, expect, it } from 'vitest';
import { createTestDb } from '../storage/helpers.js';
import { createUser } from '../../src/storage/queries/users.js';
import { connectAccount } from '../../src/storage/queries/accounts.js';
import { takePendingEvents } from '../../src/storage/queries/runtime.js';
import { InstagramAdapter } from '../../src/adapters/instagram/sender.js';
import { registerWebhookRoutes } from '../../src/web/routes/webhooks.js';
import { loadConfig } from '../../src/config.js';

const KEY = 'a'.repeat(64);
const SECRET = 'app-secret';
const VERIFY = 'verify-token';

function config() {
  return loadConfig({
    META_APP_SECRET: SECRET, META_VERIFY_TOKEN: VERIFY, CREDENTIALS_ENC_KEY: KEY,
  } as unknown as NodeJS.ProcessEnv);
}

function build(db: ReturnType<typeof createTestDb>) {
  const app = Fastify();
  registerWebhookRoutes(app, {
    db, cfg: config(), source: new InstagramAdapter({ maxTextLength: 2000 }),
  });
  return app;
}

function signed(payload: unknown) {
  const raw = JSON.stringify(payload);
  return {
    payload: raw,
    headers: {
      'content-type': 'application/json',
      'x-hub-signature-256': 'sha256=' + createHmac('sha256', SECRET).update(raw).digest('hex'),
    },
  };
}

function commentBody(accountId: string, commentId = '17900000000000009') {
  return {
    object: 'instagram',
    entry: [{
      id: accountId, time: 1787000000,
      changes: [{
        field: 'comments',
        value: { id: commentId, text: 'цена', from: { id: '9988776655' } },
      }],
    }],
  };
}

describe('маршрут вебхука Instagram', () => {
  it('S2: GET с верным токеном возвращает challenge', async () => {
    const app = build(createTestDb());
    const res = await app.inject({
      method: 'GET',
      url: `/webhooks/instagram?hub.mode=subscribe&hub.verify_token=${VERIFY}&hub.challenge=42`,
    });
    expect(res.statusCode).toBe(200);
    expect(res.body).toBe('42');
  });

  it('S2: GET с чужим токеном получает 403 без тела', async () => {
    const app = build(createTestDb());
    const res = await app.inject({
      method: 'GET',
      url: '/webhooks/instagram?hub.mode=subscribe&hub.verify_token=чужой&hub.challenge=42',
    });
    expect(res.statusCode).toBe(403);
    expect(res.body).toBe('');
  });

  it('S1: событие с верной подписью попадает в очередь владельца', async () => {
    const db = createTestDb();
    const userId = createUser(db, { email: 'a@a.a', passwordHash: 'x' });
    connectAccount(db, userId, { platform: 'instagram', externalAccountId: '17841400000000001', token: 'т' }, KEY);
    const app = build(db);

    const res = await app.inject({
      method: 'POST', url: '/webhooks/instagram',
      ...signed(commentBody('17841400000000001')),
    });

    expect(res.statusCode).toBe(200);
    const queued = takePendingEvents(db);
    expect(queued).toHaveLength(1);
    expect(queued[0]?.userId).toBe(userId);
  });

  it('S1: подпись от чужого секрета даёт 403 и ничего не кладёт в очередь', async () => {
    const db = createTestDb();
    const userId = createUser(db, { email: 'b@b.b', passwordHash: 'x' });
    connectAccount(db, userId, { platform: 'instagram', externalAccountId: '17841400000000001', token: 'т' }, KEY);
    const app = build(db);
    const raw = JSON.stringify(commentBody('17841400000000001'));

    const res = await app.inject({
      method: 'POST', url: '/webhooks/instagram', payload: raw,
      headers: {
        'content-type': 'application/json',
        'x-hub-signature-256': 'sha256=' + createHmac('sha256', 'чужой').update(raw).digest('hex'),
      },
    });

    expect(res.statusCode).toBe(403);
    expect(res.body).toBe('');
    expect(takePendingEvents(db)).toHaveLength(0);
  });

  it('S1: запрос без заголовка подписи даёт 403', async () => {
    const app = build(createTestDb());
    const res = await app.inject({
      method: 'POST', url: '/webhooks/instagram',
      payload: JSON.stringify(commentBody('17841400000000001')),
      headers: { 'content-type': 'application/json' },
    });
    expect(res.statusCode).toBe(403);
  });

  it('S17: событие неизвестного аккаунта отбрасывается, но ответ 200', async () => {
    const db = createTestDb();
    const app = build(db);

    const res = await app.inject({
      method: 'POST', url: '/webhooks/instagram',
      ...signed(commentBody('99999999999999999')),
    });

    expect(res.statusCode).toBe(200);
    expect(takePendingEvents(db)).toHaveLength(0);
  });

  it('S17: событие клиента A не попадает в очередь клиента B', async () => {
    const db = createTestDb();
    const a = createUser(db, { email: 'a2@a.a', passwordHash: 'x' });
    const b = createUser(db, { email: 'b2@b.b', passwordHash: 'x' });
    connectAccount(db, a, { platform: 'instagram', externalAccountId: '111', token: 'т' }, KEY);
    connectAccount(db, b, { platform: 'instagram', externalAccountId: '222', token: 'т' }, KEY);
    const app = build(db);

    await app.inject({ method: 'POST', url: '/webhooks/instagram', ...signed(commentBody('111')) });

    const queued = takePendingEvents(db);
    expect(queued).toHaveLength(1);
    expect(queued[0]?.userId).toBe(a);
    expect(queued.some((r) => r.userId === b)).toBe(false);
  });

  it('повторная доставка того же события не создаёт вторую запись', async () => {
    const db = createTestDb();
    const userId = createUser(db, { email: 'c@c.c', passwordHash: 'x' });
    connectAccount(db, userId, { platform: 'instagram', externalAccountId: '17841400000000001', token: 'т' }, KEY);
    const app = build(db);
    const request = { method: 'POST' as const, url: '/webhooks/instagram', ...signed(commentBody('17841400000000001')) };

    await app.inject(request);
    await app.inject(request);

    expect(takePendingEvents(db)).toHaveLength(1);
  });

  it('тело, которое не является JSON, не роняет обработчик', async () => {
    const db = createTestDb();
    const app = build(db);
    const raw = 'не json';

    const res = await app.inject({
      method: 'POST', url: '/webhooks/instagram', payload: raw,
      headers: {
        'content-type': 'application/json',
        'x-hub-signature-256': 'sha256=' + createHmac('sha256', SECRET).update(raw).digest('hex'),
      },
    });

    expect(res.statusCode).toBe(200);
  });
});
```

- [x] **Step 2: Запустить тест, убедиться что падает**

Run: `npx vitest run tests/web/webhooks.test.ts`
Expected: FAIL — модуль `src/web/routes/webhooks.js` не найден.

- [x] **Step 3: Реализовать `src/web/routes/webhooks.ts`**

```ts
import type { FastifyInstance } from 'fastify';
import type { Config } from '../../config.js';
import type { WebhookSource } from '../../adapters/types.js';
import { verifyHandshake, verifySignature } from '../../adapters/instagram/signature.js';
import type { AppDb } from '../../storage/db.js';
import { resolveAccountOwner } from '../../storage/queries/accounts.js';
import { enqueueEvent, markEventSeen } from '../../storage/queries/runtime.js';

interface Deps {
  db: AppDb;
  cfg: Config;
  source: WebhookSource;
}

/** Тело на сотню мегабайт не должно доживать даже до проверки подписи. */
const BODY_LIMIT = 1_048_576;

export function registerWebhookRoutes(app: FastifyInstance, deps: Deps): void {
  /**
   * S1: подпись считается от сырых байт. Разобранное Fastify тело для этого
   * не годится — JSON.stringify(req.body) даёт другую строку.
   */
  app.addContentTypeParser(
    'application/json',
    { parseAs: 'buffer', bodyLimit: BODY_LIMIT },
    (_req, body, done) => { done(null, body); },
  );

  app.get('/webhooks/instagram', (request, reply) => {
    const query = request.query;
    const params = typeof query === 'object' && query !== null
      ? (query as Record<string, unknown>)
      : {};
    const challenge = verifyHandshake(params, deps.cfg.META_VERIFY_TOKEN);

    if (challenge === undefined) return reply.code(403).send();
    return reply.type('text/plain').send(challenge);
  });

  app.post('/webhooks/instagram', (request, reply) => {
    const raw = Buffer.isBuffer(request.body) ? request.body : Buffer.alloc(0);
    const header = request.headers['x-hub-signature-256'];

    if (!verifySignature(raw, typeof header === 'string' ? header : undefined, deps.cfg.META_APP_SECRET)) {
      // Тело в ответе не нужно: подсказывать, что именно не сошлось, незачем
      return reply.code(403).send();
    }

    let body: unknown;
    try {
      body = JSON.parse(raw.toString('utf8'));
    } catch {
      // Подпись верна, значит это Meta; форму мы просто не поняли. Повтор не поможет
      return reply.code(200).send();
    }

    for (const account of deps.source.parseWebhook(body)) {
      const owner = resolveAccountOwner(deps.db, deps.source.platform, account.externalAccountId);
      // S17: неизвестный аккаунт — молча мимо. Код ответа тот же, что и для своего:
      // разные коды позволяют снаружи перебрать, кто у нас клиент
      if (owner === undefined) continue;

      for (const event of account.events) {
        if (!markEventSeen(deps.db, owner.userId, event.dedupeKey)) continue;
        enqueueEvent(deps.db, owner.userId, deps.source.platform, event);
      }
    }

    // Meta отключает медленные приложения: движок и сеть работают отдельным циклом
    return reply.code(200).send();
  });
}
```

- [x] **Step 4: Запустить тест, убедиться что проходит**

Run: `npx vitest run tests/web/webhooks.test.ts`
Expected: PASS, 9 тестов.

- [x] **Step 5: Реализовать `src/server.ts`**

```ts
import Fastify, { type FastifyInstance } from 'fastify';
import { loadConfig } from './config.js';
import { InstagramAdapter } from './adapters/instagram/sender.js';
import type { MessageSender } from './adapters/types.js';
import { ReplyThrottle } from './core/throttle.js';
import type { Platform } from './core/types.js';
import { openDb } from './storage/db.js';
import { registerWebhookRoutes } from './web/routes/webhooks.js';
import { runDelivery, runIntake, type WorkerDeps } from './worker.js';

function main(): void {
  const cfg = loadConfig();
  const db = openDb(cfg.DATABASE_URL);
  const instagram = new InstagramAdapter({ maxTextLength: cfg.MAX_INCOMING_TEXT_LENGTH });

  const app: FastifyInstance = Fastify({ logger: { level: cfg.NODE_ENV === 'production' ? 'info' : 'debug' } });
  registerWebhookRoutes(app, { db, cfg, source: instagram });

  const worker: WorkerDeps = {
    db, cfg,
    senders: new Map<Platform, MessageSender>([['instagram', instagram]]),
    throttle: new ReplyThrottle(cfg.THROTTLE_MAX_REPLIES_PER_MINUTE),
  };

  // Один процесс на бота и веб: общий деплой, общая база (раздел 10 спеки).
  // Таймер, а не бесконечный цикл: так шаг воркера остаётся вызываемым из теста.
  let running = false;
  setInterval(() => {
    if (running) return;
    running = true;
    const now = new Date();
    try {
      runIntake(worker, now);
    } finally {
      void runDelivery(worker, now)
        .catch(() => app.log.error('цикл доставки упал'))
        .finally(() => { running = false; });
    }
  }, cfg.WORKER_INTERVAL_MS);

  app.listen({ port: cfg.PORT, host: '0.0.0.0' }).catch((): void => {
    // Ошибку не печатаем целиком: в ней бывает конфигурация (S9)
    app.log.error('не удалось занять порт');
    process.exit(1);
  });
}

main();
```

В `package.json`, в `scripts`, добавить:

```json
"dev": "tsx watch src/server.ts",
"start": "tsx src/server.ts",
"seed": "tsx scripts/seed.ts"
```

- [x] **Step 6: Реализовать `scripts/seed.ts`**

Кабинета ещё нет (фаза D), поэтому первый клиент, его аккаунт и одна воронка
заводятся скриптом. Пароль здесь заведомо непригоден для входа — форма входа
появится в фазе D вместе с argon2id (S13).

```ts
import { loadConfig } from '../src/config.js';
import { openDb } from '../src/storage/db.js';
import { createUser } from '../src/storage/queries/users.js';
import { connectAccount } from '../src/storage/queries/accounts.js';
import { createAutomation } from '../src/storage/queries/automations.js';

const [email, externalAccountId, token] = process.argv.slice(2);

if (email === undefined || externalAccountId === undefined || token === undefined) {
  console.error('Использование: npm run seed -- <email> <instagram-account-id> <token>');
  process.exit(1);
}

const cfg = loadConfig();
const db = openDb(cfg.DATABASE_URL);

const userId = createUser(db, { email, passwordHash: 'ЗАГЛУШКА-ДО-ФАЗЫ-D' });
connectAccount(db, userId, { platform: 'instagram', externalAccountId, token }, cfg.CREDENTIALS_ENC_KEY);
createAutomation(db, userId, {
  name: 'Прайс по слову «цена»',
  triggerType: 'contains',
  triggerValue: 'цена',
  steps: [
    { say: 'Отправил в директ, посмотрите сообщения' },
    { say: 'Как вас зовут?', saveReplyAs: 'name' },
    { say: 'Спасибо! Скоро свяжемся.' },
  ],
});

// Токен не печатаем ни при каких условиях (S9)
console.log(`Клиент заведён: ${userId}`);
```

- [x] **Step 7: Контрольная точка фазы**

```powershell
npm test; if ($?) { npm run typecheck }
npm audit
```

Expected: все тесты зелёные, typecheck без ошибок, `npm audit` без уязвимостей
уровня high и critical.

- [ ] **Step 8: Коммит**

```bash
git add src/web/ src/server.ts scripts/seed.ts tests/web/ package.json
git commit -m "feat(web): маршрут вебхука Instagram, сборка процесса и посев"
```

---

## Что фаза сознательно не делает

- **Живой прогон через туннель.** Приложения Meta пока нет. Когда появится:
  `npx localtunnel --port 3000`, адрес в настройках приложения, `npm run seed`,
  комментарий под постом. Фикстуры при этом заменяются на снятые с живого вебхука.
- **Файлы в директ** (`attachment_id`, PDF) — фаза C.
- **Кабинет, вход, сессии** — фаза D. `scripts/seed.ts` до тех пор единственный
  способ завести клиента, и пароль в нём — заглушка.
- **24-часовое окно Instagram** — фаза F. Сейчас выход за окно выглядит как
  окончательная ошибка отправки с причиной в `failed_reason`.
- **`notify_operator` в `core/types.ts`** остаётся в union, хотя из воронок в БД
  не приходит. Удаление действия из ядра — отдельное решение, не входящее в эту фазу.

---

## Отклонения от плана при исполнении

- **`enqueueOutbox` получил шестой параметр `nextAttemptAt: Date = new Date()`**
  (задача A7 фазы A, доработана здесь). Раньше время следующей попытки ставил
  дефолт схемы, то есть системные часы. Из-за этого тесты outbox с захардкоженной
  датой протухли, как только реальная дата ушла вперёд, а воркер не мог запланировать
  отложенную отправку. Теперь `runIntake` передаёт в очередь собственное `now`:
  все строки одного прогона получают одно и то же время, а тест задаёт его явно.
  Пауза между сообщениями цепочки (фаза C) опирается на этот же параметр.

- **`runDelivery` разбирает `action_json` и `delivery_json` схемами Zod,**
  а не присваиванием результата `JSON.parse` типизированной переменной, как было
  в плане. `JSON.parse` возвращает `any`, и такое присваивание — необъявленное
  приведение типа: повреждённая строка доехала бы до адаптера. Повреждённая строка
  теперь закрывается с причиной, как и любой невосстановимый отказ.

- **`runIntake` в `src/server.ts` обёрнут в `try/catch`, а не `try/finally`.**
  С `finally` исключение из цикла приёма всплывало из колбэка таймера и роняло
  процесс целиком: одно битое событие останавливало сервис всем клиентам.
  Текст ошибки не логируется — в нём оказываются тело сообщения и токен (S4, S9).

- **`tsconfig.json` → `include` расширен до `["src", "tests", "scripts"]`.**
  `scripts/seed.ts` иначе не попадал под `npm run typecheck` вообще.

- **`npm audit`: 4 уязвимости уровня moderate**, все — в `drizzle-kit` через
  `@esbuild-kit/*` → `esbuild`. Это dev-зависимость, в рантайм не попадает;
  порог контрольной точки (нет high и critical) выдержан.
