# Фаза E — конструктор воронок

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Клиент сам создаёт и правит воронку в браузере: слово-триггер, цепочка
сообщений, файл, кнопки — и загружает файлы, не трогая консоль.

**Architecture:** Конструктор — обычная HTML-форма без JavaScript. Каждое действие
(«добавить шаг», «удалить шаг», «вверх», «вниз», «сохранить») — это POST всей формы:
сервер сначала сохраняет то, что клиент уже набрал, потом применяет действие,
потом перерисовывает страницу. Ничего не теряется, скрипта на странице нет,
всё проверяется через `fastify.inject()`.

Сохранение заменяет шаги целиком, а не считает разницу по позициям. Цена — новые
`id` у шагов: диалог, застрявший на старом шаге, движок сбросит в ноль
(`engine.ts:31-33` — неизвестный `stepId` → `stepId = null`), а не уронит.

Загрузка файлов живёт на отдельной странице `/files`: multipart остаётся в одном
маршруте, форма конструктора остаётся обычной, а один файл переиспользуется
в разных воронках.

**Tech Stack:** TypeScript ESM, Fastify 5, better-sqlite3 13, drizzle-orm 0.45, Zod 4,
vitest 4, Node >= 20. Одна новая зависимость: `@fastify/multipart`.

**Spec:** `docs/superpowers/specs/2026-08-27-saas-comment-to-dm-design.md`
(разделы 2, 3, 5, 7; требования S6, S11, S14, S15, S16, S18, S21)

## Global Constraints

- `src/core/` не содержит слов `instagram`, `tiktok`, `meta`, `fastify`, `drizzle`,
  `fetch(`, `process.env`, `import(`. Исключение — union `Platform` в `core/types.ts`.
  Проверяет `tests/core/purity.test.ts`. **В этой фазе ядро не меняется вообще.**
- В `src/` запрещены `any`, `as unknown as`, `!` (non-null assertion). `tsconfig`
  строгий, включая `noUncheckedIndexedAccess`.
- `process.env` читается только в `src/config.ts`. Новая переменная — три синхронные
  правки: `EnvSchema`, `.env.example`, тест в `tests/config.test.ts`.
  **В этой фазе новых переменных нет.**
- **Владелец — первый аргумент** в `src/storage/queries/`, и он входит в условие
  выборки (`WHERE id = ? AND user_id = ?`), а не проверяется отдельным `if` после неё.
- **`user_id`, роль и любые признаки владения никогда не читаются из тела запроса**
  (S14). Владелец берётся только из сессии.
- **Разметка собирается только тегом `html`** из `src/web/html.ts`. Конкатенация строк
  с данными клиента запрещена (S21).
- ESM: относительные импорты пишутся с расширением `.js`. Проверяет `tests/esm-imports.test.ts`.
- Секреты и ПД не логируются выше уровня `debug` (S9).
- Тест пишется до реализации. Каждая задача заканчивается коммитом. Сообщения
  коммитов и комментарии — на русском.
- Контрольная точка фазы: `npm test`, затем `npm run typecheck`, затем `npm audit`.
- Оболочка — Windows PowerShell 5.1: `&&` в консоли даёт синтаксическую ошибку,
  контрольная точка пишется как `npm test; if ($?) { npm run typecheck }`.

## Карта файлов

| Файл | Ответственность |
|---|---|
| `src/storage/queries/automations.ts` *(правка)* | `updateAutomation`, `stepCounts`, пропуск пустых воронок |
| `src/storage/files.ts` *(правка)* | `deleteFile` с проверкой «файл используется шагом» |
| `src/web/forms.ts` | разбор формы конструктора в `NewStep[]` — чистая функция без Fastify |
| `src/web/views/files.ts` | страница файлов: форма загрузки и список |
| `src/web/routes/files.ts` | `GET /files`, `POST /files`, `POST /files/:id/delete` |
| `src/web/views/constructor.ts` | страница воронки: название, триггер, шаги, выбор файла |
| `src/web/routes/constructor.ts` | `GET /automations/new`, `POST /automations`, `GET/POST /automations/:id` |
| `src/web/views/style.ts` | текст `app.css` одной константой |
| `src/web/routes/style.ts` | `GET /app.css` |
| `src/web/views/layout.ts` *(правка)* | `<link rel="stylesheet">` |
| `src/web/views/dashboard.ts` *(правка)* | ссылки на конструктор, пометка «черновик» |
| `src/web/routes/dashboard.ts` *(правка)* | передаёт число шагов в представление |
| `src/server.ts` *(правка)* | регистрация новых маршрутов |

Порядок задач задан риском: первым чинится то, что иначе роняет воркер в бою.

---

## Task E1: Пустая воронка не роняет приём событий

Конструктор создаёт воронку раньше, чем у неё появляются шаги: на странице создания
иначе некуда нажимать «добавить шаг». А `buildScenario` на пустом списке бросает —
в `ScenarioSchema` стоит `steps: z.array(StepSchema).min(1)`.

`loadEnabledScenarios` вызывается в цикле приёма воркера. Исключение оттуда попадает
в `catch` в `server.ts`, который печатает «цикл приёма упал» и теряет **весь тик,
для всех клиентов сразу**. То есть одна недоделанная воронка одного клиента
останавливает бота у остальных — пока эта строка не исправлена.

**Files:**
- Modify: `src/storage/queries/automations.ts:101-122`
- Test: `tests/storage/queries/automations.test.ts`

**Interfaces:**
- Consumes: `loadEnabledScenarios(db, userId)` — сигнатура не меняется
- Produces: то же самое, но воронки без шагов пропускаются

- [x] **Step 1: Написать падающий тест**

В `tests/storage/queries/automations.test.ts` добавить:

```ts
it('включённая воронка без шагов пропускается, а не роняет загрузку', () => {
  const db = createTestDb();
  const userId = createUser(db, { email: 'a@a.a', passwordHash: 'x' });
  const withSteps = createAutomation(db, userId, {
    name: 'С шагами', triggerType: 'contains', triggerValue: 'цена',
    steps: [{ say: 'Ответ' }],
  });
  // Так выглядит только что созданная в конструкторе воронка
  createAutomation(db, userId, {
    name: 'Черновик', triggerType: 'contains', triggerValue: 'цена', steps: [],
  });

  const scenarios = loadEnabledScenarios(db, userId);

  expect(scenarios).toHaveLength(1);
  expect(scenarios[0]?.id).toBe(withSteps);
});
```

- [x] **Step 2: Запустить тест, убедиться что падает**

Run: `npx vitest run tests/storage/queries/automations.test.ts`
Expected: FAIL — и не на `toHaveLength`, а исключением из `ScenarioSchema.parse`:
`steps: Array must contain at least 1 element(s)`. Именно это исключение приходило бы
в воркер.

- [x] **Step 3: Пропустить пустые воронки**

В `src/storage/queries/automations.ts` заменить последний `return` функции
`loadEnabledScenarios`:

```ts
  return rows.flatMap((automation) => {
    const steps = byAutomation.get(automation.id) ?? [];
    // Воронка без шагов — не ошибка, а черновик из конструктора: она создаётся
    // раньше своих шагов. buildScenario на ней бросает (steps.min(1) в схеме),
    // и это исключение прилетело бы в цикл приёма воркера, то есть в бота
    // всех клиентов сразу
    if (steps.length === 0) return [];
    return [buildScenario(toDraft(automation, steps))];
  });
```

- [x] **Step 4: Запустить тесты, убедиться что проходят**

Run: `npx vitest run tests/storage/queries/automations.test.ts tests/worker.test.ts`
Expected: PASS.

- [x] **Step 5: Коммит**

```bash
git add src/storage/queries/automations.ts tests/storage/queries/automations.test.ts
git commit -m "fix(storage): воронка без шагов пропускается, а не роняет цикл приёма"
```

---

## Task E2: Правка воронки в хранилище

**Files:**
- Modify: `src/storage/queries/automations.ts`
- Test: `tests/storage/queries/automations.test.ts`

**Interfaces:**
- Consumes: `AppDb`, таблицы `automations` и `automationSteps`, тип `NewStep`
- Produces:
  - `updateAutomation(db: AppDb, userId: string, automationId: string, input: { name: string; triggerType: 'exact' | 'contains' | 'starts_with'; triggerValue: string; steps: NewStep[] }): boolean`
  - `stepCounts(db: AppDb, userId: string): Map<string, number>`

- [x] **Step 1: Написать падающий тест**

В `tests/storage/queries/automations.test.ts` добавить (импорты дополнить
`updateAutomation`, `stepCounts`, `getAutomation`):

```ts
describe('правка воронки', () => {
  function seedTwo() {
    const db = createTestDb();
    const a = createUser(db, { email: 'a@a.a', passwordHash: 'x' });
    const b = createUser(db, { email: 'b@b.b', passwordHash: 'x' });
    const automationA = createAutomation(db, a, {
      name: 'Было', triggerType: 'contains', triggerValue: 'цена',
      steps: [{ say: 'Шаг 1' }, { say: 'Шаг 2' }, { say: 'Шаг 3' }],
    });
    return { db, a, b, automationA };
  }

  it('меняет название и триггер', () => {
    const { db, a, automationA } = seedTwo();

    expect(updateAutomation(db, a, automationA, {
      name: 'Стало', triggerType: 'exact', triggerValue: 'прайс', steps: [{ say: 'Шаг' }],
    })).toBe(true);

    const found = getAutomation(db, a, automationA);
    expect(found?.automation.name).toBe('Стало');
    expect(found?.automation.triggerType).toBe('exact');
    expect(found?.automation.triggerValue).toBe('прайс');
  });

  it('заменяет шаги целиком и сохраняет их порядок', () => {
    const { db, a, automationA } = seedTwo();

    updateAutomation(db, a, automationA, {
      name: 'Было', triggerType: 'contains', triggerValue: 'цена',
      steps: [{ say: 'Новый первый' }, { say: 'Новый второй', saveReplyAs: 'name' }],
    });

    const steps = getAutomation(db, a, automationA)?.steps ?? [];
    expect(steps.map((s) => s.say)).toEqual(['Новый первый', 'Новый второй']);
    expect(steps.map((s) => s.position)).toEqual([0, 1]);
    expect(steps[1]?.saveReplyAs).toBe('name');
  });

  it('пустой список шагов допустим: это черновик', () => {
    const { db, a, automationA } = seedTwo();

    expect(updateAutomation(db, a, automationA, {
      name: 'Черновик', triggerType: 'contains', triggerValue: 'цена', steps: [],
    })).toBe(true);
    expect(getAutomation(db, a, automationA)?.steps).toHaveLength(0);
  });

  it('S11: клиент B не правит воронку клиента A', () => {
    const { db, a, b, automationA } = seedTwo();

    expect(updateAutomation(db, b, automationA, {
      name: 'Взломано', triggerType: 'exact', triggerValue: 'моё', steps: [{ say: 'Моё' }],
    })).toBe(false);

    const found = getAutomation(db, a, automationA);
    expect(found?.automation.name).toBe('Было');
    expect(found?.steps.map((s) => s.say)).toEqual(['Шаг 1', 'Шаг 2', 'Шаг 3']);
  });

  it('считает шаги каждой воронки клиента', () => {
    const { db, a, b, automationA } = seedTwo();
    const emptyOne = createAutomation(db, a, {
      name: 'Черновик', triggerType: 'contains', triggerValue: 'ц', steps: [],
    });
    createAutomation(db, b, {
      name: 'Чужая', triggerType: 'contains', triggerValue: 'ц', steps: [{ say: 'Чужой' }],
    });

    const counts = stepCounts(db, a);

    expect(counts.get(automationA)).toBe(3);
    // Воронки без шагов в результате нет вовсе: для представления это «черновик»
    expect(counts.get(emptyOne)).toBeUndefined();
    expect(counts.size).toBe(1);
  });
});
```

- [x] **Step 2: Запустить тест, убедиться что падает**

Run: `npx vitest run tests/storage/queries/automations.test.ts`
Expected: FAIL — `updateAutomation is not a function`.

- [x] **Step 3: Вынести сборку строки шага**

В `src/storage/queries/automations.ts` добавить перед `createAutomation`:

```ts
/**
 * Одно место, где `NewStep` превращается в строку таблицы. Создание и правка
 * раскладывают поля одинаково, и новое поле нельзя забыть в одном из двух мест.
 */
function stepValues(automationId: string, step: NewStep, position: number) {
  return {
    id: randomUUID(),
    automationId,
    position,
    say: step.say,
    saveReplyAs: step.saveReplyAs ?? null,
    fileId: step.fileId ?? null,
    buttonsJson: step.buttons === undefined ? null : JSON.stringify(step.buttons),
  };
}
```

И заменить тело цикла в `createAutomation` на:

```ts
  input.steps.forEach((step, position) => {
    db.insert(automationSteps).values(stepValues(id, step, position)).run();
  });
```

- [x] **Step 4: Реализовать `updateAutomation` и `stepCounts`**

Добавить после `setEnabled`:

```ts
/**
 * Полная замена: шаги удаляются и вставляются заново. Так форма конструктора,
 * где шаг добавляют, удаляют и переставляют, не превращается в вычисление
 * разницы по позициям.
 *
 * Цена — новые `id` у шагов. Диалог, застрявший на старом шаге, движок сбросит
 * в ноль (`engine.ts`: неизвестный `stepId` → `stepId = null`), а не уронит.
 *
 * S11: владелец и в проверке существования, и в условии UPDATE. Чужая воронка
 * не находится — функция возвращает false, не изменив ничего.
 */
export function updateAutomation(
  db: AppDb,
  userId: string,
  automationId: string,
  input: {
    name: string;
    triggerType: 'exact' | 'contains' | 'starts_with';
    triggerValue: string;
    steps: NewStep[];
  },
): boolean {
  const owned = db.select({ id: automations.id }).from(automations)
    .where(and(eq(automations.id, automationId), eq(automations.userId, userId)))
    .all()[0];
  if (owned === undefined) return false;

  // Транзакция: между удалением старых шагов и вставкой новых воронка пуста,
  // и в этот момент её не должен увидеть воркер
  db.transaction((tx) => {
    tx.update(automations)
      .set({
        name: input.name,
        triggerType: input.triggerType,
        triggerValue: input.triggerValue,
      })
      .where(and(eq(automations.id, automationId), eq(automations.userId, userId)))
      .run();

    tx.delete(automationSteps).where(eq(automationSteps.automationId, automationId)).run();

    input.steps.forEach((step, position) => {
      tx.insert(automationSteps).values(stepValues(automationId, step, position)).run();
    });
  });
  return true;
}

/**
 * Сколько шагов у каждой воронки клиента. Нужно кабинету, чтобы отличить готовую
 * воронку от черновика — одним запросом, а не запросом на каждую строку списка.
 */
export function stepCounts(db: AppDb, userId: string): Map<string, number> {
  const rows = db.select({
    automationId: automationSteps.automationId,
    total: count(),
  })
    .from(automationSteps)
    .innerJoin(automations, eq(automations.id, automationSteps.automationId))
    .where(eq(automations.userId, userId))
    .groupBy(automationSteps.automationId)
    .all();

  return new Map(rows.map((row) => [row.automationId, row.total]));
}
```

Импорт в шапке файла дополнить: `import { and, asc, count, eq, inArray } from 'drizzle-orm';`

- [x] **Step 5: Запустить тесты, убедиться что проходят**

Run: `npx vitest run tests/storage/`
Expected: PASS.

- [x] **Step 6: Коммит**

```bash
git add src/storage/queries/automations.ts tests/storage/queries/automations.test.ts
git commit -m "feat(storage): правка воронки с полной заменой шагов и счётчик шагов (S11)"
```

---
## Task E3: Разбор формы конструктора

Форма конструктора — единственное место, где текст клиента превращается в шаги
воронки. Разбор вынесен в чистую функцию без Fastify: правила «что считается
корректной воронкой» проверяются таблицей входов и выходов, без HTTP и без БД.

**Имена полей нумерованные, а не повторяющиеся** (`say_0`, `say_1`, …). Причина
техническая: разборщик форм из фазы D построен на
`Object.fromEntries(new URLSearchParams(...))`, а он оставляет от повторяющихся имён
только последнее значение. Массив полей с одинаковым именем молча потерял бы все шаги,
кроме последнего.

**Пустой текст шага — ошибка, а не молчаливое отбрасывание.** Отбрасывание сдвинуло бы
нумерацию, и кнопка «вниз» у третьего шага применилась бы ко второму.

**Payload кнопки генерируется, а не вводится.** Клиенту незачем придумывать внутренний
идентификатор, а два одинаковых payload сломали бы разбор нажатия.

**Files:**
- Create: `src/web/forms.ts`
- Test: `tests/web/forms.test.ts`

**Interfaces:**
- Consumes: тип `NewStep` из `src/storage/queries/automations.js`
- Produces:
  - `interface ConstructorForm { name: string; triggerType: 'exact' | 'contains' | 'starts_with'; triggerValue: string; steps: NewStep[] }`
  - `type FormResult = { ok: true; form: ConstructorForm } | { ok: false; error: string }`
  - `parseConstructorForm(body: unknown): FormResult`
  - `MAX_STEPS`, `MAX_BUTTONS` — константы, их же показывает страница

- [x] **Step 1: Написать падающий тест**

`tests/web/forms.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { parseConstructorForm } from '../../src/web/forms.js';

function form(fields: Record<string, string>) {
  return { name: 'Прайс', trigger_type: 'contains', trigger_value: 'цена', ...fields };
}

describe('разбор формы конструктора', () => {
  it('собирает шаги по порядку', () => {
    const result = parseConstructorForm(form({
      say_0: 'Первый', say_1: 'Второй', say_2: 'Третий',
    }));

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.form.steps.map((s) => s.say)).toEqual(['Первый', 'Второй', 'Третий']);
    expect(result.form.name).toBe('Прайс');
    expect(result.form.triggerType).toBe('contains');
    expect(result.form.triggerValue).toBe('цена');
  });

  it('десятый шаг не встаёт между первым и вторым: сортировка числовая', () => {
    const result = parseConstructorForm(form({
      say_0: 'A', say_1: 'B', say_2: 'C', say_3: 'D', say_4: 'E',
      say_5: 'F', say_6: 'G', say_7: 'H', say_8: 'I', say_9: 'J', say_10: 'K',
    }));

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.form.steps.map((s) => s.say).join('')).toBe('ABCDEFGHIJK');
  });

  it('дыра в нумерации не ломает порядок', () => {
    const result = parseConstructorForm(form({ say_0: 'Первый', say_7: 'Второй' }));

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.form.steps.map((s) => s.say)).toEqual(['Первый', 'Второй']);
  });

  it('пустой текст шага — ошибка, а не пропуск: иначе сдвинется нумерация', () => {
    const result = parseConstructorForm(form({ say_0: 'Первый', say_1: '   ' }));

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain('Текст шага');
  });

  it('без названия форма отвергается', () => {
    const result = parseConstructorForm({ trigger_type: 'contains', trigger_value: 'цена' });
    expect(result.ok).toBe(false);
  });

  it('неизвестный тип триггера отвергается: regex в триггерах запрещён (S7)', () => {
    const result = parseConstructorForm({
      name: 'Прайс', trigger_type: 'regex', trigger_value: '.*', say_0: 'Ответ',
    });
    expect(result.ok).toBe(false);
  });

  it('имя переменной проверяется здесь, а не падением воркера позже', () => {
    const bad = parseConstructorForm(form({ say_0: 'Как вас зовут?', reply_0: '2имя' }));
    expect(bad.ok).toBe(false);

    const good = parseConstructorForm(form({ say_0: 'Как вас зовут?', reply_0: 'name' }));
    expect(good.ok).toBe(true);
    if (!good.ok) return;
    expect(good.form.steps[0]?.saveReplyAs).toBe('name');
  });

  it('пустое поле переменной и файла означает «нет», а не пустую строку', () => {
    const result = parseConstructorForm(form({ say_0: 'Ответ', reply_0: '', file_0: '' }));

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.form.steps[0]?.saveReplyAs).toBeUndefined();
    expect(result.form.steps[0]?.fileId).toBeUndefined();
  });

  it('кнопки берутся построчно, payload у каждой свой', () => {
    const result = parseConstructorForm(form({
      say_0: 'Выберите', buttons_0: 'Да\n Нет \n\n',
    }));

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const buttons = result.form.steps[0]?.buttons ?? [];
    expect(buttons.map((b) => b.label)).toEqual(['Да', 'Нет']);
    expect(new Set(buttons.map((b) => b.payload)).size).toBe(2);
  });

  it('кнопок больше трёх — ошибка', () => {
    const result = parseConstructorForm(form({
      say_0: 'Выберите', buttons_0: 'Раз\nДва\nТри\nЧетыре',
    }));
    expect(result.ok).toBe(false);
  });

  it('слишком длинный текст шага отвергается', () => {
    const result = parseConstructorForm(form({ say_0: 'я'.repeat(1001) }));
    expect(result.ok).toBe(false);
  });

  it('шагов больше двадцати — ошибка', () => {
    const fields: Record<string, string> = {};
    for (let i = 0; i < 21; i += 1) fields[`say_${i}`] = 'Шаг';
    expect(parseConstructorForm(form(fields)).ok).toBe(false);
  });

  it('S6: поле __proto__ в форме не загрязняет прототип', () => {
    parseConstructorForm(form({ say_0: 'Ответ', __proto__: 'сломано' }));
    expect(Object.prototype).not.toHaveProperty('0');
    expect({}).not.toHaveProperty('сломано');
  });

  it('не объект вместо тела не роняет разбор', () => {
    expect(parseConstructorForm(undefined).ok).toBe(false);
    expect(parseConstructorForm('строка').ok).toBe(false);
    expect(parseConstructorForm(null).ok).toBe(false);
  });
});
```

- [x] **Step 2: Запустить тест, убедиться что падает**

Run: `npx vitest run tests/web/forms.test.ts`
Expected: FAIL — модуль `src/web/forms.js` не найден.

- [x] **Step 3: Реализовать `src/web/forms.ts`**

```ts
import { z } from 'zod';
import type { NewStep } from '../storage/queries/automations.js';

export const MAX_STEPS = 20;
export const MAX_BUTTONS = 3;
const MAX_NAME = 100;
const MAX_TRIGGER = 100;
const MAX_SAY = 1000;
const MAX_LABEL = 20;

/** Та же форма имени, что у `VariableName` в `core/scenario.ts`. */
const VARIABLE = /^[a-z][a-z0-9_]*$/i;

/**
 * Типы триггеров перечислены, а не приняты строкой: regex в триггерах запрещён
 * (ReDoS, S7), и запрет держится схемой, а не памятью того, кто пишет форму.
 */
const Head = z.object({
  name: z.string().trim().min(1).max(MAX_NAME),
  trigger_type: z.enum(['exact', 'contains', 'starts_with']),
  trigger_value: z.string().trim().min(1).max(MAX_TRIGGER),
});

export interface ConstructorForm {
  name: string;
  triggerType: 'exact' | 'contains' | 'starts_with';
  triggerValue: string;
  steps: NewStep[];
}

export type FormResult =
  | { ok: true; form: ConstructorForm }
  | { ok: false; error: string };

function text(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

/**
 * Клиент вводит только подпись кнопки, по одной на строку. Payload генерируется:
 * это внутренний идентификатор для платформы, придумывать его клиенту незачем,
 * а два одинаковых payload сломали бы разбор нажатия.
 *
 * Подпись обрезается: длинная не помещается в кнопку Instagram. Значение
 * ограничения — наше, платформенное уточняется при первой живой отправке.
 */
function parseButtons(raw: string, stepIndex: number): { label: string; payload: string }[] {
  return raw
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((label, i) => ({
      label: label.slice(0, MAX_LABEL),
      payload: `step_${stepIndex}_btn_${i}`,
    }));
}

/**
 * Индексы шагов приходят в именах полей: `say_0`, `say_1`. Повторяющиеся имена
 * не годятся — разборщик форм (`Object.fromEntries` над `URLSearchParams`)
 * оставляет от них только последнее значение, и все шаги, кроме последнего,
 * молча пропали бы.
 */
export function parseConstructorForm(body: unknown): FormResult {
  if (typeof body !== 'object' || body === null) {
    return { ok: false, error: 'Форма не разобрана' };
  }
  const fields: Record<string, unknown> = { ...body };

  const head = Head.safeParse(fields);
  if (!head.success) {
    return { ok: false, error: 'Заполните название и слово-триггер' };
  }

  const indexes = Object.keys(fields)
    .map((key) => /^say_(\d+)$/.exec(key))
    .filter((match): match is RegExpExecArray => match !== null)
    .map((match) => Number(match[1]))
    // Числовая сортировка, а не алфавитная: иначе шаг 10 встанет между 1 и 2
    .sort((a, b) => a - b);

  if (indexes.length > MAX_STEPS) {
    return { ok: false, error: `Шагов в одной воронке не больше ${MAX_STEPS}` };
  }

  const steps: NewStep[] = [];
  for (const index of indexes) {
    const say = text(fields[`say_${index}`]).trim();
    // Пустой шаг не отбрасывается: отбрасывание сдвинуло бы нумерацию,
    // и «вниз» у третьего шага применилось бы ко второму
    if (say.length === 0) {
      return { ok: false, error: 'Текст шага не может быть пустым' };
    }
    if (say.length > MAX_SAY) {
      return { ok: false, error: `Текст шага длиннее ${MAX_SAY} символов` };
    }

    const reply = text(fields[`reply_${index}`]).trim();
    if (reply.length > 0 && !VARIABLE.test(reply)) {
      return {
        ok: false,
        error: 'Имя переменной: латинская буква, дальше буквы, цифры и подчёркивание',
      };
    }

    const buttons = parseButtons(text(fields[`buttons_${index}`]), index);
    if (buttons.length > MAX_BUTTONS) {
      return { ok: false, error: `Кнопок в шаге не больше ${MAX_BUTTONS}` };
    }

    const fileId = text(fields[`file_${index}`]).trim();

    steps.push({
      say,
      ...(reply.length === 0 ? {} : { saveReplyAs: reply }),
      ...(fileId.length === 0 ? {} : { fileId }),
      ...(buttons.length === 0 ? {} : { buttons }),
    });
  }

  return {
    ok: true,
    form: {
      name: head.data.name,
      triggerType: head.data.trigger_type,
      triggerValue: head.data.trigger_value,
      steps,
    },
  };
}
```

- [x] **Step 4: Запустить тест, убедиться что проходит**

Run: `npx vitest run tests/web/forms.test.ts`
Expected: PASS, 14 тестов.

- [x] **Step 5: Коммит**

```bash
git add src/web/forms.ts tests/web/forms.test.ts
git commit -m "feat(web): разбор формы конструктора в шаги воронки (S6, S7)"
```

---

## Task E4: Страница файлов и загрузка

`saveFile` из фазы C уже проверяет расширение, заявленный MIME, первые байты и размер,
и уже не пускает присланное имя в путь на диске. Эта задача только доводит до неё
байты из браузера и показывает список.

**CSRF в multipart-форме.** Поле `csrf` в разметке стоит **до** поля файла: busboy
отдаёт части в том порядке, в каком они пришли, и к моменту появления файла токен
уже разобран. Обратный порядок оставил бы проверку без токена. Тест на это есть.

**Files:**
- Create: `src/web/views/files.ts`, `src/web/routes/files.ts`
- Modify: `package.json`
- Test: `tests/web/files.test.ts`

**Interfaces:**
- Consumes: `saveFile`, `listFiles`, `FileRow` из `src/storage/files.js`; `currentSession`,
  `redirectToLogin`, `WebDeps` из `src/web/session.js`; `csrfToken`, `csrfValid` из `src/web/csrf.js`
- Produces:
  - `filesPage(rows: FileRow[], csrf: string, error: string | undefined): Html`
  - `registerFilesRoutes(app: FastifyInstance, deps: WebDeps): void`

- [x] **Step 1: Поставить зависимость**

```bash
npm install @fastify/multipart
```

Плагин обёрнут в `fastify-plugin`, поэтому разбор multipart появляется на том же
экземпляре Fastify, куда его зарегистрировали, а не в дочернем контексте. Без этого
маршруты, объявленные рядом, не увидели бы разборщик.

- [x] **Step 2: Написать падающий тест**

`tests/web/files.test.ts`:

```ts
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Fastify, { type FastifyInstance } from 'fastify';
import { describe, expect, it } from 'vitest';
import { createTestDb } from '../storage/helpers.js';
import { createUser } from '../../src/storage/queries/users.js';
import { createSession } from '../../src/storage/queries/sessions.js';
import { listFiles, saveFile } from '../../src/storage/files.js';
import { loadConfig } from '../../src/config.js';
import { ReplyThrottle } from '../../src/core/throttle.js';
import { csrfToken } from '../../src/web/csrf.js';
import { registerFormParser } from '../../src/web/http.js';
import { registerFilesRoutes } from '../../src/web/routes/files.js';
import type { AppDb } from '../../src/storage/db.js';

const SECRET = 'a'.repeat(32);
const NOW = new Date('2026-09-02T12:00:00Z');
const DAY = 86_400_000;
const PDF = Buffer.concat([Buffer.from([0x25, 0x50, 0x44, 0x46]), Buffer.from('-1.4 тест')]);
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00]);

function config(filesDir: string) {
  return loadConfig({
    META_APP_SECRET: 's', META_VERIFY_TOKEN: 'v',
    CREDENTIALS_ENC_KEY: 'a'.repeat(64), SESSION_SECRET: SECRET, FILES_DIR: filesDir,
  } as unknown as NodeJS.ProcessEnv);
}

function build(db: AppDb): { app: FastifyInstance; dir: string } {
  const dir = mkdtempSync(join(tmpdir(), 'files-test-'));
  const app = Fastify();
  registerFormParser(app);
  registerFilesRoutes(app, { db, cfg: config(dir), throttle: new ReplyThrottle(5) });
  return { app, dir };
}

function login(db: AppDb, userId: string) {
  const token = createSession(db, userId, NOW, 7 * DAY);
  return { cookie: `sid=${token}`, csrf: csrfToken(token, SECRET) };
}

/**
 * Готовый запрос на загрузку. Тело multipart собирается вручную: инъекция
 * принимает только готовые байты, а порядок частей здесь важен — токен должен
 * идти до файла.
 *
 * Boundary только из ASCII: RFC 2046 ограничивает его набор символов,
 * на кириллице в нём разбора не происходит вовсе.
 *
 * Cookie кладётся в тот же объект заголовков, а не рядом в вызове inject:
 * спред заголовков затирает соседний ключ `headers` целиком, и сессия
 * тогда не доезжает до маршрута.
 */
function upload(
  cookie: string,
  fields: Record<string, string>,
  file?: { name: string; type: string; bytes: Buffer },
) {
  const boundary = '----granica';
  const parts: Buffer[] = [];
  for (const [key, value] of Object.entries(fields)) {
    parts.push(Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="${key}"\r\n\r\n${value}\r\n`,
    ));
  }
  if (file !== undefined) {
    parts.push(Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${file.name}"\r\n`
      + `Content-Type: ${file.type}\r\n\r\n`,
    ));
    parts.push(file.bytes);
    parts.push(Buffer.from('\r\n'));
  }
  parts.push(Buffer.from(`--${boundary}--\r\n`));

  return {
    method: 'POST' as const,
    url: '/files',
    headers: { cookie, 'content-type': `multipart/form-data; boundary=${boundary}` },
    payload: Buffer.concat(parts),
  };
}

describe('файлы клиента', () => {
  it('без сессии уводит на форму входа', async () => {
    const { app } = build(createTestDb());
    expect((await app.inject({ method: 'GET', url: '/files' })).statusCode).toBe(303);
  });

  it('загруженный PDF появляется в списке', async () => {
    const db = createTestDb();
    const userId = createUser(db, { email: 'a@a.a', passwordHash: 'x' });
    const { app } = build(db);
    const { cookie, csrf } = login(db, userId);

    const res = await app.inject(
      upload(cookie, { csrf }, { name: 'прайс.pdf', type: 'application/pdf', bytes: PDF }),
    );

    expect(res.statusCode).toBe(303);
    expect(listFiles(db, userId).map((f) => f.originalName)).toEqual(['прайс.pdf']);
  });

  it('S15: без CSRF-токена файл не сохраняется', async () => {
    const db = createTestDb();
    const userId = createUser(db, { email: 'a@a.a', passwordHash: 'x' });
    const { app } = build(db);
    const { cookie } = login(db, userId);

    const res = await app.inject(
      upload(cookie, {}, { name: 'прайс.pdf', type: 'application/pdf', bytes: PDF }),
    );

    expect(res.statusCode).toBe(403);
    expect(listFiles(db, userId)).toHaveLength(0);
  });

  it('содержимое не того типа отвергается, а не сохраняется', async () => {
    const db = createTestDb();
    const userId = createUser(db, { email: 'a@a.a', passwordHash: 'x' });
    const { app } = build(db);
    const { cookie, csrf } = login(db, userId);

    // Имя и заявленный тип говорят «PDF», байты — PNG
    const res = await app.inject(
      upload(cookie, { csrf }, { name: 'обман.pdf', type: 'application/pdf', bytes: PNG }),
    );

    expect(res.statusCode).toBe(400);
    expect(listFiles(db, userId)).toHaveLength(0);
  });

  it('S9: отказ не пересказывает клиенту внутреннее сообщение', async () => {
    const db = createTestDb();
    const userId = createUser(db, { email: 'a@a.a', passwordHash: 'x' });
    const { app } = build(db);
    const { cookie, csrf } = login(db, userId);

    const res = await app.inject(
      upload(cookie, { csrf }, { name: 'скрипт.exe', type: 'application/pdf', bytes: PDF }),
    );

    expect(res.body).not.toContain('белого списка');
    expect(res.body).toContain('PDF');
  });

  it('S11: клиент видит только свои файлы', async () => {
    const db = createTestDb();
    const a = createUser(db, { email: 'a@a.a', passwordHash: 'x' });
    const b = createUser(db, { email: 'b@b.b', passwordHash: 'x' });
    const { app, dir } = build(db);
    saveFile(db, a, { originalName: 'моё.pdf', mimeType: 'application/pdf', bytes: PDF }, dir);
    saveFile(db, b, { originalName: 'чужое.pdf', mimeType: 'application/pdf', bytes: PDF }, dir);

    const res = await app.inject({
      method: 'GET', url: '/files', headers: { cookie: login(db, a).cookie },
    });

    expect(res.body).toContain('моё.pdf');
    expect(res.body).not.toContain('чужое.pdf');
  });

  it('S21: имя файла со скриптом выводится текстом', async () => {
    const db = createTestDb();
    const userId = createUser(db, { email: 'a@a.a', passwordHash: 'x' });
    const { app, dir } = build(db);
    saveFile(db, userId, {
      originalName: '<script>alert(1)</script>.pdf', mimeType: 'application/pdf', bytes: PDF,
    }, dir);

    const res = await app.inject({
      method: 'GET', url: '/files', headers: { cookie: login(db, userId).cookie },
    });

    expect(res.body).not.toContain('<script>alert(1)</script>');
    expect(res.body).toContain('&lt;script&gt;');
  });
});

```

- [x] **Step 3: Запустить тест, убедиться что падает**

Run: `npx vitest run tests/web/files.test.ts`
Expected: FAIL — модуль `src/web/routes/files.js` не найден.

- [x] **Step 4: Реализовать `src/web/views/files.ts`**

```ts
import type { FileRow } from '../../storage/files.js';
import { html, type Html } from '../html.js';
import { layout } from './layout.js';

/**
 * Список разрешённого показан прямо в форме: клиент должен видеть правила
 * до отказа, а не после. Сами правила живут в `storage/files.ts` — здесь
 * только их человеческая формулировка.
 */
export function filesPage(rows: FileRow[], csrf: string, error: string | undefined): Html {
  const items = rows.map((row) => html`
<tr>
  <td>${row.originalName}</td>
  <td>${Math.ceil(row.sizeBytes / 1024)} КБ</td>
  <td>
    <form method="post" action="/files/${row.id}/delete">
      <input type="hidden" name="csrf" value="${csrf}">
      <button type="submit">Удалить</button>
    </form>
  </td>
</tr>`);

  return layout('Файлы', html`
<h1>Файлы</h1>
<p><a href="/">Мои воронки</a></p>
${error === undefined ? '' : html`<p role="alert">${error}</p>`}

<form method="post" action="/files" enctype="multipart/form-data">
  <input type="hidden" name="csrf" value="${csrf}">
  <label>Файл <input type="file" name="file" accept=".pdf,.png,.jpg,.jpeg" required></label>
  <button type="submit">Загрузить</button>
</form>
<p>Разрешены PDF до 25 МБ, PNG и JPEG до 8 МБ.</p>

${rows.length === 0 ? html`<p>Файлов пока нет.</p>` : html`
<table>
  <thead><tr><th>Имя</th><th>Размер</th><th></th></tr></thead>
  <tbody>${items}</tbody>
</table>`}`);
}
```

- [x] **Step 5: Реализовать `src/web/routes/files.ts`**

```ts
import multipart, { type MultipartFields } from '@fastify/multipart';
import type { FastifyInstance } from 'fastify';
import { listFiles, saveFile } from '../../storage/files.js';
import { csrfToken, csrfValid } from '../csrf.js';
import { currentSession, redirectToLogin, type WebDeps } from '../session.js';
import { filesPage } from '../views/files.js';

const MB = 1024 * 1024;

/**
 * Значение поля формы из multipart. Написано отдельной функцией, потому что
 * в `fields` лежит объединение типов: поле, файл или массив — и разбирать его
 * приведением типа запрещено правилами проекта.
 */
function fieldValue(fields: MultipartFields, name: string): string | undefined {
  const found = fields[name];
  if (found === undefined || Array.isArray(found)) return undefined;
  if (found.type !== 'field') return undefined;
  return typeof found.value === 'string' ? found.value : undefined;
}

export function registerFilesRoutes(app: FastifyInstance, deps: WebDeps): void {
  // Плагин обёрнут в fastify-plugin: разбор multipart появляется на этом же
  // экземпляре, а не в дочернем контексте, и маршруты ниже его видят.
  // Лимит на уровне плагина — первый рубеж: файл выше него не дочитывается
  // в память вообще, до всякой проверки содержимого
  void app.register(multipart, { limits: { fileSize: 25 * MB, files: 1, fields: 6 } });

  app.get('/files', (request, reply) => {
    const session = currentSession(deps, request, new Date());
    if (session === undefined) return redirectToLogin(reply);

    return reply
      .header('cache-control', 'no-store')
      .type('text/html; charset=utf-8')
      .send(filesPage(
        listFiles(deps.db, session.userId),
        csrfToken(session.token, deps.cfg.SESSION_SECRET),
        undefined,
      ).value);
  });

  app.post('/files', async (request, reply) => {
    const session = currentSession(deps, request, new Date());
    if (session === undefined) return redirectToLogin(reply);

    const uploaded = await request.file();
    if (uploaded === undefined) return reply.code(400).send();

    // Поле csrf в разметке стоит до поля файла: busboy отдаёт части по порядку,
    // и к моменту появления файла токен уже разобран
    if (!csrfValid(session.token, fieldValue(uploaded.fields, 'csrf'), deps.cfg.SESSION_SECRET)) {
      return reply.code(403).send();
    }

    try {
      saveFile(deps.db, session.userId, {
        originalName: uploaded.filename,
        mimeType: uploaded.mimetype,
        bytes: await uploaded.toBuffer(),
      }, deps.cfg.FILES_DIR);
    } catch {
      // Сообщения saveFile написаны для лога, не для клиента: они называют
      // сработавшую проверку. Клиенту хватает списка разрешённого (S9)
      return reply.code(400).header('cache-control', 'no-store')
        .type('text/html; charset=utf-8')
        .send(filesPage(
          listFiles(deps.db, session.userId),
          csrfToken(session.token, deps.cfg.SESSION_SECRET),
          'Файл не принят. Разрешены PDF до 25 МБ, PNG и JPEG до 8 МБ',
        ).value);
    }

    return reply.code(303).header('location', '/files').send();
  });
}
```

- [x] **Step 6: Запустить тест, убедиться что проходит**

Run: `npx vitest run tests/web/files.test.ts`
Expected: PASS, 7 тестов.

- [x] **Step 7: Коммит**

```bash
git add src/web/views/files.ts src/web/routes/files.ts tests/web/files.test.ts package.json package-lock.json
git commit -m "feat(web): страница файлов и загрузка через multipart (S11, S15, S21)"
```

---
## Task E5: Удаление файла

Удалять можно только файл, на который не ссылается ни один шаг. Внешний ключ
`automation_steps.file_id` объявлен с `onDelete: 'set null'` — без проверки удаление
тихо отцепило бы файл от шага, и воронка продолжила бы работать, отправляя один текст
вместо обещанного чеклиста. Такую поломку клиент заметит не сразу и не поймёт причину.

**Files:**
- Modify: `src/storage/files.ts`, `src/web/routes/files.ts`, `src/web/views/files.ts`
- Test: `tests/storage/files.test.ts`, `tests/web/files.test.ts`

**Interfaces:**
- Consumes: `getFile`, таблицы `files` и `automationSteps`
- Produces: `deleteFile(db: AppDb, userId: string, fileId: string, dir: string): 'deleted' | 'in_use' | 'not_found'`

- [x] **Step 1: Написать падающий тест хранилища**

В `tests/storage/files.test.ts` уже есть `beforeEach`, поднимающий временный каталог
`dir`, базу `db` и двух клиентов `a` и `b`, и константа `PDF` с корректным PDF.
Новый блок пользуется ими, а не заводит свои. Импорты файла дополнить: `existsSync`
из `node:fs`, `deleteFile` из `../../src/storage/files.js`, `createAutomation`
из `../../src/storage/queries/automations.js`.

```ts
describe('удаление файла', () => {
  const ПРАЙС = { originalName: 'прайс.pdf', mimeType: 'application/pdf', bytes: PDF };

  it('удаляет строку и байты с диска', () => {
    const fileId = saveFile(db, a, ПРАЙС, dir);
    const row = getFile(db, a, fileId);
    if (row === undefined) throw new Error('файл не сохранён');

    expect(deleteFile(db, a, fileId, dir)).toBe('deleted');

    expect(getFile(db, a, fileId)).toBeUndefined();
    expect(existsSync(join(dir, a, row.storedName))).toBe(false);
  });

  it('файл, на который ссылается шаг, не удаляется', () => {
    const fileId = saveFile(db, a, ПРАЙС, dir);
    createAutomation(db, a, {
      name: 'Прайс', triggerType: 'contains', triggerValue: 'цена',
      steps: [{ say: 'Держите', fileId }],
    });

    expect(deleteFile(db, a, fileId, dir)).toBe('in_use');
    expect(getFile(db, a, fileId)).toBeDefined();
  });

  it('S11: чужой файл неотличим от несуществующего и остаётся цел', () => {
    const fileId = saveFile(db, a, ПРАЙС, dir);

    expect(deleteFile(db, b, fileId, dir)).toBe('not_found');
    expect(deleteFile(db, b, 'нет-такого', dir)).toBe('not_found');
    expect(getFile(db, a, fileId)).toBeDefined();
  });
});
```

- [x] **Step 2: Запустить тест, убедиться что падает**

Run: `npx vitest run tests/storage/files.test.ts`
Expected: FAIL — `deleteFile is not a function`.

- [x] **Step 3: Реализовать `deleteFile`**

В `src/storage/files.ts` добавить в конец (импорты дополнить: `rmSync` из `node:fs`,
`automationSteps` из `./schema.js`):

```ts
export type DeleteFileResult = 'deleted' | 'in_use' | 'not_found';

/**
 * S11: чужой файл возвращает `not_found`, а не отдельный отказ — по ответу нельзя
 * узнать, существует ли такой файл у кого-то другого.
 *
 * Проверка ссылок обязательна: внешний ключ объявлен с `set null`, поэтому без неё
 * удаление тихо отцепило бы файл от шага, и воронка продолжила бы работать,
 * отправляя текст без обещанного файла.
 */
export function deleteFile(
  db: AppDb, userId: string, fileId: string, dir: string,
): DeleteFileResult {
  const row = getFile(db, userId, fileId);
  if (row === undefined) return 'not_found';

  const used = db.select({ id: automationSteps.id }).from(automationSteps)
    .where(eq(automationSteps.fileId, fileId))
    .all()[0];
  if (used !== undefined) return 'in_use';

  // Сначала строка, потом байты. Падение между ними оставит мусор на диске —
  // это лучше, чем строка, ведущая в пустоту: на ней споткнётся отправка
  db.delete(files).where(and(eq(files.id, fileId), eq(files.userId, userId))).run();
  rmSync(join(dir, userId, row.storedName), { force: true });
  return 'deleted';
}
```

- [x] **Step 4: Написать падающий тест маршрута**

В `tests/web/files.test.ts` добавить:

```ts
it('кнопка удаления убирает файл из списка', async () => {
  const db = createTestDb();
  const userId = createUser(db, { email: 'a@a.a', passwordHash: 'x' });
  const { app, dir } = build(db);
  const fileId = saveFile(db, userId, {
    originalName: 'прайс.pdf', mimeType: 'application/pdf', bytes: PDF,
  }, dir);
  const { cookie, csrf } = login(db, userId);

  const res = await app.inject({
    method: 'POST', url: `/files/${fileId}/delete`,
    headers: { cookie, 'content-type': 'application/x-www-form-urlencoded' },
    payload: new URLSearchParams({ csrf }).toString(),
  });

  expect(res.statusCode).toBe(303);
  expect(listFiles(db, userId)).toHaveLength(0);
});

it('S15: удаление без CSRF-токена отвечает 403 и файл цел', async () => {
  const db = createTestDb();
  const userId = createUser(db, { email: 'a@a.a', passwordHash: 'x' });
  const { app, dir } = build(db);
  const fileId = saveFile(db, userId, {
    originalName: 'прайс.pdf', mimeType: 'application/pdf', bytes: PDF,
  }, dir);
  const { cookie } = login(db, userId);

  const res = await app.inject({
    method: 'POST', url: `/files/${fileId}/delete`,
    headers: { cookie, 'content-type': 'application/x-www-form-urlencoded' },
    payload: new URLSearchParams({}).toString(),
  });

  expect(res.statusCode).toBe(403);
  expect(listFiles(db, userId)).toHaveLength(1);
});

it('S11: клиент B не удаляет файл клиента A', async () => {
  const db = createTestDb();
  const a = createUser(db, { email: 'a@a.a', passwordHash: 'x' });
  const b = createUser(db, { email: 'b@b.b', passwordHash: 'x' });
  const { app, dir } = build(db);
  const fileId = saveFile(db, a, {
    originalName: 'моё.pdf', mimeType: 'application/pdf', bytes: PDF,
  }, dir);
  const { cookie, csrf } = login(db, b);

  await app.inject({
    method: 'POST', url: `/files/${fileId}/delete`,
    headers: { cookie, 'content-type': 'application/x-www-form-urlencoded' },
    payload: new URLSearchParams({ csrf }).toString(),
  });

  expect(listFiles(db, a)).toHaveLength(1);
});

it('файл, использованный в воронке, не удаляется и клиент видит почему', async () => {
  const db = createTestDb();
  const userId = createUser(db, { email: 'a@a.a', passwordHash: 'x' });
  const { app, dir } = build(db);
  const fileId = saveFile(db, userId, {
    originalName: 'прайс.pdf', mimeType: 'application/pdf', bytes: PDF,
  }, dir);
  createAutomation(db, userId, {
    name: 'Прайс', triggerType: 'contains', triggerValue: 'цена',
    steps: [{ say: 'Держите', fileId }],
  });
  const { cookie, csrf } = login(db, userId);

  const res = await app.inject({
    method: 'POST', url: `/files/${fileId}/delete`,
    headers: { cookie, 'content-type': 'application/x-www-form-urlencoded' },
    payload: new URLSearchParams({ csrf }).toString(),
  });

  expect(res.statusCode).toBe(409);
  expect(res.body).toContain('используется');
  expect(listFiles(db, userId)).toHaveLength(1);
});
```

Импорты теста дополнить: `createAutomation` из `../../src/storage/queries/automations.js`.
Форма удаления — обычная, не multipart: разбор форм в этом наборе тестов нужно
подключить, поэтому в `build` добавить `registerFormParser(app);` перед
`registerFilesRoutes` (импорт из `../../src/web/http.js`).

- [x] **Step 5: Реализовать маршрут удаления**

В `src/web/routes/files.ts` добавить (импорт `deleteFile` и `z` из `zod`):

```ts
const DeleteForm = z.object({ csrf: z.string().optional() });
const Params = z.object({ id: z.string().min(1) });

  app.post('/files/:id/delete', (request, reply) => {
    const session = currentSession(deps, request, new Date());
    if (session === undefined) return redirectToLogin(reply);

    const form = DeleteForm.safeParse(request.body);
    const params = Params.safeParse(request.params);
    if (!form.success || !params.success) return reply.code(400).send();

    if (!csrfValid(session.token, form.data.csrf, deps.cfg.SESSION_SECRET)) {
      return reply.code(403).send();
    }

    const result = deleteFile(deps.db, session.userId, params.data.id, deps.cfg.FILES_DIR);
    if (result === 'in_use') {
      return reply.code(409).header('cache-control', 'no-store')
        .type('text/html; charset=utf-8')
        .send(filesPage(
          listFiles(deps.db, session.userId),
          csrfToken(session.token, deps.cfg.SESSION_SECRET),
          'Файл используется в воронке. Сначала уберите его из шага',
        ).value);
    }

    // `not_found` отвечает тем же редиректом, что и успех: разный ответ выдал бы,
    // что такой файл существует у другого клиента (S11)
    return reply.code(303).header('location', '/files').send();
  });
```

- [x] **Step 6: Запустить тесты, убедиться что проходят**

Run: `npx vitest run tests/storage/files.test.ts tests/web/files.test.ts`
Expected: PASS.

- [x] **Step 7: Коммит**

```bash
git add src/storage/files.ts src/web/routes/files.ts tests/storage/files.test.ts tests/web/files.test.ts
git commit -m "feat(web): удаление файла с проверкой использования в воронке (S11)"
```

---

## Task E6: Конструктор воронки

Главная задача фазы. Страница правки — одна форма; кнопки «добавить», «удалить»,
«вверх», «вниз» и «сохранить» отправляют её целиком, различаясь только полем `action`.
Сервер сначала сохраняет набранное, потом применяет действие. Поэтому нажатие
«добавить шаг» не теряет текст, который клиент только что напечатал.

Создание разделено с правкой: `POST /automations` заводит воронку **без шагов
и выключенной**, дальше клиент работает на её странице. Иначе на странице создания
кнопке «добавить шаг» некуда отправлять форму — воронки ещё нет.

**Выключенной** — потому что включённый черновик молча ничего не отвечал бы: ровно
это и делает пропуск из задачи E1. Пусть клиент включает воронку сам, когда шаги готовы.

**Files:**
- Create: `src/web/views/constructor.ts`, `src/web/routes/constructor.ts`
- Modify: `src/web/views/dashboard.ts`, `src/web/routes/dashboard.ts`
- Test: `tests/web/constructor.test.ts`, `tests/web/dashboard.test.ts`

**Interfaces:**
- Consumes: `parseConstructorForm`, `MAX_BUTTONS` из `src/web/forms.js`; `createAutomation`,
  `getAutomation`, `updateAutomation`, `setEnabled`, `AutomationRow`, `StepRow` из
  `src/storage/queries/automations.js`; `listFiles`, `getFile`, `FileRow` из
  `src/storage/files.js`; `currentSession`, `redirectToLogin`, `WebDeps`
- Produces:
  - `newAutomationPage(csrf: string, error: string | undefined): Html`
  - `constructorPage(automation: AutomationRow, steps: StepRow[], files: FileRow[], csrf: string, error: string | undefined): Html`
  - `notFoundPage(): Html`
  - `registerConstructorRoutes(app: FastifyInstance, deps: WebDeps): void`

- [x] **Step 1: Написать падающий тест**

`tests/web/constructor.test.ts`:

```ts
import Fastify, { type FastifyInstance } from 'fastify';
import { describe, expect, it } from 'vitest';
import { createTestDb } from '../storage/helpers.js';
import { createUser } from '../../src/storage/queries/users.js';
import {
  createAutomation, getAutomation, listAutomations,
} from '../../src/storage/queries/automations.js';
import { createSession } from '../../src/storage/queries/sessions.js';
import { saveFile } from '../../src/storage/files.js';
import { loadConfig } from '../../src/config.js';
import { ReplyThrottle } from '../../src/core/throttle.js';
import { csrfToken } from '../../src/web/csrf.js';
import { registerFormParser } from '../../src/web/http.js';
import { registerConstructorRoutes } from '../../src/web/routes/constructor.js';
import type { AppDb } from '../../src/storage/db.js';

const SECRET = 'a'.repeat(32);
const NOW = new Date('2026-09-02T12:00:00Z');
const DAY = 86_400_000;

function config() {
  return loadConfig({
    META_APP_SECRET: 's', META_VERIFY_TOKEN: 'v',
    CREDENTIALS_ENC_KEY: 'a'.repeat(64), SESSION_SECRET: SECRET,
  } as unknown as NodeJS.ProcessEnv);
}

function build(db: AppDb): FastifyInstance {
  const app = Fastify();
  registerFormParser(app);
  registerConstructorRoutes(app, { db, cfg: config(), throttle: new ReplyThrottle(5) });
  return app;
}

function login(db: AppDb, userId: string) {
  const token = createSession(db, userId, NOW, 7 * DAY);
  return { cookie: `sid=${token}`, csrf: csrfToken(token, SECRET) };
}

function post(fields: Record<string, string>) {
  return {
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    payload: new URLSearchParams(fields).toString(),
  };
}

function seed() {
  const db = createTestDb();
  const a = createUser(db, { email: 'a@a.a', passwordHash: 'x' });
  const b = createUser(db, { email: 'b@b.b', passwordHash: 'x' });
  const automationA = createAutomation(db, a, {
    name: 'Прайс A', triggerType: 'contains', triggerValue: 'цена',
    steps: [{ say: 'Первый' }, { say: 'Второй' }, { say: 'Третий' }],
  });
  return { db, a, b, automationA };
}

describe('конструктор', () => {
  it('без сессии уводит на форму входа', async () => {
    const { db } = seed();
    const res = await build(db).inject({ method: 'GET', url: '/automations/new' });
    expect(res.statusCode).toBe(303);
  });

  it('создание заводит выключенную воронку без шагов и открывает её страницу', async () => {
    const db = createTestDb();
    const userId = createUser(db, { email: 'a@a.a', passwordHash: 'x' });
    const { cookie, csrf } = login(db, userId);

    const res = await build(db).inject({
      method: 'POST', url: '/automations', headers: { cookie },
      ...post({ name: 'Новая', trigger_type: 'contains', trigger_value: 'цена', csrf }),
    });

    const созданная = listAutomations(db, userId)[0];
    expect(res.statusCode).toBe(303);
    expect(res.headers.location).toBe(`/automations/${созданная?.id ?? ''}`);
    expect(созданная?.name).toBe('Новая');
    // Черновик не должен молча молчать в ответ на слово-триггер
    expect(созданная?.enabled).toBe(false);
    expect(getAutomation(db, userId, созданная?.id ?? '')?.steps).toHaveLength(0);
  });

  it('страница показывает шаги воронки', async () => {
    const { db, a, automationA } = seed();

    const res = await build(db).inject({
      method: 'GET', url: `/automations/${automationA}`, headers: { cookie: login(db, a).cookie },
    });

    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('Первый');
    expect(res.body).toContain('Третий');
    expect(res.headers['cache-control']).toBe('no-store');
  });

  it('S11: чужая воронка отвечает 404, как и несуществующая', async () => {
    const { db, b, automationA } = seed();
    const app = build(db);
    const { cookie } = login(db, b);

    const foreign = await app.inject({
      method: 'GET', url: `/automations/${automationA}`, headers: { cookie },
    });
    const missing = await app.inject({
      method: 'GET', url: '/automations/нет-такой', headers: { cookie },
    });

    expect(foreign.statusCode).toBe(404);
    expect(missing.statusCode).toBe(404);
    expect(foreign.body).toBe(missing.body);
  });

  it('сохранение записывает название, триггер и шаги', async () => {
    const { db, a, automationA } = seed();
    const { cookie, csrf } = login(db, a);

    const res = await build(db).inject({
      method: 'POST', url: `/automations/${automationA}`, headers: { cookie },
      ...post({
        name: 'Обновлённая', trigger_type: 'exact', trigger_value: 'прайс',
        say_0: 'Держите прайс', reply_0: '', file_0: '', buttons_0: '',
        say_1: 'Как вас зовут?', reply_1: 'name', file_1: '', buttons_1: '',
        action: 'save', csrf,
      }),
    });

    expect(res.statusCode).toBe(303);
    const found = getAutomation(db, a, automationA);
    expect(found?.automation.name).toBe('Обновлённая');
    expect(found?.automation.triggerType).toBe('exact');
    expect(found?.steps.map((s) => s.say)).toEqual(['Держите прайс', 'Как вас зовут?']);
    expect(found?.steps[1]?.saveReplyAs).toBe('name');
  });

  it('«добавить шаг» не теряет уже набранный текст', async () => {
    const { db, a, automationA } = seed();
    const { cookie, csrf } = login(db, a);

    await build(db).inject({
      method: 'POST', url: `/automations/${automationA}`, headers: { cookie },
      ...post({
        name: 'Прайс A', trigger_type: 'contains', trigger_value: 'цена',
        say_0: 'Только что напечатал', action: 'add', csrf,
      }),
    });

    const steps = getAutomation(db, a, automationA)?.steps ?? [];
    expect(steps.map((s) => s.say)).toEqual(['Только что напечатал', 'Новый шаг']);
  });

  it('«удалить шаг» убирает именно его', async () => {
    const { db, a, automationA } = seed();
    const { cookie, csrf } = login(db, a);

    await build(db).inject({
      method: 'POST', url: `/automations/${automationA}`, headers: { cookie },
      ...post({
        name: 'Прайс A', trigger_type: 'contains', trigger_value: 'цена',
        say_0: 'Первый', say_1: 'Второй', say_2: 'Третий', action: 'remove_1', csrf,
      }),
    });

    expect(getAutomation(db, a, automationA)?.steps.map((s) => s.say))
      .toEqual(['Первый', 'Третий']);
  });

  it('«вверх» меняет шаг местами с предыдущим', async () => {
    const { db, a, automationA } = seed();
    const { cookie, csrf } = login(db, a);

    await build(db).inject({
      method: 'POST', url: `/automations/${automationA}`, headers: { cookie },
      ...post({
        name: 'Прайс A', trigger_type: 'contains', trigger_value: 'цена',
        say_0: 'Первый', say_1: 'Второй', say_2: 'Третий', action: 'up_2', csrf,
      }),
    });

    expect(getAutomation(db, a, automationA)?.steps.map((s) => s.say))
      .toEqual(['Первый', 'Третий', 'Второй']);
  });

  it('«вверх» у первого шага ничего не ломает', async () => {
    const { db, a, automationA } = seed();
    const { cookie, csrf } = login(db, a);

    const res = await build(db).inject({
      method: 'POST', url: `/automations/${automationA}`, headers: { cookie },
      ...post({
        name: 'Прайс A', trigger_type: 'contains', trigger_value: 'цена',
        say_0: 'Первый', say_1: 'Второй', action: 'up_0', csrf,
      }),
    });

    expect(res.statusCode).toBe(303);
    expect(getAutomation(db, a, automationA)?.steps.map((s) => s.say))
      .toEqual(['Первый', 'Второй']);
  });

  it('S11: клиент B не правит воронку клиента A', async () => {
    const { db, a, b, automationA } = seed();
    const { cookie, csrf } = login(db, b);

    const res = await build(db).inject({
      method: 'POST', url: `/automations/${automationA}`, headers: { cookie },
      ...post({
        name: 'Взломано', trigger_type: 'exact', trigger_value: 'моё',
        say_0: 'Моё', action: 'save', csrf,
      }),
    });

    expect(res.statusCode).toBe(404);
    expect(getAutomation(db, a, automationA)?.automation.name).toBe('Прайс A');
  });

  it('S11: чужой файл в поле шага отвергается', async () => {
    const { db, a, b, automationA } = seed();
    const dir = mkdtempSync(join(tmpdir(), 'constructor-test-'));
    const foreignFile = saveFile(db, b, {
      originalName: 'чужое.pdf', mimeType: 'application/pdf',
      bytes: Buffer.concat([Buffer.from([0x25, 0x50, 0x44, 0x46]), Buffer.from('-1.4')]),
    }, dir);
    const { cookie, csrf } = login(db, a);

    const res = await build(db).inject({
      method: 'POST', url: `/automations/${automationA}`, headers: { cookie },
      ...post({
        name: 'Прайс A', trigger_type: 'contains', trigger_value: 'цена',
        say_0: 'Держите', file_0: foreignFile, action: 'save', csrf,
      }),
    });

    expect(res.statusCode).toBe(400);
    // Ничего не сохранилось: подставленный id не должен попасть даже в текст шага
    expect(getAutomation(db, a, automationA)?.steps.map((s) => s.say))
      .toEqual(['Первый', 'Второй', 'Третий']);
  });

  it('S15: без CSRF-токена ничего не меняется', async () => {
    const { db, a, automationA } = seed();
    const { cookie } = login(db, a);

    const res = await build(db).inject({
      method: 'POST', url: `/automations/${automationA}`, headers: { cookie },
      ...post({
        name: 'Взломано', trigger_type: 'contains', trigger_value: 'цена',
        say_0: 'Первый', action: 'save',
      }),
    });

    expect(res.statusCode).toBe(403);
    expect(getAutomation(db, a, automationA)?.automation.name).toBe('Прайс A');
  });

  it('пустой текст шага показывает ошибку и не сохраняет воронку', async () => {
    const { db, a, automationA } = seed();
    const { cookie, csrf } = login(db, a);

    const res = await build(db).inject({
      method: 'POST', url: `/automations/${automationA}`, headers: { cookie },
      ...post({
        name: 'Прайс A', trigger_type: 'contains', trigger_value: 'цена',
        say_0: '  ', action: 'save', csrf,
      }),
    });

    expect(res.statusCode).toBe(400);
    expect(res.body).toContain('Текст шага');
    expect(getAutomation(db, a, automationA)?.steps).toHaveLength(3);
  });

  it('S21: название со скриптом выводится текстом', async () => {
    const db = createTestDb();
    const userId = createUser(db, { email: 'a@a.a', passwordHash: 'x' });
    const id = createAutomation(db, userId, {
      name: '<script>alert(1)</script>', triggerType: 'contains', triggerValue: 'ц',
      steps: [{ say: '<img src=x onerror=alert(1)>' }],
    });

    const res = await build(db).inject({
      method: 'GET', url: `/automations/${id}`, headers: { cookie: login(db, userId).cookie },
    });

    expect(res.body).not.toContain('<script>alert(1)</script>');
    expect(res.body).not.toContain('<img src=x');
    expect(res.body).toContain('&lt;script&gt;');
  });
});
```

Шапку файла дополнить импортами для теста с чужим файлом:
`import { mkdtempSync } from 'node:fs';`, `import { tmpdir } from 'node:os';`,
`import { join } from 'node:path';`.

- [x] **Step 2: Запустить тест, убедиться что падает**

Run: `npx vitest run tests/web/constructor.test.ts`
Expected: FAIL — модуль `src/web/routes/constructor.js` не найден.

- [x] **Step 3: Реализовать `src/web/views/constructor.ts`**

```ts
import { z } from 'zod';
import type { AutomationRow, StepRow } from '../../storage/queries/automations.js';
import type { FileRow } from '../../storage/files.js';
import { MAX_BUTTONS } from '../forms.js';
import { html, type Html } from '../html.js';
import { layout } from './layout.js';

const Buttons = z.array(z.object({ label: z.string(), payload: z.string() }));

/**
 * Строку писали мы сами, но представление не должно падать на испорченной:
 * страница правки — единственный способ такую воронку починить.
 */
function buttonLabels(json: string | null): string {
  if (json === null) return '';
  try {
    const parsed = Buttons.safeParse(JSON.parse(json));
    return parsed.success ? parsed.data.map((b) => b.label).join('\n') : '';
  } catch {
    return '';
  }
}

function triggerOptions(selected: string): Html {
  const kinds: [string, string][] = [
    ['contains', 'содержит слово'],
    ['exact', 'точное совпадение'],
    ['starts_with', 'начинается со слова'],
  ];
  return html`${kinds.map(([value, label]) => html`
<option value="${value}"${value === selected ? html` selected` : ''}>${label}</option>`)}`;
}

export function newAutomationPage(csrf: string, error: string | undefined): Html {
  return layout('Новая воронка', html`
<h1>Новая воронка</h1>
<p><a href="/">Мои воронки</a></p>
${error === undefined ? '' : html`<p role="alert">${error}</p>`}
<form method="post" action="/automations">
  <input type="hidden" name="csrf" value="${csrf}">
  <label>Название <input name="name" required maxlength="100"></label>
  <label>Триггер <select name="trigger_type">${triggerOptions('contains')}</select></label>
  <label>Слово <input name="trigger_value" required maxlength="100"></label>
  <button type="submit">Создать</button>
</form>
<p>Шаги добавляются после создания. Пока шагов нет, воронка выключена.</p>`);
}

export function notFoundPage(): Html {
  return layout('Не найдено', html`<h1>Не найдено</h1><p><a href="/">Мои воронки</a></p>`);
}

/**
 * Имена полей нумерованные (`say_0`, `say_1`), а не повторяющиеся: разборщик форм
 * оставляет от одинаковых имён только последнее значение.
 *
 * Кнопки действий отличаются значением одного поля `action`: браузер отправляет
 * значение только нажатой кнопки, поэтому сервер узнаёт, что именно нажали,
 * получив при этом всю форму целиком.
 */
export function constructorPage(
  automation: AutomationRow,
  steps: StepRow[],
  files: FileRow[],
  csrf: string,
  error: string | undefined,
): Html {
  const stepBlocks = steps.map((step, i) => html`
<fieldset>
  <legend>Шаг ${i + 1}</legend>
  <label>Текст
    <textarea name="say_${i}" rows="3" maxlength="1000" required>${step.say}</textarea>
  </label>
  <label>Файл
    <select name="file_${i}">
      <option value="">без файла</option>
      ${files.map((file) => html`
      <option value="${file.id}"${file.id === step.fileId ? html` selected` : ''}>${file.originalName}</option>`)}
    </select>
  </label>
  <label>Ответ сохранить как
    <input name="reply_${i}" value="${step.saveReplyAs ?? ''}" maxlength="40">
  </label>
  <label>Кнопки, по одной на строку (не больше ${MAX_BUTTONS})
    <textarea name="buttons_${i}" rows="3">${buttonLabels(step.buttonsJson)}</textarea>
  </label>
  <button type="submit" name="action" value="up_${i}">Вверх</button>
  <button type="submit" name="action" value="down_${i}">Вниз</button>
  <button type="submit" name="action" value="remove_${i}">Удалить шаг</button>
</fieldset>`);

  return layout(`Воронка: ${automation.name}`, html`
<h1>${automation.name}</h1>
<p><a href="/">Мои воронки</a> · <a href="/files">Файлы</a></p>
${automation.enabled ? '' : html`<p>Воронка выключена. Включить можно в списке воронок.</p>`}
${error === undefined ? '' : html`<p role="alert">${error}</p>`}

<form method="post" action="/automations/${automation.id}">
  <input type="hidden" name="csrf" value="${csrf}">
  <label>Название <input name="name" value="${automation.name}" required maxlength="100"></label>
  <label>Триггер
    <select name="trigger_type">${triggerOptions(automation.triggerType)}</select>
  </label>
  <label>Слово
    <input name="trigger_value" value="${automation.triggerValue}" required maxlength="100">
  </label>

  ${steps.length === 0 ? html`<p>Шагов пока нет.</p>` : stepBlocks}

  <button type="submit" name="action" value="add">Добавить шаг</button>
  <button type="submit" name="action" value="save">Сохранить</button>
</form>`);
}
```

- [x] **Step 4: Реализовать `src/web/routes/constructor.ts`**

```ts
import type { FastifyInstance, FastifyReply } from 'fastify';
import { z } from 'zod';
import {
  createAutomation, getAutomation, setEnabled, updateAutomation,
  type NewStep,
} from '../../storage/queries/automations.js';
import { getFile, listFiles } from '../../storage/files.js';
import { csrfToken, csrfValid } from '../csrf.js';
import { parseConstructorForm } from '../forms.js';
import { currentSession, redirectToLogin, type WebDeps } from '../session.js';
import { constructorPage, newAutomationPage, notFoundPage } from '../views/constructor.js';

const Params = z.object({ id: z.string().min(1) });

/** S14: при создании читаются ровно эти поля. Шагов здесь нет вовсе. */
const CreateForm = z.object({
  name: z.string().trim().min(1).max(100),
  trigger_type: z.enum(['exact', 'contains', 'starts_with']),
  trigger_value: z.string().trim().min(1).max(100),
  csrf: z.string().optional(),
});

const ActionField = z.object({ action: z.string().optional(), csrf: z.string().optional() });
const ACTION = /^(save|add|up|down|remove)(?:_(\d+))?$/;

/**
 * Действие применяется к уже разобранным шагам, а не к строкам БД: клиент видит
 * результат сразу вместе с тем, что он напечатал до нажатия.
 */
function applyAction(steps: NewStep[], action: string): NewStep[] {
  const match = ACTION.exec(action);
  if (match === null) return steps;

  const kind = match[1];
  const index = match[2] === undefined ? -1 : Number(match[2]);
  const next = [...steps];

  if (kind === 'add') {
    // Текст, а не пустая строка: пустой шаг форма не принимает,
    // и клиент увидел бы ошибку сразу после нажатия «добавить»
    next.push({ say: 'Новый шаг' });
    return next;
  }

  const current = next[index];
  if (current === undefined) return next;

  if (kind === 'remove') {
    next.splice(index, 1);
    return next;
  }

  const target = kind === 'up' ? index - 1 : index + 1;
  const neighbour = next[target];
  // Край списка: «вверх» у первого и «вниз» у последнего просто ничего не делают
  if (neighbour === undefined) return next;

  next[index] = neighbour;
  next[target] = current;
  return next;
}

function notFound(reply: FastifyReply): FastifyReply {
  return reply.code(404).type('text/html; charset=utf-8').send(notFoundPage().value);
}

export function registerConstructorRoutes(app: FastifyInstance, deps: WebDeps): void {
  app.get('/automations/new', (request, reply) => {
    const session = currentSession(deps, request, new Date());
    if (session === undefined) return redirectToLogin(reply);

    return reply
      .header('cache-control', 'no-store')
      .type('text/html; charset=utf-8')
      .send(newAutomationPage(csrfToken(session.token, deps.cfg.SESSION_SECRET), undefined).value);
  });

  app.post('/automations', (request, reply) => {
    const session = currentSession(deps, request, new Date());
    if (session === undefined) return redirectToLogin(reply);

    const form = CreateForm.safeParse(request.body);
    if (!form.success) {
      return reply.code(400).type('text/html; charset=utf-8').send(newAutomationPage(
        csrfToken(session.token, deps.cfg.SESSION_SECRET),
        'Заполните название и слово-триггер',
      ).value);
    }
    if (!csrfValid(session.token, form.data.csrf, deps.cfg.SESSION_SECRET)) {
      return reply.code(403).send();
    }

    const id = createAutomation(deps.db, session.userId, {
      name: form.data.name,
      triggerType: form.data.trigger_type,
      triggerValue: form.data.trigger_value,
      steps: [],
    });
    // Черновик без шагов включённым быть не должен: он молча не ответит
    // на слово-триггер, и клиент решит, что сломан бот
    setEnabled(deps.db, session.userId, id, false);

    return reply.code(303).header('location', `/automations/${id}`).send();
  });

  app.get('/automations/:id', (request, reply) => {
    const session = currentSession(deps, request, new Date());
    if (session === undefined) return redirectToLogin(reply);

    const params = Params.safeParse(request.params);
    if (!params.success) return notFound(reply);

    // S11: владелец внутри запроса. Чужая воронка не находится, и ответ
    // такой же, как для несуществующей
    const found = getAutomation(deps.db, session.userId, params.data.id);
    if (found === undefined) return notFound(reply);

    return reply
      .header('cache-control', 'no-store')
      .type('text/html; charset=utf-8')
      .send(constructorPage(
        found.automation, found.steps, listFiles(deps.db, session.userId),
        csrfToken(session.token, deps.cfg.SESSION_SECRET), undefined,
      ).value);
  });

  app.post('/automations/:id', (request, reply) => {
    const session = currentSession(deps, request, new Date());
    if (session === undefined) return redirectToLogin(reply);

    const params = Params.safeParse(request.params);
    const meta = ActionField.safeParse(request.body);
    if (!params.success || !meta.success) return reply.code(400).send();

    if (!csrfValid(session.token, meta.data.csrf, deps.cfg.SESSION_SECRET)) {
      return reply.code(403).send();
    }

    const found = getAutomation(deps.db, session.userId, params.data.id);
    if (found === undefined) return notFound(reply);

    const parsed = parseConstructorForm(request.body);
    const show = (code: number, error: string): FastifyReply => reply.code(code)
      .header('cache-control', 'no-store')
      .type('text/html; charset=utf-8')
      .send(constructorPage(
        found.automation, found.steps, listFiles(deps.db, session.userId),
        csrfToken(session.token, deps.cfg.SESSION_SECRET), error,
      ).value);

    if (!parsed.ok) return show(400, parsed.error);

    // S11: id файла приходит из формы, а поле формы подделывается. Без этой
    // проверки клиент подставил бы чужой id, и бот разослал бы чужой файл
    for (const step of parsed.form.steps) {
      if (step.fileId === undefined) continue;
      if (getFile(deps.db, session.userId, step.fileId) === undefined) {
        return show(400, 'Файл не найден среди ваших');
      }
    }

    const steps = applyAction(parsed.form.steps, meta.data.action ?? 'save');
    updateAutomation(deps.db, session.userId, params.data.id, { ...parsed.form, steps });

    return reply.code(303).header('location', `/automations/${params.data.id}`).send();
  });
}
```

- [x] **Step 5: Запустить тест, убедиться что проходит**

Run: `npx vitest run tests/web/constructor.test.ts`
Expected: PASS, 14 тестов.

- [x] **Step 6: Показать в кабинете ссылку на конструктор и пометку «черновик»**

Сначала тест — в `tests/web/dashboard.test.ts` добавить:

```ts
it('воронка без шагов помечена черновиком и не предлагает включение', async () => {
  const db = createTestDb();
  const userId = createUser(db, { email: 'x@x.x', passwordHash: 'x' });
  createAutomation(db, userId, {
    name: 'Черновик', triggerType: 'contains', triggerValue: 'ц', steps: [],
  });

  const res = await build(db).inject({
    method: 'GET', url: '/', headers: { cookie: login(db, userId).cookie },
  });

  expect(res.body).toContain('черновик');
  expect(res.body).not.toContain('Выключить');
});

it('в списке есть ссылки на правку и на создание', async () => {
  const { db, a, aAutomation } = seed();
  const res = await build(db).inject({
    method: 'GET', url: '/', headers: { cookie: login(db, a).cookie },
  });

  expect(res.body).toContain(`/automations/${aAutomation}`);
  expect(res.body).toContain('/automations/new');
});
```

Run: `npx vitest run tests/web/dashboard.test.ts` → FAIL.

Затем в `src/web/views/dashboard.ts` заменить сигнатуру и тело строки таблицы:

```ts
export function dashboardPage(
  rows: AutomationRow[], counts: Map<string, number>, csrf: string,
): Html {
  const items = rows.map((row) => {
    const steps = counts.get(row.id) ?? 0;
    return html`
<tr>
  <td><a href="/automations/${row.id}">${row.name}</a></td>
  <td>${row.triggerType} «${row.triggerValue}»</td>
  <td>${steps === 0 ? 'черновик' : row.enabled ? 'включена' : 'выключена'}</td>
  <td>
    ${steps === 0 ? html`<a href="/automations/${row.id}">Добавить шаги</a>` : html`
    <form method="post" action="/automations/${row.id}/toggle">
      <input type="hidden" name="csrf" value="${csrf}">
      <input type="hidden" name="enabled" value="${row.enabled ? 'false' : 'true'}">
      <button type="submit">${row.enabled ? 'Выключить' : 'Включить'}</button>
    </form>`}
  </td>
</tr>`;
  });

  return layout('Мои воронки', html`
<h1>Мои воронки</h1>
<p><a href="/leads">Заявки</a> · <a href="/files">Файлы</a> · <a href="/automations/new">Новая воронка</a></p>
${rows.length === 0 ? html`<p>Воронок пока нет.</p>` : html`
<table>
  <thead><tr><th>Название</th><th>Триггер</th><th>Состояние</th><th></th></tr></thead>
  <tbody>${items}</tbody>
</table>`}
<form method="post" action="/logout"><button type="submit">Выйти</button></form>`);
}
```

И в `src/web/routes/dashboard.ts` в обработчике `GET /` передать счётчики
(импорт `stepCounts`):

```ts
    const rows = listAutomations(deps.db, session.userId);
    const counts = stepCounts(deps.db, session.userId);
    return reply
      .header('cache-control', 'no-store')
      .type('text/html; charset=utf-8')
      .send(dashboardPage(rows, counts, csrfToken(session.token, deps.cfg.SESSION_SECRET)).value);
```

Run: `npx vitest run tests/web/dashboard.test.ts` → PASS.

- [x] **Step 7: Коммит**

```bash
git add src/web/views/constructor.ts src/web/routes/constructor.ts src/web/views/dashboard.ts src/web/routes/dashboard.ts tests/web/constructor.test.ts tests/web/dashboard.test.ts
git commit -m "feat(web): конструктор воронки — создание, правка, шаги и файлы (S11, S14, S15, S21)"
```

---
## Task E7: Стили

Фаза D оставила разметку голой намеренно: CSP запрещает инлайновые стили, а отдельный
файл стилей нечего было оформлять, пока не было конструктора. Теперь есть.

Файл отдаётся маршрутом, а не статикой из каталога: файл ровно один, и лишняя
зависимость с обходом путей ради него не нужна.

**Files:**
- Create: `src/web/views/style.ts`, `src/web/routes/style.ts`
- Modify: `src/web/views/layout.ts`
- Test: `tests/web/style.test.ts`

**Interfaces:**
- Produces: `APP_CSS: string`, `registerStyleRoute(app: FastifyInstance): void`

- [x] **Step 1: Написать падающий тест**

`tests/web/style.test.ts`:

```ts
import Fastify from 'fastify';
import { describe, expect, it } from 'vitest';
import { registerStyleRoute } from '../../src/web/routes/style.js';
import { layout } from '../../src/web/views/layout.js';
import { html } from '../../src/web/html.js';

describe('стили', () => {
  it('отдаются отдельным файлом', async () => {
    const app = Fastify();
    registerStyleRoute(app);

    const res = await app.inject({ method: 'GET', url: '/app.css' });

    expect(res.statusCode).toBe(200);
    expect(String(res.headers['content-type'])).toContain('text/css');
    expect(res.body).toContain('body');
  });

  it('файл стилей кэшируется: он одинаков для всех и не содержит ПД', async () => {
    const app = Fastify();
    registerStyleRoute(app);

    const res = await app.inject({ method: 'GET', url: '/app.css' });

    expect(String(res.headers['cache-control'])).toContain('max-age=');
  });

  it('страницы подключают файл, а не инлайновый стиль: CSP запрещает второе', () => {
    const page = layout('Проверка', html`<p>тело</p>`).value;

    expect(page).toContain('<link rel="stylesheet" href="/app.css">');
    expect(page).not.toContain('<style');
  });
});
```

- [x] **Step 2: Запустить тест, убедиться что падает**

Run: `npx vitest run tests/web/style.test.ts`
Expected: FAIL — модуль `src/web/routes/style.js` не найден.

- [x] **Step 3: Реализовать `src/web/views/style.ts`**

```ts
/**
 * Один файл на весь кабинет. Инлайновых стилей нет и не будет: CSP запрещает
 * `unsafe-inline`, и это второй рубеж после экранирования разметки (S21, S22).
 */
export const APP_CSS = `
:root { color-scheme: light dark; }

body {
  margin: 0 auto;
  padding: 1.5rem 1rem 4rem;
  max-width: 46rem;
  font: 16px/1.5 system-ui, sans-serif;
}

h1 { font-size: 1.5rem; margin-bottom: 0.5rem; }

a { color: inherit; }

table { width: 100%; border-collapse: collapse; margin: 1rem 0; }
th, td { padding: 0.5rem; text-align: left; border-bottom: 1px solid currentColor; }
th { font-weight: 600; }

fieldset { margin: 1rem 0; padding: 1rem; border: 1px solid currentColor; }
legend { padding: 0 0.4rem; font-weight: 600; }

label { display: block; margin-bottom: 0.75rem; }
input, select, textarea {
  display: block;
  width: 100%;
  margin-top: 0.25rem;
  padding: 0.5rem;
  font: inherit;
  box-sizing: border-box;
}
textarea { resize: vertical; }

button { padding: 0.5rem 1rem; font: inherit; cursor: pointer; }

/* Формы-кнопки в таблице не должны растягивать строку на всю ширину */
td form { display: inline; }

[role="alert"] { padding: 0.75rem; border: 2px solid currentColor; font-weight: 600; }
`;
```

- [x] **Step 4: Реализовать `src/web/routes/style.ts`**

```ts
import type { FastifyInstance } from 'fastify';
import { APP_CSS } from '../views/style.js';

/**
 * Маршрут, а не отдача каталога: файл ровно один, и ради него незачем брать
 * зависимость, которая умеет отдавать произвольные пути с диска (S18).
 *
 * Сессия здесь не нужна: в стилях нет ничего клиентского.
 */
export function registerStyleRoute(app: FastifyInstance): void {
  app.get('/app.css', (_request, reply) => reply
    .type('text/css; charset=utf-8')
    .header('cache-control', 'public, max-age=3600')
    .send(APP_CSS));
}
```

- [x] **Step 5: Подключить файл в макет**

В `src/web/views/layout.ts` добавить строку перед `<title>`:

```ts
<link rel="stylesheet" href="/app.css">
```

- [x] **Step 6: Запустить тесты, убедиться что проходят**

Run: `npx vitest run tests/web/`
Expected: PASS.

- [x] **Step 7: Коммит**

```bash
git add src/web/views/style.ts src/web/routes/style.ts src/web/views/layout.ts tests/web/style.test.ts
git commit -m "feat(web): файл стилей кабинета отдельным маршрутом (S22)"
```

---

## Task E8: Сборка процесса и контрольная точка

**Files:**
- Modify: `src/server.ts`, `CLAUDE.md`
- Test: `tests/web/isolation.test.ts`

**Interfaces:**
- Consumes: `registerFilesRoutes`, `registerConstructorRoutes`, `registerStyleRoute`

- [x] **Step 1: Расширить сквозной тест изоляции**

В `tests/web/isolation.test.ts` в функцию `cabinet` добавить регистрацию новых
маршрутов (импорты сверху дополнить):

```ts
  registerFilesRoutes(app, deps);
  registerConstructorRoutes(app, deps);
  registerStyleRoute(app);
```

В `seedClient` после создания воронки добавить возврат её id:

```ts
  return { userId, automationId, cookie: `sid=${createSession(db, userId, NOW, 7 * DAY)}` };
```

И добавить два теста:

```ts
it('S11: страница чужой воронки не открывается', async () => {
  const db = createTestDb();
  const a = seedClient(db, 'a@a.a', 'A');
  const b = seedClient(db, 'b@b.b', 'B');
  const app = cabinet(db);

  const res = await app.inject({
    method: 'GET', url: `/automations/${b.automationId}`, headers: { cookie: a.cookie },
  });

  expect(res.statusCode).toBe(404);
});

it('S11: список файлов и список воронок не показывают чужое', async () => {
  const db = createTestDb();
  const a = seedClient(db, 'a@a.a', 'A');
  seedClient(db, 'b@b.b', 'B');
  const app = cabinet(db);

  for (const url of ['/', '/files', `/automations/${a.automationId}`]) {
    const res = await app.inject({ method: 'GET', url, headers: { cookie: a.cookie } });
    expect(res.statusCode, url).toBe(200);
    expect(res.body, url).not.toContain('Воронка B');
    expect(res.body, url).not.toContain('Имя B');
  }
});
```

Существующий тест «ни один маршрут кабинета не отдаёт чужое» сравнивает тело
с одиночной буквой `B`. После появления файла стилей и новых страниц эта проверка
станет ложно срабатывать на любой латинской `B` в разметке — заменить в нём
`not.toContain('B')` на `not.toContain('Воронка B')`.

- [x] **Step 2: Запустить тест, убедиться что падает**

Run: `npx vitest run tests/web/isolation.test.ts`
Expected: FAIL — `registerFilesRoutes is not defined` (маршруты ещё не импортированы
в этот файл) либо 404 на `/files`.

- [x] **Step 3: Собрать маршруты в `src/server.ts`**

В импорты добавить:

```ts
import { registerConstructorRoutes } from './web/routes/constructor.js';
import { registerFilesRoutes } from './web/routes/files.js';
import { registerStyleRoute } from './web/routes/style.js';
```

После `registerLeadsRoutes(app, web);` добавить:

```ts
  registerFilesRoutes(app, web);
  registerConstructorRoutes(app, web);
  registerStyleRoute(app);
```

- [x] **Step 4: Запустить весь набор**

Run: `npx vitest run`
Expected: PASS.

- [x] **Step 5: Обновить `CLAUDE.md`**

- В «Источники истины» указать этот план как план последней закрытой фазы (E),
  а следующей назвать фазу F (админка и запуск), плана для которой ещё нет.
- В разделе «Архитектура» в строку `web/` добавить `forms`, `constructor`, `files`.
- В «Команды» ничего не меняется.
- В «Обязательные правила» добавить пункт: **имена полей в формах со списками
  нумеруются (`say_0`, `say_1`), а не повторяются**: разборщик форм построен на
  `Object.fromEntries(new URLSearchParams(...))` и от одинаковых имён оставляет
  только последнее значение.

- [x] **Step 6: Контрольная точка фазы**

```powershell
npm test; if ($?) { npm run typecheck }
npm audit
```

Expected: все тесты зелёные, typecheck без вывода, в `npm audit` нет уязвимостей
уровня high и critical. Известные 4 moderate от `drizzle-kit → esbuild` — dev-зависимость,
исправление ломающее; не трогаем в этой фазе.

- [x] **Step 7: Коммит**

```bash
git add src/server.ts CLAUDE.md tests/web/isolation.test.ts
git commit -m "feat(web): конструктор и файлы в сборке процесса, сквозной тест изоляции (S11)"
```

---

## Что фаза сознательно не делает

- **Не удаляет воронки.** Ошибочно созданную можно выключить и переписать.
  Удаление тянет за собой вопрос, что делать с заявками, которые на неё ссылаются
  (`leads.automation_id`) — это решается вместе с админкой, в фазе F.
- **Не даёт ветвлений.** Кнопки ведут по той же линейной цепочке (раздел 2 спеки).
  Поле `payload` заполняется автоматически именно потому, что выбирать по нему
  пока нечего.
- **Не показывает предпросмотр воронки.** Проверка — живым сообщением в Instagram.
- **Не заводит клиентов и не разделяет роли.** `requireOwner` и админка — фаза F,
  там же проверяется S12.
- **Не трогает ядро.** `engine.ts`, `matcher.ts`, `scenario.ts`, `throttle.ts`
  в этой фазе не меняются ни строкой.
- **Не переписывает `saveFile`.** Проверки сигнатуры, размера и расширения уже
  написаны и покрыты тестами в фазе C; задача E4 только доводит до них байты
  из браузера.
