# Админка владельца — план реализации (фаза F, часть 1)

> **Для агентов-исполнителей:** ОБЯЗАТЕЛЬНЫЙ СУБ-СКИЛЛ: `superpowers:subagent-driven-development`
> (рекомендуется) или `superpowers:executing-plans`. Шаги отмечаются чекбоксами `- [ ]`.
> Дополнительно обязательны `modern-architecture` и `web-security` — правило CLAUDE.md.

**Цель:** владелец сервиса заводит клиентов, выдаёт доступ ссылкой-приглашением,
подключает их Instagram-аккаунты и отключает неплательщиков через веб-интерфейс,
а не через `npm run seed` на машине с проектом.

**Архитектура:** маршруты админки живут в одном Fastify-плагине с префиксом `/admin`
и единственным хуком `onRequest`, который проверяет роль (S12) — новый маршрут внутри
плагина защищён автоматически, забыть проверку физически нечего. Приглашение хранится
хэшем токена, ровно как сессия: сам токен существует только в ссылке. Гашение
приглашения — одна атомарная `UPDATE ... WHERE used_at IS NULL AND expires_at > ?`
с `RETURNING`, а не транзакция из двух шагов.

**Стек:** Fastify 5, Drizzle + better-sqlite3, Zod 4, argon2id (`@node-rs/argon2`),
vitest 4, TypeScript 7 (strict, `noUncheckedIndexedAccess`).

**Спека:** `docs/superpowers/specs/2026-09-06-phase-f-admin-design.md`

## Глобальные ограничения

Действуют в каждой задаче, повторно не напоминаются:

- **ESM.** Относительные импорты — с расширением `.js`, даже когда файл `.ts`.
  Проверяет `tests/esm-imports.test.ts`.
- **Никаких `any`, `as unknown as`, `!`** в `src/`. В тестах `as unknown as NodeJS.ProcessEnv`
  допустим — им подделывают окружение.
- **`process.env` — только в `src/config.ts`.** Единственное исключение в этом плане:
  `drizzle.config.ts` (задача 1) — это инструмент сборки миграций, он не входит
  в `tsconfig.include` и в рантайм приложения не попадает.
- **Владелец первым аргументом** во всех функциях `src/storage/queries/`, и он входит
  в `WHERE`, а не проверяется отдельным `if` (S11). Задача 3 добавляет **четвёртое**
  задокументированное исключение — `listClients`; его обязательный сопроводитель —
  правка CLAUDE.md в задаче 12.
- **`user_id`, роль и признаки владения не читаются из тела запроса никогда** (S14).
  Zod-схема формы описывает ровно разрешённые поля.
- **Разметка — только тегом `html`** из `src/web/html.ts`, конкатенация строк с данными
  пользователя запрещена (S21).
- **Секреты и ПД не логируются** выше `debug` (S4, S9). В этой фазе появляется секрет
  в URL — токен приглашения; см. задачу 10.
- **Тест пишется до реализации, каждая задача заканчивается коммитом.** Сообщения
  коммитов и комментарии в коде — на русском.
- **База в тестах** берётся из `tests/storage/helpers.ts` — `createTestDb()`.
- Контрольная точка в PowerShell: `npm test; if ($?) { npm run typecheck }`.

---

## Структура файлов

**Создаются:**

| Файл | Ответственность |
|---|---|
| `src/storage/queries/invites.ts` | выпуск, гашение и отзыв приглашений; хэширование токена |
| `src/web/routes/admin.ts` | плагин `/admin`: хук роли и пять маршрутов владельца |
| `src/web/views/admin.ts` | разметка списка клиентов и форм админки |
| `src/web/routes/invite.ts` | публичные `GET/POST /invite/:token` |
| `src/web/views/invite.ts` | разметка формы установки пароля |
| `scripts/create-owner.ts` | первый владелец сервиса |
| `tests/storage/queries/invites.test.ts` | запросы приглашений |
| `tests/web/admin.test.ts` | S12, заведение, отключение, подключение аккаунта |
| `tests/web/invite.test.ts` | приём приглашения, S15, S19 |

**Правятся:**

| Файл | Что меняется |
|---|---|
| `src/storage/schema.ts` | `users.disabled_at`, таблица `invites` |
| `src/storage/queries/users.ts` | `findUserById`, `setUserDisabled`, `setUserPassword`, `listClients` |
| `src/storage/queries/sessions.ts` | `loadSession` возвращает ещё и роль |
| `src/storage/queries/accounts.ts` | `resolveAccountOwner` не видит отключённых; `connectOrUpdateAccount` |
| `src/config.ts`, `.env.example` | `INVITE_TTL_HOURS`, `PUBLIC_BASE_URL` |
| `src/web/session.ts` | `Session` несёт `role` |
| `src/web/routes/auth.ts` | email приводится к нижнему регистру |
| `src/web/views/dashboard.ts` | ссылка на `/admin` только владельцу |
| `src/server.ts` | регистрация плагинов, сериализатор `req` для логгера (S9) |
| `drizzle.config.ts`, `package.json` | применение миграций |
| `CLAUDE.md` | четвёртое исключение из правила «владелец первым аргументом» |

Почему именно так: маршруты и представления разделены — это уже принятое в проекте
разделение, разметка меняется при смене вида страницы, маршрут при смене поведения.
Отдельного «сервисного слоя» админка не получает: у неё нет бизнес-логики сверх той,
что уже лежит в запросах, и промежуточный слой был бы индирекцией без пользы.

---

## Задача 1: Схема, миграция и способ её применить

**Файлы:**
- Правка: `src/storage/schema.ts`
- Правка: `drizzle.config.ts`
- Правка: `package.json`
- Создание: `drizzle/0001_*.sql` (генерируется)
- Тест: `tests/storage/schema.test.ts`

**Интерфейсы:**
- Отдаёт: таблицу `invites` (`id`, `userId`, `expiresAt`, `usedAt`, `createdAt`)
  и колонку `users.disabledAt: Date | null`. На них опираются задачи 2, 3.

**Решение, которое здесь фиксируется.** До этой фазы миграции применялись только
в тестах (`migrate()` в `tests/storage/helpers.ts`), а рабочая база не мигрировалась
ничем — это первая миграция поверх живой базы, и способ её применить нужно завести
сейчас. Выбран `npm run migrate` (`drizzle-kit migrate`), а не вызов `migrate()`
при старте сервера: старт остаётся тупым, а миграция — осознанным действием оператора.
Цена: развёртывание становится двухшаговым (`npm run migrate`, затем `npm start`).

- [x] **Шаг 1: Написать падающий тест**

В конец `tests/storage/schema.test.ts` добавить:

```ts
import { invites, users } from '../../src/storage/schema.js';
import { createTestDb } from './helpers.js';

describe('схема фазы F', () => {
  it('приглашение хранится с хэшем токена и сроком жизни', () => {
    const db = createTestDb();
    const userId = createUser(db, { email: 'k@k.k', passwordHash: 'x' });
    const expiresAt = new Date('2026-09-10T00:00:00Z');

    db.insert(invites).values({ id: 'хэш-токена', userId, expiresAt }).run();
    const row = db.select().from(invites).all()[0];

    expect(row?.usedAt).toBeNull();
    expect(row?.expiresAt).toEqual(expiresAt);
  });

  it('клиент по умолчанию не отключён', () => {
    const db = createTestDb();
    createUser(db, { email: 'k@k.k', passwordHash: 'x' });
    expect(db.select().from(users).all()[0]?.disabledAt).toBeNull();
  });
});
```

Импорт `createUser` из `../../src/storage/queries/users.js` добавить, если его
ещё нет в шапке файла.

- [x] **Шаг 2: Запустить тест, убедиться что падает**

Запуск: `npx vitest run tests/storage/schema.test.ts`
Ожидание: FAIL — `invites` не экспортируется, `disabledAt` нет в типе строки.

- [x] **Шаг 3: Добавить колонку и таблицу в схему**

В `src/storage/schema.ts`, в `users`, после `role`:

```ts
  /**
   * Отключённый клиент: nullable timestamp, а не boolean — в проекте флаги
   * уже так выражены (`sent_at`, `processed_at`), и видно не только «отключён»,
   * но и когда. Отключение обратимо, удаления клиента в v1 нет.
   */
  disabledAt: integer('disabled_at', { mode: 'timestamp' }),
```

В конец файла, следом за `sessions`:

```ts
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
```

- [x] **Шаг 4: Сгенерировать миграцию**

Запуск: `npx drizzle-kit generate`
Ожидание: появился `drizzle/0001_<имя>.sql` с `ALTER TABLE users ADD disabled_at`
и `CREATE TABLE invites`. Файл открыть и глазами проверить, что `DROP` в нём нет:
SQLite не умеет менять колонки на месте, и drizzle-kit при неудачном diff иногда
пересоздаёт таблицу через `DROP`/`CREATE`. Если `DROP TABLE users` там есть —
не применять, а переписать миграцию руками на чистый `ALTER TABLE`.

- [x] **Шаг 5: Завести способ применить миграцию**

В `drizzle.config.ts`:

```ts
export default {
  schema: './src/storage/schema.ts',
  out: './drizzle',
  dialect: 'sqlite',
  // `generate` обходится без подключения, `migrate` — нет. Это инструмент
  // сборки: он не входит в tsconfig.include и в рантайм приложения не попадает,
  // поэтому чтение process.env здесь не нарушает правило «env только в config.ts»
  dbCredentials: { url: process.env.DATABASE_URL ?? './data/bot.db' },
} satisfies Config;
```

В `package.json`, в `scripts`, после `"typecheck"`:

```json
    "migrate": "drizzle-kit migrate",
```

- [x] **Шаг 6: Запустить тесты, убедиться что проходят**

Запуск: `npm test; if ($?) { npm run typecheck }`
Ожидание: PASS. Тесты берут схему из `./drizzle` через `migrate()`, новая миграция
подхватывается сама.

- [x] **Шаг 7: Коммит**

```bash
git add src/storage/schema.ts drizzle/ drizzle.config.ts package.json tests/storage/schema.test.ts
git commit -m "feat(storage): отключение клиента и таблица приглашений, применение миграций"
```

---

## Задача 2: Запросы приглашений

**Файлы:**
- Создание: `src/storage/queries/invites.ts`
- Тест: `tests/storage/queries/invites.test.ts`

**Интерфейсы:**
- Использует: `invites` из схемы (задача 1).
- Отдаёт:
  - `createInvite(db: AppDb, userId: string, now: Date, ttlMs: number): string` — возвращает токен
  - `consumeInvite(db: AppDb, token: string, now: Date): { userId: string } | undefined`
  - `revokeUserInvites(db: AppDb, userId: string, now: Date): void`

**Почему `consumeInvite` возвращает `userId`, а не принимает его.** Гость, идущий
по ссылке, ещё не знает, кто он — его личность и есть содержимое приглашения.
Это тот же случай, что `resolveAccountOwner`: владелец здесь определяется, а не
проверяется, поэтому правило «userId первым аргументом» к функции не применимо.

- [x] **Шаг 1: Написать падающий тест**

Создать `tests/storage/queries/invites.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { createTestDb } from '../helpers.js';
import { createUser } from '../../../src/storage/queries/users.js';
import {
  consumeInvite, createInvite, revokeUserInvites,
} from '../../../src/storage/queries/invites.js';
import { invites } from '../../../src/storage/schema.js';

const HOUR = 3_600_000;
const now = new Date('2026-09-09T12:00:00Z');
const later = new Date('2026-09-09T13:00:00Z');

function seedClient(email = 'k@k.k') {
  const db = createTestDb();
  return { db, userId: createUser(db, { email, passwordHash: 'x' }) };
}

describe('приглашения', () => {
  it('токен не хранится в базе — только его хэш', () => {
    const { db, userId } = seedClient();
    const token = createInvite(db, userId, now, 48 * HOUR);

    const stored = db.select().from(invites).all()[0];
    expect(stored?.id).not.toBe(token);
    expect(token.length).toBeGreaterThanOrEqual(32);
  });

  it('действующее приглашение гасится и отдаёт владельца', () => {
    const { db, userId } = seedClient();
    const token = createInvite(db, userId, now, 48 * HOUR);

    expect(consumeInvite(db, token, later)).toEqual({ userId });
  });

  it('погашенное приглашение второй раз не срабатывает', () => {
    const { db, userId } = seedClient();
    const token = createInvite(db, userId, now, 48 * HOUR);

    consumeInvite(db, token, later);
    expect(consumeInvite(db, token, later)).toBeUndefined();
  });

  it('протухшее приглашение не срабатывает', () => {
    const { db, userId } = seedClient();
    const token = createInvite(db, userId, now, HOUR);

    expect(consumeInvite(db, token, new Date('2026-09-09T14:00:00Z'))).toBeUndefined();
  });

  it('несуществующий токен не роняет запрос', () => {
    const { db } = seedClient();
    expect(consumeInvite(db, 'выдуманный-токен', now)).toBeUndefined();
  });

  it('перевыпуск гасит прежние ссылки того же клиента', () => {
    const { db, userId } = seedClient();
    const old = createInvite(db, userId, now, 48 * HOUR);

    revokeUserInvites(db, userId, later);
    const fresh = createInvite(db, userId, later, 48 * HOUR);

    expect(consumeInvite(db, old, later)).toBeUndefined();
    expect(consumeInvite(db, fresh, later)).toEqual({ userId });
  });

  it('S11: отзыв не трогает приглашения другого клиента', () => {
    const { db, userId: a } = seedClient('a@a.a');
    const b = createUser(db, { email: 'b@b.b', passwordHash: 'x' });
    const tokenB = createInvite(db, b, now, 48 * HOUR);

    revokeUserInvites(db, a, later);

    expect(consumeInvite(db, tokenB, later)).toEqual({ userId: b });
  });
});
```

- [x] **Шаг 2: Запустить тест, убедиться что падает**

Запуск: `npx vitest run tests/storage/queries/invites.test.ts`
Ожидание: FAIL — модуля `invites.ts` не существует.

- [x] **Шаг 3: Реализовать `src/storage/queries/invites.ts`**

```ts
import { createHash, randomBytes } from 'node:crypto';
import { and, eq, gt, isNull } from 'drizzle-orm';
import type { AppDb } from '../db.js';
import { invites } from '../schema.js';

/**
 * Тот же приём, что в `sessions`: в ссылку уезжает токен, в базу ложится хэш.
 * Соли и растягивания нет намеренно — токен уже случайный на 256 бит.
 */
function tokenHash(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

/** Возвращает токен: он существует только здесь и в ссылке у владельца. */
export function createInvite(db: AppDb, userId: string, now: Date, ttlMs: number): string {
  const token = randomBytes(32).toString('hex');
  db.insert(invites).values({
    id: tokenHash(token),
    userId,
    expiresAt: new Date(now.getTime() + ttlMs),
    createdAt: now,
  }).run();
  return token;
}

/**
 * Проверка и гашение — одна операция, а не транзакция из двух шагов: между
 * «нашли действующее» и «пометили использованным» есть щель, в которую
 * проходит двойной сабмит формы. `RETURNING` отдаёт владельца той же строкой,
 * которую только что погасил, — если не затронуто ни одной, ссылка недействительна.
 *
 * Владельца функция не принимает, а определяет: гость, идущий по ссылке,
 * ещё не аутентифицирован. Осознанное исключение из правила S11, как
 * `resolveAccountOwner`.
 */
export function consumeInvite(
  db: AppDb, token: string, now: Date,
): { userId: string } | undefined {
  return db.update(invites)
    .set({ usedAt: now })
    .where(and(
      eq(invites.id, tokenHash(token)),
      isNull(invites.usedAt),
      gt(invites.expiresAt, now),
    ))
    .returning({ userId: invites.userId })
    .all()[0];
}

/** Только проверка, без гашения: нужна GET-маршруту, чтобы решить, показывать ли форму. */
export function peekInvite(db: AppDb, token: string, now: Date): boolean {
  return db.select({ id: invites.id }).from(invites)
    .where(and(
      eq(invites.id, tokenHash(token)),
      isNull(invites.usedAt),
      gt(invites.expiresAt, now),
    ))
    .all().length === 1;
}

/**
 * S11: владелец в условии. Гасит все действующие приглашения клиента — иначе
 * после «ссылка утекла, выпустите новую» старая работала бы до конца срока.
 */
export function revokeUserInvites(db: AppDb, userId: string, now: Date): void {
  db.update(invites)
    .set({ usedAt: now })
    .where(and(eq(invites.userId, userId), isNull(invites.usedAt)))
    .run();
}
```

- [x] **Шаг 4: Запустить тесты, убедиться что проходят**

Запуск: `npx vitest run tests/storage/queries/invites.test.ts`
Ожидание: PASS, все 7.

- [x] **Шаг 5: Коммит**

```bash
git add src/storage/queries/invites.ts tests/storage/queries/invites.test.ts
git commit -m "feat(storage): приглашения с хэшем токена и атомарным гашением (S15)"
```

---

## Задача 3: Отключение клиента и список клиентов

**Файлы:**
- Правка: `src/storage/queries/users.ts`
- Правка: `src/storage/queries/accounts.ts` (только `resolveAccountOwner`)
- Тест: `tests/storage/queries/users.test.ts` (создать)
- Тест: `tests/storage/queries/accounts.test.ts`

**Интерфейсы:**
- Отдаёт:
  - `findUserById(db: AppDb, userId: string): UserRow | undefined`
  - `setUserDisabled(db: AppDb, userId: string, disabledAt: Date | null): void`
  - `setUserPassword(db: AppDb, userId: string, passwordHash: string): void`
  - `ClientRow { id, email, disabledAt, connected, automationCount }`
  - `listClients(db: AppDb): ClientRow[]`

**Четвёртое исключение из «владелец первым аргументом».** `listClients` читает всех
клиентов и `userId` не принимает: у владельца сервиса нет «своих» клиентов в смысле
S11 — ему принадлежат все. Защита здесь не в `WHERE`, а в хуке роли плагина `/admin`
(S12), и это осознанно другая защита. Функция обязана быть недоступна ниоткуда,
кроме админки; правка CLAUDE.md — в задаче 12.

**Почему три запроса, а не один JOIN.** Списку нужны и число воронок, и факт
подключённого аккаунта. Один `LEFT JOIN` на обе таблицы размножит строки
(3 воронки × 1 аккаунт = 3 строки) и число воронок посчитается неверно. Три
отдельных запроса с последующей склейкой в памяти — по одному на таблицу,
без N+1 и без фан-аута.

- [x] **Шаг 1: Написать падающий тест отключения**

Создать `tests/storage/queries/users.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { createTestDb } from '../helpers.js';
import {
  createUser, findUserById, listClients, setUserDisabled, setUserPassword,
} from '../../../src/storage/queries/users.js';
import { createAutomation } from '../../../src/storage/queries/automations.js';
import { connectAccount } from '../../../src/storage/queries/accounts.js';

const KEY = 'a'.repeat(64);
const now = new Date('2026-09-09T12:00:00Z');

describe('пользователи', () => {
  it('отключение обратимо', () => {
    const db = createTestDb();
    const id = createUser(db, { email: 'k@k.k', passwordHash: 'x' });

    setUserDisabled(db, id, now);
    expect(findUserById(db, id)?.disabledAt).toEqual(now);

    setUserDisabled(db, id, null);
    expect(findUserById(db, id)?.disabledAt).toBeNull();
  });

  it('смена пароля не трогает остальные поля', () => {
    const db = createTestDb();
    const id = createUser(db, { email: 'k@k.k', passwordHash: 'старый' });

    setUserPassword(db, id, 'новый');

    const row = findUserById(db, id);
    expect(row?.passwordHash).toBe('новый');
    expect(row?.email).toBe('k@k.k');
    expect(row?.role).toBe('client');
  });

  it('список клиентов не показывает владельцев сервиса', () => {
    const db = createTestDb();
    createUser(db, { email: 'vladelec@k.k', passwordHash: 'x', role: 'owner' });
    createUser(db, { email: 'klient@k.k', passwordHash: 'x' });

    expect(listClients(db).map((c) => c.email)).toEqual(['klient@k.k']);
  });

  it('число воронок не размножается подключённым аккаунтом', () => {
    const db = createTestDb();
    const id = createUser(db, { email: 'k@k.k', passwordHash: 'x' });
    connectAccount(db, id, { platform: 'instagram', externalAccountId: '1', token: 't' }, KEY);
    for (const name of ['первая', 'вторая', 'третья']) {
      createAutomation(db, id, {
        name, triggerType: 'exact', triggerValue: name, steps: [{ say: 'привет' }],
      });
    }

    const row = listClients(db)[0];
    expect(row?.automationCount).toBe(3);
    expect(row?.connected).toBe(true);
  });

  it('клиент без аккаунта и воронок показывается нулями, а не пропадает', () => {
    const db = createTestDb();
    createUser(db, { email: 'novyy@k.k', passwordHash: 'x' });

    const row = listClients(db)[0];
    expect(row?.connected).toBe(false);
    expect(row?.automationCount).toBe(0);
  });
});
```

Перед реализацией сверить сигнатуру `createAutomation` с
`src/storage/queries/automations.ts:34` — если поле шагов называется иначе,
поправить вызов в тесте, а не выдумывать.

- [x] **Шаг 2: Запустить тест, убедиться что падает**

Запуск: `npx vitest run tests/storage/queries/users.test.ts`
Ожидание: FAIL — `findUserById`, `setUserDisabled`, `setUserPassword`, `listClients`
не экспортируются.

- [x] **Шаг 3: Дописать `src/storage/queries/users.ts`**

Шапку импортов заменить на:

```ts
import { randomUUID } from 'node:crypto';
import { count, eq, inArray } from 'drizzle-orm';
import type { AppDb } from '../db.js';
import { automations, platformAccounts, users } from '../schema.js';
```

В конец файла добавить:

```ts
export function findUserById(db: AppDb, userId: string): UserRow | undefined {
  return db.select().from(users).where(eq(users.id, userId)).all()[0];
}

/** `null` включает клиента обратно. Отключение обратимо, удаления в v1 нет. */
export function setUserDisabled(db: AppDb, userId: string, disabledAt: Date | null): void {
  db.update(users).set({ disabledAt }).where(eq(users.id, userId)).run();
}

/** Хэш приходит готовым: как и в `createUser`, хранилище не знает про argon2 (S13). */
export function setUserPassword(db: AppDb, userId: string, passwordHash: string): void {
  db.update(users).set({ passwordHash }).where(eq(users.id, userId)).run();
}

export interface ClientRow {
  id: string;
  email: string;
  disabledAt: Date | null;
  connected: boolean;
  automationCount: number;
}

/**
 * Четвёртое осознанное исключение из правила «владелец первым аргументом»:
 * у владельца сервиса нет «своих» клиентов — ему принадлежат все. Защищает
 * эту функцию не `WHERE`, а хук роли плагина `/admin` (S12), и вызываться
 * она обязана только оттуда.
 *
 * Три запроса, а не один JOIN: `LEFT JOIN` сразу на воронки и аккаунты
 * размножил бы строки и посчитал воронки неверно.
 */
export function listClients(db: AppDb): ClientRow[] {
  const rows = db.select({
    id: users.id, email: users.email, disabledAt: users.disabledAt,
  }).from(users).where(eq(users.role, 'client')).all();

  if (rows.length === 0) return [];
  const ids = rows.map((r) => r.id);

  const counts = new Map(
    db.select({ userId: automations.userId, n: count() })
      .from(automations).where(inArray(automations.userId, ids))
      .groupBy(automations.userId).all()
      .map((r) => [r.userId, r.n] as const),
  );
  const connected = new Set(
    db.select({ userId: platformAccounts.userId })
      .from(platformAccounts).where(inArray(platformAccounts.userId, ids))
      .all().map((r) => r.userId),
  );

  return rows.map((r) => ({
    ...r,
    connected: connected.has(r.id),
    automationCount: counts.get(r.id) ?? 0,
  }));
}
```

- [x] **Шаг 4: Написать падающий тест про вебхук отключённого клиента**

В `tests/storage/queries/accounts.test.ts` добавить:

```ts
  it('S17: вебхук отключённого клиента не находит владельца', () => {
    const db = createTestDb();
    const userId = createUser(db, { email: 'k@k.k', passwordHash: 'x' });
    connectAccount(db, userId, {
      platform: 'instagram', externalAccountId: '17841400000000000', token: 't',
    }, KEY);

    expect(resolveAccountOwner(db, 'instagram', '17841400000000000')).toBeDefined();

    setUserDisabled(db, userId, new Date('2026-09-09T12:00:00Z'));

    expect(resolveAccountOwner(db, 'instagram', '17841400000000000')).toBeUndefined();
  });
```

Импорты `setUserDisabled` и `createUser` при необходимости добавить в шапку.
Константу `KEY` взять ту, что уже объявлена в файле.

- [x] **Шаг 5: Запустить оба теста, убедиться что падает второй**

Запуск: `npx vitest run tests/storage/queries/`
Ожидание: `users.test.ts` — PASS; новый тест в `accounts.test.ts` — FAIL:
отключённый клиент по-прежнему находится.

- [x] **Шаг 6: Научить `resolveAccountOwner` не видеть отключённых**

В `src/storage/queries/accounts.ts` в импорты добавить `isNull` и `users`:

```ts
import { and, eq, isNull } from 'drizzle-orm';
import { platformAccounts, users } from '../schema.js';
```

Тело `resolveAccountOwner` заменить на:

```ts
export function resolveAccountOwner(
  db: AppDb,
  platform: Platform,
  externalAccountId: string,
): { userId: string; accountId: string } | undefined {
  const row = db.select({ userId: platformAccounts.userId, accountId: platformAccounts.id })
    .from(platformAccounts)
    .innerJoin(users, eq(users.id, platformAccounts.userId))
    .where(and(
      eq(platformAccounts.platform, platform),
      eq(platformAccounts.externalAccountId, externalAccountId),
      // Отключённый клиент неотличим от неизвестного аккаунта: новое требование
      // выражено через уже написанный S17, а не отдельной проверкой выше по стеку
      isNull(users.disabledAt),
    ))
    .all()[0];
  return row;
}
```

Комментарий-шапку функции («S17: единственный вход без userId…») сохранить,
дописав к нему строку про отключённого клиента.

- [x] **Шаг 7: Запустить тесты, убедиться что проходят**

Запуск: `npm test; if ($?) { npm run typecheck }`
Ожидание: PASS. Особое внимание на `tests/web/webhooks.test.ts` и `tests/worker.test.ts` —
они опираются на `resolveAccountOwner`.

- [x] **Шаг 8: Коммит**

```bash
git add src/storage/queries/users.ts src/storage/queries/accounts.ts tests/storage/queries/
git commit -m "feat(storage): отключение клиента, список клиентов и глухой вебхук отключённого (S17)"
```

---

## Задача 4: Подключение и перезапись Instagram-аккаунта

**Файлы:**
- Правка: `src/storage/queries/accounts.ts`
- Тест: `tests/storage/queries/accounts.test.ts`

**Интерфейсы:**
- Отдаёт: `connectOrUpdateAccount(db, userId, input, keyHex): 'created' | 'updated' | 'taken'`,
  где `input: { platform: Platform; externalAccountId: string; token: string }`.
  Используется задачей 9.

**Почему отказ при чужом внешнем id — требование, а не удобство.** Без него клиент Б
вписывает внешний id аккаунта клиента А и перехватывает все его вебхуки:
`resolveAccountOwner` ищет по `(platform, external_account_id)`. Это пробой S17
через админку.

- [x] **Шаг 1: Написать падающий тест**

В `tests/storage/queries/accounts.test.ts` добавить:

```ts
describe('подключение аккаунта из админки', () => {
  it('свободный внешний id создаёт запись', () => {
    const db = createTestDb();
    const userId = createUser(db, { email: 'a@a.a', passwordHash: 'x' });

    const outcome = connectOrUpdateAccount(db, userId, {
      platform: 'instagram', externalAccountId: '111', token: 'токен-1',
    }, KEY);

    expect(outcome).toBe('created');
    expect(getAccountTokenForPlatform(db, userId, 'instagram', KEY)?.token).toBe('токен-1');
  });

  it('свой аккаунт перезаписывает токен, а не плодит вторую строку', () => {
    const db = createTestDb();
    const userId = createUser(db, { email: 'a@a.a', passwordHash: 'x' });
    connectOrUpdateAccount(db, userId, {
      platform: 'instagram', externalAccountId: '111', token: 'старый',
    }, KEY);

    const outcome = connectOrUpdateAccount(db, userId, {
      platform: 'instagram', externalAccountId: '111', token: 'новый',
    }, KEY);

    expect(outcome).toBe('updated');
    expect(getAccountTokenForPlatform(db, userId, 'instagram', KEY)?.token).toBe('новый');
    expect(listAccounts(db, userId)).toHaveLength(1);
  });

  it('S17: чужой внешний id отвергается и токен владельца не меняется', () => {
    const db = createTestDb();
    const a = createUser(db, { email: 'a@a.a', passwordHash: 'x' });
    const b = createUser(db, { email: 'b@b.b', passwordHash: 'x' });
    connectOrUpdateAccount(db, a, {
      platform: 'instagram', externalAccountId: '111', token: 'токен-А',
    }, KEY);

    const outcome = connectOrUpdateAccount(db, b, {
      platform: 'instagram', externalAccountId: '111', token: 'токен-Б',
    }, KEY);

    expect(outcome).toBe('taken');
    expect(getAccountTokenForPlatform(db, a, 'instagram', KEY)?.token).toBe('токен-А');
    expect(listAccounts(db, b)).toHaveLength(0);
    expect(resolveAccountOwner(db, 'instagram', '111')).toMatchObject({ userId: a });
  });
});
```

- [x] **Шаг 2: Запустить тест, убедиться что падает**

Запуск: `npx vitest run tests/storage/queries/accounts.test.ts`
Ожидание: FAIL — `connectOrUpdateAccount` не экспортируется.

- [x] **Шаг 3: Реализовать `connectOrUpdateAccount`**

В конец `src/storage/queries/accounts.ts`:

```ts
export type ConnectOutcome = 'created' | 'updated' | 'taken';

/**
 * Три исхода вместо булева результата: «занят другим» и «обновили свой» —
 * разные события для владельца, и сводить их к `false`/`true` значит
 * заставить вызывающего гадать.
 *
 * `taken` — не удобство, а требование: без него клиент вписывает внешний id
 * чужого аккаунта и перехватывает его вебхуки (пробой S17 через админку).
 * `updated` — тоже не удобство: токены Instagram живут 60 дней, без перезаписи
 * сервис молча умирает через два месяца.
 *
 * S11: владелец первым аргументом и в условии обновления. Чужую строку
 * эта функция изменить не может — она её только видит, чтобы отказать.
 */
export function connectOrUpdateAccount(
  db: AppDb,
  userId: string,
  input: { platform: Platform; externalAccountId: string; token: string },
  keyHex: string,
): ConnectOutcome {
  const existing = db.select({ userId: platformAccounts.userId })
    .from(platformAccounts)
    .where(and(
      eq(platformAccounts.platform, input.platform),
      eq(platformAccounts.externalAccountId, input.externalAccountId),
    ))
    .all()[0];

  if (existing !== undefined && existing.userId !== userId) return 'taken';

  if (existing !== undefined) {
    db.update(platformAccounts)
      .set({ tokenEncrypted: encryptSecret(input.token, keyHex) })
      .where(and(
        eq(platformAccounts.userId, userId),
        eq(platformAccounts.platform, input.platform),
        eq(platformAccounts.externalAccountId, input.externalAccountId),
      ))
      .run();
    return 'updated';
  }

  connectAccount(db, userId, input, keyHex);
  return 'created';
}
```

Здесь `resolveAccountOwner` намеренно не переиспользуется: он с задачи 3 не видит
отключённых клиентов, а занятость внешнего id от отключённости не зависит —
иначе аккаунт отключённого клиента можно было бы увести.

- [x] **Шаг 4: Запустить тесты, убедиться что проходят**

Запуск: `npx vitest run tests/storage/queries/accounts.test.ts`
Ожидание: PASS.

- [x] **Шаг 5: Коммит**

```bash
git add src/storage/queries/accounts.ts tests/storage/queries/accounts.test.ts
git commit -m "feat(storage): подключение аккаунта с перезаписью токена и отказом на чужой id (S17)"
```

---

## Задача 5: Две переменные окружения

**Файлы:**
- Правка: `src/config.ts`, `.env.example`
- Правка: `tests/config.test.ts`
- Правка: `tests/web/auth.test.ts`, `constructor.test.ts`, `dashboard.test.ts`,
  `files.test.ts`, `isolation.test.ts`, `leads.test.ts`, `webhooks.test.ts`,
  `tests/worker.test.ts`

**Ловушка, из-за которой правок восемь.** `PUBLIC_BASE_URL` обязательна и без значения
по умолчанию — это осознанно: вывести её из заголовка `Host` нельзя, он приходит
от клиента, и ссылка приглашения увела бы токен на чужой домен. Но восемь тестовых
файлов строят минимальное окружение из четырёх переменных и после этой правки
упадут все разом. Их надо поправить в этой же задаче, иначе следующая задача
начнётся с красных тестов, не имеющих к ней отношения.

- [x] **Шаг 1: Написать падающий тест**

В `tests/config.test.ts` в объект `valid` добавить строку
`PUBLIC_BASE_URL: 'https://bot.example.com',` и дописать в конец `describe`:

```ts
  it('подставляет срок жизни приглашения по умолчанию', () => {
    expect(loadConfig(valid).INVITE_TTL_HOURS).toBe(48);
  });

  it('PUBLIC_BASE_URL обязательна: из заголовка Host её брать нельзя', () => {
    const { PUBLIC_BASE_URL, ...missing } = valid;
    expect(() => loadConfig(missing as NodeJS.ProcessEnv)).toThrow(/PUBLIC_BASE_URL/);
  });

  it('S10: непохожий на URL адрес отвергается по имени, без значения', () => {
    const bad = { ...valid, PUBLIC_BASE_URL: 'ne-url-a-musor' };
    try {
      loadConfig(bad as NodeJS.ProcessEnv);
      throw new Error('должно было упасть');
    } catch (e) {
      const msg = (e as Error).message;
      expect(msg).toContain('PUBLIC_BASE_URL');
      expect(msg).not.toContain('ne-url-a-musor');
    }
  });
```

- [x] **Шаг 2: Запустить тест, убедиться что падает**

Запуск: `npx vitest run tests/config.test.ts`
Ожидание: FAIL — `INVITE_TTL_HOURS` нет в типе `Config`, отсутствие
`PUBLIC_BASE_URL` не приводит к ошибке.

- [x] **Шаг 3: Дописать `EnvSchema`**

В `src/config.ts` после блока `LOGIN_WINDOW_MINUTES`:

```ts
  INVITE_TTL_HOURS: z.coerce.number().int().positive().default(48),
  // Основа ссылки приглашения. Обязательная и не выводится из заголовка `Host`:
  // он приходит от клиента, и ссылка увела бы токен на чужой домен
  PUBLIC_BASE_URL: z.url(),
```

`z.url()` — форма Zod 4; `z.string().url()` в этой версии устарела.

В `.env.example` в блок «Вход и сессии»:

```
# Основа ссылки приглашения, без завершающего слэша
PUBLIC_BASE_URL=http://localhost:3000
INVITE_TTL_HOURS=48
```

- [x] **Шаг 4: Починить восемь тестовых окружений**

В каждом из восьми файлов найти объект, который передаётся в `loadConfig`
(в большинстве — внутри функции `config()`), и добавить в него
`PUBLIC_BASE_URL: 'https://bot.example.com',`.

Найти все места одной командой:

```bash
grep -rn "CREDENTIALS_ENC_KEY" tests/
```

- [x] **Шаг 5: Запустить весь набор, убедиться что зелено**

Запуск: `npm test; if ($?) { npm run typecheck }`
Ожидание: PASS целиком. Если какой-то файл остался красным — в нём есть
второй, не найденный `grep`, вызов `loadConfig`.

- [x] **Шаг 6: Коммит**

```bash
git add src/config.ts .env.example tests/
git commit -m "feat(config): срок жизни приглашения и основа публичной ссылки"
```

---

## Задача 6: Роль в сессии и плагин админки со списком клиентов

**Файлы:**
- Правка: `src/storage/queries/sessions.ts`, `src/web/session.ts`
- Создание: `src/web/routes/admin.ts`, `src/web/views/admin.ts`
- Тест: `tests/web/admin.test.ts`

**Интерфейсы:**
- Использует: `listClients` (задача 3), `csrfToken` (`src/web/csrf.ts`),
  `currentSession`, `redirectToLogin` (`src/web/session.ts`).
- Отдаёт:
  - `Session { token: string; userId: string; role: 'client' | 'owner' }`
  - `registerAdminRoutes(app: FastifyInstance, deps: WebDeps): void`
  - `adminPage(clients: ClientRow[], csrf: string, notice: Notice | undefined): Html`,
    где `Notice = { kind: 'error' | 'invite'; text: string }`. Используется задачами 7–9.

**Почему роль берётся из БД, а не кладётся в сессию.** `loadSession` и так ходит
в базу на каждый запрос — добавить `INNER JOIN users` дешевле, чем завести второй
запрос, и роль всегда актуальна: разжалование действует немедленно, а не до конца
срока сессии.

**Почему хук, а не `requireOwner()` в каждом обработчике.** Fastify инкапсулирует
хуки внутри плагина: новый маршрут, добавленный в плагин, защищён автоматически.
`requireOwner()` в теле каждого обработчика держится на дисциплине, и тесты молчат,
пока кто-то не напишет тест именно на новый маршрут. Глобальный хук
с `path.startsWith('/admin')` — защита на сравнении строк: `//admin`,
`/admin/../admin`, регистр — каждый случай пришлось бы предусматривать отдельно.

- [x] **Шаг 1: Написать падающий тест**

Создать `tests/web/admin.test.ts`:

```ts
import Fastify from 'fastify';
import { describe, expect, it } from 'vitest';
import { createTestDb } from '../storage/helpers.js';
import { loadConfig } from '../../src/config.js';
import { ReplyThrottle } from '../../src/core/throttle.js';
import type { AppDb } from '../../src/storage/db.js';
import { createUser } from '../../src/storage/queries/users.js';
import { createSession } from '../../src/storage/queries/sessions.js';
import { csrfToken } from '../../src/web/csrf.js';
import { registerFormParser } from '../../src/web/http.js';
import { registerAdminRoutes } from '../../src/web/routes/admin.js';

const SECRET = 'a'.repeat(32);
const now = new Date('2026-09-09T12:00:00Z');
const DAY = 86_400_000;

function config() {
  return loadConfig({
    META_APP_SECRET: 's', META_VERIFY_TOKEN: 'v',
    CREDENTIALS_ENC_KEY: 'a'.repeat(64), SESSION_SECRET: SECRET,
    PUBLIC_BASE_URL: 'https://bot.example.com',
  } as unknown as NodeJS.ProcessEnv);
}

function build(db: AppDb) {
  const cfg = config();
  const app = Fastify();
  registerFormParser(app);
  registerAdminRoutes(app, { db, cfg, throttle: new ReplyThrottle(100, 60_000) });
  return app;
}

/** Возвращает и cookie, и csrf: формы админки без него получат 403. */
function login(db: AppDb, userId: string) {
  const token = createSession(db, userId, now, DAY);
  return { cookie: `sid=${token}`, csrf: csrfToken(token, SECRET) };
}

/**
 * Все маршруты плагина разом: новый маршрут обязан попасть в этот список.
 * До задачи 9 существует только первый — остальные четыре строки закомментировать
 * и вернуть в задаче 9, шаг 4.
 */
const ROUTES = [
  { method: 'GET' as const, url: '/admin' },
  { method: 'POST' as const, url: '/admin/clients' },
  { method: 'POST' as const, url: '/admin/clients/чужой-id/invite' },
  { method: 'POST' as const, url: '/admin/clients/чужой-id/toggle' },
  { method: 'POST' as const, url: '/admin/clients/чужой-id/accounts' },
];

describe('доступ в админку', () => {
  it.each(ROUTES)('S12: клиент получает 403 на $method $url', async (route) => {
    const db = createTestDb();
    const clientId = createUser(db, { email: 'k@k.k', passwordHash: 'x' });
    const { cookie } = login(db, clientId);

    const res = await build(db).inject({ ...route, headers: { cookie } });

    expect(res.statusCode).toBe(403);
  });

  it.each(ROUTES)('S12: аноним уходит на вход с $method $url', async (route) => {
    const res = await build(createTestDb()).inject(route);

    expect(res.statusCode).toBe(303);
    expect(res.headers.location).toBe('/login');
  });

  it('владелец видит список клиентов', async () => {
    const db = createTestDb();
    const ownerId = createUser(db, { email: 'vladelec@k.k', passwordHash: 'x', role: 'owner' });
    createUser(db, { email: 'klient@k.k', passwordHash: 'x' });
    const { cookie } = login(db, ownerId);

    const res = await build(db).inject({ method: 'GET', url: '/admin', headers: { cookie } });

    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('klient@k.k');
  });

  it('S11: владелец сервиса не показан в списке как клиент', async () => {
    const db = createTestDb();
    const ownerId = createUser(db, { email: 'vladelec@k.k', passwordHash: 'x', role: 'owner' });
    const { cookie } = login(db, ownerId);

    const res = await build(db).inject({ method: 'GET', url: '/admin', headers: { cookie } });

    expect(res.body).not.toContain('vladelec@k.k');
  });

  it('S9: страница админки не кэшируется', async () => {
    const db = createTestDb();
    const ownerId = createUser(db, { email: 'v@k.k', passwordHash: 'x', role: 'owner' });
    const { cookie } = login(db, ownerId);

    const res = await build(db).inject({ method: 'GET', url: '/admin', headers: { cookie } });

    expect(res.headers['cache-control']).toBe('no-store');
  });
});
```

- [x] **Шаг 2: Запустить тест, убедиться что падает**

Запуск: `npx vitest run tests/web/admin.test.ts`
Ожидание: FAIL — модуля `src/web/routes/admin.ts` не существует.

- [x] **Шаг 3: Научить сессию отдавать роль**

В `src/storage/queries/sessions.ts` в импорт схемы добавить `users`:

```ts
import { sessions, users } from '../schema.js';
```

и заменить `loadSession`:

```ts
/**
 * Срок жизни проверяется в самом запросе: истёкшая строка просто не находится.
 *
 * Роль берётся из `users` тем же запросом, а не кладётся в сессию при входе:
 * в базу мы ходим здесь всё равно, а роль из БД всегда актуальна — разжалование
 * действует немедленно, а не до конца срока сессии (S12).
 */
export function loadSession(
  db: AppDb, token: string, now: Date,
): { userId: string; role: 'client' | 'owner' } | undefined {
  return db.select({ userId: sessions.userId, role: users.role })
    .from(sessions)
    .innerJoin(users, eq(users.id, sessions.userId))
    .where(and(eq(sessions.id, tokenHash(token)), gt(sessions.expiresAt, now)))
    .all()[0];
}
```

В `src/web/session.ts` расширить `Session`:

```ts
export interface Session {
  token: string;
  userId: string;
  role: 'client' | 'owner';
}
```

и в теле `currentSession` последнюю строку заменить на:

```ts
  return { token, userId: found.userId, role: found.role };
```

- [x] **Шаг 4: Реализовать `src/web/views/admin.ts`**

```ts
import { html, type Html } from '../html.js';
import type { ClientRow } from '../../storage/queries/users.js';
import { layout } from './layout.js';

/**
 * Ссылка приглашения показывается один раз: в базе только хэш, восстановить
 * нечего — можно лишь перевыпустить. Поэтому это не «сообщение об успехе»,
 * а часть результата операции.
 */
export interface Notice {
  kind: 'error' | 'invite';
  text: string;
}

function row(client: ClientRow, csrf: string): Html {
  const state = client.disabledAt === null ? 'работает' : 'отключён';
  return html`
<tr>
  <td>${client.email}</td>
  <td>${state}</td>
  <td>${client.connected ? 'подключён' : 'нет'}</td>
  <td>${client.automationCount}</td>
  <td>
    <form method="post" action="/admin/clients/${client.id}/toggle">
      <input type="hidden" name="csrf" value="${csrf}">
      <button type="submit">${client.disabledAt === null ? 'Отключить' : 'Включить'}</button>
    </form>
    <form method="post" action="/admin/clients/${client.id}/invite">
      <input type="hidden" name="csrf" value="${csrf}">
      <button type="submit">Новая ссылка</button>
    </form>
    <form method="post" action="/admin/clients/${client.id}/accounts">
      <input type="hidden" name="csrf" value="${csrf}">
      <label>ID аккаунта <input name="external_account_id" required inputmode="numeric"></label>
      <label>Токен <input type="password" name="token" required autocomplete="off"></label>
      <button type="submit">Подключить</button>
    </form>
  </td>
</tr>`;
}

export function adminPage(
  clients: ClientRow[], csrf: string, notice: Notice | undefined,
): Html {
  return layout('Клиенты', html`
<h1>Клиенты</h1>
<p><a href="/">Мой кабинет</a></p>
${notice === undefined ? '' : html`<p role="alert">${notice.text}</p>`}
<form method="post" action="/admin/clients">
  <input type="hidden" name="csrf" value="${csrf}">
  <label>Почта нового клиента <input type="email" name="email" required></label>
  <button type="submit">Завести</button>
</form>
${clients.length === 0 ? html`<p>Клиентов пока нет.</p>` : html`
<table>
  <thead><tr><th>Почта</th><th>Состояние</th><th>Instagram</th><th>Воронок</th><th></th></tr></thead>
  <tbody>${clients.map((c) => row(c, csrf))}</tbody>
</table>`}`);
}
```

Токен вводится в `type="password"` не ради секретности ввода, а чтобы он не остался
в автозаполнении браузера владельца.

- [x] **Шаг 5: Реализовать плагин `src/web/routes/admin.ts`**

```ts
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { listClients } from '../../storage/queries/users.js';
import { csrfToken } from '../csrf.js';
import { currentSession, redirectToLogin, type WebDeps } from '../session.js';
import { adminPage, type Notice } from '../views/admin.js';

/**
 * Единственное место, которое рисует список: все POST-маршруты заканчиваются
 * им же, только с разным `notice`. Редиректа после POST нет намеренно —
 * ссылку приглашения нужно показать, а через редирект её пришлось бы
 * протаскивать в URL, то есть в лог и в историю браузера (S9).
 */
function renderList(
  deps: WebDeps, request: FastifyRequest, reply: FastifyReply, notice: Notice | undefined,
): FastifyReply {
  const session = currentSession(deps, request, new Date());
  if (session === undefined) return redirectToLogin(reply);

  return reply
    .header('cache-control', 'no-store')
    .type('text/html; charset=utf-8')
    .send(adminPage(
      listClients(deps.db),
      csrfToken(session.token, deps.cfg.SESSION_SECRET),
      notice,
    ).value);
}

/**
 * S12 — function-level авторизация. Хук живёт внутри плагина, а Fastify
 * инкапсулирует хуки: он действует на маршруты этого плагина и только на них.
 * Новый маршрут внутри защищён автоматически — забыть проверку физически нечего.
 *
 * Это другая проверка, чем S11: там «твой ли объект», тут «твоя ли роль».
 */
export function registerAdminRoutes(app: FastifyInstance, deps: WebDeps): void {
  app.register((admin, _opts, done) => {
    admin.addHook('onRequest', (request, reply, next) => {
      const session = currentSession(deps, request, new Date());
      if (session === undefined) {
        void redirectToLogin(reply);
        return;
      }
      if (session.role !== 'owner') {
        // 403, а не 404: скрывать существование админки бессмысленно,
        // а разные коды помогают владельцу понять, что он зашёл не тем входом
        void reply.code(403).send();
        return;
      }
      next();
    });

    // Обработчики зовут currentSession повторно: им нужен `token` для CSRF.
    // Это один индексированный SELECT — дешевле, чем протаскивать сессию
    // через декоратор запроса и подпирать его расширением типов Fastify
    admin.get('/', (request, reply) => renderList(deps, request, reply, undefined));

    done();
  }, { prefix: '/admin' });
}
```

- [x] **Шаг 6: Запустить тесты, убедиться что проходят**

Запуск: `npm test; if ($?) { npm run typecheck }`
Ожидание: PASS. Четыре POST-маршрута из `ROUTES` ещё не существуют — на этом шаге
в списке должна остаться только строка `GET /admin` (см. комментарий в тесте),
остальные возвращаются в задаче 9.

- [x] **Шаг 7: Коммит**

```bash
git add src/storage/queries/sessions.ts src/web/session.ts src/web/routes/admin.ts src/web/views/admin.ts tests/web/admin.test.ts
git commit -m "feat(web): плагин админки с хуком роли и списком клиентов (S12)"
```

---

## Задача 7: Заведение клиента и перевыпуск приглашения

**Файлы:**
- Правка: `src/web/routes/admin.ts`
- Тест: `tests/web/admin.test.ts`

**Интерфейсы:**
- Использует: `createUser`, `findUserByEmail`, `findUserById` (задача 3),
  `createInvite`, `revokeUserInvites` (задача 2), `hashPassword`
  (`src/web/password.ts`), `cfg.PUBLIC_BASE_URL`, `cfg.INVITE_TTL_HOURS` (задача 5).

**Почему у нового клиента всё-таки есть `password_hash`.** Колонка `notNull`,
а пароля у клиента до приёма приглашения нет. Кладём хэш от случайного UUID:
он не совпадёт ни с одним вводом, и путь установки пароля остаётся ровно один —
через приглашение.

- [x] **Шаг 1: Написать падающий тест**

В `tests/web/admin.test.ts` в шапку добавить
`findUserByEmail` к импорту из `users.js`, затем дописать:

```ts
function seedOwner(db: AppDb) {
  const ownerId = createUser(db, { email: 'vladelec@k.k', passwordHash: 'x', role: 'owner' });
  return login(db, ownerId);
}

const FORM = { 'content-type': 'application/x-www-form-urlencoded' };

describe('заведение клиента', () => {
  it('создаёт клиента и показывает ссылку приглашения один раз', async () => {
    const db = createTestDb();
    const { cookie, csrf } = seedOwner(db);

    const res = await build(db).inject({
      method: 'POST', url: '/admin/clients',
      headers: { cookie, ...FORM },
      payload: new URLSearchParams({ csrf, email: 'novyy@k.k' }).toString(),
    });

    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('https://bot.example.com/invite/');
    expect(findUserByEmail(db, 'novyy@k.k')?.role).toBe('client');
  });

  it('S14: role=owner в теле формы создаёт клиента, а не владельца', async () => {
    const db = createTestDb();
    const { cookie, csrf } = seedOwner(db);

    await build(db).inject({
      method: 'POST', url: '/admin/clients',
      headers: { cookie, ...FORM },
      payload: new URLSearchParams({ csrf, email: 'hitryy@k.k', role: 'owner' }).toString(),
    });

    expect(findUserByEmail(db, 'hitryy@k.k')?.role).toBe('client');
  });

  it('почта приводится к нижнему регистру', async () => {
    const db = createTestDb();
    const { cookie, csrf } = seedOwner(db);

    await build(db).inject({
      method: 'POST', url: '/admin/clients',
      headers: { cookie, ...FORM },
      payload: new URLSearchParams({ csrf, email: 'Klient@K.K' }).toString(),
    });

    expect(findUserByEmail(db, 'klient@k.k')).toBeDefined();
  });

  it('повторная почта — ошибка формы, а не 500', async () => {
    const db = createTestDb();
    const { cookie, csrf } = seedOwner(db);
    createUser(db, { email: 'zanyato@k.k', passwordHash: 'x' });

    const res = await build(db).inject({
      method: 'POST', url: '/admin/clients',
      headers: { cookie, ...FORM },
      payload: new URLSearchParams({ csrf, email: 'zanyato@k.k' }).toString(),
    });

    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('уже заведён');
  });

  it('S15: без csrf-токена клиент не заводится', async () => {
    const db = createTestDb();
    const { cookie } = seedOwner(db);

    const res = await build(db).inject({
      method: 'POST', url: '/admin/clients',
      headers: { cookie, ...FORM },
      payload: new URLSearchParams({ email: 'bez-csrf@k.k' }).toString(),
    });

    expect(res.statusCode).toBe(403);
    expect(findUserByEmail(db, 'bez-csrf@k.k')).toBeUndefined();
  });

  it('S9: хэш пароля-заглушки не попадает на страницу', async () => {
    const db = createTestDb();
    const { cookie, csrf } = seedOwner(db);

    const res = await build(db).inject({
      method: 'POST', url: '/admin/clients',
      headers: { cookie, ...FORM },
      payload: new URLSearchParams({ csrf, email: 'novyy@k.k' }).toString(),
    });

    const hash = findUserByEmail(db, 'novyy@k.k')?.passwordHash ?? '';
    expect(hash.startsWith('$argon2')).toBe(true);
    expect(res.body).not.toContain(hash);
  });

  it('перевыпуск ссылки работает и не трогает роль клиента', async () => {
    const db = createTestDb();
    const { cookie, csrf } = seedOwner(db);
    const clientId = createUser(db, { email: 'k@k.k', passwordHash: 'x' });

    const res = await build(db).inject({
      method: 'POST', url: `/admin/clients/${clientId}/invite`,
      headers: { cookie, ...FORM },
      payload: new URLSearchParams({ csrf }).toString(),
    });

    expect(res.body).toContain('https://bot.example.com/invite/');
  });

  it('S12: перевыпустить ссылку владельцу сервиса через админку нельзя', async () => {
    const db = createTestDb();
    const { cookie, csrf } = seedOwner(db);
    const second = createUser(db, { email: 'vtoroy@k.k', passwordHash: 'x', role: 'owner' });

    const res = await build(db).inject({
      method: 'POST', url: `/admin/clients/${second}/invite`,
      headers: { cookie, ...FORM },
      payload: new URLSearchParams({ csrf }).toString(),
    });

    expect(res.body).toContain('Клиент не найден');
  });
});
```

- [x] **Шаг 2: Запустить тест, убедиться что падает**

Запуск: `npx vitest run tests/web/admin.test.ts -t "заведение"`
Ожидание: FAIL — маршрута `POST /admin/clients` нет, ответ 404.

- [x] **Шаг 3: Реализовать маршруты**

В шапку `src/web/routes/admin.ts` добавить:

```ts
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { Config } from '../../config.js';
import { createInvite, revokeUserInvites } from '../../storage/queries/invites.js';
import {
  createUser, findUserByEmail, findUserById, listClients,
} from '../../storage/queries/users.js';
import { csrfToken, csrfValid } from '../csrf.js';
import { hashPassword } from '../password.js';
```

Перед `registerAdminRoutes`:

```ts
/**
 * S14: схемы описывают ровно разрешённые поля. `role`, `user_id` и `disabled_at`
 * не читаются из тела нигде и никогда — владелец берётся из сессии, роль задаётся
 * кодом. Поэтому `role=owner` в форме просто не доходит до кода.
 *
 * `csrf` необязателен в схеме намеренно: его отсутствие — отказ (403),
 * а не кривой запрос (400).
 */
const NewClientForm = z.object({
  email: z.email().max(320),
  csrf: z.string().optional(),
});

/** Формы без полей, кроме csrf: перевыпуск ссылки и переключатель отключения. */
const CsrfOnlyForm = z.object({ csrf: z.string().optional() });

const Params = z.object({ id: z.string().min(1) });

function inviteFor(deps: WebDeps, userId: string, now: Date): string {
  // Перевыпуск гасит прежние: иначе после «ссылка утекла, выпустите новую»
  // старая продолжала бы работать до конца своего срока
  revokeUserInvites(deps.db, userId, now);
  const token = createInvite(deps.db, userId, now, deps.cfg.INVITE_TTL_HOURS * 3_600_000);
  return `${base(deps.cfg)}/invite/${token}`;
}

function base(cfg: Config): string {
  return cfg.PUBLIC_BASE_URL.replace(/\/+$/, '');
}
```

Внутрь плагина, после `admin.get('/')`:

```ts
    admin.post('/clients', async (request, reply) => {
      const session = currentSession(deps, request, new Date());
      if (session === undefined) return redirectToLogin(reply);

      const parsed = NewClientForm.safeParse(request.body);
      if (!parsed.success) {
        return renderList(deps, request, reply, { kind: 'error', text: 'Некорректная почта' });
      }
      if (!csrfValid(session.token, parsed.data.csrf, deps.cfg.SESSION_SECRET)) {
        return reply.code(403).send();
      }

      const email = parsed.data.email.trim().toLowerCase();
      if (findUserByEmail(deps.db, email) !== undefined) {
        return renderList(deps, request, reply, {
          kind: 'error', text: 'Клиент с такой почтой уже заведён',
        });
      }

      // Пароля у клиента ещё нет, а колонка notNull. Хэш от случайного UUID
      // не совпадёт ни с одним вводом, и путь установки пароля остаётся один —
      // через приглашение (S13)
      let userId: string;
      try {
        userId = createUser(deps.db, {
          email, passwordHash: await hashPassword(randomUUID()),
        });
      } catch {
        // Между проверкой почты и вставкой есть щель — её закрывает UNIQUE-индекс.
        // Объект ошибки не логируем и наружу не отдаём: в нём бывает вся строка (S9)
        return renderList(deps, request, reply, {
          kind: 'error', text: 'Клиент с такой почтой уже заведён',
        });
      }

      const link = inviteFor(deps, userId, new Date());
      return renderList(deps, request, reply, {
        kind: 'invite', text: `Ссылка для ${email}, показывается один раз: ${link}`,
      });
    });

    admin.post('/clients/:id/invite', (request, reply) => {
      const session = currentSession(deps, request, new Date());
      if (session === undefined) return redirectToLogin(reply);

      const params = Params.safeParse(request.params);
      const body = CsrfOnlyForm.safeParse(request.body);
      if (!params.success || !body.success) return reply.code(400).send();
      if (!csrfValid(session.token, body.data.csrf, deps.cfg.SESSION_SECRET)) {
        return reply.code(403).send();
      }

      // Владельцы сервиса через админку не управляются: перевыпустить ссылку
      // себе или другому владельцу отсюда нельзя
      const target = findUserById(deps.db, params.data.id);
      if (target === undefined || target.role !== 'client') {
        return renderList(deps, request, reply, { kind: 'error', text: 'Клиент не найден' });
      }

      const link = inviteFor(deps, target.id, new Date());
      return renderList(deps, request, reply, {
        kind: 'invite', text: `Новая ссылка для ${target.email}: ${link}`,
      });
    });
```

- [x] **Шаг 4: Запустить тесты, убедиться что проходят**

Запуск: `npx vitest run tests/web/admin.test.ts`
Ожидание: PASS.

- [x] **Шаг 5: Коммит**

```bash
git add src/web/routes/admin.ts tests/web/admin.test.ts
git commit -m "feat(web): заведение клиента и перевыпуск приглашения (S12, S14)"
```

---

## Задача 8: Отключение и включение клиента

**Файлы:**
- Правка: `src/web/routes/admin.ts`
- Правка: `src/web/routes/auth.ts` (приведение почты к нижнему регистру)
- Тест: `tests/web/admin.test.ts`, `tests/web/auth.test.ts`

**Интерфейсы:**
- Использует: `setUserDisabled` (задача 3), `deleteUserSessions`
  (`src/storage/queries/sessions.ts`, уже есть).

**Небольшое расширение объёма и почему оно обязано быть здесь.** Задача 7 начала
приводить почту к нижнему регистру при заведении клиента. Форма входа этого
не делает — клиент, заведённый как `Klient@K.K` и хранимый как `klient@k.k`,
не смог бы войти, введя почту так, как её видит в своей переписке. Правка входа
на две строки и её тест — часть той же смены поведения, а не отдельная задача.

- [x] **Шаг 1: Написать падающий тест**

В `tests/web/admin.test.ts` добавить `findUserById` к импорту из `users.js`,
`loadSession` — к импорту из `sessions.js`, и дописать:

```ts
describe('отключение клиента', () => {
  it('отключает и включает обратно', async () => {
    const db = createTestDb();
    const { cookie, csrf } = seedOwner(db);
    const clientId = createUser(db, { email: 'k@k.k', passwordHash: 'x' });
    const app = build(db);
    const toggle = () => app.inject({
      method: 'POST', url: `/admin/clients/${clientId}/toggle`,
      headers: { cookie, ...FORM },
      payload: new URLSearchParams({ csrf }).toString(),
    });

    await toggle();
    expect(findUserById(db, clientId)?.disabledAt).not.toBeNull();

    await toggle();
    expect(findUserById(db, clientId)?.disabledAt).toBeNull();
  });

  it('S15: отключение гасит живые сессии клиента немедленно', async () => {
    const db = createTestDb();
    const { cookie, csrf } = seedOwner(db);
    const clientId = createUser(db, { email: 'k@k.k', passwordHash: 'x' });
    const clientToken = createSession(db, clientId, now, DAY);

    await build(db).inject({
      method: 'POST', url: `/admin/clients/${clientId}/toggle`,
      headers: { cookie, ...FORM },
      payload: new URLSearchParams({ csrf }).toString(),
    });

    expect(loadSession(db, clientToken, now)).toBeUndefined();
  });

  it('S12: владельца сервиса отключить через админку нельзя', async () => {
    const db = createTestDb();
    const { cookie, csrf } = seedOwner(db);
    const second = createUser(db, { email: 'vtoroy@k.k', passwordHash: 'x', role: 'owner' });

    await build(db).inject({
      method: 'POST', url: `/admin/clients/${second}/toggle`,
      headers: { cookie, ...FORM },
      payload: new URLSearchParams({ csrf }).toString(),
    });

    expect(findUserById(db, second)?.disabledAt).toBeNull();
  });
});
```

В `tests/web/auth.test.ts`:

```ts
  it('почта сравнивается без учёта регистра', async () => {
    const db = createTestDb();
    await seedUser(db, 'klient@k.k');

    const res = await build(db).inject({
      method: 'POST', url: '/login',
      ...form({ email: '  Klient@K.K  ', password: 'пароль-клиента' }),
    });

    expect(res.statusCode).toBe(303);
  });
```

- [x] **Шаг 2: Запустить тесты, убедиться что падают**

Запуск: `npx vitest run tests/web/admin.test.ts tests/web/auth.test.ts`
Ожидание: FAIL — маршрута `toggle` нет; вход с `Klient@K.K` отвечает 401.

- [x] **Шаг 3: Реализовать маршрут отключения**

В шапку `src/web/routes/admin.ts` добавить
`import { deleteUserSessions } from '../../storage/queries/sessions.js';`
и `setUserDisabled` к импорту из `users.js`.

Внутрь плагина:

```ts
    admin.post('/clients/:id/toggle', (request, reply) => {
      const session = currentSession(deps, request, new Date());
      if (session === undefined) return redirectToLogin(reply);

      const params = Params.safeParse(request.params);
      const body = CsrfOnlyForm.safeParse(request.body);
      if (!params.success || !body.success) return reply.code(400).send();
      if (!csrfValid(session.token, body.data.csrf, deps.cfg.SESSION_SECRET)) {
        return reply.code(403).send();
      }

      const target = findUserById(deps.db, params.data.id);
      if (target === undefined || target.role !== 'client') {
        return renderList(deps, request, reply, { kind: 'error', text: 'Клиент не найден' });
      }

      const disabling = target.disabledAt === null;
      setUserDisabled(deps.db, target.id, disabling ? new Date() : null);
      // Отключённость действует немедленно, а не с истечением сессии:
      // вебхук уже отсекает `resolveAccountOwner`, вход — общий ответ S13,
      // а живой кабинет закрывается только этим (S15)
      if (disabling) deleteUserSessions(deps.db, target.id);

      return renderList(deps, request, reply, {
        kind: 'invite',
        text: `${target.email}: ${disabling ? 'отключён' : 'включён обратно'}`,
      });
    });
```

- [x] **Шаг 4: Привести почту к нижнему регистру на входе**

В `src/web/routes/auth.ts` в `LoginForm`:

```ts
const LoginForm = z.object({
  // Почта хранится в нижнем регистре (её так кладёт админка), и сравнение
  // должно быть таким же — иначе клиент, заведённый как `Klient@K.K`,
  // не войдёт, введя почту так, как видит её в переписке
  email: z.string().min(1).max(320).trim().toLowerCase(),
  password: z.string().min(1).max(1024),
});
```

- [x] **Шаг 5: Запустить весь набор**

Запуск: `npm test; if ($?) { npm run typecheck }`
Ожидание: PASS. Проверить, что тесты входа и `tests/web/isolation.test.ts`
не упали от нормализации почты: если где-то клиент заведён с заглавной буквой
в почте, тест надо поправить, а не отменять нормализацию.

- [x] **Шаг 6: Коммит**

```bash
git add src/web/routes/admin.ts src/web/routes/auth.ts tests/web/
git commit -m "feat(web): отключение клиента гасит сессии, почта сравнивается без регистра (S15)"
```

---

## Задача 9: Подключение Instagram-аккаунта из админки

**Файлы:**
- Правка: `src/web/routes/admin.ts`
- Тест: `tests/web/admin.test.ts`

**Интерфейсы:**
- Использует: `connectOrUpdateAccount` (задача 4), `cfg.CREDENTIALS_ENC_KEY`.

- [x] **Шаг 1: Написать падающий тест**

В `tests/web/admin.test.ts` добавить в шапку
`import { getAccountTokenForPlatform, listAccounts } from '../../src/storage/queries/accounts.js';`
и дописать:

```ts
describe('подключение аккаунта', () => {
  const KEY = 'a'.repeat(64);

  function connect(
    app: ReturnType<typeof build>, cookie: string, csrf: string,
    clientId: string, externalAccountId: string, token: string,
  ) {
    return app.inject({
      method: 'POST', url: `/admin/clients/${clientId}/accounts`,
      headers: { cookie, ...FORM },
      payload: new URLSearchParams({
        csrf, external_account_id: externalAccountId, token,
      }).toString(),
    });
  }

  it('подключает аккаунт и перезаписывает токен при повторе', async () => {
    const db = createTestDb();
    const { cookie, csrf } = seedOwner(db);
    const clientId = createUser(db, { email: 'k@k.k', passwordHash: 'x' });
    const app = build(db);

    await connect(app, cookie, csrf, clientId, '17841400000000000', 'старый');
    await connect(app, cookie, csrf, clientId, '17841400000000000', 'новый');

    expect(getAccountTokenForPlatform(db, clientId, 'instagram', KEY)?.token).toBe('новый');
    expect(listAccounts(db, clientId)).toHaveLength(1);
  });

  it('S17: чужой внешний id отвергается', async () => {
    const db = createTestDb();
    const { cookie, csrf } = seedOwner(db);
    const a = createUser(db, { email: 'a@a.a', passwordHash: 'x' });
    const b = createUser(db, { email: 'b@b.b', passwordHash: 'x' });
    const app = build(db);

    await connect(app, cookie, csrf, a, '17841400000000000', 'токен-А');
    const res = await connect(app, cookie, csrf, b, '17841400000000000', 'токен-Б');

    expect(res.body).toContain('уже подключён другому');
    expect(listAccounts(db, b)).toHaveLength(0);
  });

  it('нечисловой внешний id — ошибка формы, а не запись', async () => {
    const db = createTestDb();
    const { cookie, csrf } = seedOwner(db);
    const clientId = createUser(db, { email: 'k@k.k', passwordHash: 'x' });

    const res = await connect(build(db), cookie, csrf, clientId, '../../etc/passwd', 'т');

    expect(res.statusCode).toBe(200);
    expect(listAccounts(db, clientId)).toHaveLength(0);
  });

  it('S9: токен не возвращается на страницу', async () => {
    const db = createTestDb();
    const { cookie, csrf } = seedOwner(db);
    const clientId = createUser(db, { email: 'k@k.k', passwordHash: 'x' });

    const res = await connect(build(db), cookie, csrf, clientId, '111', 'ОЧЕНЬ-СЕКРЕТНЫЙ-ТОКЕН');

    expect(res.body).not.toContain('ОЧЕНЬ-СЕКРЕТНЫЙ-ТОКЕН');
  });
});
```

- [x] **Шаг 2: Запустить тест, убедиться что падает**

Запуск: `npx vitest run tests/web/admin.test.ts -t "подключение аккаунта"`
Ожидание: FAIL — маршрута нет, 404.

- [x] **Шаг 3: Реализовать маршрут**

В шапку `src/web/routes/admin.ts`:
`import { connectOrUpdateAccount } from '../../storage/queries/accounts.js';`

Рядом с `NewClientForm`:

```ts
/**
 * Внешний id — строка из цифр: Instagram выдаёт числовые идентификаторы,
 * и всё остальное здесь либо опечатка, либо попытка что-то подсунуть.
 * S14: платформа задаётся кодом, а не приходит формой.
 */
const AccountForm = z.object({
  external_account_id: z.string().regex(/^[0-9]{1,32}$/),
  token: z.string().min(1).max(512),
  csrf: z.string().optional(),
});
```

Внутрь плагина:

```ts
    admin.post('/clients/:id/accounts', (request, reply) => {
      const session = currentSession(deps, request, new Date());
      if (session === undefined) return redirectToLogin(reply);

      const params = Params.safeParse(request.params);
      const body = AccountForm.safeParse(request.body);
      if (!params.success) return reply.code(400).send();
      if (!body.success) {
        // Текст ошибки не содержит присланного значения: в этой же форме
        // рядом лежит токен, и эхо ввода — лишний путь для него в разметку (S9, S21)
        return renderList(deps, request, reply, {
          kind: 'error', text: 'ID аккаунта — это число, токен не пустой',
        });
      }
      if (!csrfValid(session.token, body.data.csrf, deps.cfg.SESSION_SECRET)) {
        return reply.code(403).send();
      }

      const target = findUserById(deps.db, params.data.id);
      if (target === undefined || target.role !== 'client') {
        return renderList(deps, request, reply, { kind: 'error', text: 'Клиент не найден' });
      }

      const outcome = connectOrUpdateAccount(deps.db, target.id, {
        platform: 'instagram',
        externalAccountId: body.data.external_account_id,
        token: body.data.token,
      }, deps.cfg.CREDENTIALS_ENC_KEY);

      const text = outcome === 'taken'
        ? 'Этот аккаунт уже подключён другому клиенту'
        : `${target.email}: аккаунт ${outcome === 'created' ? 'подключён' : 'обновлён'}`;
      return renderList(deps, request, reply, {
        kind: outcome === 'taken' ? 'error' : 'invite', text,
      });
    });
```

- [x] **Шаг 4: Вернуть в тест полный список маршрутов**

В `tests/web/admin.test.ts` раскомментировать оставшиеся четыре строки `ROUTES`
(см. задачу 6, шаг 1): теперь все пять маршрутов существуют, и цикл S12
проверяет каждый.

- [x] **Шаг 5: Запустить тесты, убедиться что проходят**

Запуск: `npm test; if ($?) { npm run typecheck }`
Ожидание: PASS, включая обе ветки `it.each` по пяти маршрутам.

- [x] **Шаг 6: Коммит**

```bash
git add src/web/routes/admin.ts tests/web/admin.test.ts
git commit -m "feat(web): подключение Instagram-аккаунта клиенту из админки (S17)"
```

---

## Задача 10: Приём приглашения

**Файлы:**
- Создание: `src/web/routes/invite.ts`, `src/web/views/invite.ts`
- Правка: `src/server.ts` (сериализатор `req` для логгера)
- Тест: `tests/web/invite.test.ts`

**Интерфейсы:**
- Использует: `consumeInvite`, `peekInvite` (задача 2), `setUserPassword` (задача 3),
  `deleteUserSessions`, `createSession`, `hashPassword`, `sessionCookie`, `ttlMs`.
- Отдаёт: `registerInviteRoutes(app: FastifyInstance, deps: WebDeps): void`,
  `invitePage(token: string, error: string | undefined): Html`,
  `inviteInvalidPage(): Html`.

**Почему на этой форме нет CSRF-токена.** `csrfToken` выводится из токена сессии,
а у гостя сессии нет — брать его неоткуда. Защищают три вещи: `SameSite=Lax`
на cookie, `form-action 'self'` в CSP (обе уже настроены в `src/web/http.ts`)
и сам секрет в ссылке, которого атакующий не знает. Ровно та же ситуация,
что на `/login`.

**Почему GET не гасит приглашение.** Браузеры и мессенджеры предзагружают ссылки;
гашение на GET означало бы, что приглашение сгорает от превью в мессенджере,
не дойдя до клиента. Гасит только POST.

- [x] **Шаг 1: Написать падающий тест**

Создать `tests/web/invite.test.ts`:

```ts
import Fastify from 'fastify';
import type { FastifyRequest } from 'fastify';
import { describe, expect, it } from 'vitest';
import { createTestDb } from '../storage/helpers.js';
import { loadConfig } from '../../src/config.js';
import { ReplyThrottle } from '../../src/core/throttle.js';
import type { AppDb } from '../../src/storage/db.js';
import { createUser, findUserById } from '../../src/storage/queries/users.js';
import { createInvite } from '../../src/storage/queries/invites.js';
import { createSession, loadSession } from '../../src/storage/queries/sessions.js';
import { registerFormParser } from '../../src/web/http.js';
import { registerInviteRoutes } from '../../src/web/routes/invite.js';

const now = new Date('2026-09-09T12:00:00Z');
const HOUR = 3_600_000;

function config() {
  return loadConfig({
    META_APP_SECRET: 's', META_VERIFY_TOKEN: 'v',
    CREDENTIALS_ENC_KEY: 'a'.repeat(64), SESSION_SECRET: 'a'.repeat(32),
    PUBLIC_BASE_URL: 'https://bot.example.com',
  } as unknown as NodeJS.ProcessEnv);
}

function build(db: AppDb, maxAttempts = 100) {
  const cfg = config();
  const app = Fastify();
  registerFormParser(app);
  registerInviteRoutes(app, { db, cfg, throttle: new ReplyThrottle(maxAttempts, 15 * 60_000) });
  return app;
}

function post(token: string, password: string) {
  return {
    method: 'POST' as const,
    url: `/invite/${token}`,
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    payload: new URLSearchParams({ password }).toString(),
  };
}

function seedInvite(db: AppDb, ttlMs = 48 * HOUR) {
  const userId = createUser(db, { email: 'k@k.k', passwordHash: 'заглушка' });
  return { userId, token: createInvite(db, userId, now, ttlMs) };
}

describe('приём приглашения', () => {
  it('действующая ссылка показывает форму пароля', async () => {
    const db = createTestDb();
    const { token } = seedInvite(db);

    const res = await build(db).inject({ method: 'GET', url: `/invite/${token}` });

    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('type="password"');
  });

  it('GET не гасит приглашение: превью в мессенджере не сжигает ссылку', async () => {
    const db = createTestDb();
    const { token } = seedInvite(db);
    const app = build(db);

    await app.inject({ method: 'GET', url: `/invite/${token}` });
    const res = await app.inject(post(token, 'достаточно-длинный-пароль'));

    expect(res.statusCode).toBe(303);
  });

  it('пароль ставится, и клиент сразу в кабинете', async () => {
    const db = createTestDb();
    const { userId, token } = seedInvite(db);

    const res = await build(db).inject(post(token, 'достаточно-длинный-пароль'));

    expect(res.statusCode).toBe(303);
    expect(res.headers.location).toBe('/');
    expect(String(res.headers['set-cookie'])).toContain('HttpOnly');
    expect(findUserById(db, userId)?.passwordHash).not.toBe('заглушка');
  });

  it('вторая попытка по той же ссылке не проходит', async () => {
    const db = createTestDb();
    const { token } = seedInvite(db);
    const app = build(db);

    await app.inject(post(token, 'достаточно-длинный-пароль'));
    const res = await app.inject(post(token, 'другой-длинный-пароль'));

    expect(res.statusCode).toBe(404);
  });

  it('протухшая ссылка не проходит', async () => {
    const db = createTestDb();
    const userId = createUser(db, { email: 'k@k.k', passwordHash: 'заглушка' });
    const token = createInvite(db, userId, new Date('2026-09-01T00:00:00Z'), HOUR);

    const res = await build(db).inject({ method: 'GET', url: `/invite/${token}` });

    expect(res.statusCode).toBe(404);
  });

  it('выдуманный токен не проходит', async () => {
    const res = await build(createTestDb()).inject({ method: 'GET', url: '/invite/vydumka' });
    expect(res.statusCode).toBe(404);
  });

  it('S15: установка пароля убивает прежние сессии клиента', async () => {
    const db = createTestDb();
    const { userId, token } = seedInvite(db);
    const old = createSession(db, userId, now, 86_400_000);

    await build(db).inject(post(token, 'достаточно-длинный-пароль'));

    expect(loadSession(db, old, now)).toBeUndefined();
  });

  it('S13: короткий пароль отвергается, приглашение остаётся живым', async () => {
    const db = createTestDb();
    const { token } = seedInvite(db);
    const app = build(db);

    const short = await app.inject(post(token, 'коротко'));
    expect(short.statusCode).toBe(400);

    const retry = await app.inject(post(token, 'достаточно-длинный-пароль'));
    expect(retry.statusCode).toBe(303);
  });

  it('S19: перебор токенов упирается в лимит', async () => {
    const db = createTestDb();
    const app = build(db, 3);

    for (let i = 0; i < 3; i += 1) {
      await app.inject({ method: 'GET', url: `/invite/popytka-${i}` });
    }

    const res = await app.inject({ method: 'GET', url: '/invite/popytka-4' });
    expect(res.statusCode).toBe(429);
  });

  it('S9: пароль не возвращается на страницу после ошибки', async () => {
    const db = createTestDb();
    const { token } = seedInvite(db);

    const res = await build(db).inject(post(token, 'секрет'));

    expect(res.body).not.toContain('секрет');
  });

  it('S9: токен приглашения не попадает в лог', async () => {
    const db = createTestDb();
    const { token } = seedInvite(db);
    const lines: string[] = [];

    const app = Fastify({
      logger: {
        level: 'info',
        serializers: {
          req: (request: FastifyRequest) => ({
            method: request.method,
            url: request.url.startsWith('/invite/') ? '/invite/:token' : request.url,
          }),
        },
        stream: { write: (line: string) => { lines.push(line); } },
      },
    });
    registerFormParser(app);
    registerInviteRoutes(app, {
      db, cfg: config(), throttle: new ReplyThrottle(100, 60_000),
    });

    await app.inject({ method: 'GET', url: `/invite/${token}` });

    expect(lines.join('')).not.toContain(token);
  });
});
```

Последний тест дублирует конфигурацию логгера из `server.ts` осознанно: выносить
её в общий модуль ради одного объекта не стоит, а разъехаться молча они не могут —
тест сломается ровно тогда, когда сериализатор из `server.ts` исчезнет и токен
снова полезет в лог. Если при исполнении дублирование мешает — вынести сериализатор
в `src/web/http.ts` рядом с `registerSecurityHeaders` и звать из обоих мест.

- [x] **Шаг 2: Запустить тест, убедиться что падает**

Запуск: `npx vitest run tests/web/invite.test.ts`
Ожидание: FAIL — модуля `src/web/routes/invite.ts` не существует.

- [x] **Шаг 3: Реализовать `src/web/views/invite.ts`**

```ts
import { html, type Html } from '../html.js';
import { layout } from './layout.js';

/**
 * CSRF-токена на форме нет по той же причине, что и на `/login`: он выводится
 * из сессии, а у гостя её нет. Защищают `SameSite=Lax`, `form-action 'self'`
 * в CSP и сам секрет в ссылке.
 */
export function invitePage(token: string, error: string | undefined): Html {
  return layout('Пароль для входа', html`
<h1>Придумайте пароль</h1>
${error === undefined ? '' : html`<p role="alert">${error}</p>`}
<form method="post" action="/invite/${token}">
  <label>Пароль <input type="password" name="password" required minlength="12"
    autocomplete="new-password"></label>
  <button type="submit">Войти</button>
</form>`);
}

/**
 * Протухшая, погашенная и несуществующая ссылка дают одну страницу и один код:
 * по разнице ответов иначе перебором отделялись бы живые токены от мусора.
 */
export function inviteInvalidPage(): Html {
  return layout('Ссылка недействительна', html`
<h1>Ссылка недействительна</h1>
<p>Срок действия истёк или ссылкой уже воспользовались. Попросите новую.</p>`);
}
```

- [x] **Шаг 4: Реализовать `src/web/routes/invite.ts`**

```ts
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { consumeInvite, peekInvite } from '../../storage/queries/invites.js';
import { createSession, deleteUserSessions } from '../../storage/queries/sessions.js';
import { setUserPassword } from '../../storage/queries/users.js';
import { sessionCookie } from '../http.js';
import { hashPassword } from '../password.js';
import { ttlMs, type WebDeps } from '../session.js';
import { inviteInvalidPage, invitePage } from '../views/invite.js';

const Params = z.object({ token: z.string().min(1).max(128) });

/**
 * S13: нижняя граница пароля, верхняя — чтобы argon2 не считал мегабайт.
 * Те же значения, что в спеке: 12–1024.
 */
const PasswordForm = z.object({
  password: z.string().min(12).max(1024),
});

/**
 * Маршруты вне плагина админки: у гостя ещё нет сессии, и хук роли
 * не пропустил бы его.
 */
export function registerInviteRoutes(app: FastifyInstance, deps: WebDeps): void {
  // S19: токен в ссылке — секрет, и без лимита он перебирается запросами.
  // Счётчик общий с формой входа, ключ свой: лимиты одинаковые, счёт раздельный
  const allow = (ip: string, at: Date): boolean =>
    deps.throttle.allow(`приглашение:ip:${ip}`, at);

  app.get('/invite/:token', (request, reply) => {
    const now = new Date();
    if (!allow(request.ip, now)) return reply.code(429).send();

    const params = Params.safeParse(request.params);
    if (!params.success) return reply.code(404).send();

    // GET не гасит приглашение: мессенджеры и браузеры предзагружают ссылки,
    // и приглашение сгорало бы от превью, не дойдя до клиента. Здесь только
    // проверка, что форму есть смысл показывать
    if (!peekInvite(deps.db, params.data.token, now)) {
      return reply.code(404).header('cache-control', 'no-store')
        .type('text/html; charset=utf-8').send(inviteInvalidPage().value);
    }

    return reply.header('cache-control', 'no-store')
      .type('text/html; charset=utf-8')
      .send(invitePage(params.data.token, undefined).value);
  });

  app.post('/invite/:token', async (request, reply) => {
    const now = new Date();
    if (!allow(request.ip, now)) return reply.code(429).send();

    const params = Params.safeParse(request.params);
    if (!params.success) return reply.code(404).send();

    const form = PasswordForm.safeParse(request.body);
    if (!form.success) {
      // Приглашение ещё не гасим: клиент ошибся длиной пароля, а не ссылкой.
      // Присланное значение на страницу не возвращаем — это пароль (S9)
      return reply.code(400).header('cache-control', 'no-store')
        .type('text/html; charset=utf-8')
        .send(invitePage(params.data.token, 'Пароль не короче 12 символов').value);
    }

    // Гашение и чтение владельца — одна операция: двойной сабмит формы
    // не пройдёт дважды, гонку разруливает СУБД
    const invite = consumeInvite(deps.db, params.data.token, now);
    if (invite === undefined) {
      return reply.code(404).header('cache-control', 'no-store')
        .type('text/html; charset=utf-8').send(inviteInvalidPage().value);
    }

    setUserPassword(deps.db, invite.userId, await hashPassword(form.data.password));
    // S15: смена пароля выкидывает со всех устройств, новая сессия с нуля
    deleteUserSessions(deps.db, invite.userId);

    const token = createSession(deps.db, invite.userId, now, ttlMs(deps.cfg));
    return reply
      .header('set-cookie', sessionCookie(token, ttlMs(deps.cfg), deps.cfg.NODE_ENV === 'production'))
      .code(303).header('location', '/').send();
  });
}
```

- [x] **Шаг 5: Закрыть токен в логе (S9)**

В `src/server.ts` добавить `FastifyRequest` в импорт типов из `fastify`
и заменить создание приложения:

```ts
  const app: FastifyInstance = Fastify({
    logger: {
      level: cfg.NODE_ENV === 'production' ? 'info' : 'debug',
      // S9: Fastify логирует URL каждого запроса, а в `/invite/<токен>` лежит
      // секрет. До этой фазы секретов в путях не было — теперь путь усечён
      serializers: {
        req: (request: FastifyRequest) => ({
          method: request.method,
          url: request.url.startsWith('/invite/') ? '/invite/:token' : request.url,
        }),
      },
    },
  });
```

- [x] **Шаг 6: Запустить тесты, убедиться что проходят**

Запуск: `npm test; if ($?) { npm run typecheck }`
Ожидание: PASS.

- [x] **Шаг 7: Коммит**

```bash
git add src/web/routes/invite.ts src/web/views/invite.ts src/server.ts tests/web/invite.test.ts
git commit -m "feat(web): приём приглашения с установкой пароля, токен не пишется в лог (S13, S15, S19, S9)"
```

---

## Задача 11: Первый владелец сервиса

**Файлы:**
- Создание: `scripts/create-owner.ts`
- Правка: `package.json`

**Интерфейсы:**
- Использует: `createUser` с `role: 'owner'`, `createInvite`, `cfg.PUBLIC_BASE_URL`,
  `cfg.INVITE_TTL_HOURS`.

**Почему владелец не получает пароль аргументом.** Пароль в аргументе командной
строки попадает в историю оболочки и в список процессов. Владелец ставит пароль
той же формой, что и клиенты: один путь установки пароля на весь сервис, потому
что второй путь — это второе место, где можно ошибиться.

- [x] **Шаг 1: Написать скрипт**

Создать `scripts/create-owner.ts`:

```ts
import { randomUUID } from 'node:crypto';
import { loadConfig } from '../src/config.js';
import { openDb } from '../src/storage/db.js';
import { createInvite } from '../src/storage/queries/invites.js';
import { createUser, findUserByEmail } from '../src/storage/queries/users.js';
import { hashPassword } from '../src/web/password.js';

const [rawEmail] = process.argv.slice(2);

if (rawEmail === undefined) {
  console.error('Использование: npm run owner -- <email>');
  process.exit(1);
}

const email = rawEmail.trim().toLowerCase();
const cfg = loadConfig();
const db = openDb(cfg.DATABASE_URL);

if (findUserByEmail(db, email) !== undefined) {
  console.error('Пользователь с такой почтой уже есть');
  process.exit(1);
}

// Пароль не принимается аргументом: он остался бы в истории оболочки и в списке
// процессов. Владелец ставит его той же формой приглашения, что и клиенты —
// один путь установки пароля на весь сервис
const userId = createUser(db, {
  email, passwordHash: await hashPassword(randomUUID()), role: 'owner',
});
const token = createInvite(db, userId, new Date(), cfg.INVITE_TTL_HOURS * 3_600_000);

console.log(`Владелец ${email} заведён.`);
console.log(`Ссылка (действует ${cfg.INVITE_TTL_HOURS} ч, показывается один раз):`);
console.log(`${cfg.PUBLIC_BASE_URL.replace(/\/+$/, '')}/invite/${token}`);
```

- [x] **Шаг 2: Добавить скрипт в `package.json`**

В `scripts`, после `"seed"`:

```json
    "owner": "tsx --env-file-if-exists=.env scripts/create-owner.ts"
```

- [x] **Шаг 3: Проверить типы и работу**

Запуск: `npm run typecheck`
Ожидание: PASS — `tsconfig.include` покрывает `scripts/`.

Запуск: `npm run owner -- vladelec@example.com`
Ожидание: печатает ссылку вида `http://localhost:3000/invite/<128 hex-символов>`.
Повторный запуск с той же почтой — «Пользователь с такой почтой уже есть»,
код выхода 1.

- [x] **Шаг 4: Коммит**

```bash
git add scripts/create-owner.ts package.json
git commit -m "feat(scripts): первый владелец сервиса заводится ссылкой-приглашением"
```

---

## Задача 12: Сборка в процессе и сквозной тест изоляции

**Файлы:**
- Правка: `src/server.ts`
- Правка: `src/web/routes/dashboard.ts`, `src/web/views/dashboard.ts`
- Правка: `CLAUDE.md`
- Тест: `tests/web/isolation.test.ts`

**Ссылка на `/admin` в кабинете — удобство, а не защита.** Доступ закрыт хуком
роли, а не отсутствием ссылки: клиент, который наберёт `/admin` руками, получит
403 независимо от того, видел ли он ссылку (S12).

- [x] **Шаг 1: Написать падающий тест изоляции**

В `tests/web/isolation.test.ts` расширить существующий помощник сборки приложения
(он в файле уже есть — свой заводить не надо): он должен регистрировать
`registerAdminRoutes` и `registerInviteRoutes` наравне с остальными. Затем добавить:

```ts
  it('S12: владелец видит обоих клиентов, клиент не видит админку', async () => {
    const db = createTestDb();
    const ownerId = createUser(db, { email: 'vladelec@k.k', passwordHash: 'x', role: 'owner' });
    createUser(db, { email: 'client-a@k.k', passwordHash: 'x' });
    const b = createUser(db, { email: 'client-b@k.k', passwordHash: 'x' });
    const app = build(db);

    const ownerCookie = `sid=${createSession(db, ownerId, now, 86_400_000)}`;
    const clientCookie = `sid=${createSession(db, b, now, 86_400_000)}`;

    const asOwner = await app.inject({
      method: 'GET', url: '/admin', headers: { cookie: ownerCookie },
    });
    const asClient = await app.inject({
      method: 'GET', url: '/admin', headers: { cookie: clientCookie },
    });

    expect(asOwner.body).toContain('client-a@k.k');
    expect(asOwner.body).toContain('client-b@k.k');
    expect(asClient.statusCode).toBe(403);
  });

  it('ссылка на админку показана владельцу и не показана клиенту', async () => {
    const db = createTestDb();
    const ownerId = createUser(db, { email: 'vladelec@k.k', passwordHash: 'x', role: 'owner' });
    const clientId = createUser(db, { email: 'klient@k.k', passwordHash: 'x' });
    const app = build(db);

    const asOwner = await app.inject({
      method: 'GET', url: '/',
      headers: { cookie: `sid=${createSession(db, ownerId, now, 86_400_000)}` },
    });
    const asClient = await app.inject({
      method: 'GET', url: '/',
      headers: { cookie: `sid=${createSession(db, clientId, now, 86_400_000)}` },
    });

    expect(asOwner.body).toContain('href="/admin"');
    expect(asClient.body).not.toContain('href="/admin"');
  });
```

- [x] **Шаг 2: Запустить тест, убедиться что падает**

Запуск: `npx vitest run tests/web/isolation.test.ts`
Ожидание: FAIL — `/admin` отвечает 404, ссылки в кабинете нет.

- [x] **Шаг 3: Собрать плагины в процессе**

В `src/server.ts` в импорты:

```ts
import { registerAdminRoutes } from './web/routes/admin.js';
import { registerInviteRoutes } from './web/routes/invite.js';
```

И после `registerConstructorRoutes(app, web);`:

```ts
  registerAdminRoutes(app, web);
  registerInviteRoutes(app, web);
```

- [x] **Шаг 4: Показать ссылку владельцу**

В `src/web/views/dashboard.ts` изменить сигнатуру:

```ts
export function dashboardPage(
  rows: AutomationRow[], counts: Map<string, number>, csrf: string, isOwner: boolean,
): Html {
```

и строку навигации:

```ts
<p><a href="/leads">Заявки</a> · <a href="/files">Файлы</a> · <a href="/automations/new">Новая воронка</a>${isOwner ? html` · <a href="/admin">Клиенты</a>` : ''}</p>
```

В `src/web/routes/dashboard.ts` в вызове `dashboardPage` добавить четвёртым
аргументом `session.role === 'owner'`.

- [x] **Шаг 5: Дописать исключения в CLAUDE.md**

В разделе «Обязательные правила», в пункте «Владелец — первым аргументом»,
заменить «Три осознанных исключения» на «Пять осознанных исключений» и добавить
к перечислению `listClients` (владельцу сервиса принадлежат все клиенты, защищает
её хук роли плагина `/admin`, а не `WHERE`) и `consumeInvite`/`peekInvite`
(гость ещё не аутентифицирован — владелец здесь определяется, как
в `resolveAccountOwner`).

Фразу «Общее у них одно: вызывает их воркер, у которого пользователя нет вообще,
— а не браузер» заменить: общее теперь в том, что во всех этих случаях
пользователя ещё или вообще нет — воркер, вебхук, гость по ссылке, — либо роль
владельца делает вопрос «чей это объект» бессмысленным.

- [x] **Шаг 6: Запустить весь набор и аудит**

Запуск: `npm test; if ($?) { npm run typecheck }`
Ожидание: PASS целиком.

Запуск: `npm audit`
Ожидание: новых зависимостей фаза не добавляла — результат должен совпасть
с тем, что был до неё.

- [x] **Шаг 7: Ручная проверка на живом сервере**

```bash
npm run migrate
npm run owner -- vladelec@example.com
npm run dev
```

Пройти по ссылке из вывода, поставить пароль, попасть в кабинет, увидеть ссылку
«Клиенты», завести клиента, скопировать его ссылку, открыть её в приватном окне,
поставить пароль, убедиться, что второй клиент в свой кабинет попал, а `/admin`
даёт ему 403.

- [x] **Шаг 8: Коммит**

```bash
git add src/server.ts src/web/routes/dashboard.ts src/web/views/dashboard.ts CLAUDE.md tests/web/isolation.test.ts
git commit -m "feat(web): админка в сборке процесса, сквозной тест изоляции ролей (S12)"
```

---

## Самопроверка плана

**Покрытие спеки.** Раздел 3 (модель данных) → задача 1; 4 (маршруты) → задачи 6–10;
5 (потоки) → 7, 8, 9, 10; 6 (безопасность) → S12 в 6, S11 в 3 и 6, S13 в 7 и 10,
S14 в 7 и 9, S15 в 8 и 10, S17 в 3 и 4, S19 в 10, S21 в 6, S9 в 10; 7 (конфигурация)
→ задача 5; 8 (тестирование) → все семь файлов из таблицы спеки покрыты;
9 (ограничения) — принято как есть, кода не требует; 10 (затронутые файлы)
→ совпадает со «Структурой файлов» плюс `sessions.ts`, `session.ts`, `auth.ts`,
`dashboard.*`, `drizzle.config.ts`, `CLAUDE.md`, которых в спеке не было.

**Чего в спеке не было, а в плане есть, и почему:**

- **Роль в `loadSession`** — спека говорит «хук проверяет роль», но не говорит,
  откуда роль берётся. Взята из БД тем же запросом, что и сессия.
- **`PUBLIC_BASE_URL` ломает восемь тестовых файлов** — прямое следствие того,
  что переменная обязательна. Починка вписана в задачу 5, чтобы следующая задача
  не начиналась с чужих красных тестов.
- **Нижний регистр почты на входе** — админка нормализует почту, форма входа
  до сих пор нет; без парной правки клиент не смог бы войти.
- **`peekInvite`** — спека описывает только гашение, но GET-маршруту нужна
  проверка без гашения, иначе превью ссылки в мессенджере сжигает приглашение.
- **`npm run migrate` и `dbCredentials`** — первая миграция поверх живой базы;
  до фазы F миграции применялись только в тестах.

**Согласованность имён.** `ClientRow` (задача 3) используется в `adminPage`
(задача 6). `ConnectOutcome` (задача 4) — в задаче 9. `Notice` (задача 6) —
в задачах 7–9. `consumeInvite`/`peekInvite`/`revokeUserInvites` (задачи 2, 10)
— в задачах 7, 8, 10. `Session.role` (задача 6) — в задачах 6 и 12.
`CsrfOnlyForm` и `Params` (задача 7) — в задачах 8 и 9.

**Заглушек нет:** каждый шаг содержит либо готовый код, либо точную команду
с ожидаемым результатом.
