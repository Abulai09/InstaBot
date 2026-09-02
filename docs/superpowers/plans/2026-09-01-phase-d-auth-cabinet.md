# Фаза D — вход и кабинет

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Клиент входит по паролю, видит свои воронки и заявки, включает и выключает
автоматизации, выгружает заявки в CSV — и не видит ничего чужого.

**Architecture:** Появляется четвёртый слой `web/`. Сессия хранится в БД как SHA-256
от случайного токена, сам токен живёт только в cookie. Владелец каждой операции берётся
из сессии и никогда из тела запроса. Представления — чистые функции «данные → строка»,
собранные тегом с экранированием по умолчанию; они не знают о Fastify и тестируются
без HTTP.

**Tech Stack:** TypeScript ESM, Fastify 5, better-sqlite3 13, drizzle-orm 0.45, Zod 4,
vitest 4, Node >= 20. Одна новая зависимость: `@node-rs/argon2`.

**Spec:** `docs/superpowers/specs/2026-08-27-saas-comment-to-dm-design.md`
(разделы 2, 4, 7; требования S11–S22)

## Global Constraints

- `src/core/` не содержит слов `instagram`, `tiktok`, `meta`, `fastify`, `drizzle`,
  `fetch(`, `process.env`, `import(`. Исключение — union `Platform` в `core/types.ts`.
  Проверяет `tests/core/purity.test.ts`. **В этой фазе ядро меняется один раз:**
  у `ReplyThrottle` появляется параметр окна (задача D5).
- В `src/` запрещены `any`, `as unknown as`, `!` (non-null assertion). `tsconfig`
  строгий, включая `noUncheckedIndexedAccess`.
- `process.env` читается только в `src/config.ts`. Новая переменная — три синхронные
  правки: `EnvSchema`, `.env.example`, тест в `tests/config.test.ts`.
- **Владелец — первый аргумент** в `src/storage/queries/`, и он входит в условие
  выборки (`WHERE id = ? AND user_id = ?`), а не проверяется отдельным `if` после неё.
- **`user_id`, роль и любые признаки владения никогда не читаются из тела запроса**
  (S14). Владелец берётся только из сессии. Zod-схема формы описывает ровно
  разрешённые поля.
- ESM: относительные импорты пишутся с расширением `.js`. Проверяет `tests/esm-imports.test.ts`.
- Секреты и ПД не логируются выше уровня `debug` (S9). Пароль, токен сессии и
  CSRF-токен не логируются никогда и ни на каком уровне.
- Тест пишется до реализации. Каждая задача заканчивается коммитом. Сообщения
  коммитов и комментарии — на русском.
- Контрольная точка фазы: `npm test`, затем `npm run typecheck`, затем `npm audit`.
- Оболочка — Windows PowerShell 5.1: `&&` в консоли даёт синтаксическую ошибку,
  контрольная точка пишется как `npm test; if ($?) { npm run typecheck }`.

## Карта файлов

| Файл | Ответственность |
|---|---|
| `src/web/html.ts` | тег-шаблон: экранирование каждой подстановки, `raw()` для явного HTML |
| `src/web/password.ts` | argon2id: хэш и проверка с выравниванием времени ответа |
| `src/storage/queries/sessions.ts` | сессия в БД: создать, найти, продлить, удалить |
| `src/web/csrf.ts` | токен из id сессии на `SESSION_SECRET`, сравнение constant-time |
| `src/web/http.ts` | разбор cookie, разбор тела формы, заголовки безопасности |
| `src/web/session.ts` | `requireUser`: cookie → сессия → `userId`, иначе редирект |
| `src/web/routes/auth.ts` | `GET /login`, `POST /login`, `POST /logout` |
| `src/web/routes/dashboard.ts` | `GET /`, `POST /automations/:id/toggle` |
| `src/web/routes/leads.ts` | `GET /leads`, `GET /leads.csv` |
| `src/web/views/*.ts` | layout, login, dashboard, leads — чистые функции |
| `src/web/csv.ts` | CSV с экранированием формул |
| `src/core/throttle.ts` *(правка)* | окно троттлинга параметром |
| `src/config.ts` *(правка)* | `SESSION_SECRET`, `SESSION_TTL_DAYS`, `LOGIN_MAX_ATTEMPTS` |
| `src/server.ts` *(правка)* | регистрация маршрутов кабинета |

Представления лежат отдельно от маршрутов, потому что меняются по разным причинам:
разметка — когда меняется вид страницы, маршрут — когда меняется поведение.

---

## Task D1: Тег-шаблон с экранированием по умолчанию

XSS в кабинете возникает там, где в разметку попадает введённое клиентом: название
воронки, текст шага, имя файла, ответ человека в заявке. Экранирование «по памяти
в нужных местах» рано или поздно забывают в одном месте — и этого достаточно.
Поэтому экранирование включено по умолчанию, а сырой HTML требует явного `raw()`.

**Files:**
- Create: `src/web/html.ts`
- Test: `tests/web/html.test.ts`

**Interfaces:**
- Produces:
  - `class Html { readonly value: string }`
  - `raw(value: string): Html`
  - `escapeHtml(value: string): string`
  - `html(strings: TemplateStringsArray, ...values: unknown[]): Html`

- [x] **Step 1: Написать падающий тест**

`tests/web/html.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { escapeHtml, html, raw } from '../../src/web/html.js';

describe('тег html', () => {
  it('S21: экранирует подстановку', () => {
    const name = '<script>alert(1)</script>';
    expect(html`<h1>${name}</h1>`.value)
      .toBe('<h1>&lt;script&gt;alert(1)&lt;/script&gt;</h1>');
  });

  it('S21: экранирует кавычки — иначе подстановка выходит из атрибута', () => {
    const value = '" onmouseover="alert(1)';
    expect(html`<input value="${value}">`.value)
      .toBe('<input value="&quot; onmouseover=&quot;alert(1)">');
  });

  it('S21: экранирует одинарную кавычку и амперсанд', () => {
    expect(escapeHtml("&'")).toBe('&amp;&#39;');
  });

  it('амперсанд экранируется первым, иначе выходит двойное экранирование', () => {
    expect(escapeHtml('&lt;')).toBe('&amp;lt;');
  });

  it('raw вставляется как есть: им собирают вложенную разметку', () => {
    expect(html`<div>${raw('<b>жирный</b>')}</div>`.value)
      .toBe('<div><b>жирный</b></div>');
  });

  it('вложенный результат тега не экранируется повторно', () => {
    const row = html`<li>${'<b>'}</li>`;
    expect(html`<ul>${row}</ul>`.value).toBe('<ul><li>&lt;b&gt;</li></ul>');
  });

  it('массив склеивается без разделителя: так собирают списки', () => {
    const items = ['a', '<b>'].map((t) => html`<li>${t}</li>`);
    expect(html`<ul>${items}</ul>`.value).toBe('<ul><li>a</li><li>&lt;b&gt;</li></ul>');
  });

  it('null и undefined дают пустую строку, а не текст "null"', () => {
    expect(html`<p>${null}${undefined}</p>`.value).toBe('<p></p>');
  });

  it('число подставляется как текст', () => {
    expect(html`<p>${42}</p>`.value).toBe('<p>42</p>');
  });
});
```

- [x] **Step 2: Запустить тест, убедиться что падает**

Run: `npx vitest run tests/web/html.test.ts`
Expected: FAIL — модуль `src/web/html.js` не найден.

- [x] **Step 3: Реализовать `src/web/html.ts`**

```ts
/**
 * Экранирование по умолчанию — единственная защита от XSS, которую нельзя забыть
 * применить (S21). Сырой HTML требует явного `raw()`, и это видно в месте вызова.
 *
 * Амперсанд заменяется первым: если сделать это после `<`, уже вставленные
 * `&lt;` экранируются повторно и разметка поедет.
 */
export function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

/** Готовая разметка: строка, которая уже безопасна и не экранируется повторно. */
export class Html {
  constructor(readonly value: string) {}
}

/**
 * Явное «этот HTML написал я». На данных, пришедших от пользователя,
 * не вызывается никогда — в этом весь смысл отдельной функции.
 */
export function raw(value: string): Html {
  return new Html(value);
}

function render(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (value instanceof Html) return value.value;
  if (Array.isArray(value)) return value.map(render).join('');
  return escapeHtml(String(value));
}

export function html(strings: TemplateStringsArray, ...values: unknown[]): Html {
  let out = '';
  strings.forEach((part, i) => {
    out += part;
    if (i < values.length) out += render(values[i]);
  });
  return new Html(out);
}
```

- [x] **Step 4: Запустить тест, убедиться что проходит**

Run: `npx vitest run tests/web/html.test.ts`
Expected: PASS, 9 тестов.

- [x] **Step 5: Коммит**

```bash
git add src/web/html.ts tests/web/html.test.ts
git commit -m "feat(web): тег html с экранированием по умолчанию (S21)"
```

---

## Task D2: Пароли argon2id

**Files:**
- Create: `src/web/password.ts`
- Test: `tests/web/password.test.ts`
- Modify: `package.json`

**Interfaces:**
- Produces:
  - `hashPassword(plain: string): Promise<string>`
  - `verifyPassword(storedHash: string | undefined, plain: string): Promise<boolean>`

- [ ] **Step 1: Поставить зависимость**

```bash
npm install @node-rs/argon2
```

Пакет приезжает готовым бинарником под платформу — node-gyp и Visual Studio Build
Tools не нужны, в отличие от пакета `argon2`.

- [ ] **Step 2: Написать падающий тест**

`tests/web/password.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { hashPassword, verifyPassword } from '../../src/web/password.js';

describe('пароли', () => {
  it('S13: хэш не содержит пароля', async () => {
    const stored = await hashPassword('очень-секретный-пароль');
    expect(stored).not.toContain('очень-секретный-пароль');
    expect(stored.startsWith('$argon2id$')).toBe(true);
  });

  it('S13: два хэша одного пароля различаются — соль случайная', async () => {
    expect(await hashPassword('один')).not.toBe(await hashPassword('один'));
  });

  it('верный пароль проходит', async () => {
    const stored = await hashPassword('верный');
    expect(await verifyPassword(stored, 'верный')).toBe(true);
  });

  it('неверный пароль не проходит', async () => {
    const stored = await hashPassword('верный');
    expect(await verifyPassword(stored, 'неверный')).toBe(false);
  });

  it('S13: несуществующий пользователь — тоже false, а не исключение', async () => {
    expect(await verifyPassword(undefined, 'любой')).toBe(false);
  });

  it('S13: битый хэш в БД не роняет вход', async () => {
    expect(await verifyPassword('не-хэш-вовсе', 'любой')).toBe(false);
  });
});
```

- [ ] **Step 3: Запустить тест, убедиться что падает**

Run: `npx vitest run tests/web/password.test.ts`
Expected: FAIL — модуль `src/web/password.js` не найден.

- [ ] **Step 4: Реализовать `src/web/password.ts`**

```ts
import { randomUUID } from 'node:crypto';
import { hash, verify } from '@node-rs/argon2';

export function hashPassword(plain: string): Promise<string> {
  return hash(plain);
}

/**
 * Заглушка для случая «такого email нет». Без неё ответ на несуществующий email
 * возвращается мгновенно, а на существующий — через десятки миллисекунд argon2,
 * и по времени ответа перебором собирается список аккаунтов сервиса (S13).
 *
 * Считается один раз за жизнь процесса: сам хэш ничего не защищает,
 * он нужен только чтобы потратить столько же времени.
 */
let dummy: Promise<string> | undefined;
function dummyHash(): Promise<string> {
  dummy ??= hashPassword(randomUUID());
  return dummy;
}

export async function verifyPassword(
  storedHash: string | undefined, plain: string,
): Promise<boolean> {
  const target = storedHash ?? await dummyHash();
  try {
    return await verify(target, plain);
  } catch {
    // Строка в колонке не является хэшем argon2 — вход просто не удался.
    // Объект ошибки не логируем: в нём оказывается сам хэш
    return false;
  }
}
```

- [ ] **Step 5: Запустить тест, убедиться что проходит**

Run: `npx vitest run tests/web/password.test.ts`
Expected: PASS, 6 тестов.

- [ ] **Step 6: Коммит**

```bash
git add src/web/password.ts tests/web/password.test.ts package.json package-lock.json
git commit -m "feat(web): хэширование паролей argon2id (S13)"
```

---
## Task D3: Сессии в базе

В cookie уезжает случайный токен, в базе лежит его SHA-256. Утечка дампа базы
после этого не даёт войти ни в один кабинет: по хэшу токен не восстанавливается.
Схему менять не нужно — хэш кладётся в `sessions.id`.

Хэш здесь не солится и не растягивается, в отличие от пароля: токен уже случайный
на 256 бит, перебирать его нечем, а вход по сессии происходит на каждый запрос —
argon2 на каждой странице кабинета был бы заметен.

**Files:**
- Create: `src/storage/queries/sessions.ts`
- Modify: `src/config.ts`, `.env.example`, `tests/config.test.ts`
- Test: `tests/storage/queries/sessions.test.ts`

**Interfaces:**
- Consumes: `AppDb` из `src/storage/db.js`, таблица `sessions` из `src/storage/schema.js`
- Produces:
  - `createSession(db: AppDb, userId: string, now: Date, ttlMs: number): string` — возвращает **токен**, не id
  - `loadSession(db: AppDb, token: string, now: Date): { userId: string } | undefined`
  - `touchSession(db: AppDb, token: string, now: Date, ttlMs: number): void`
  - `deleteSession(db: AppDb, token: string): void`
  - `deleteUserSessions(db: AppDb, userId: string): void`

- [ ] **Step 1: Добавить переменные окружения**

В `src/config.ts`, в `EnvSchema`, после `CREDENTIALS_ENC_KEY`:

```ts
  // Ключ для CSRF-токенов. Отдельный от CREDENTIALS_ENC_KEY: один ключ
  // на две разные задачи — плохая практика, компрометация одной ломает обе
  SESSION_SECRET: z.string().min(32),
  SESSION_TTL_DAYS: z.coerce.number().int().positive().default(7),
  LOGIN_MAX_ATTEMPTS: z.coerce.number().int().positive().default(5),
  LOGIN_WINDOW_MINUTES: z.coerce.number().int().positive().default(15),
```

В `.env.example` в конец:

```
# Вход и сессии
SESSION_SECRET=смените-на-случайную-строку-не-короче-32-символов
SESSION_TTL_DAYS=7
LOGIN_MAX_ATTEMPTS=5
LOGIN_WINDOW_MINUTES=15
```

**Осторожно: новая обязательная переменная ломает уже написанные тесты.** `SESSION_SECRET`
не имеет значения по умолчанию, поэтому каждый существующий вызов `loadConfig` в тестах
перестанет проходить валидацию. Поправить нужно три места, иначе `npm test` покраснеет
целиком:

- `tests/config.test.ts` — константа `valid`;
- `tests/worker.test.ts` — функция `config()`;
- `tests/web/webhooks.test.ts` — функция `config()`.

В каждую добавить `SESSION_SECRET: 'a'.repeat(32)`.

Значения по умолчанию у секрета быть не должно: конфигурация с предсказуемым ключом,
случайно уехавшая в прод, обесценивает CSRF-защиту целиком.

В `tests/config.test.ts` константу `valid` дополнить тем же полем и добавить тест:

```ts
it('подставляет значения по умолчанию для входа', () => {
  const cfg = loadConfig(valid);
  expect(cfg.SESSION_TTL_DAYS).toBe(7);
  expect(cfg.LOGIN_MAX_ATTEMPTS).toBe(5);
  expect(cfg.LOGIN_WINDOW_MINUTES).toBe(15);
});

it('S10: короткий SESSION_SECRET отвергается по имени, без значения', () => {
  const bad = { ...valid, SESSION_SECRET: 'коротко' };
  try {
    loadConfig(bad as unknown as NodeJS.ProcessEnv);
    throw new Error('должно было упасть');
  } catch (error) {
    const msg = error instanceof Error ? error.message : '';
    expect(msg).toContain('SESSION_SECRET');
    expect(msg).not.toContain('коротко');
  }
});
```

- [ ] **Step 2: Написать падающий тест**

`tests/storage/queries/sessions.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { createTestDb } from '../helpers.js';
import { createUser } from '../../../src/storage/queries/users.js';
import { sessions } from '../../../src/storage/schema.js';
import {
  createSession, deleteSession, deleteUserSessions, loadSession, touchSession,
} from '../../../src/storage/queries/sessions.js';

const DAY = 86_400_000;
const NOW = new Date('2026-09-01T12:00:00Z');

function seed() {
  const db = createTestDb();
  const a = createUser(db, { email: 'a@a.a', passwordHash: 'x' });
  const b = createUser(db, { email: 'b@b.b', passwordHash: 'x' });
  return { db, a, b };
}

describe('сессии', () => {
  it('созданная сессия находится по своему токену', () => {
    const { db, a } = seed();
    const token = createSession(db, a, NOW, 7 * DAY);
    expect(loadSession(db, token, NOW)?.userId).toBe(a);
  });

  it('S15: в базе лежит не токен, а его хэш', () => {
    const { db, a } = seed();
    const token = createSession(db, a, NOW, 7 * DAY);

    const rows = db.select().from(sessions).all();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.id).not.toBe(token);
    expect(db.select().from(sessions).where(eq(sessions.id, token)).all()).toHaveLength(0);
  });

  it('два входа дают разные токены', () => {
    const { db, a } = seed();
    expect(createSession(db, a, NOW, 7 * DAY)).not.toBe(createSession(db, a, NOW, 7 * DAY));
  });

  it('истёкшая сессия не находится', () => {
    const { db, a } = seed();
    const token = createSession(db, a, NOW, 7 * DAY);
    expect(loadSession(db, token, new Date(NOW.getTime() + 8 * DAY))).toBeUndefined();
  });

  it('продление отодвигает срок от текущего момента', () => {
    const { db, a } = seed();
    const token = createSession(db, a, NOW, 7 * DAY);
    const later = new Date(NOW.getTime() + 6 * DAY);

    touchSession(db, token, later, 7 * DAY);

    // Без продления сессия умерла бы на 7-й день, с продлением жива на 12-й
    expect(loadSession(db, token, new Date(NOW.getTime() + 12 * DAY))?.userId).toBe(a);
  });

  it('выход удаляет именно эту сессию', () => {
    const { db, a } = seed();
    const first = createSession(db, a, NOW, 7 * DAY);
    const second = createSession(db, a, NOW, 7 * DAY);

    deleteSession(db, first);

    expect(loadSession(db, first, NOW)).toBeUndefined();
    expect(loadSession(db, second, NOW)?.userId).toBe(a);
  });

  it('S15: смена пароля убивает все сессии пользователя', () => {
    const { db, a } = seed();
    const first = createSession(db, a, NOW, 7 * DAY);
    const second = createSession(db, a, NOW, 7 * DAY);

    deleteUserSessions(db, a);

    expect(loadSession(db, first, NOW)).toBeUndefined();
    expect(loadSession(db, second, NOW)).toBeUndefined();
  });

  it('S15: чужие сессии при этом живы', () => {
    const { db, a, b } = seed();
    const mine = createSession(db, a, NOW, 7 * DAY);
    const theirs = createSession(db, b, NOW, 7 * DAY);

    deleteUserSessions(db, a);

    expect(loadSession(db, mine, NOW)).toBeUndefined();
    expect(loadSession(db, theirs, NOW)?.userId).toBe(b);
  });

  it('мусор вместо токена не находит ничего и не падает', () => {
    const { db } = seed();
    expect(loadSession(db, '', NOW)).toBeUndefined();
    expect(loadSession(db, '../../etc/passwd', NOW)).toBeUndefined();
  });
});
```

- [ ] **Step 3: Запустить тест, убедиться что падает**

Run: `npx vitest run tests/storage/queries/sessions.test.ts`
Expected: FAIL — модуль `src/storage/queries/sessions.js` не найден.

- [ ] **Step 4: Реализовать `src/storage/queries/sessions.ts`**

```ts
import { createHash, randomBytes } from 'node:crypto';
import { and, eq, gt } from 'drizzle-orm';
import type { AppDb } from '../db.js';
import { sessions } from '../schema.js';

/**
 * В cookie уезжает токен, в базу ложится его хэш. Дамп базы после этого
 * не даёт войти ни в один кабинет (S15).
 *
 * Соли и растягивания нет намеренно: токен уже случайный на 256 бит, словарь
 * к нему не подберёшь, а сессия проверяется на каждый запрос — argon2 здесь
 * стоил бы десятки миллисекунд на каждой странице.
 */
function tokenHash(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

/**
 * Возвращает токен, а не id строки: id — это уже хэш, и наружу он не нужен.
 * Токен существует только в этом возврате и в cookie клиента.
 */
export function createSession(db: AppDb, userId: string, now: Date, ttlMs: number): string {
  const token = randomBytes(32).toString('hex');
  db.insert(sessions).values({
    id: tokenHash(token),
    userId,
    expiresAt: new Date(now.getTime() + ttlMs),
    createdAt: now,
  }).run();
  return token;
}

/** Срок жизни проверяется в самом запросе: истёкшая строка просто не находится. */
export function loadSession(
  db: AppDb, token: string, now: Date,
): { userId: string } | undefined {
  const row = db.select().from(sessions)
    .where(and(eq(sessions.id, tokenHash(token)), gt(sessions.expiresAt, now)))
    .all()[0];
  return row === undefined ? undefined : { userId: row.userId };
}

/** Скользящее окно: срок считается от текущего момента, а не от входа. */
export function touchSession(db: AppDb, token: string, now: Date, ttlMs: number): void {
  db.update(sessions)
    .set({ expiresAt: new Date(now.getTime() + ttlMs) })
    .where(eq(sessions.id, tokenHash(token)))
    .run();
}

export function deleteSession(db: AppDb, token: string): void {
  db.delete(sessions).where(eq(sessions.id, tokenHash(token))).run();
}

/**
 * Владелец первым аргументом, как во всех запросах слоя: это единственный
 * способ выйти со всех устройств при смене пароля (S15).
 */
export function deleteUserSessions(db: AppDb, userId: string): void {
  db.delete(sessions).where(eq(sessions.userId, userId)).run();
}
```

- [ ] **Step 5: Запустить тесты, убедиться что проходят**

Run: `npx vitest run tests/storage/queries/sessions.test.ts tests/config.test.ts`
Expected: PASS.

- [ ] **Step 6: Коммит**

```bash
git add src/storage/queries/sessions.ts tests/storage/queries/sessions.test.ts src/config.ts .env.example tests/config.test.ts
git commit -m "feat(storage): сессии в базе, в cookie токен, в БД его хэш (S15)"
```

---

## Task D4: CSRF, cookie, тело формы и заголовки

Четыре механики HTTP, которых у проекта ещё не было. Они лежат в двух файлах,
а не в каждом маршруте, потому что забыть их в одном маршруте — это дыра.

CSRF-токен не хранится нигде: он выводится из id сессии функцией HMAC на
`SESSION_SECRET`. Отдельная колонка и её ротация не нужны, а подделать токен
без секрета нельзя.

**Files:**
- Create: `src/web/csrf.ts`, `src/web/http.ts`
- Test: `tests/web/csrf.test.ts`, `tests/web/http.test.ts`

**Interfaces:**
- Produces:
  - `csrfToken(sessionToken: string, secret: string): string`
  - `csrfValid(sessionToken: string, provided: string | undefined, secret: string): boolean`
  - `readCookie(header: string | undefined, name: string): string | undefined`
  - `sessionCookie(token: string, ttlMs: number, secure: boolean): string`
  - `clearedCookie(): string`
  - `registerFormParser(app: FastifyInstance): void`
  - `registerSecurityHeaders(app: FastifyInstance, isProduction: boolean): void`

- [ ] **Step 1: Написать падающий тест для CSRF**

`tests/web/csrf.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { csrfToken, csrfValid } from '../../src/web/csrf.js';

const SECRET = 'a'.repeat(32);

describe('CSRF-токен', () => {
  it('один и тот же для одной сессии', () => {
    expect(csrfToken('сессия-1', SECRET)).toBe(csrfToken('сессия-1', SECRET));
  });

  it('S15: разный для разных сессий', () => {
    expect(csrfToken('сессия-1', SECRET)).not.toBe(csrfToken('сессия-2', SECRET));
  });

  it('S15: не выводится без секрета', () => {
    expect(csrfToken('сессия-1', SECRET)).not.toBe(csrfToken('сессия-1', 'b'.repeat(32)));
  });

  it('свой токен проходит проверку', () => {
    expect(csrfValid('сессия-1', csrfToken('сессия-1', SECRET), SECRET)).toBe(true);
  });

  it('S15: токен чужой сессии не проходит', () => {
    expect(csrfValid('сессия-1', csrfToken('сессия-2', SECRET), SECRET)).toBe(false);
  });

  it('S15: отсутствие токена — это отказ, а не пропуск', () => {
    expect(csrfValid('сессия-1', undefined, SECRET)).toBe(false);
    expect(csrfValid('сессия-1', '', SECRET)).toBe(false);
  });

  it('токен другой длины не роняет сравнение', () => {
    expect(csrfValid('сессия-1', 'коротко', SECRET)).toBe(false);
  });
});
```

- [ ] **Step 2: Запустить тест, убедиться что падает**

Run: `npx vitest run tests/web/csrf.test.ts`
Expected: FAIL — модуль `src/web/csrf.js` не найден.

- [ ] **Step 3: Реализовать `src/web/csrf.ts`**

```ts
import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * Токен выводится из сессии, а не хранится: подделать его без секрета нельзя,
 * а колонки в БД и её ротации не требуется (S15).
 *
 * Секрет отдельный от ключа шифрования токенов платформ: один ключ на две
 * задачи означает, что компрометация одной ломает обе.
 */
export function csrfToken(sessionToken: string, secret: string): string {
  return createHmac('sha256', secret).update(sessionToken, 'utf8').digest('hex');
}

/**
 * Сравнение constant-time по той же причине, что и подпись вебхука:
 * обычное === выходит на первом различии, и токен подбирается побайтно.
 */
export function csrfValid(
  sessionToken: string, provided: string | undefined, secret: string,
): boolean {
  if (provided === undefined || provided.length === 0) return false;

  const expected = Buffer.from(csrfToken(sessionToken, secret), 'utf8');
  const received = Buffer.from(provided, 'utf8');
  if (expected.length !== received.length) return false;

  return timingSafeEqual(expected, received);
}
```

- [ ] **Step 4: Написать падающий тест для HTTP-механики**

`tests/web/http.test.ts`:

```ts
import Fastify from 'fastify';
import { describe, expect, it } from 'vitest';
import {
  clearedCookie, readCookie, registerFormParser, registerSecurityHeaders, sessionCookie,
} from '../../src/web/http.js';

const DAY = 86_400_000;

describe('cookie', () => {
  it('читает нужную cookie из заголовка с несколькими', () => {
    expect(readCookie('theme=dark; sid=abc123; lang=ru', 'sid')).toBe('abc123');
  });

  it('отсутствующая cookie — undefined, а не пустая строка', () => {
    expect(readCookie('theme=dark', 'sid')).toBeUndefined();
    expect(readCookie(undefined, 'sid')).toBeUndefined();
  });

  it('не путает cookie с похожим именем', () => {
    expect(readCookie('notsid=нет; sid=да', 'sid')).toBe('да');
  });

  it('S15: cookie сессии HttpOnly и SameSite=Lax', () => {
    const value = sessionCookie('токен', 7 * DAY, false);
    expect(value).toContain('HttpOnly');
    expect(value).toContain('SameSite=Lax');
    expect(value).toContain('Path=/');
    expect(value).toContain('Max-Age=604800');
  });

  it('S15: Secure появляется только в проде', () => {
    expect(sessionCookie('токен', DAY, true)).toContain('Secure');
    expect(sessionCookie('токен', DAY, false)).not.toContain('Secure');
  });

  it('выход обнуляет cookie', () => {
    expect(clearedCookie()).toContain('Max-Age=0');
  });
});

describe('тело формы', () => {
  it('разбирается в объект', async () => {
    const app = Fastify();
    registerFormParser(app);
    app.post('/echo', (request, reply) => reply.send(request.body));

    const res = await app.inject({
      method: 'POST', url: '/echo',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      payload: 'email=a%40a.a&password=%D0%BF%D0%B0%D1%80%D0%BE%D0%BB%D1%8C',
    });

    expect(res.json()).toEqual({ email: 'a@a.a', password: 'пароль' });
  });

  it('S6: __proto__ в теле формы не загрязняет прототип', async () => {
    const app = Fastify();
    registerFormParser(app);
    app.post('/echo', (request, reply) => reply.send({ ok: true }));

    await app.inject({
      method: 'POST', url: '/echo',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      payload: '__proto__[admin]=true',
    });

    expect(Object.prototype).not.toHaveProperty('admin');
  });
});

describe('заголовки безопасности', () => {
  it('S22: стоят на любом ответе', async () => {
    const app = Fastify();
    registerSecurityHeaders(app, false);
    app.get('/', (_request, reply) => reply.send('ок'));

    const res = await app.inject({ method: 'GET', url: '/' });

    expect(res.headers['x-frame-options']).toBe('DENY');
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['referrer-policy']).toBe('same-origin');
    expect(String(res.headers['content-security-policy'])).not.toContain('unsafe-inline');
  });

  it('S22: HSTS только в проде', async () => {
    const dev = Fastify();
    registerSecurityHeaders(dev, false);
    dev.get('/', (_request, reply) => reply.send('ок'));

    const prod = Fastify();
    registerSecurityHeaders(prod, true);
    prod.get('/', (_request, reply) => reply.send('ок'));

    expect((await dev.inject({ method: 'GET', url: '/' })).headers['strict-transport-security'])
      .toBeUndefined();
    expect((await prod.inject({ method: 'GET', url: '/' })).headers['strict-transport-security'])
      .toContain('max-age=');
  });
});
```

- [ ] **Step 5: Запустить тест, убедиться что падает**

Run: `npx vitest run tests/web/http.test.ts`
Expected: FAIL — модуль `src/web/http.js` не найден.

- [ ] **Step 6: Реализовать `src/web/http.ts`**

```ts
import type { FastifyInstance } from 'fastify';

const SESSION_COOKIE = 'sid';

/**
 * Разбор вручную, без зависимости: нужна ровно одна cookie с шестнадцатеричным
 * значением. Имя сравнивается целиком, иначе `notsid` совпал бы с `sid`.
 */
export function readCookie(header: string | undefined, name: string): string | undefined {
  if (header === undefined) return undefined;

  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq === -1) continue;
    if (part.slice(0, eq).trim() !== name) continue;
    return part.slice(eq + 1).trim();
  }
  return undefined;
}

/**
 * S15: HttpOnly закрывает cookie от JavaScript, SameSite=Lax отсекает
 * межсайтовые POST-запросы, Secure требует HTTPS. Secure только в проде —
 * иначе браузер не примет cookie с localhost по http.
 */
export function sessionCookie(token: string, ttlMs: number, secure: boolean): string {
  const parts = [
    `${SESSION_COOKIE}=${token}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    `Max-Age=${Math.floor(ttlMs / 1000)}`,
  ];
  if (secure) parts.push('Secure');
  return parts.join('; ');
}

export function clearedCookie(): string {
  return `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`;
}

export { SESSION_COOKIE };

/**
 * Формы приходят как application/x-www-form-urlencoded, а Fastify по умолчанию
 * разбирает только JSON. URLSearchParams вместо ручного разбора: он же обрабатывает
 * проценты и плюсы.
 *
 * Object.fromEntries на URLSearchParams не создаёт `__proto__` как свойство
 * прототипа — ключ ложится обычным собственным свойством (S6).
 */
export function registerFormParser(app: FastifyInstance): void {
  app.addContentTypeParser(
    'application/x-www-form-urlencoded',
    { parseAs: 'string', bodyLimit: 65_536 },
    (_request, body, done) => {
      try {
        done(null, Object.fromEntries(new URLSearchParams(String(body))));
      } catch {
        done(null, {});
      }
    },
  );
}

/**
 * S22. CSP без `unsafe-inline` — второй рубеж после экранирования: даже если
 * разметка утечёт, инлайновый скрипт не выполнится. Поэтому стили и скрипты
 * страниц кабинета не могут быть инлайновыми.
 */
export function registerSecurityHeaders(app: FastifyInstance, isProduction: boolean): void {
  app.addHook('onSend', (_request, reply, payload, done) => {
    reply.header('x-frame-options', 'DENY');
    reply.header('x-content-type-options', 'nosniff');
    reply.header('referrer-policy', 'same-origin');
    reply.header(
      'content-security-policy',
      "default-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
    );
    if (isProduction) {
      reply.header('strict-transport-security', 'max-age=31536000; includeSubDomains');
    }
    done(null, payload);
  });
}
```

- [ ] **Step 7: Запустить тесты, убедиться что проходят**

Run: `npx vitest run tests/web/csrf.test.ts tests/web/http.test.ts`
Expected: PASS, 7 + 10 тестов.

- [ ] **Step 8: Коммит**

```bash
git add src/web/csrf.ts src/web/http.ts tests/web/csrf.test.ts tests/web/http.test.ts
git commit -m "feat(web): CSRF-токен, cookie сессии, разбор форм и заголовки (S15, S22)"
```

---
## Task D5: Вход и выход

**Files:**
- Create: `src/web/session.ts`, `src/web/views/layout.ts`, `src/web/views/login.ts`, `src/web/routes/auth.ts`
- Modify: `src/core/throttle.ts`, `tests/core/throttle.test.ts`
- Test: `tests/web/auth.test.ts`

**Interfaces:**
- Consumes: `hashPassword`/`verifyPassword` из `src/web/password.js`; `createSession`,
  `deleteSession`, `loadSession`, `touchSession` из `src/storage/queries/sessions.js`;
  `csrfToken` из `src/web/csrf.js`; `readCookie`, `sessionCookie`, `clearedCookie`,
  `SESSION_COOKIE` из `src/web/http.js`; `findUserByEmail` из `src/storage/queries/users.js`
- Produces:
  - `interface WebDeps { db: AppDb; cfg: Config; throttle: ReplyThrottle }`
  - `interface Session { token: string; userId: string }`
  - `currentSession(deps: WebDeps, request: FastifyRequest, now: Date): Session | undefined`
  - `registerAuthRoutes(app: FastifyInstance, deps: WebDeps): void`
  - `layout(title: string, body: Html): Html`
  - `loginPage(error: string | undefined): Html`

- [ ] **Step 1: Тест на окно троттлинга**

В `tests/core/throttle.test.ts` добавить:

```ts
it('окно задаётся параметром: вход считают за 15 минут, а не за минуту', () => {
  const throttle = new ReplyThrottle(2, 15 * 60_000);
  const start = new Date('2026-09-01T12:00:00Z');

  expect(throttle.allow('вход:a@a.a', start)).toBe(true);
  expect(throttle.allow('вход:a@a.a', start)).toBe(true);
  expect(throttle.allow('вход:a@a.a', start)).toBe(false);

  // Через 10 минут окно ещё не закрылось
  expect(throttle.allow('вход:a@a.a', new Date(start.getTime() + 10 * 60_000))).toBe(false);
  // Через 16 — закрылось
  expect(throttle.allow('вход:a@a.a', new Date(start.getTime() + 16 * 60_000))).toBe(true);
});
```

- [ ] **Step 2: Запустить тест, убедиться что падает**

Run: `npx vitest run tests/core/throttle.test.ts`
Expected: FAIL — второй аргумент конструктора игнорируется, четвёртая проверка вернёт `true`.

- [ ] **Step 3: Добавить окно в `src/core/throttle.ts`**

Заменить конструктор и вычисление границы:

```ts
export class ReplyThrottle {
  private readonly hits = new Map<string, number[]>();

  /**
   * Окно параметром: тот же счётчик обслуживает и ответы боту (минута),
   * и попытки входа (пятнадцать минут). Две почти одинаковые реализации
   * разошлись бы при первой же правке.
   */
  constructor(
    private readonly maxPerWindow: number,
    private readonly windowMs = 60_000,
  ) {}

  allow(contactKey: string, now: Date): boolean {
    const cutoff = now.getTime() - this.windowMs;
    const recent = (this.hits.get(contactKey) ?? []).filter((t) => t > cutoff);

    if (recent.length >= this.maxPerWindow) {
      this.hits.set(contactKey, recent);
      return false;
    }
    recent.push(now.getTime());
    this.hits.set(contactKey, recent);
    return true;
  }
}
```

- [ ] **Step 4: Написать падающий тест входа**

`tests/web/auth.test.ts`:

```ts
import Fastify from 'fastify';
import { describe, expect, it } from 'vitest';
import { createTestDb } from '../storage/helpers.js';
import { createUser } from '../../src/storage/queries/users.js';
import { loadConfig } from '../../src/config.js';
import { ReplyThrottle } from '../../src/core/throttle.js';
import { hashPassword } from '../../src/web/password.js';
import { registerFormParser } from '../../src/web/http.js';
import { registerAuthRoutes } from '../../src/web/routes/auth.js';
import type { AppDb } from '../../src/storage/db.js';

const SECRET = 'a'.repeat(32);

function config() {
  return loadConfig({
    META_APP_SECRET: 's', META_VERIFY_TOKEN: 'v',
    CREDENTIALS_ENC_KEY: 'a'.repeat(64), SESSION_SECRET: SECRET,
  } as unknown as NodeJS.ProcessEnv);
}

function build(db: AppDb) {
  const cfg = config();
  const app = Fastify();
  registerFormParser(app);
  registerAuthRoutes(app, {
    db, cfg,
    throttle: new ReplyThrottle(cfg.LOGIN_MAX_ATTEMPTS, cfg.LOGIN_WINDOW_MINUTES * 60_000),
  });
  return app;
}

function form(fields: Record<string, string>) {
  return {
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    payload: new URLSearchParams(fields).toString(),
  };
}

async function seedUser(db: AppDb, email = 'a@a.a', password = 'пароль-клиента') {
  return createUser(db, { email, passwordHash: await hashPassword(password) });
}

describe('вход', () => {
  it('форма входа открыта без сессии', async () => {
    const res = await build(createTestDb()).inject({ method: 'GET', url: '/login' });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('<form');
  });

  it('верный пароль выдаёт сессию и уводит в кабинет', async () => {
    const db = createTestDb();
    await seedUser(db);

    const res = await build(db).inject({
      method: 'POST', url: '/login',
      ...form({ email: 'a@a.a', password: 'пароль-клиента' }),
    });

    expect(res.statusCode).toBe(303);
    expect(res.headers.location).toBe('/');
    expect(String(res.headers['set-cookie'])).toContain('HttpOnly');
  });

  it('S13: ответ одинаков при неверном пароле и несуществующем email', async () => {
    const db = createTestDb();
    await seedUser(db);
    const app = build(db);

    const wrongPassword = await app.inject({
      method: 'POST', url: '/login', ...form({ email: 'a@a.a', password: 'мимо' }),
    });
    const noSuchUser = await app.inject({
      method: 'POST', url: '/login', ...form({ email: 'нет@нет.нет', password: 'мимо' }),
    });

    expect(wrongPassword.statusCode).toBe(noSuchUser.statusCode);
    expect(wrongPassword.body).toBe(noSuchUser.body);
  });

  it('S13: неудачный вход не выдаёт cookie', async () => {
    const db = createTestDb();
    await seedUser(db);

    const res = await build(db).inject({
      method: 'POST', url: '/login', ...form({ email: 'a@a.a', password: 'мимо' }),
    });

    expect(res.statusCode).toBe(401);
    expect(res.headers['set-cookie']).toBeUndefined();
  });

  it('S9: пароль не возвращается на страницу после ошибки', async () => {
    const db = createTestDb();
    await seedUser(db);

    const res = await build(db).inject({
      method: 'POST', url: '/login',
      ...form({ email: 'a@a.a', password: 'мой-секретный-пароль' }),
    });

    expect(res.body).not.toContain('мой-секретный-пароль');
  });

  it('S15: каждый вход выдаёт новую сессию — фиксация не работает', async () => {
    const db = createTestDb();
    await seedUser(db);
    const app = build(db);

    const first = await app.inject({
      method: 'POST', url: '/login', ...form({ email: 'a@a.a', password: 'пароль-клиента' }),
    });
    const second = await app.inject({
      method: 'POST', url: '/login', ...form({ email: 'a@a.a', password: 'пароль-клиента' }),
    });

    expect(String(first.headers['set-cookie'])).not.toBe(String(second.headers['set-cookie']));
  });

  it('S19: после лимита неудач вход отвечает 429', async () => {
    const db = createTestDb();
    await seedUser(db);
    const app = build(db);
    const attempt = () => app.inject({
      method: 'POST', url: '/login', ...form({ email: 'a@a.a', password: 'мимо' }),
    });

    for (let i = 0; i < config().LOGIN_MAX_ATTEMPTS; i += 1) await attempt();

    expect((await attempt()).statusCode).toBe(429);
  });

  it('S19: исчерпанный лимит не пускает и с верным паролем', async () => {
    const db = createTestDb();
    await seedUser(db);
    const app = build(db);

    for (let i = 0; i < config().LOGIN_MAX_ATTEMPTS; i += 1) {
      await app.inject({
        method: 'POST', url: '/login', ...form({ email: 'a@a.a', password: 'мимо' }),
      });
    }

    const res = await app.inject({
      method: 'POST', url: '/login', ...form({ email: 'a@a.a', password: 'пароль-клиента' }),
    });
    expect(res.statusCode).toBe(429);
  });

  it('S14: роль из тела формы игнорируется', async () => {
    const db = createTestDb();
    await seedUser(db);

    const res = await build(db).inject({
      method: 'POST', url: '/login',
      ...form({ email: 'a@a.a', password: 'пароль-клиента', role: 'owner' }),
    });

    // Форма разобрана схемой, где роли нет вообще: вход прошёл, роль не тронута
    expect(res.statusCode).toBe(303);
  });

  it('пустая форма не роняет обработчик', async () => {
    const res = await build(createTestDb()).inject({
      method: 'POST', url: '/login', ...form({}),
    });
    expect(res.statusCode).toBe(401);
  });
});

describe('выход', () => {
  it('обнуляет cookie и уводит на форму входа', async () => {
    const db = createTestDb();
    await seedUser(db);
    const app = build(db);

    const login = await app.inject({
      method: 'POST', url: '/login', ...form({ email: 'a@a.a', password: 'пароль-клиента' }),
    });
    const cookie = String(login.headers['set-cookie']).split(';')[0] ?? '';

    const res = await app.inject({ method: 'POST', url: '/logout', headers: { cookie } });

    expect(res.statusCode).toBe(303);
    expect(res.headers.location).toBe('/login');
    expect(String(res.headers['set-cookie'])).toContain('Max-Age=0');
  });
});
```

- [ ] **Step 5: Запустить тест, убедиться что падает**

Run: `npx vitest run tests/web/auth.test.ts`
Expected: FAIL — модуль `src/web/routes/auth.js` не найден.

- [ ] **Step 6: Реализовать `src/web/session.ts`**

```ts
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { Config } from '../config.js';
import type { ReplyThrottle } from '../core/throttle.js';
import type { AppDb } from '../storage/db.js';
import { loadSession, touchSession } from '../storage/queries/sessions.js';
import { readCookie, SESSION_COOKIE } from './http.js';

export interface WebDeps {
  db: AppDb;
  cfg: Config;
  throttle: ReplyThrottle;
}

export interface Session {
  token: string;
  userId: string;
}

export function ttlMs(cfg: Config): number {
  return cfg.SESSION_TTL_DAYS * 86_400_000;
}

/**
 * Единственный источник `userId` для всего кабинета. Из тела запроса владелец
 * не берётся нигде и никогда (S14) — этой функции достаточно, чтобы правило
 * держалось само собой.
 *
 * Продление здесь же: сессия скользящая, и каждый запрос отодвигает срок.
 */
export function currentSession(
  deps: WebDeps, request: FastifyRequest, now: Date,
): Session | undefined {
  const cookieHeader = request.headers.cookie;
  const token = readCookie(typeof cookieHeader === 'string' ? cookieHeader : undefined, SESSION_COOKIE);
  if (token === undefined) return undefined;

  const found = loadSession(deps.db, token, now);
  if (found === undefined) return undefined;

  touchSession(deps.db, token, now, ttlMs(deps.cfg));
  return { token, userId: found.userId };
}

export function redirectToLogin(reply: FastifyReply): FastifyReply {
  return reply.code(303).header('location', '/login').send();
}
```

- [ ] **Step 7: Реализовать представления**

`src/web/views/layout.ts`:

```ts
import { html, type Html } from '../html.js';

/**
 * Стилей нет намеренно: CSP запрещает инлайновые стили, а отдельный файл стилей
 * появится вместе с конструктором (фаза E). Пока страницы простые, но рабочие.
 */
export function layout(title: string, body: Html): Html {
  return html`<!doctype html>
<html lang="ru">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title}</title>
</head>
<body>
${body}
</body>
</html>`;
}
```

`src/web/views/login.ts`:

```ts
import { html, type Html } from '../html.js';
import { layout } from './layout.js';

/**
 * Текст ошибки один на все случаи: разные сообщения для «нет такого email»
 * и «неверный пароль» позволяют перебором собрать список клиентов сервиса (S13).
 */
export function loginPage(error: string | undefined): Html {
  return layout('Вход', html`
<h1>Вход</h1>
${error === undefined ? '' : html`<p role="alert">${error}</p>`}
<form method="post" action="/login">
  <label>Почта <input type="email" name="email" required autocomplete="username"></label>
  <label>Пароль <input type="password" name="password" required autocomplete="current-password"></label>
  <button type="submit">Войти</button>
</form>`);
}
```

- [ ] **Step 8: Реализовать `src/web/routes/auth.ts`**

```ts
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { createSession, deleteSession } from '../../storage/queries/sessions.js';
import { findUserByEmail } from '../../storage/queries/users.js';
import { clearedCookie, readCookie, sessionCookie, SESSION_COOKIE } from '../http.js';
import { verifyPassword } from '../password.js';
import { ttlMs, type WebDeps } from '../session.js';
import { loginPage } from '../views/login.js';

/**
 * S14: схема описывает ровно два разрешённых поля. Всё остальное, что пришло
 * в форме — роль, user_id, что угодно — не попадает в код вообще.
 */
const LoginForm = z.object({
  email: z.string().min(1).max(320),
  password: z.string().min(1).max(1024),
});

/** Один текст на любую неудачу входа (S13). */
const FAILED = 'Неверная почта или пароль';

export function registerAuthRoutes(app: FastifyInstance, deps: WebDeps): void {
  app.get('/login', (_request, reply) =>
    reply.type('text/html; charset=utf-8').send(loginPage(undefined).value));

  app.post('/login', async (request, reply) => {
    const now = new Date();
    const parsed = LoginForm.safeParse(request.body);
    const email = parsed.success ? parsed.data.email : '';

    // S19: счётчик и по email, и по адресу — иначе перебор одного аккаунта
    // с разных адресов или разных аккаунтов с одного проходит мимо лимита
    const allowed = deps.throttle.allow(`вход:email:${email}`, now)
      && deps.throttle.allow(`вход:ip:${request.ip}`, now);
    if (!allowed) {
      return reply.code(429).type('text/html; charset=utf-8')
        .send(loginPage('Слишком много попыток. Попробуйте позже').value);
    }

    if (!parsed.success) {
      return reply.code(401).type('text/html; charset=utf-8').send(loginPage(FAILED).value);
    }

    const user = findUserByEmail(deps.db, parsed.data.email);
    // Пароль проверяется даже когда пользователя нет: verifyPassword считает
    // хэш от заглушки, и время ответа не выдаёт существование аккаунта (S13)
    const ok = await verifyPassword(user?.passwordHash, parsed.data.password);
    if (!ok || user === undefined) {
      return reply.code(401).type('text/html; charset=utf-8').send(loginPage(FAILED).value);
    }

    // S15: старая сессия уничтожается, новая выдаётся с нуля — иначе
    // подсунутый заранее идентификатор сессии переживёт вход
    const cookieHeader = request.headers.cookie;
    const old = readCookie(typeof cookieHeader === 'string' ? cookieHeader : undefined, SESSION_COOKIE);
    if (old !== undefined) deleteSession(deps.db, old);

    const token = createSession(deps.db, user.id, now, ttlMs(deps.cfg));
    return reply
      .header('set-cookie', sessionCookie(token, ttlMs(deps.cfg), deps.cfg.NODE_ENV === 'production'))
      .code(303).header('location', '/').send();
  });

  app.post('/logout', (request, reply) => {
    const cookieHeader = request.headers.cookie;
    const token = readCookie(typeof cookieHeader === 'string' ? cookieHeader : undefined, SESSION_COOKIE);
    if (token !== undefined) deleteSession(deps.db, token);

    return reply.header('set-cookie', clearedCookie())
      .code(303).header('location', '/login').send();
  });
}
```

- [ ] **Step 9: Запустить тесты, убедиться что проходят**

Run: `npx vitest run tests/web/auth.test.ts tests/core/throttle.test.ts`
Expected: PASS.

- [ ] **Step 10: Коммит**

```bash
git add src/web/session.ts src/web/views/ src/web/routes/auth.ts src/core/throttle.ts tests/web/auth.test.ts tests/core/throttle.test.ts
git commit -m "feat(web): вход и выход, троттлинг попыток и перевыпуск сессии (S13, S15, S19)"
```

---

## Task D6: Кабинет — список воронок и переключатель

**Files:**
- Create: `src/web/views/dashboard.ts`, `src/web/routes/dashboard.ts`
- Test: `tests/web/dashboard.test.ts`

**Interfaces:**
- Consumes: `currentSession`, `redirectToLogin`, `WebDeps` из `src/web/session.js`;
  `listAutomations`, `setEnabled` из `src/storage/queries/automations.js`;
  `csrfToken`, `csrfValid` из `src/web/csrf.js`
- Produces:
  - `registerDashboardRoutes(app: FastifyInstance, deps: WebDeps): void`
  - `dashboardPage(rows: AutomationRow[], csrf: string): Html`

- [ ] **Step 1: Написать падающий тест**

`tests/web/dashboard.test.ts`:

```ts
import Fastify, { type FastifyInstance } from 'fastify';
import { describe, expect, it } from 'vitest';
import { createTestDb } from '../storage/helpers.js';
import { createUser } from '../../src/storage/queries/users.js';
import { createAutomation, listAutomations } from '../../src/storage/queries/automations.js';
import { createSession } from '../../src/storage/queries/sessions.js';
import { loadConfig } from '../../src/config.js';
import { ReplyThrottle } from '../../src/core/throttle.js';
import { csrfToken } from '../../src/web/csrf.js';
import { registerFormParser } from '../../src/web/http.js';
import { registerDashboardRoutes } from '../../src/web/routes/dashboard.js';
import type { AppDb } from '../../src/storage/db.js';

const SECRET = 'a'.repeat(32);
const NOW = new Date('2026-09-01T12:00:00Z');
const DAY = 86_400_000;

function config() {
  return loadConfig({
    META_APP_SECRET: 's', META_VERIFY_TOKEN: 'v',
    CREDENTIALS_ENC_KEY: 'a'.repeat(64), SESSION_SECRET: SECRET,
  } as unknown as NodeJS.ProcessEnv);
}

function build(db: AppDb): FastifyInstance {
  const cfg = config();
  const app = Fastify();
  registerFormParser(app);
  registerDashboardRoutes(app, { db, cfg, throttle: new ReplyThrottle(5) });
  return app;
}

function login(db: AppDb, userId: string) {
  const token = createSession(db, userId, NOW, 7 * DAY);
  return { cookie: `sid=${token}`, csrf: csrfToken(token, SECRET) };
}

function seed() {
  const db = createTestDb();
  const a = createUser(db, { email: 'a@a.a', passwordHash: 'x' });
  const b = createUser(db, { email: 'b@b.b', passwordHash: 'x' });
  const aAutomation = createAutomation(db, a, {
    name: 'Прайс A', triggerType: 'contains', triggerValue: 'цена', steps: [{ say: 'Ответ A' }],
  });
  const bAutomation = createAutomation(db, b, {
    name: 'Прайс B', triggerType: 'contains', triggerValue: 'цена', steps: [{ say: 'Ответ B' }],
  });
  return { db, a, b, aAutomation, bAutomation };
}

describe('кабинет', () => {
  it('без сессии уводит на форму входа', async () => {
    const { db } = seed();
    const res = await build(db).inject({ method: 'GET', url: '/' });
    expect(res.statusCode).toBe(303);
    expect(res.headers.location).toBe('/login');
  });

  it('S11: показывает только свои воронки', async () => {
    const { db, a } = seed();
    const res = await build(db).inject({ method: 'GET', url: '/', headers: { cookie: login(db, a).cookie } });

    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('Прайс A');
    expect(res.body).not.toContain('Прайс B');
  });

  it('S21: имя воронки со скриптом выводится текстом', async () => {
    const db = createTestDb();
    const userId = createUser(db, { email: 'x@x.x', passwordHash: 'x' });
    createAutomation(db, userId, {
      name: '<script>alert(1)</script>', triggerType: 'contains', triggerValue: 'ц',
      steps: [{ say: 'Ответ' }],
    });

    const res = await build(db).inject({
      method: 'GET', url: '/', headers: { cookie: login(db, userId).cookie },
    });

    expect(res.body).not.toContain('<script>alert(1)</script>');
    expect(res.body).toContain('&lt;script&gt;');
  });

  it('переключатель выключает воронку', async () => {
    const { db, a, aAutomation } = seed();
    const { cookie, csrf } = login(db, a);

    const res = await build(db).inject({
      method: 'POST', url: `/automations/${aAutomation}/toggle`,
      headers: { cookie, 'content-type': 'application/x-www-form-urlencoded' },
      payload: new URLSearchParams({ enabled: 'false', csrf }).toString(),
    });

    expect(res.statusCode).toBe(303);
    expect(listAutomations(db, a)[0]?.enabled).toBe(false);
  });

  it('S15: без CSRF-токена переключатель отвечает 403 и ничего не меняет', async () => {
    const { db, a, aAutomation } = seed();
    const { cookie } = login(db, a);

    const res = await build(db).inject({
      method: 'POST', url: `/automations/${aAutomation}/toggle`,
      headers: { cookie, 'content-type': 'application/x-www-form-urlencoded' },
      payload: new URLSearchParams({ enabled: 'false' }).toString(),
    });

    expect(res.statusCode).toBe(403);
    expect(listAutomations(db, a)[0]?.enabled).toBe(true);
  });

  it('S15: токен чужой сессии не подходит', async () => {
    const { db, a, b, aAutomation } = seed();
    const { cookie } = login(db, a);
    const foreign = login(db, b).csrf;

    const res = await build(db).inject({
      method: 'POST', url: `/automations/${aAutomation}/toggle`,
      headers: { cookie, 'content-type': 'application/x-www-form-urlencoded' },
      payload: new URLSearchParams({ enabled: 'false', csrf: foreign }).toString(),
    });

    expect(res.statusCode).toBe(403);
  });

  it('S11: клиент B не выключает воронку клиента A', async () => {
    const { db, a, b, aAutomation } = seed();
    const { cookie, csrf } = login(db, b);

    const res = await build(db).inject({
      method: 'POST', url: `/automations/${aAutomation}/toggle`,
      headers: { cookie, 'content-type': 'application/x-www-form-urlencoded' },
      payload: new URLSearchParams({ enabled: 'false', csrf }).toString(),
    });

    // Ответ такой же, как для своей воронки: разный ответ выдал бы,
    // что такая воронка существует
    expect(res.statusCode).toBe(303);
    expect(listAutomations(db, a)[0]?.enabled).toBe(true);
  });

  it('S14: user_id в теле формы не меняет владельца', async () => {
    const { db, a, b, aAutomation } = seed();
    const { cookie, csrf } = login(db, b);

    await build(db).inject({
      method: 'POST', url: `/automations/${aAutomation}/toggle`,
      headers: { cookie, 'content-type': 'application/x-www-form-urlencoded' },
      payload: new URLSearchParams({ enabled: 'false', csrf, user_id: a }).toString(),
    });

    expect(listAutomations(db, a)[0]?.enabled).toBe(true);
  });
});
```

- [ ] **Step 2: Запустить тест, убедиться что падает**

Run: `npx vitest run tests/web/dashboard.test.ts`
Expected: FAIL — модуль `src/web/routes/dashboard.js` не найден.

- [ ] **Step 3: Реализовать `src/web/views/dashboard.ts`**

```ts
import { html, type Html } from '../html.js';
import type { AutomationRow } from '../../storage/queries/automations.js';
import { layout } from './layout.js';

export function dashboardPage(rows: AutomationRow[], csrf: string): Html {
  const items = rows.map((row) => html`
<tr>
  <td>${row.name}</td>
  <td>${row.triggerType} «${row.triggerValue}»</td>
  <td>${row.enabled ? 'включена' : 'выключена'}</td>
  <td>
    <form method="post" action="/automations/${row.id}/toggle">
      <input type="hidden" name="csrf" value="${csrf}">
      <input type="hidden" name="enabled" value="${row.enabled ? 'false' : 'true'}">
      <button type="submit">${row.enabled ? 'Выключить' : 'Включить'}</button>
    </form>
  </td>
</tr>`);

  return layout('Мои воронки', html`
<h1>Мои воронки</h1>
<p><a href="/leads">Заявки</a></p>
${rows.length === 0 ? html`<p>Воронок пока нет.</p>` : html`
<table>
  <thead><tr><th>Название</th><th>Триггер</th><th>Состояние</th><th></th></tr></thead>
  <tbody>${items}</tbody>
</table>`}
<form method="post" action="/logout"><button type="submit">Выйти</button></form>`);
}
```

- [ ] **Step 4: Реализовать `src/web/routes/dashboard.ts`**

```ts
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { listAutomations, setEnabled } from '../../storage/queries/automations.js';
import { csrfToken, csrfValid } from '../csrf.js';
import { currentSession, redirectToLogin, type WebDeps } from '../session.js';
import { dashboardPage } from '../views/dashboard.js';

/** S14: в форме переключателя разрешены ровно два поля. */
const ToggleForm = z.object({
  enabled: z.enum(['true', 'false']),
  csrf: z.string().min(1),
});

const Params = z.object({ id: z.string().min(1) });

export function registerDashboardRoutes(app: FastifyInstance, deps: WebDeps): void {
  app.get('/', (request, reply) => {
    const session = currentSession(deps, request, new Date());
    if (session === undefined) return redirectToLogin(reply);

    const rows = listAutomations(deps.db, session.userId);
    return reply
      // Страницы кабинета содержат ПД: в кэше браузера на общем компьютере
      // им делать нечего
      .header('cache-control', 'no-store')
      .type('text/html; charset=utf-8')
      .send(dashboardPage(rows, csrfToken(session.token, deps.cfg.SESSION_SECRET)).value);
  });

  app.post('/automations/:id/toggle', (request, reply) => {
    const session = currentSession(deps, request, new Date());
    if (session === undefined) return redirectToLogin(reply);

    const form = ToggleForm.safeParse(request.body);
    const params = Params.safeParse(request.params);
    if (!form.success || !params.success) return reply.code(400).send();

    if (!csrfValid(session.token, form.data.csrf, deps.cfg.SESSION_SECRET)) {
      return reply.code(403).send();
    }

    // S11: владелец из сессии и внутри запроса. Чужая воронка просто не найдётся,
    // и ответ будет тот же, что для своей — существование объекта не раскрывается
    setEnabled(deps.db, session.userId, params.data.id, form.data.enabled === 'true');
    return reply.code(303).header('location', '/').send();
  });
}
```

- [ ] **Step 5: Запустить тест, убедиться что проходит**

Run: `npx vitest run tests/web/dashboard.test.ts`
Expected: PASS, 8 тестов.

- [ ] **Step 6: Коммит**

```bash
git add src/web/views/dashboard.ts src/web/routes/dashboard.ts tests/web/dashboard.test.ts
git commit -m "feat(web): список воронок и переключатель с проверкой владельца (S11, S15, S21)"
```

---
## Task D7: Заявки и выгрузка в CSV

Заявка — это ПД: имя, телефон, что человек написал. Отсюда три требования к этой
задаче, которых не было в остальных: `no-store` на странице, экранирование формул
в CSV и отдельный тест на то, что чужие заявки не видны.

**Экранирование формул.** Значение `=1+1`, попавшее в CSV, выполняется как формула
при открытии в Excel, а `=HYPERLINK(...)` уводит данные на чужой сервер. Ответ человека
в директе полностью контролируется им же, поэтому это прямой путь от «клиент открыл
выгрузку» до утечки. В спеке этого требования нет — оно найдено при проектировании фазы.

**Files:**
- Create: `src/web/csv.ts`, `src/web/views/leads.ts`, `src/web/routes/leads.ts`
- Test: `tests/web/csv.test.ts`, `tests/web/leads.test.ts`

**Interfaces:**
- Consumes: `listLeads`, `leadData`, `LeadRow` из `src/storage/queries/leads.js`;
  `currentSession`, `redirectToLogin` из `src/web/session.js`
- Produces:
  - `csvCell(value: string): string`
  - `toCsv(rows: string[][]): string`
  - `leadsToCsv(rows: LeadRow[]): string`
  - `leadsPage(rows: LeadRow[]): Html`
  - `registerLeadsRoutes(app: FastifyInstance, deps: WebDeps): void`

- [ ] **Step 1: Написать падающий тест для CSV**

`tests/web/csv.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { csvCell, toCsv } from '../../src/web/csv.js';

describe('ячейка CSV', () => {
  it('обычное значение просто берётся в кавычки', () => {
    expect(csvCell('Абылай')).toBe('"Абылай"');
  });

  it('кавычка внутри удваивается', () => {
    expect(csvCell('он сказал "да"')).toBe('"он сказал ""да"""');
  });

  it('запятая и перенос строки не ломают строку файла', () => {
    expect(csvCell('а, б')).toBe('"а, б"');
    expect(csvCell('первая\nвторая')).toBe('"первая\nвторая"');
  });

  it('CSV-инъекция: значение с = обезвреживается', () => {
    expect(csvCell('=1+1')).toBe(`"'=1+1"`);
  });

  it('CSV-инъекция: +, -, @ и табуляция тоже', () => {
    expect(csvCell('+79991234567')).toBe(`"'+79991234567"`);
    expect(csvCell('-5')).toBe(`"'-5"`);
    expect(csvCell('@SUM(A1)')).toBe(`"'@SUM(A1)"`);
    expect(csvCell('\tзло')).toBe(`"'\tзло"`);
  });

  it('CSV-инъекция: HYPERLINK не выполнится', () => {
    expect(csvCell('=HYPERLINK("http://зло","клик")').startsWith(`"'=`)).toBe(true);
  });
});

describe('файл CSV', () => {
  it('строки разделяются CRLF — так ждёт Excel', () => {
    expect(toCsv([['a', 'b'], ['c', 'd']])).toBe('"a","b"\r\n"c","d"');
  });

  it('пустая таблица даёт пустую строку', () => {
    expect(toCsv([])).toBe('');
  });
});
```

- [ ] **Step 2: Запустить тест, убедиться что падает**

Run: `npx vitest run tests/web/csv.test.ts`
Expected: FAIL — модуль `src/web/csv.js` не найден.

- [ ] **Step 3: Реализовать `src/web/csv.ts`**

```ts
import type { LeadRow } from '../storage/queries/leads.js';
import { leadData } from '../storage/queries/leads.js';

/** Символы, с которых Excel и LibreOffice начинают считать ячейку формулой. */
const FORMULA_START = ['=', '+', '-', '@', '\t', '\r'];

/**
 * Ответ человека в директе он пишет сам, а выгрузку открывает клиент сервиса
 * у себя на компьютере. Без апострофа значение `=HYPERLINK("http://зло")`
 * выполнится при открытии файла и уведёт данные наружу.
 *
 * Кавычки ставятся всегда: так запятая, перенос строки и кавычка внутри
 * значения не ломают структуру файла и не требуют отдельной ветки.
 */
export function csvCell(value: string): string {
  const safe = FORMULA_START.some((c) => value.startsWith(c)) ? `'${value}` : value;
  return `"${safe.replaceAll('"', '""')}"`;
}

/** CRLF, а не LF: этого разделителя ждёт Excel по RFC 4180. */
export function toCsv(rows: string[][]): string {
  return rows.map((row) => row.map(csvCell).join(',')).join('\r\n');
}

/**
 * Колонки собранных ответов — объединение ключей всех заявок, отсортированное:
 * у разных воронок разные поля, а файл должен быть один и предсказуемый.
 */
export function leadsToCsv(rows: LeadRow[]): string {
  const parsed = rows.map((row) => ({ row, data: leadData(row) }));

  const keys = [...new Set(parsed.flatMap(({ data }) => [...data.keys()]))].sort();
  const header = ['Дата', 'Платформа', 'Контакт', ...keys];

  const body = parsed.map(({ row, data }) => [
    row.createdAt.toISOString(),
    row.platform,
    row.externalUserId,
    ...keys.map((key) => data.get(key) ?? ''),
  ]);

  return toCsv([header, ...body]);
}
```

- [ ] **Step 4: Написать падающий тест для маршрутов**

`tests/web/leads.test.ts`:

```ts
import Fastify, { type FastifyInstance } from 'fastify';
import { describe, expect, it } from 'vitest';
import { createTestDb } from '../storage/helpers.js';
import { createUser } from '../../src/storage/queries/users.js';
import { createAutomation } from '../../src/storage/queries/automations.js';
import { recordLead } from '../../src/storage/queries/leads.js';
import { createSession } from '../../src/storage/queries/sessions.js';
import { loadConfig } from '../../src/config.js';
import { ReplyThrottle } from '../../src/core/throttle.js';
import { registerLeadsRoutes } from '../../src/web/routes/leads.js';
import type { AppDb } from '../../src/storage/db.js';

const NOW = new Date('2026-09-01T12:00:00Z');
const DAY = 86_400_000;

function config() {
  return loadConfig({
    META_APP_SECRET: 's', META_VERIFY_TOKEN: 'v',
    CREDENTIALS_ENC_KEY: 'a'.repeat(64), SESSION_SECRET: 'a'.repeat(32),
  } as unknown as NodeJS.ProcessEnv);
}

function build(db: AppDb): FastifyInstance {
  const app = Fastify();
  registerLeadsRoutes(app, { db, cfg: config(), throttle: new ReplyThrottle(5) });
  return app;
}

function cookieFor(db: AppDb, userId: string) {
  return `sid=${createSession(db, userId, NOW, 7 * DAY)}`;
}

function seed() {
  const db = createTestDb();
  const a = createUser(db, { email: 'a@a.a', passwordHash: 'x' });
  const b = createUser(db, { email: 'b@b.b', passwordHash: 'x' });

  for (const [userId, name, phone] of [[a, 'Абылай', '+7 700 000 00 01'], [b, 'Борис', '+7 700 000 00 02']] as const) {
    const automationId = createAutomation(db, userId, {
      name: 'Заявка', triggerType: 'contains', triggerValue: 'запись', steps: [{ say: 'Как вас зовут?' }],
    });
    recordLead(db, userId, {
      automationId, platform: 'instagram', externalUserId: '99',
      data: new Map([['name', name], ['phone', phone]]), createdAt: NOW,
    });
  }
  return { db, a, b };
}

describe('заявки', () => {
  it('без сессии уводит на форму входа', async () => {
    const { db } = seed();
    expect((await build(db).inject({ method: 'GET', url: '/leads' })).statusCode).toBe(303);
  });

  it('S11: клиент видит свои заявки и не видит чужие', async () => {
    const { db, a } = seed();
    const res = await build(db).inject({
      method: 'GET', url: '/leads', headers: { cookie: cookieFor(db, a) },
    });

    expect(res.body).toContain('Абылай');
    expect(res.body).not.toContain('Борис');
  });

  it('ПД не оседают в кэше браузера', async () => {
    const { db, a } = seed();
    const res = await build(db).inject({
      method: 'GET', url: '/leads', headers: { cookie: cookieFor(db, a) },
    });

    expect(res.headers['cache-control']).toBe('no-store');
  });

  it('S11: выгрузка содержит только свои заявки', async () => {
    const { db, a } = seed();
    const res = await build(db).inject({
      method: 'GET', url: '/leads.csv', headers: { cookie: cookieFor(db, a) },
    });

    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('Абылай');
    expect(res.body).not.toContain('Борис');
  });

  it('выгрузка отдаётся файлом, а не открывается в браузере', async () => {
    const { db, a } = seed();
    const res = await build(db).inject({
      method: 'GET', url: '/leads.csv', headers: { cookie: cookieFor(db, a) },
    });

    expect(String(res.headers['content-type'])).toContain('text/csv');
    expect(String(res.headers['content-disposition'])).toContain('attachment');
    expect(res.headers['x-content-type-options']).toBe('nosniff');
  });

  it('CSV-инъекция: ответ с формулой обезврежен в выгрузке', async () => {
    const db = createTestDb();
    const userId = createUser(db, { email: 'x@x.x', passwordHash: 'x' });
    const automationId = createAutomation(db, userId, {
      name: 'З', triggerType: 'contains', triggerValue: 'з', steps: [{ say: 'Как вас зовут?' }],
    });
    recordLead(db, userId, {
      automationId, platform: 'instagram', externalUserId: '99',
      data: new Map([['name', '=HYPERLINK("http://зло","клик")']]), createdAt: NOW,
    });

    const res = await build(db).inject({
      method: 'GET', url: '/leads.csv', headers: { cookie: cookieFor(db, userId) },
    });

    expect(res.body).toContain(`"'=HYPERLINK`);
    expect(res.body).not.toContain('"=HYPERLINK');
  });

  it('S21: ответ со скриптом на странице выводится текстом', async () => {
    const db = createTestDb();
    const userId = createUser(db, { email: 'y@y.y', passwordHash: 'x' });
    const automationId = createAutomation(db, userId, {
      name: 'З', triggerType: 'contains', triggerValue: 'з', steps: [{ say: 'Как вас зовут?' }],
    });
    recordLead(db, userId, {
      automationId, platform: 'instagram', externalUserId: '99',
      data: new Map([['name', '<script>alert(1)</script>']]), createdAt: NOW,
    });

    const res = await build(db).inject({
      method: 'GET', url: '/leads', headers: { cookie: cookieFor(db, userId) },
    });

    expect(res.body).not.toContain('<script>alert(1)</script>');
  });
});
```

- [ ] **Step 5: Запустить тест, убедиться что падает**

Run: `npx vitest run tests/web/leads.test.ts`
Expected: FAIL — модуль `src/web/routes/leads.js` не найден.

- [ ] **Step 6: Реализовать `src/web/views/leads.ts`**

```ts
import { leadData, type LeadRow } from '../../storage/queries/leads.js';
import { html, type Html } from '../html.js';
import { layout } from './layout.js';

export function leadsPage(rows: LeadRow[]): Html {
  const parsed = rows.map((row) => ({ row, data: leadData(row) }));
  const keys = [...new Set(parsed.flatMap(({ data }) => [...data.keys()]))].sort();

  const head = html`<tr><th>Дата</th><th>Контакт</th>${keys.map((k) => html`<th>${k}</th>`)}</tr>`;
  const body = parsed.map(({ row, data }) => html`
<tr>
  <td>${row.createdAt.toISOString()}</td>
  <td>${row.externalUserId}</td>
  ${keys.map((key) => html`<td>${data.get(key) ?? ''}</td>`)}
</tr>`);

  return layout('Заявки', html`
<h1>Заявки</h1>
<p><a href="/">Мои воронки</a> · <a href="/leads.csv">Скачать CSV</a></p>
${rows.length === 0 ? html`<p>Заявок пока нет.</p>` : html`
<table><thead>${head}</thead><tbody>${body}</tbody></table>`}`);
}
```

- [ ] **Step 7: Реализовать `src/web/routes/leads.ts`**

```ts
import type { FastifyInstance } from 'fastify';
import { listLeads } from '../../storage/queries/leads.js';
import { leadsToCsv } from '../csv.js';
import { currentSession, redirectToLogin, type WebDeps } from '../session.js';
import { leadsPage } from '../views/leads.js';

export function registerLeadsRoutes(app: FastifyInstance, deps: WebDeps): void {
  app.get('/leads', (request, reply) => {
    const session = currentSession(deps, request, new Date());
    if (session === undefined) return redirectToLogin(reply);

    // S11: владелец из сессии, фильтр внутри запроса
    const rows = listLeads(deps.db, session.userId);
    return reply
      .header('cache-control', 'no-store')
      .type('text/html; charset=utf-8')
      .send(leadsPage(rows).value);
  });

  app.get('/leads.csv', (request, reply) => {
    const session = currentSession(deps, request, new Date());
    if (session === undefined) return redirectToLogin(reply);

    const rows = listLeads(deps.db, session.userId, 10_000);

    return reply
      .header('cache-control', 'no-store')
      // nosniff нужен именно здесь: без него браузер может решить, что файл —
      // это HTML, и выполнить его содержимое как страницу
      .header('x-content-type-options', 'nosniff')
      .header('content-disposition', 'attachment; filename="leads.csv"')
      .type('text/csv; charset=utf-8')
      // BOM: без него Excel открывает UTF-8 как windows-1251 и кириллица бьётся
      .send(`﻿${leadsToCsv(rows)}`);
  });
}
```

- [ ] **Step 8: Запустить тесты, убедиться что проходят**

Run: `npx vitest run tests/web/csv.test.ts tests/web/leads.test.ts`
Expected: PASS, 8 + 7 тестов.

- [ ] **Step 9: Коммит**

```bash
git add src/web/csv.ts src/web/views/leads.ts src/web/routes/leads.ts tests/web/csv.test.ts tests/web/leads.test.ts
git commit -m "feat(web): заявки клиента и выгрузка CSV с защитой от формул (S11, S21)"
```

---

## Task D8: Сборка процесса и контрольная точка

**Files:**
- Modify: `src/server.ts`, `scripts/seed.ts`, `CLAUDE.md`
- Test: `tests/web/isolation.test.ts`

**Interfaces:**
- Consumes: `registerAuthRoutes`, `registerDashboardRoutes`, `registerLeadsRoutes`,
  `registerFormParser`, `registerSecurityHeaders`

- [ ] **Step 1: Написать сквозной тест изоляции двух клиентов**

Спека требует такой тест в каждой фазе, затрагивающей данные: клиент A и клиент B
в одной базе, ни один маршрут не отдаёт чужое.

`tests/web/isolation.test.ts`:

```ts
import Fastify, { type FastifyInstance } from 'fastify';
import { describe, expect, it } from 'vitest';
import { createTestDb } from '../storage/helpers.js';
import { createUser } from '../../src/storage/queries/users.js';
import { createAutomation } from '../../src/storage/queries/automations.js';
import { recordLead } from '../../src/storage/queries/leads.js';
import { createSession } from '../../src/storage/queries/sessions.js';
import { loadConfig } from '../../src/config.js';
import { ReplyThrottle } from '../../src/core/throttle.js';
import { registerFormParser, registerSecurityHeaders } from '../../src/web/http.js';
import { registerAuthRoutes } from '../../src/web/routes/auth.js';
import { registerDashboardRoutes } from '../../src/web/routes/dashboard.js';
import { registerLeadsRoutes } from '../../src/web/routes/leads.js';
import type { AppDb } from '../../src/storage/db.js';

const NOW = new Date('2026-09-01T12:00:00Z');
const DAY = 86_400_000;

function cabinet(db: AppDb): FastifyInstance {
  const cfg = loadConfig({
    META_APP_SECRET: 's', META_VERIFY_TOKEN: 'v',
    CREDENTIALS_ENC_KEY: 'a'.repeat(64), SESSION_SECRET: 'a'.repeat(32),
  } as unknown as NodeJS.ProcessEnv);
  const app = Fastify();
  const deps = { db, cfg, throttle: new ReplyThrottle(cfg.LOGIN_MAX_ATTEMPTS, 900_000) };

  registerFormParser(app);
  registerSecurityHeaders(app, false);
  registerAuthRoutes(app, deps);
  registerDashboardRoutes(app, deps);
  registerLeadsRoutes(app, deps);
  return app;
}

function seedClient(db: AppDb, email: string, marker: string) {
  const userId = createUser(db, { email, passwordHash: 'x' });
  const automationId = createAutomation(db, userId, {
    name: `Воронка ${marker}`, triggerType: 'contains', triggerValue: 'цена',
    steps: [{ say: `Ответ ${marker}` }],
  });
  recordLead(db, userId, {
    automationId, platform: 'instagram', externalUserId: `внешний-${marker}`,
    data: new Map([['name', `Имя ${marker}`]]), createdAt: NOW,
  });
  return { userId, cookie: `sid=${createSession(db, userId, NOW, 7 * DAY)}` };
}

describe('S11: два клиента в одной базе', () => {
  it('ни один маршрут кабинета не отдаёт чужое', async () => {
    const db = createTestDb();
    const a = seedClient(db, 'a@a.a', 'A');
    seedClient(db, 'b@b.b', 'B');
    const app = cabinet(db);

    for (const url of ['/', '/leads', '/leads.csv']) {
      const res = await app.inject({ method: 'GET', url, headers: { cookie: a.cookie } });
      expect(res.statusCode, url).toBe(200);
      expect(res.body, url).not.toContain('B');
      expect(res.body, url).not.toContain('Имя B');
    }
  });

  it('S22: заголовки безопасности стоят на страницах кабинета', async () => {
    const db = createTestDb();
    const a = seedClient(db, 'a@a.a', 'A');

    const res = await cabinet(db).inject({ method: 'GET', url: '/', headers: { cookie: a.cookie } });

    expect(res.headers['x-frame-options']).toBe('DENY');
    expect(res.headers['content-security-policy']).toBeDefined();
  });
});
```

- [ ] **Step 2: Запустить тест, убедиться что падает**

Run: `npx vitest run tests/web/isolation.test.ts`
Expected: FAIL — модули маршрутов ещё не собраны вместе (или тест падает
на первом же несобранном импорте).

- [ ] **Step 3: Собрать маршруты в `src/server.ts`**

В импорты добавить:

```ts
import { registerFormParser, registerSecurityHeaders } from './web/http.js';
import { registerAuthRoutes } from './web/routes/auth.js';
import { registerDashboardRoutes } from './web/routes/dashboard.js';
import { registerLeadsRoutes } from './web/routes/leads.js';
```

После `registerWebhookRoutes(app, { db, cfg, source: instagram })` добавить:

```ts
  // Кабинет и вебхук живут в одном процессе (раздел 10 спеки). Троттлинг входа
  // свой, отдельный от троттлинга ответов боту: у них разные окна и разная цена
  // ошибки
  const web = {
    db, cfg,
    throttle: new ReplyThrottle(cfg.LOGIN_MAX_ATTEMPTS, cfg.LOGIN_WINDOW_MINUTES * 60_000),
  };
  registerFormParser(app);
  registerSecurityHeaders(app, cfg.NODE_ENV === 'production');
  registerAuthRoutes(app, web);
  registerDashboardRoutes(app, web);
  registerLeadsRoutes(app, web);
```

- [ ] **Step 4: Научить посев задавать пароль**

В `scripts/seed.ts` заменить строку с `passwordHash: 'ЗАГЛУШКА-ДО-ФАЗЫ-D'` на чтение
пароля из пятого аргумента и его хэширование:

```ts
const [email, externalAccountId, token, filePath, password] = process.argv.slice(2);
```

```ts
if (password === undefined) {
  console.error('Пятым аргументом нужен пароль: без него клиент не сможет войти');
  process.exit(1);
}

const userId = createUser(db, { email, passwordHash: await hashPassword(password) });
```

Импорт: `import { hashPassword } from '../src/web/password.js';`
Скрипт исполняется через tsx как ESM-модуль, поэтому `await` на верхнем уровне допустим.
Пароль не печатается ни при каких условиях (S9).

- [ ] **Step 5: Запустить тесты, убедиться что проходят**

Run: `npx vitest run tests/web/`
Expected: PASS.

- [ ] **Step 6: Обновить `CLAUDE.md`**

- В разделе «Архитектура» в дерево слоёв добавить содержимое `web/`:
  `auth`, `csrf`, `html`, `csv`, `routes/`, `views/`.
- В разделе «Команды» ничего не меняется.
- В «Источники истины» указать этот план как план последней закрытой фазы.
- В «Обязательные правила» добавить пункт: **разметка собирается только тегом
  `html` из `src/web/html.ts`; конкатенация строк с данными пользователя запрещена** (S21).

- [ ] **Step 7: Контрольная точка фазы**

```powershell
npm test; if ($?) { npm run typecheck }
npm audit
```

Expected: все тесты зелёные, typecheck без вывода, в `npm audit` нет уязвимостей
уровня high и critical.

- [ ] **Step 8: Коммит**

```bash
git add src/server.ts scripts/seed.ts CLAUDE.md tests/web/isolation.test.ts
git commit -m "feat(web): сборка кабинета в процессе и сквозной тест изоляции (S11, S22)"
```

---

## Что фаза сознательно не делает

- **Не заводит клиентов через интерфейс.** Регистрации нет по замыслу (раздел 2 спеки),
  а админка владельца — фаза F. Пока клиента заводит `npm run seed`.
- **Не даёт менять пароль.** `deleteUserSessions` для этого уже написан и протестирован,
  но форма смены пароля осмысленна вместе с админкой и восстановлением доступа.
- **Не создаёт и не правит воронки.** Это конструктор, фаза E. Здесь воронку можно
  только включить и выключить.
- **Не загружает файлы через браузер.** `saveFile` из фазы C уже проверяет сигнатуру,
  размер и расширение; форма загрузки появится в фазе E рядом с конструктором.
- **Не оформляет страницы.** CSP запрещает инлайновые стили, а отдельный файл стилей
  без конструктора нечего оформлять. Разметка простая и семантическая — стили лягут
  на неё в фазе E, не переписывая маршруты.
- **Не разделяет роли.** `requireOwner` не пишется, пока нет ни одного маршрута
  для роли `owner` (S12 проверяется в фазе F вместе с админкой).
