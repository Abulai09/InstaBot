# Мультиплатформенный чат-бот — план реализации

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Бот-воронка для одного бизнеса, отвечающий по YAML-сценариям на директ и комментарии в Instagram и на комментарии в TikTok.

**Architecture:** Три слоя. `core/` — чистая логика конечного автомата, не знает названий платформ. `adapters/` — приводят push (webhook Instagram) и pull (polling TikTok) к единому `IncomingEvent` и исполняют `OutgoingAction`. `storage/` — SQLite через Drizzle, там же очередь событий и outbox исходящих. HTTP-обработчик только принимает и кладёт в очередь; обработка идёт в отдельном воркере.

**Tech Stack:** TypeScript (strict), Node 20+, Fastify, Drizzle ORM + better-sqlite3, Zod, js-yaml, Vitest.

**Spec:** `docs/superpowers/specs/2026-08-26-chatbot-design.md`

## Global Constraints

- Node.js >= 20. TypeScript `strict: true`, `noUncheckedIndexedAccess: true`.
- В каталоге `src/core/` не должно встречаться слов `instagram`, `tiktok`, `meta`, `fastify`, `drizzle`. Проверяется тестом в Task 4.
- Никаких `any`, `as unknown as`, `!` (non-null assertion) в production-коде.
- Секреты только через `src/config.ts`. Прямой `process.env.X` вне этого файла запрещён.
- Токены, тела сообщений и телефоны не логируются выше уровня `debug` (S9).
- Контекст диалога — `Map<string, string>`, не объектный литерал (S6).
- Регулярные выражения в триггерах сценариев запрещены в v1 (S7).
- Каждая задача заканчивается коммитом. Тест пишется до реализации.

---

## Структура файлов

| Файл | Ответственность |
|---|---|
| `src/config.ts` | единственное место чтения и валидации env |
| `src/core/types.ts` | `IncomingEvent`, `OutgoingAction`, `ConversationState` |
| `src/core/scenario.ts` | Zod-схема сценария, безопасный парсинг YAML |
| `src/core/matcher.ts` | сопоставление текста с триггером |
| `src/core/engine.ts` | `step()` — чистая функция конечного автомата |
| `src/core/throttle.ts` | ограничение частоты ответов на контакт |
| `src/storage/schema.ts` | таблицы Drizzle |
| `src/storage/crypto.ts` | AES-256-GCM для токенов платформ |
| `src/storage/queries.ts` | именованные запросы (без слоя репозиториев) |
| `src/adapters/types.ts` | `MessageSender` / `WebhookSource` / `PollingSource` |
| `src/adapters/instagram/verify.ts` | проверка подписи Meta (S1, S2) |
| `src/adapters/instagram/parse.ts` | вебхук → `IncomingEvent[]`, фильтр `is_echo` (S3) |
| `src/adapters/instagram/send.ts` | исполнение `OutgoingAction` в Instagram |
| `src/adapters/tiktok/auth.ts` | получение и ротация токена |
| `src/adapters/tiktok/poll.ts` | опрос комментариев **и** ответ на них (один адаптер — один файл) |
| `src/operator.ts` | `notify_operator` — уведомление живого менеджера |
| `src/worker.ts` | очередь → `step()` → outbox |
| `src/server.ts` | Fastify, raw body, роуты вебхука |
| `src/scheduler.ts` | таймер опроса TikTok |

---

# Фаза 0 — фундамент

## Task 1: Скелет проекта и слой конфигурации

**Files:**
- Create: `package.json`, `tsconfig.json`, `.gitignore`, `.env.example`, `src/config.ts`
- Test: `tests/config.test.ts`

**Interfaces:**
- Consumes: ничего, первая задача
- Produces: `loadConfig(raw?: NodeJS.ProcessEnv): Config`, тип `Config`

- [ ] **Step 1: Инициализировать репозиторий и зависимости**

```bash
git init
npm init -y
npm pkg set type=module
npm i fastify zod js-yaml drizzle-orm better-sqlite3 pino
npm i -D typescript vitest @types/node @types/js-yaml @types/better-sqlite3 drizzle-kit tsx
```

- [ ] **Step 2: Создать `.gitignore` — обязательно до первого коммита**

```
node_modules/
dist/
data/
.env
*.db
```

- [ ] **Step 3: Создать `tsconfig.json`**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "types": ["node"],
    "outDir": "dist",
    "rootDir": "."
  },
  "include": ["src", "tests"]
}
```

> `"types": ["node"]` обязателен: TypeScript 7 не подхватывает `@types/node`
> автоматически, и без этой строки `NodeJS.ProcessEnv` и `process` не находятся,
> хотя тесты при этом проходят — ошибка видна только в `tsc --noEmit`.

- [ ] **Step 4: Написать падающий тест**

`tests/config.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { loadConfig } from '../src/config.js';

const valid = {
  META_APP_SECRET: 'app-secret',
  META_VERIFY_TOKEN: 'verify-token',
  IG_PAGE_ACCESS_TOKEN: 'page-token',
  CREDENTIALS_ENC_KEY: 'a'.repeat(64),
} as unknown as NodeJS.ProcessEnv;

describe('loadConfig', () => {
  it('подставляет значения по умолчанию', () => {
    const cfg = loadConfig(valid);
    expect(cfg.PORT).toBe(3000);
    expect(cfg.NODE_ENV).toBe('development');
  });

  it('падает, если обязательная переменная отсутствует', () => {
    const { META_APP_SECRET, ...missing } = valid;
    expect(() => loadConfig(missing as NodeJS.ProcessEnv)).toThrow(/META_APP_SECRET/);
  });

  it('S10: не печатает значения переменных в сообщении об ошибке', () => {
    const bad = { ...valid, CREDENTIALS_ENC_KEY: 'korotkiy-klyuch' };
    try {
      loadConfig(bad as NodeJS.ProcessEnv);
      throw new Error('должно было упасть');
    } catch (e) {
      const msg = (e as Error).message;
      expect(msg).toContain('CREDENTIALS_ENC_KEY');
      expect(msg).not.toContain('korotkiy-klyuch');
      expect(msg).not.toContain('app-secret');
    }
  });
});
```

- [ ] **Step 5: Запустить тест, убедиться что падает**

Run: `npx vitest run tests/config.test.ts`
Expected: FAIL — `Cannot find module '../src/config.js'`

- [ ] **Step 6: Реализовать `src/config.ts`**

```ts
import { z } from 'zod';

const EnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(3000),
  DATABASE_URL: z.string().min(1).default('./data/bot.db'),

  META_APP_SECRET: z.string().min(1),
  META_VERIFY_TOKEN: z.string().min(1),
  IG_PAGE_ACCESS_TOKEN: z.string().min(1),

  // 32 байта в hex — ключ AES-256-GCM
  CREDENTIALS_ENC_KEY: z.string().length(64),

  TIKTOK_CLIENT_KEY: z.string().optional(),
  TIKTOK_CLIENT_SECRET: z.string().optional(),
  TIKTOK_POLL_INTERVAL_SEC: z.coerce.number().int().positive().default(120),

  OPERATOR_TELEGRAM_BOT_TOKEN: z.string().optional(),
  OPERATOR_TELEGRAM_CHAT_ID: z.string().optional(),

  THROTTLE_MAX_REPLIES_PER_MINUTE: z.coerce.number().int().positive().default(6),
  MAX_INCOMING_TEXT_LENGTH: z.coerce.number().int().positive().default(2000),
});

export type Config = z.infer<typeof EnvSchema>;

export function loadConfig(raw: NodeJS.ProcessEnv = process.env): Config {
  const parsed = EnvSchema.safeParse(raw);
  if (!parsed.success) {
    // S10: только имена переменных, никогда значения
    const names = parsed.error.issues.map((i) => i.path.join('.')).join(', ');
    throw new Error(`Некорректная конфигурация окружения: ${names}`);
  }
  return parsed.data;
}
```

- [ ] **Step 7: Создать `.env.example`** (коммитится, значения пустые)

```
NODE_ENV=development
PORT=3000
DATABASE_URL=./data/bot.db
META_APP_SECRET=
META_VERIFY_TOKEN=
IG_PAGE_ACCESS_TOKEN=
CREDENTIALS_ENC_KEY=
TIKTOK_CLIENT_KEY=
TIKTOK_CLIENT_SECRET=
OPERATOR_TELEGRAM_BOT_TOKEN=
OPERATOR_TELEGRAM_CHAT_ID=
```

- [ ] **Step 8: Запустить тест, убедиться что проходит**

Run: `npx vitest run tests/config.test.ts`
Expected: PASS, 3 теста

- [ ] **Step 9: Коммит**

```bash
git add -A
git commit -m "chore: скелет проекта и валидируемая конфигурация"
```

---

## Task 2: Типы ядра и загрузка сценариев

**Files:**
- Create: `src/core/types.ts`, `src/core/scenario.ts`, `scenarios/price.yaml`
- Test: `tests/core/scenario.test.ts`

**Interfaces:**
- Consumes: ничего
- Produces: типы `Platform`, `IncomingEvent`, `OutgoingAction`, `Button`, `ConversationState`, `emptyState()`; типы `Trigger`, `ScenarioStep`, `Scenario`; функции `parseScenario(yamlText: string): Scenario`, `loadScenarios(dir: string): Scenario[]`

- [ ] **Step 1: Написать падающий тест**

`tests/core/scenario.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { parseScenario } from '../../src/core/scenario.js';

const valid = [
  'id: price',
  'trigger:',
  '  type: contains',
  '  value: цена',
  'steps:',
  '  - id: ask_phone',
  '    say: "Оставьте номер"',
  '    save_reply_as: phone',
  '    next: done',
  '  - id: done',
  '    say: "Спасибо!"',
  '    notify_operator: "новая заявка"',
].join('\n');

describe('parseScenario', () => {
  it('разбирает корректный сценарий', () => {
    const s = parseScenario(valid);
    expect(s.id).toBe('price');
    expect(s.trigger.type).toBe('contains');
    expect(s.steps).toHaveLength(2);
  });

  it('S7: отвергает regex как тип триггера', () => {
    expect(() => parseScenario(valid.replace('type: contains', 'type: regex'))).toThrow();
  });

  it('отвергает next на несуществующий шаг', () => {
    expect(() => parseScenario(valid.replace('next: done', 'next: nowhere'))).toThrow(/nowhere/);
  });

  it('S5: не выполняет небезопасные YAML-теги', () => {
    const attack = [
      'id: x',
      'trigger: { type: exact, value: x }',
      'steps:',
      '  - id: a',
      '    say: !!js/function "function(){ return 1 }"',
    ].join('\n');
    expect(() => parseScenario(attack)).toThrow();
  });

  it('S6: отвергает __proto__ как имя переменной', () => {
    expect(() => parseScenario(valid.replace('save_reply_as: phone', 'save_reply_as: __proto__'))).toThrow();
  });
});
```

- [ ] **Step 2: Запустить тест, убедиться что падает**

Run: `npx vitest run tests/core/scenario.test.ts`
Expected: FAIL — модуль не найден

- [ ] **Step 3: Реализовать `src/core/types.ts`**

```ts
export type Platform = 'instagram' | 'tiktok';
export type EventKind = 'direct_message' | 'comment' | 'button_click';

export interface IncomingEvent {
  platform: Platform;
  kind: EventKind;
  /** id пользователя внутри платформы */
  externalUserId: string;
  /** диалог, либо пост под которым оставлен комментарий */
  externalThreadId: string;
  /** id комментария — нужен, чтобы ответить именно на него */
  externalCommentId: string | null;
  text: string | null;
  /** payload нажатой кнопки */
  payload: string | null;
  /** ключ защиты от повторной доставки */
  dedupeKey: string;
  receivedAt: Date;
}

export interface Button {
  label: string;
  payload: string;
}

export type OutgoingAction =
  | { type: 'send_text'; text: string }
  | { type: 'send_buttons'; text: string; buttons: Button[] }
  | { type: 'reply_comment'; text: string }
  | { type: 'dm_the_commenter'; text: string }
  | { type: 'notify_operator'; reason: string; context: Record<string, string> };

export interface ConversationState {
  /** null — диалог ещё не начат */
  stepId: string | null;
  /** Map, а не литерал: ключи приходят из сценария (S6) */
  context: Map<string, string>;
  lastUserMessageAt: Date | null;
}

export function emptyState(): ConversationState {
  return { stepId: null, context: new Map(), lastUserMessageAt: null };
}

/**
 * Куда доставить действие. Живёт в core, а не в storage или adapters:
 * это доменное понятие, и оба слоя должны зависеть от ядра, а не друг от друга.
 */
export interface DeliveryContext {
  threadId: string;
  commentId?: string;
  userId?: string;
}
```

- [ ] **Step 4: Реализовать `src/core/scenario.ts`**

```ts
import { load, CORE_SCHEMA } from 'js-yaml';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';

const TriggerSchema = z.object({
  // S7: regex сознательно отсутствует
  type: z.enum(['exact', 'contains', 'starts_with']),
  value: z.string().min(1),
});

const VariableName = z
  .string()
  .regex(/^[a-z][a-z0-9_]*$/i, 'имя переменной: буква, затем буквы/цифры/подчёркивание');

const StepSchema = z.object({
  id: z.string().min(1),
  say: z.string().min(1),
  buttons: z.array(z.object({ label: z.string().min(1), payload: z.string().min(1) })).optional(),
  /** куда сохранить следующий ответ пользователя */
  save_reply_as: VariableName.optional(),
  next: z.string().optional(),
  notify_operator: z.string().optional(),
});

const ScenarioSchema = z.object({
  id: z.string().min(1),
  trigger: TriggerSchema,
  steps: z.array(StepSchema).min(1),
});

export type Trigger = z.infer<typeof TriggerSchema>;
export type ScenarioStep = z.infer<typeof StepSchema>;
export type Scenario = z.infer<typeof ScenarioSchema>;

export function parseScenario(yamlText: string): Scenario {
  // S5: CORE_SCHEMA не умеет конструировать функции и произвольные объекты
  const raw = load(yamlText, { schema: CORE_SCHEMA });
  const scenario = ScenarioSchema.parse(raw);

  const ids = new Set(scenario.steps.map((s) => s.id));
  for (const step of scenario.steps) {
    if (step.next !== undefined && !ids.has(step.next)) {
      throw new Error(`Шаг "${step.id}" ссылается на несуществующий next: "${step.next}"`);
    }
  }
  return scenario;
}

export function loadScenarios(dir: string): Scenario[] {
  return readdirSync(dir)
    .filter((f) => f.endsWith('.yaml') || f.endsWith('.yml'))
    .map((f) => parseScenario(readFileSync(join(dir, f), 'utf8')));
}
```

Примечание: `VariableName` отвергает `__proto__` (начинается с подчёркивания) — это второй рубеж защиты S6, первый — `Map` в `ConversationState`.

- [ ] **Step 5: Создать `scenarios/price.yaml`**

```yaml
id: price
trigger:
  type: contains
  value: цена
steps:
  - id: ask_product
    say: "Здравствуйте! Подскажите, какой товар вас интересует?"
    save_reply_as: product
    next: ask_phone
  - id: ask_phone
    say: "Оставьте номер телефона — менеджер пришлёт точную цену."
    save_reply_as: phone
    next: done
  - id: done
    say: "Спасибо! Менеджер свяжется с вами в течение рабочего дня."
    notify_operator: "новая заявка с ценового сценария"
```

- [ ] **Step 6: Запустить тест, убедиться что проходит**

Run: `npx vitest run tests/core/scenario.test.ts`
Expected: PASS, 5 тестов

- [ ] **Step 7: Коммит**

```bash
git add -A
git commit -m "feat(core): типы ядра и безопасная загрузка YAML-сценариев"
```

---

# Фаза 1 — мозг бота, полностью без сети

## Task 3: Матчер триггеров — РЕАЛИЗУЕТ ВЛАДЕЛЕЦ

**Files:**
- Create: `src/core/matcher.ts`
- Test: `tests/core/matcher.test.ts`

**Interfaces:**
- Consumes: `Trigger` из `src/core/scenario.ts`
- Produces: `matches(trigger: Trigger, userText: string): boolean`

> **Эта задача намеренно оставлена владельцу проекта.** От неё зависит доля
> клиентов, которых бот проигнорирует, — это бизнес-решение, а не техническое.
> Тесты ниже уже написаны и фиксируют требования. Реализация — за владельцем;
> агент-исполнитель должен остановиться на этой задаче и запросить код.

- [ ] **Step 1: Написать тесты (агент пишет, владелец может дополнить)**

`tests/core/matcher.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { matches } from '../../src/core/matcher.js';
import type { Trigger } from '../../src/core/scenario.js';

const contains: Trigger = { type: 'contains', value: 'цена' };
const exact: Trigger = { type: 'exact', value: 'цена' };
const starts: Trigger = { type: 'starts_with', value: 'привет' };

describe('matches', () => {
  it('contains ловит слово внутри фразы', () => {
    expect(matches(contains, 'какая цена?')).toBe(true);
  });

  it('игнорирует регистр, включая кириллицу', () => {
    expect(matches(contains, 'КАКАЯ ЦЕНА')).toBe(true);
    expect(matches(exact, 'Цена')).toBe(true);
  });

  it('exact терпит пробелы и пунктуацию вокруг', () => {
    expect(matches(exact, '  цена?  ')).toBe(true);
    expect(matches(exact, 'цена!!!')).toBe(true);
  });

  it('exact не срабатывает на другую фразу', () => {
    expect(matches(exact, 'цена товара')).toBe(false);
  });

  it('starts_with проверяет начало', () => {
    expect(matches(starts, 'Привет, есть в наличии?')).toBe(true);
    expect(matches(starts, 'Скажите, привет всем')).toBe(false);
  });

  it('пустой ввод не матчится', () => {
    expect(matches(contains, '')).toBe(false);
    expect(matches(contains, '   ')).toBe(false);
  });
});
```

- [ ] **Step 2: Запустить тесты, убедиться что падают**

Run: `npx vitest run tests/core/matcher.test.ts`
Expected: FAIL — модуль не найден

- [ ] **Step 3: Создать заготовку `src/core/matcher.ts` и ОСТАНОВИТЬСЯ**

```ts
import type { Trigger } from './scenario.js';

/**
 * Решает, сработал ли триггер сценария на сообщение пользователя.
 * Вызывается на КАЖДОЕ входящее сообщение и комментарий.
 *
 * Компромиссы, которые нужно взвесить:
 *  - регистр: для кириллицы нужен toLocaleLowerCase, не toLowerCase;
 *  - contains ловит и ложные срабатывания: триггер "цена" совпадёт с
 *    "цена меня не волнует, у вас брак" — и бот пришлёт прайс на претензию;
 *  - люди пишут "цена?", "цена!!!", "  цена  ", "цена 🙏" — exact без
 *    нормализации промахнётся почти всегда;
 *  - текст уже обрезан по MAX_INCOMING_TEXT_LENGTH вызывающей стороной (S7).
 *
 * @param trigger  правило из YAML
 * @param userText текст от пользователя
 * @returns        true если сценарий должен запуститься
 */
export function matches(trigger: Trigger, userText: string): boolean {
  throw new Error('НЕ РЕАЛИЗОВАНО — реализует владелец проекта');
}
```

- [ ] **Step 4: Владелец пишет реализацию, агент делает ревью**

- [ ] **Step 5: Запустить тесты, убедиться что проходят**

Run: `npx vitest run tests/core/matcher.test.ts`
Expected: PASS, 6 тестов

- [ ] **Step 6: Коммит**

```bash
git add -A
git commit -m "feat(core): матчер триггеров сценариев"
```

---

## Task 4: Движок конечного автомата

**Files:**
- Create: `src/core/engine.ts`
- Test: `tests/core/engine.test.ts`, `tests/core/purity.test.ts`

**Interfaces:**
- Consumes: `Scenario`, `ScenarioStep` из `scenario.ts`; `matches` из `matcher.ts`; `IncomingEvent`, `OutgoingAction`, `ConversationState`, `emptyState` из `types.ts`
- Produces: `step(scenarios: Scenario[], state: ConversationState, event: IncomingEvent): StepResult`, где `interface StepResult { state: ConversationState; actions: OutgoingAction[] }`

- [ ] **Step 1: Написать падающий тест поведения**

`tests/core/engine.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { step } from '../../src/core/engine.js';
import { parseScenario } from '../../src/core/scenario.js';
import { emptyState, type IncomingEvent } from '../../src/core/types.js';

const scenario = parseScenario([
  'id: price',
  'trigger: { type: contains, value: цена }',
  'steps:',
  '  - id: ask_phone',
  '    say: "Оставьте номер"',
  '    save_reply_as: phone',
  '    next: done',
  '  - id: done',
  '    say: "Спасибо!"',
  '    notify_operator: "новая заявка"',
].join('\n'));

function evt(text: string): IncomingEvent {
  return {
    platform: 'instagram',
    kind: 'direct_message',
    externalUserId: 'u1',
    externalThreadId: 't1',
    externalCommentId: null,
    text,
    payload: null,
    dedupeKey: `k-${text}`,
    receivedAt: new Date('2026-08-26T10:00:00Z'),
  };
}

describe('step', () => {
  it('запускает сценарий по триггеру и отдаёт первый шаг', () => {
    const r = step([scenario], emptyState(), evt('какая цена?'));
    expect(r.state.stepId).toBe('ask_phone');
    expect(r.actions).toEqual([{ type: 'send_text', text: 'Оставьте номер' }]);
  });

  it('молчит, если ни один триггер не сработал', () => {
    const r = step([scenario], emptyState(), evt('добрый день'));
    expect(r.state.stepId).toBeNull();
    expect(r.actions).toEqual([]);
  });

  it('сохраняет ответ пользователя в контекст', () => {
    const started = step([scenario], emptyState(), evt('цена'));
    const r = step([scenario], started.state, evt('+7 999 111 22 33'));
    expect(r.state.context.get('phone')).toBe('+7 999 111 22 33');
    // шаг done не имеет next — значит воронка завершена, stepId сбрасывается
    expect(r.state.stepId).toBeNull();
  });

  it('на последнем шаге зовёт оператора и завершает диалог', () => {
    const s1 = step([scenario], emptyState(), evt('цена'));
    const s2 = step([scenario], s1.state, evt('+7 999 111 22 33'));
    expect(s2.actions).toEqual([
      { type: 'send_text', text: 'Спасибо!' },
      { type: 'notify_operator', reason: 'новая заявка', context: { phone: '+7 999 111 22 33' } },
    ]);
    expect(s2.state.stepId).toBeNull();
  });

  it('не мутирует переданное состояние', () => {
    const before = emptyState();
    step([scenario], before, evt('цена'));
    expect(before.stepId).toBeNull();
    expect(before.context.size).toBe(0);
  });

  it('на комментарий отвечает комментарием, а не директом', () => {
    const commentEvent: IncomingEvent = { ...evt('цена'), kind: 'comment', externalCommentId: 'c1' };
    const r = step([scenario], emptyState(), commentEvent);
    expect(r.actions).toEqual([{ type: 'reply_comment', text: 'Оставьте номер' }]);
  });
});
```

- [ ] **Step 2: Написать тест чистоты ядра**

`tests/core/purity.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

// Инфраструктура запрещена везде в core
const FORBIDDEN_EVERYWHERE = ['fastify', 'drizzle', 'fetch(', 'process.env', 'import(' ];
// Имена платформ запрещены везде, КРОМЕ types.ts: там живёт union `Platform`,
// и это единственное законное место, где ядро вообще их перечисляет.
const FORBIDDEN_OUTSIDE_TYPES = ['instagram', 'tiktok', 'meta'];

describe('чистота слоя core', () => {
  it('core не упоминает платформы и инфраструктуру', () => {
    const dir = 'src/core';
    for (const file of readdirSync(dir)) {
      const text = readFileSync(join(dir, file), 'utf8').toLowerCase();

      for (const word of FORBIDDEN_EVERYWHERE) {
        expect(text, `${file} содержит запрещённое "${word}"`).not.toContain(word);
      }
      if (file === 'types.ts') continue;
      for (const word of FORBIDDEN_OUTSIDE_TYPES) {
        expect(text, `${file} содержит имя платформы "${word}"`).not.toContain(word);
      }
    }
  });
});
```

- [ ] **Step 3: Запустить тесты, убедиться что падают**

Run: `npx vitest run tests/core/`
Expected: FAIL — `engine.js` не найден

- [ ] **Step 4: Реализовать `src/core/engine.ts`**

```ts
import { matches } from './matcher.js';
import type { Scenario, ScenarioStep } from './scenario.js';
import type { ConversationState, IncomingEvent, OutgoingAction } from './types.js';

export interface StepResult {
  state: ConversationState;
  actions: OutgoingAction[];
}

/**
 * Чистая функция. Ни await, ни БД, ни сети — вся бизнес-логика бота здесь,
 * и вся она тестируется без интернета и без моков.
 */
export function step(
  scenarios: Scenario[],
  state: ConversationState,
  event: IncomingEvent,
): StepResult {
  const text = (event.text ?? '').trim();
  const next: ConversationState = {
    stepId: state.stepId,
    context: new Map(state.context),
    lastUserMessageAt: event.receivedAt,
  };

  // Диалог не начат: ищем сценарий, чей триггер сработал
  if (next.stepId === null) {
    const scenario = scenarios.find((s) => matches(s.trigger, text));
    if (scenario === undefined) return { state: next, actions: [] };

    const first = scenario.steps[0];
    if (first === undefined) return { state: next, actions: [] };

    next.stepId = first.id;
    return { state: next, actions: renderStep(first, next, event) };
  }

  // Диалог идёт: находим текущий шаг
  const scenario = scenarios.find((s) => s.steps.some((st) => st.id === next.stepId));
  const current = scenario?.steps.find((st) => st.id === next.stepId);
  if (scenario === undefined || current === undefined) {
    // Сценарий переименовали или удалили под работающим диалогом — сбрасываем
    return { state: { ...next, stepId: null }, actions: [] };
  }

  if (current.save_reply_as !== undefined && text.length > 0) {
    next.context.set(current.save_reply_as, text);
  }

  if (current.next === undefined) {
    return { state: { ...next, stepId: null }, actions: [] };
  }

  const following = scenario.steps.find((st) => st.id === current.next);
  if (following === undefined) {
    return { state: { ...next, stepId: null }, actions: [] };
  }

  const actions = renderStep(following, next, event);
  // Шаг без next — конец воронки
  next.stepId = following.next === undefined ? null : following.id;
  return { state: next, actions };
}

// Параметр НЕ называется step: это затенило бы экспортируемую функцию step
// в этом же модуле и превратило бы опечатку в молчаливый баг.
function renderStep(
  target: ScenarioStep,
  state: ConversationState,
  event: IncomingEvent,
): OutgoingAction[] {
  const actions: OutgoingAction[] = [];

  if (target.buttons !== undefined && target.buttons.length > 0) {
    actions.push({ type: 'send_buttons', text: target.say, buttons: target.buttons });
  } else if (event.kind === 'comment') {
    actions.push({ type: 'reply_comment', text: target.say });
  } else {
    actions.push({ type: 'send_text', text: target.say });
  }

  if (target.notify_operator !== undefined) {
    actions.push({
      type: 'notify_operator',
      reason: target.notify_operator,
      context: Object.fromEntries(state.context),
    });
  }
  return actions;
}
```

- [ ] **Step 5: Запустить тесты, убедиться что проходят**

Run: `npx vitest run tests/core/`
Expected: PASS — engine 6 тестов, purity 1, matcher 6, scenario 5

- [ ] **Step 6: Коммит**

```bash
git add -A
git commit -m "feat(core): движок сценариев как чистая функция"
```

---

## Task 5: Троттлинг на контакт (S8)

**Files:**
- Create: `src/core/throttle.ts`
- Test: `tests/core/throttle.test.ts`

**Interfaces:**
- Consumes: ничего
- Produces: `class ReplyThrottle { constructor(maxPerMinute: number); allow(contactKey: string, now: Date): boolean }`

- [ ] **Step 1: Написать падающий тест**

`tests/core/throttle.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { ReplyThrottle } from '../../src/core/throttle.js';

const t0 = new Date('2026-08-26T10:00:00Z');
const plus = (sec: number) => new Date(t0.getTime() + sec * 1000);

describe('ReplyThrottle', () => {
  it('пропускает до лимита', () => {
    const th = new ReplyThrottle(3);
    expect(th.allow('u1', t0)).toBe(true);
    expect(th.allow('u1', t0)).toBe(true);
    expect(th.allow('u1', t0)).toBe(true);
    expect(th.allow('u1', t0)).toBe(false);
  });

  it('считает лимит отдельно для каждого контакта', () => {
    const th = new ReplyThrottle(1);
    expect(th.allow('u1', t0)).toBe(true);
    expect(th.allow('u2', t0)).toBe(true);
    expect(th.allow('u1', t0)).toBe(false);
  });

  it('освобождает лимит через минуту', () => {
    const th = new ReplyThrottle(1);
    expect(th.allow('u1', t0)).toBe(true);
    expect(th.allow('u1', plus(30))).toBe(false);
    expect(th.allow('u1', plus(61))).toBe(true);
  });
});
```

- [ ] **Step 2: Запустить тест, убедиться что падает**

Run: `npx vitest run tests/core/throttle.test.ts`
Expected: FAIL — модуль не найден

- [ ] **Step 3: Реализовать `src/core/throttle.ts`**

```ts
/**
 * Скользящее окно в одну минуту на каждый контакт.
 * Защита от того, что один пользователь спамит директ, бот отвечает на всё,
 * и аккаунт получает флаг за спам (S8).
 */
export class ReplyThrottle {
  private readonly hits = new Map<string, number[]>();

  constructor(private readonly maxPerMinute: number) {}

  allow(contactKey: string, now: Date): boolean {
    const cutoff = now.getTime() - 60_000;
    const recent = (this.hits.get(contactKey) ?? []).filter((t) => t > cutoff);

    if (recent.length >= this.maxPerMinute) {
      this.hits.set(contactKey, recent);
      return false;
    }
    recent.push(now.getTime());
    this.hits.set(contactKey, recent);
    return true;
  }
}
```

- [ ] **Step 4: Запустить тест, убедиться что проходит**

Run: `npx vitest run tests/core/throttle.test.ts`
Expected: PASS, 3 теста

- [ ] **Step 5: Коммит**

```bash
git add -A
git commit -m "feat(core): троттлинг ответов на контакт"
```

**Контрольная точка фазы 1.** Весь мозг бота готов и полностью покрыт тестами,
при этом не написано ни строчки сетевого кода. Запусти `npx vitest run` —
всё должно быть зелёным.

---

# Фаза 2 — память

## Task 6: Схема БД и шифрование токенов

**Files:**
- Create: `src/storage/schema.ts`, `src/storage/crypto.ts`, `src/storage/db.ts`, `drizzle.config.ts`
- Test: `tests/storage/crypto.test.ts`

**Interfaces:**
- Consumes: `Config` из `src/config.ts`
- Produces:
  - таблицы `contacts`, `conversations`, `processedEvents`, `eventQueue`, `outbox`, `platformCredentials`
  - `encrypt(plaintext: string, hexKey: string): string`, `decrypt(payload: string, hexKey: string): string`
  - `createDb(url: string)` возвращающая drizzle-инстанс

- [ ] **Step 1: Написать падающий тест шифрования**

`tests/storage/crypto.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { encrypt, decrypt } from '../../src/storage/crypto.js';

const key = 'b'.repeat(64);

describe('crypto токенов', () => {
  it('расшифровывает то, что зашифровал', () => {
    const secret = 'tiktok-refresh-token-12345';
    expect(decrypt(encrypt(secret, key), key)).toBe(secret);
  });

  it('шифротекст не содержит исходный секрет', () => {
    expect(encrypt('my-secret', key)).not.toContain('my-secret');
  });

  it('дважды шифрует по-разному (случайный IV)', () => {
    expect(encrypt('same', key)).not.toBe(encrypt('same', key));
  });

  it('падает при подмене шифротекста', () => {
    const payload = encrypt('secret', key);
    const tampered = payload.slice(0, -2) + (payload.endsWith('aa') ? 'bb' : 'aa');
    expect(() => decrypt(tampered, key)).toThrow();
  });

  it('падает при неверном ключе', () => {
    expect(() => decrypt(encrypt('secret', key), 'c'.repeat(64))).toThrow();
  });
});
```

- [ ] **Step 2: Запустить тест, убедиться что падает**

Run: `npx vitest run tests/storage/crypto.test.ts`
Expected: FAIL — модуль не найден

- [ ] **Step 3: Реализовать `src/storage/crypto.ts`**

```ts
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

const IV_BYTES = 12;
const TAG_BYTES = 16;

/**
 * AES-256-GCM. GCM выбран, а не CBC, потому что даёт аутентификацию:
 * подмена шифротекста обнаруживается при расшифровке, а не проходит молча.
 * Формат: hex(iv) : hex(tag) : hex(ciphertext)
 */
export function encrypt(plaintext: string, hexKey: string): string {
  const key = Buffer.from(hexKey, 'hex');
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const ct = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  return [iv.toString('hex'), cipher.getAuthTag().toString('hex'), ct.toString('hex')].join(':');
}

export function decrypt(payload: string, hexKey: string): string {
  const parts = payload.split(':');
  const [ivHex, tagHex, ctHex] = parts;
  if (parts.length !== 3 || ivHex === undefined || tagHex === undefined || ctHex === undefined) {
    throw new Error('Повреждённый шифротекст');
  }
  const tag = Buffer.from(tagHex, 'hex');
  if (tag.length !== TAG_BYTES) throw new Error('Повреждённый шифротекст');

  const decipher = createDecipheriv('aes-256-gcm', Buffer.from(hexKey, 'hex'), Buffer.from(ivHex, 'hex'));
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(Buffer.from(ctHex, 'hex')), decipher.final()]).toString('utf8');
}
```

- [ ] **Step 4: Реализовать `src/storage/schema.ts`**

```ts
import { sql } from 'drizzle-orm';
import { index, integer, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core';

export const contacts = sqliteTable(
  'contacts',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    platform: text('platform').notNull(),
    externalUserId: text('external_user_id').notNull(),
    createdAt: integer('created_at', { mode: 'timestamp' }).notNull().default(sql`(unixepoch())`),
  },
  (t) => ({ uniq: uniqueIndex('contacts_platform_user').on(t.platform, t.externalUserId) }),
);

export const conversations = sqliteTable(
  'conversations',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    contactId: integer('contact_id').notNull().references(() => contacts.id),
    externalThreadId: text('external_thread_id').notNull(),
    stepId: text('step_id'),
    /** контекст сериализуется как JSON, в память грузится как Map (S6) */
    contextJson: text('context_json').notNull().default('{}'),
    lastUserMessageAt: integer('last_user_message_at', { mode: 'timestamp' }),
  },
  (t) => ({ uniq: uniqueIndex('conv_contact_thread').on(t.contactId, t.externalThreadId) }),
);

/** Защита от повторной доставки: обе платформы гарантируют at-least-once */
export const processedEvents = sqliteTable(
  'processed_events',
  {
    dedupeKey: text('dedupe_key').primaryKey(),
    processedAt: integer('processed_at', { mode: 'timestamp' }).notNull().default(sql`(unixepoch())`),
  },
);

/** Очередь: HTTP-обработчик только кладёт сюда и сразу отвечает 200 */
export const eventQueue = sqliteTable(
  'event_queue',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    eventJson: text('event_json').notNull(),
    status: text('status', { enum: ['pending', 'done', 'failed'] }).notNull().default('pending'),
    createdAt: integer('created_at', { mode: 'timestamp' }).notNull().default(sql`(unixepoch())`),
  },
  (t) => ({ byStatus: index('queue_status').on(t.status, t.id) }),
);

/** Outbox: исходящие с повторами и экспоненциальной задержкой */
export const outbox = sqliteTable(
  'outbox',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    platform: text('platform').notNull(),
    actionJson: text('action_json').notNull(),
    deliveryContextJson: text('delivery_context_json').notNull(),
    status: text('status', { enum: ['pending', 'sent', 'failed'] }).notNull().default('pending'),
    attempts: integer('attempts').notNull().default(0),
    nextAttemptAt: integer('next_attempt_at', { mode: 'timestamp' }).notNull().default(sql`(unixepoch())`),
    /** нужен для проверки 24-часового окна Instagram при отложенных повторах */
    createdAt: integer('created_at', { mode: 'timestamp' }).notNull().default(sql`(unixepoch())`),
    lastError: text('last_error'),
  },
  (t) => ({ byDue: index('outbox_due').on(t.status, t.nextAttemptAt) }),
);

/** S4: значения зашифрованы AES-256-GCM, в логи не попадают никогда */
export const platformCredentials = sqliteTable('platform_credentials', {
  platform: text('platform').primaryKey(),
  accessTokenEnc: text('access_token_enc').notNull(),
  refreshTokenEnc: text('refresh_token_enc'),
  expiresAt: integer('expires_at', { mode: 'timestamp' }),
});
```

- [ ] **Step 5: Реализовать `src/storage/db.ts`**

```ts
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import * as schema from './schema.js';

export function createDb(url: string) {
  if (url !== ':memory:') mkdirSync(dirname(url), { recursive: true });
  const sqlite = new Database(url);
  sqlite.pragma('journal_mode = WAL');
  sqlite.pragma('foreign_keys = ON');
  return drizzle(sqlite, { schema });
}

export type Db = ReturnType<typeof createDb>;
```

- [ ] **Step 6: Создать `drizzle.config.ts` и сгенерировать миграции**

```ts
import type { Config } from 'drizzle-kit';

export default {
  schema: './src/storage/schema.ts',
  out: './drizzle',
  dialect: 'sqlite',
} satisfies Config;
```

```bash
npx drizzle-kit generate
```

- [ ] **Step 7: Запустить тесты, убедиться что проходят**

Run: `npx vitest run tests/storage/crypto.test.ts`
Expected: PASS, 5 тестов

- [ ] **Step 8: Коммит**

```bash
git add -A
git commit -m "feat(storage): схема БД и шифрование токенов платформ"
```

---

## Task 7: Запросы, очередь и outbox

**Files:**
- Create: `src/storage/queries.ts`
- Test: `tests/storage/queries.test.ts`

**Interfaces:**
- Consumes: `Db` из `db.ts`, таблицы из `schema.ts`, `ConversationState`/`IncomingEvent`/`OutgoingAction` из `core/types.ts`
- Produces:
  - `markProcessed(db, dedupeKey): boolean` — `false` если уже обработано
  - `enqueueEvent(db, event): void`
  - `dequeueEvents(db, limit): { id: number; event: IncomingEvent }[]`
  - `completeEvent(db, id, status): void`
  - `loadState(db, platform, externalUserId, threadId): { conversationId: number; state: ConversationState }`
  - `saveState(db, conversationId, state): void`
  - `enqueueOutbox(db, platform, action, deliveryContext): void`
  - `dueOutbox(db, now, limit): OutboxRow[]`
  - `markSent(db, id): void`
  - `markRetry(db, id, error, now): void` — экспоненциальная задержка
  - `markFailedPermanently(db, id, error): void`

- [ ] **Step 1: Написать падающий тест**

`tests/storage/queries.test.ts`:

```ts
import { describe, it, expect, beforeEach } from 'vitest';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { createDb, type Db } from '../../src/storage/db.js';
import {
  markProcessed, enqueueEvent, dequeueEvents, completeEvent,
  loadState, saveState, enqueueOutbox, dueOutbox, markSent, markRetry,
} from '../../src/storage/queries.js';
import type { IncomingEvent } from '../../src/core/types.js';

let db: Db;

const event: IncomingEvent = {
  platform: 'instagram',
  kind: 'direct_message',
  externalUserId: 'u1',
  externalThreadId: 't1',
  externalCommentId: null,
  text: 'цена',
  payload: null,
  dedupeKey: 'mid.abc',
  receivedAt: new Date('2026-08-26T10:00:00Z'),
};

beforeEach(() => {
  db = createDb(':memory:');
  migrate(db, { migrationsFolder: './drizzle' });
});

describe('дедупликация', () => {
  it('первый раз пропускает, второй — нет', () => {
    expect(markProcessed(db, 'mid.abc')).toBe(true);
    expect(markProcessed(db, 'mid.abc')).toBe(false);
  });
});

describe('очередь событий', () => {
  it('кладёт и забирает событие с сохранением типов', () => {
    enqueueEvent(db, event);
    const rows = dequeueEvents(db, 10);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.event.text).toBe('цена');
    expect(rows[0]?.event.receivedAt).toBeInstanceOf(Date);
  });

  it('обработанное событие больше не выдаётся', () => {
    enqueueEvent(db, event);
    const [row] = dequeueEvents(db, 10);
    completeEvent(db, row!.id, 'done');
    expect(dequeueEvents(db, 10)).toHaveLength(0);
  });
});

describe('состояние диалога', () => {
  it('создаёт пустое состояние для нового контакта', () => {
    const { state } = loadState(db, 'instagram', 'u1', 't1');
    expect(state.stepId).toBeNull();
    expect(state.context.size).toBe(0);
  });

  it('сохраняет и читает контекст как Map', () => {
    const { conversationId } = loadState(db, 'instagram', 'u1', 't1');
    saveState(db, conversationId, {
      stepId: 'ask_phone',
      context: new Map([['phone', '+79991112233']]),
      lastUserMessageAt: new Date('2026-08-26T10:00:00Z'),
    });
    const { state } = loadState(db, 'instagram', 'u1', 't1');
    expect(state.stepId).toBe('ask_phone');
    expect(state.context).toBeInstanceOf(Map);
    expect(state.context.get('phone')).toBe('+79991112233');
  });
});

describe('outbox', () => {
  const now = new Date('2026-08-26T10:00:00Z');

  it('выдаёт только созревшие записи', () => {
    enqueueOutbox(db, 'instagram', { type: 'send_text', text: 'привет' }, { threadId: 't1' });
    expect(dueOutbox(db, now, 10)).toHaveLength(1);
  });

  it('после markSent запись не выдаётся', () => {
    enqueueOutbox(db, 'instagram', { type: 'send_text', text: 'привет' }, { threadId: 't1' });
    const [row] = dueOutbox(db, now, 10);
    markSent(db, row!.id);
    expect(dueOutbox(db, now, 10)).toHaveLength(0);
  });

  it('markRetry откладывает попытку экспоненциально', () => {
    enqueueOutbox(db, 'instagram', { type: 'send_text', text: 'привет' }, { threadId: 't1' });
    const [row] = dueOutbox(db, now, 10);
    markRetry(db, row!.id, 'network error', now);
    expect(dueOutbox(db, now, 10)).toHaveLength(0);
    const later = new Date(now.getTime() + 5 * 60_000);
    expect(dueOutbox(db, later, 10)).toHaveLength(1);
  });
});
```

- [ ] **Step 2: Запустить тест, убедиться что падает**

Run: `npx vitest run tests/storage/queries.test.ts`
Expected: FAIL — модуль не найден

- [ ] **Step 3: Реализовать `src/storage/queries.ts`**

```ts
import { and, asc, eq, lte } from 'drizzle-orm';
import type { Db } from './db.js';
import { contacts, conversations, eventQueue, outbox, processedEvents } from './schema.js';
import type {
  ConversationState, DeliveryContext, IncomingEvent, OutgoingAction, Platform,
} from '../core/types.js';

const BASE_BACKOFF_MS = 60_000;
const MAX_ATTEMPTS = 6;

export function markProcessed(db: Db, dedupeKey: string): boolean {
  const inserted = db
    .insert(processedEvents)
    .values({ dedupeKey })
    .onConflictDoNothing()
    .returning({ key: processedEvents.dedupeKey })
    .all();
  return inserted.length > 0;
}

export function enqueueEvent(db: Db, event: IncomingEvent): void {
  db.insert(eventQueue).values({ eventJson: JSON.stringify(event) }).run();
}

export function dequeueEvents(db: Db, limit: number): { id: number; event: IncomingEvent }[] {
  return db
    .select()
    .from(eventQueue)
    .where(eq(eventQueue.status, 'pending'))
    .orderBy(asc(eventQueue.id))
    .limit(limit)
    .all()
    .map((row) => {
      const raw = JSON.parse(row.eventJson) as IncomingEvent;
      return { id: row.id, event: { ...raw, receivedAt: new Date(raw.receivedAt) } };
    });
}

export function completeEvent(db: Db, id: number, status: 'done' | 'failed'): void {
  db.update(eventQueue).set({ status }).where(eq(eventQueue.id, id)).run();
}

export function loadState(
  db: Db,
  platform: Platform,
  externalUserId: string,
  threadId: string,
): { conversationId: number; state: ConversationState } {
  db.insert(contacts).values({ platform, externalUserId }).onConflictDoNothing().run();
  const contact = db
    .select()
    .from(contacts)
    .where(and(eq(contacts.platform, platform), eq(contacts.externalUserId, externalUserId)))
    .get();
  if (contact === undefined) throw new Error('Не удалось создать контакт');

  db.insert(conversations)
    .values({ contactId: contact.id, externalThreadId: threadId })
    .onConflictDoNothing()
    .run();
  const conv = db
    .select()
    .from(conversations)
    .where(and(eq(conversations.contactId, contact.id), eq(conversations.externalThreadId, threadId)))
    .get();
  if (conv === undefined) throw new Error('Не удалось создать диалог');

  const plain = JSON.parse(conv.contextJson) as Record<string, string>;
  return {
    conversationId: conv.id,
    state: {
      stepId: conv.stepId,
      context: new Map(Object.entries(plain)),
      lastUserMessageAt: conv.lastUserMessageAt,
    },
  };
}

export function saveState(db: Db, conversationId: number, state: ConversationState): void {
  db.update(conversations)
    .set({
      stepId: state.stepId,
      contextJson: JSON.stringify(Object.fromEntries(state.context)),
      lastUserMessageAt: state.lastUserMessageAt,
    })
    .where(eq(conversations.id, conversationId))
    .run();
}

export function enqueueOutbox(
  db: Db,
  platform: Platform,
  action: OutgoingAction,
  deliveryContext: DeliveryContext,
): void {
  db.insert(outbox)
    .values({
      platform,
      actionJson: JSON.stringify(action),
      deliveryContextJson: JSON.stringify(deliveryContext),
    })
    .run();
}

export interface OutboxRow {
  id: number;
  platform: Platform;
  action: OutgoingAction;
  deliveryContext: DeliveryContext;
  attempts: number;
  createdAt: Date;
}

export function dueOutbox(db: Db, now: Date, limit: number): OutboxRow[] {
  return db
    .select()
    .from(outbox)
    .where(and(eq(outbox.status, 'pending'), lte(outbox.nextAttemptAt, now)))
    .orderBy(asc(outbox.id))
    .limit(limit)
    .all()
    .map((r) => ({
      id: r.id,
      platform: r.platform as Platform,
      action: JSON.parse(r.actionJson) as OutgoingAction,
      deliveryContext: JSON.parse(r.deliveryContextJson) as DeliveryContext,
      attempts: r.attempts,
      createdAt: r.createdAt,
    }));
}

export function markSent(db: Db, id: number): void {
  db.update(outbox).set({ status: 'sent' }).where(eq(outbox.id, id)).run();
}

/** Временная ошибка: повтор с экспоненциальной задержкой 1, 2, 4, 8... минут */
export function markRetry(db: Db, id: number, error: string, now: Date): void {
  const row = db.select().from(outbox).where(eq(outbox.id, id)).get();
  if (row === undefined) return;

  const attempts = row.attempts + 1;
  if (attempts >= MAX_ATTEMPTS) {
    markFailedPermanently(db, id, error);
    return;
  }
  const delay = BASE_BACKOFF_MS * 2 ** (attempts - 1);
  db.update(outbox)
    .set({ attempts, lastError: error, nextAttemptAt: new Date(now.getTime() + delay) })
    .where(eq(outbox.id, id))
    .run();
}

/** Осмысленный отказ платформы (4xx) — повторять бессмысленно */
export function markFailedPermanently(db: Db, id: number, error: string): void {
  db.update(outbox).set({ status: 'failed', lastError: error }).where(eq(outbox.id, id)).run();
}
```

- [ ] **Step 4: Запустить тест, убедиться что проходит**

Run: `npx vitest run tests/storage/queries.test.ts`
Expected: PASS, 8 тестов

- [ ] **Step 5: Коммит**

```bash
git add -A
git commit -m "feat(storage): состояние диалогов, очередь событий и outbox"
```

---

# Фаза 3 — Instagram, первый живой канал

## Task 8: Проверка подписи Meta — самая критичная задача плана

**Files:**
- Create: `src/adapters/types.ts`, `src/adapters/instagram/verify.ts`
- Test: `tests/adapters/instagram/verify.test.ts`

**Interfaces:**
- Consumes: `Platform`, `IncomingEvent`, `OutgoingAction`, `DeliveryContext` из `core/types.ts`
- Produces:
  - интерфейсы `MessageSender`, `WebhookSource`, `PollingSource`
  - `verifyMetaSignature(rawBody: Buffer, header: string | undefined, appSecret: string): boolean`
  - `verifyHandshakeToken(provided: string | undefined, expected: string): boolean`

- [ ] **Step 1: Написать падающий тест — это тест безопасности, он важнее остальных**

`tests/adapters/instagram/verify.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { createHmac } from 'node:crypto';
import { verifyMetaSignature, verifyHandshakeToken } from '../../../src/adapters/instagram/verify.js';

const SECRET = 'app-secret';
const body = Buffer.from('{"object":"instagram","entry":[]}', 'utf8');
const good = 'sha256=' + createHmac('sha256', SECRET).update(body).digest('hex');

describe('verifyMetaSignature', () => {
  it('принимает корректную подпись', () => {
    expect(verifyMetaSignature(body, good, SECRET)).toBe(true);
  });

  it('отвергает подпись от другого секрета', () => {
    const forged = 'sha256=' + createHmac('sha256', 'wrong').update(body).digest('hex');
    expect(verifyMetaSignature(body, forged, SECRET)).toBe(false);
  });

  it('отвергает подпись, посчитанную по другому телу', () => {
    const other = Buffer.from('{"object":"instagram","entry":[1]}', 'utf8');
    expect(verifyMetaSignature(other, good, SECRET)).toBe(false);
  });

  it('отвергает отсутствующий заголовок', () => {
    expect(verifyMetaSignature(body, undefined, SECRET)).toBe(false);
  });

  it('отвергает заголовок без префикса sha256=', () => {
    expect(verifyMetaSignature(body, good.replace('sha256=', ''), SECRET)).toBe(false);
  });

  it('отвергает подпись неверной длины, не бросая исключение', () => {
    expect(() => verifyMetaSignature(body, 'sha256=abcd', SECRET)).not.toThrow();
    expect(verifyMetaSignature(body, 'sha256=abcd', SECRET)).toBe(false);
  });

  it('отвергает мусор вместо hex', () => {
    expect(() => verifyMetaSignature(body, 'sha256=не-хекс', SECRET)).not.toThrow();
    expect(verifyMetaSignature(body, 'sha256=не-хекс', SECRET)).toBe(false);
  });

  it('КЛЮЧЕВОЕ: JSON.stringify от распарсенного тела даёт другую подпись', () => {
    // именно здесь ломаются почти все реализации и отключают проверку
    const reserialized = Buffer.from(JSON.stringify(JSON.parse(body.toString())), 'utf8');
    const sigOfReserialized = 'sha256=' + createHmac('sha256', SECRET).update(reserialized).digest('hex');
    const spaced = Buffer.from('{"object": "instagram", "entry": []}', 'utf8');
    expect(verifyMetaSignature(spaced, sigOfReserialized, SECRET)).toBe(false);
  });
});

describe('verifyHandshakeToken', () => {
  it('принимает совпадающий токен', () => {
    expect(verifyHandshakeToken('tok', 'tok')).toBe(true);
  });

  it('отвергает несовпадающий и отсутствующий', () => {
    expect(verifyHandshakeToken('nope', 'tok')).toBe(false);
    expect(verifyHandshakeToken(undefined, 'tok')).toBe(false);
  });

  it('отвергает токен другой длины, не бросая исключение', () => {
    expect(() => verifyHandshakeToken('t', 'tok')).not.toThrow();
    expect(verifyHandshakeToken('t', 'tok')).toBe(false);
  });
});
```

- [ ] **Step 2: Запустить тест, убедиться что падает**

Run: `npx vitest run tests/adapters/instagram/verify.test.ts`
Expected: FAIL — модуль не найден

- [ ] **Step 3: Реализовать `src/adapters/types.ts`**

```ts
import type { DeliveryContext, IncomingEvent, OutgoingAction, Platform } from '../core/types.js';

/**
 * Осмысленный отказ платформы (4xx): повторять бессмысленно.
 * Живёт здесь, а не в instagram/send.ts — иначе worker.ts, который ничего
 * не должен знать о конкретных платформах, импортировал бы Instagram-модуль.
 */
export class PermanentDeliveryError extends Error {}

export interface MessageSender {
  readonly platform: Platform;
  execute(action: OutgoingAction, ctx: DeliveryContext): Promise<void>;
}

/** Платформа сама присылает события (Instagram) */
export interface WebhookSource extends MessageSender {
  parseWebhook(body: unknown): IncomingEvent[];
}

/** Платформу приходится опрашивать (TikTok — вебхука на комментарии нет) */
export interface PollingSource extends MessageSender {
  poll(since: Date): Promise<IncomingEvent[]>;
}
```

- [ ] **Step 4: Реализовать `src/adapters/instagram/verify.ts`**

```ts
import { createHmac, timingSafeEqual } from 'node:crypto';

const PREFIX = 'sha256=';

/**
 * S1. Два подвоха, на которых ломаются почти все реализации:
 *
 * 1. Подпись считается от СЫРЫХ БАЙТ тела. JSON.stringify(req.body) не равен
 *    исходным байтам — отличается порядок ключей, пробелы, экранирование
 *    юникода. Поэтому в server.ts тело сохраняется до парсинга.
 * 2. Сравнение только timingSafeEqual: обычное === выходит на первом
 *    несовпавшем байте, и подпись подбирается по времени ответа.
 *    timingSafeEqual бросает при разной длине, поэтому длину проверяем раньше.
 */
export function verifyMetaSignature(
  rawBody: Buffer,
  header: string | undefined,
  appSecret: string,
): boolean {
  if (header === undefined || !header.startsWith(PREFIX)) return false;

  const hex = header.slice(PREFIX.length);
  if (!/^[0-9a-f]+$/i.test(hex)) return false;

  const provided = Buffer.from(hex, 'hex');
  const expected = createHmac('sha256', appSecret).update(rawBody).digest();

  if (provided.length !== expected.length) return false;
  return timingSafeEqual(provided, expected);
}

/** S2: тот же constant-time для hub.verify_token в GET-хендшейке */
export function verifyHandshakeToken(provided: string | undefined, expected: string): boolean {
  if (provided === undefined) return false;

  const a = Buffer.from(provided, 'utf8');
  const b = Buffer.from(expected, 'utf8');
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}
```

- [ ] **Step 5: Запустить тест, убедиться что проходит**

Run: `npx vitest run tests/adapters/instagram/verify.test.ts`
Expected: PASS, 11 тестов

- [ ] **Step 6: Коммит**

```bash
git add -A
git commit -m "feat(instagram): constant-time проверка подписи вебхука"
```

---

## Task 9: Разбор вебхука Instagram и защита от эхо-петли

**Files:**
- Create: `src/adapters/instagram/parse.ts`
- Create: `tests/fixtures/ig-dm.json`, `tests/fixtures/ig-echo.json`, `tests/fixtures/ig-comment.json`
- Test: `tests/adapters/instagram/parse.test.ts`

**Interfaces:**
- Consumes: `IncomingEvent` из `core/types.ts`
- Produces: `parseInstagramWebhook(body: unknown): IncomingEvent[]`

- [ ] **Step 1: Создать фикстуры реальной формы вебхуков**

`tests/fixtures/ig-dm.json`:

```json
{
  "object": "instagram",
  "entry": [
    {
      "id": "17841400000000000",
      "time": 1787000000,
      "messaging": [
        {
          "sender": { "id": "user-123" },
          "recipient": { "id": "17841400000000000" },
          "timestamp": 1787000000000,
          "message": { "mid": "mid.aaa", "text": "какая цена?" }
        }
      ]
    }
  ]
}
```

`tests/fixtures/ig-echo.json`:

```json
{
  "object": "instagram",
  "entry": [
    {
      "id": "17841400000000000",
      "time": 1787000001,
      "messaging": [
        {
          "sender": { "id": "17841400000000000" },
          "recipient": { "id": "user-123" },
          "timestamp": 1787000001000,
          "message": { "mid": "mid.bbb", "text": "Оставьте номер", "is_echo": true }
        }
      ]
    }
  ]
}
```

`tests/fixtures/ig-comment.json`:

```json
{
  "object": "instagram",
  "entry": [
    {
      "id": "17841400000000000",
      "time": 1787000002,
      "changes": [
        {
          "field": "comments",
          "value": {
            "id": "comment-1",
            "text": "цена?",
            "from": { "id": "user-456", "username": "buyer" },
            "media": { "id": "media-9" }
          }
        }
      ]
    }
  ]
}
```

- [ ] **Step 2: Написать падающий тест**

`tests/adapters/instagram/parse.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { parseInstagramWebhook } from '../../../src/adapters/instagram/parse.js';

const fixture = (name: string) =>
  JSON.parse(readFileSync(`tests/fixtures/${name}.json`, 'utf8')) as unknown;

describe('parseInstagramWebhook', () => {
  it('разбирает директ', () => {
    const [e] = parseInstagramWebhook(fixture('ig-dm'));
    expect(e?.kind).toBe('direct_message');
    expect(e?.externalUserId).toBe('user-123');
    expect(e?.text).toBe('какая цена?');
    expect(e?.dedupeKey).toBe('instagram:mid.aaa');
  });

  it('S3: отбрасывает эхо собственных сообщений — иначе бесконечная петля', () => {
    expect(parseInstagramWebhook(fixture('ig-echo'))).toEqual([]);
  });

  it('разбирает комментарий и сохраняет id комментария', () => {
    const [e] = parseInstagramWebhook(fixture('ig-comment'));
    expect(e?.kind).toBe('comment');
    expect(e?.externalCommentId).toBe('comment-1');
    expect(e?.externalThreadId).toBe('media-9');
    expect(e?.externalUserId).toBe('user-456');
  });

  it('не падает на мусоре', () => {
    expect(parseInstagramWebhook({})).toEqual([]);
    expect(parseInstagramWebhook(null)).toEqual([]);
    expect(parseInstagramWebhook({ entry: 'не массив' })).toEqual([]);
    expect(parseInstagramWebhook({ entry: [{ messaging: [{}] }] })).toEqual([]);
  });
});
```

- [ ] **Step 3: Запустить тест, убедиться что падает**

Run: `npx vitest run tests/adapters/instagram/parse.test.ts`
Expected: FAIL — модуль не найден

- [ ] **Step 4: Реализовать `src/adapters/instagram/parse.ts`**

```ts
import { z } from 'zod';
import type { IncomingEvent } from '../../core/types.js';

// Тело вебхука — чужие данные. Форма меняется между версиями API,
// поля бывают опциональными без предупреждения. Поэтому Zod, а не приведение типа.
const MessagingSchema = z.object({
  sender: z.object({ id: z.string() }),
  timestamp: z.number().optional(),
  message: z
    .object({
      mid: z.string(),
      text: z.string().optional(),
      is_echo: z.boolean().optional(),
      quick_reply: z.object({ payload: z.string() }).optional(),
    })
    .optional(),
});

const CommentChangeSchema = z.object({
  field: z.literal('comments'),
  value: z.object({
    id: z.string(),
    text: z.string().optional(),
    from: z.object({ id: z.string() }).optional(),
    media: z.object({ id: z.string() }).optional(),
  }),
});

const EntrySchema = z.object({
  id: z.string().optional(),
  time: z.number().optional(),
  messaging: z.array(MessagingSchema).optional(),
  changes: z.array(z.unknown()).optional(),
});

const BodySchema = z.object({ entry: z.array(EntrySchema).optional() });

export function parseInstagramWebhook(body: unknown): IncomingEvent[] {
  const parsed = BodySchema.safeParse(body);
  if (!parsed.success) return [];

  const events: IncomingEvent[] = [];

  for (const entry of parsed.data.entry ?? []) {
    for (const m of entry.messaging ?? []) {
      // S3: сообщения, отправленные самим бизнесом, возвращаются как эхо.
      // Не отфильтровать = бот отвечает сам себе бесконечно.
      if (m.message === undefined || m.message.is_echo === true) continue;

      const payload = m.message.quick_reply?.payload ?? null;
      events.push({
        platform: 'instagram',
        kind: payload === null ? 'direct_message' : 'button_click',
        externalUserId: m.sender.id,
        externalThreadId: m.sender.id,
        externalCommentId: null,
        text: m.message.text ?? null,
        payload,
        dedupeKey: `instagram:${m.message.mid}`,
        receivedAt: new Date(m.timestamp ?? Date.now()),
      });
    }

    for (const raw of entry.changes ?? []) {
      const change = CommentChangeSchema.safeParse(raw);
      if (!change.success) continue;

      const v = change.data.value;
      const authorId = v.from?.id;
      // Комментарий без автора или без медиа обработать нельзя
      if (authorId === undefined || v.media === undefined) continue;

      events.push({
        platform: 'instagram',
        kind: 'comment',
        externalUserId: authorId,
        externalThreadId: v.media.id,
        externalCommentId: v.id,
        text: v.text ?? null,
        payload: null,
        dedupeKey: `instagram:comment:${v.id}`,
        receivedAt: new Date((entry.time ?? Date.now() / 1000) * 1000),
      });
    }
  }
  return events;
}
```

- [ ] **Step 5: Запустить тест, убедиться что проходит**

Run: `npx vitest run tests/adapters/instagram/parse.test.ts`
Expected: PASS, 4 теста

- [ ] **Step 6: Коммит**

```bash
git add -A
git commit -m "feat(instagram): разбор вебхука и фильтр эхо-сообщений"
```

---

## Task 10: Отправка в Instagram

**Files:**
- Create: `src/adapters/instagram/send.ts`
- Test: `tests/adapters/instagram/send.test.ts`

**Interfaces:**
- Consumes: `WebhookSource` из `adapters/types.ts`, `parseInstagramWebhook`, `DeliveryContext`
- Produces:
  - `createInstagramAdapter(deps: { pageAccessToken: string; fetchFn?: typeof fetch }): WebhookSource`
  - (`PermanentDeliveryError` определён в Task 8, в `adapters/types.ts`)

- [ ] **Step 1: Написать падающий тест с подменённым fetch**

`tests/adapters/instagram/send.test.ts`:

```ts
import { describe, it, expect, vi } from 'vitest';
import { createInstagramAdapter } from '../../../src/adapters/instagram/send.js';
import { PermanentDeliveryError } from '../../../src/adapters/types.js';

function fakeFetch(status: number, body: unknown = {}) {
  return vi.fn(async () => new Response(JSON.stringify(body), { status }));
}

describe('instagram adapter execute', () => {
  it('отправляет текст в директ', async () => {
    const f = fakeFetch(200);
    const a = createInstagramAdapter({ pageAccessToken: 'tok', fetchFn: f as unknown as typeof fetch });
    await a.execute({ type: 'send_text', text: 'привет' }, { threadId: 'u1', userId: 'u1' });

    expect(f).toHaveBeenCalledOnce();
    const [url, init] = f.mock.calls[0]!;
    expect(String(url)).toContain('/messages');
    const sent = JSON.parse(String((init as RequestInit).body));
    expect(sent.recipient.id).toBe('u1');
    expect(sent.message.text).toBe('привет');
  });

  it('S4: токен уходит в заголовке, а не в URL — иначе он окажется в логах', async () => {
    const f = fakeFetch(200);
    const a = createInstagramAdapter({ pageAccessToken: 'tok', fetchFn: f as unknown as typeof fetch });
    await a.execute({ type: 'send_text', text: 'привет' }, { threadId: 'u1', userId: 'u1' });

    const [url, init] = f.mock.calls[0]!;
    expect(String(url)).not.toContain('tok');
    expect((init as RequestInit).headers).toMatchObject({ Authorization: 'Bearer tok' });
  });

  it('отвечает на комментарий по его id', async () => {
    const f = fakeFetch(200);
    const a = createInstagramAdapter({ pageAccessToken: 'tok', fetchFn: f as unknown as typeof fetch });
    await a.execute({ type: 'reply_comment', text: 'ответ' }, { threadId: 'm1', commentId: 'c1' });

    expect(String(f.mock.calls[0]![0])).toContain('/c1/replies');
  });

  it('4xx превращается в PermanentDeliveryError — повторять нельзя', async () => {
    const f = fakeFetch(400, { error: { message: 'вне 24-часового окна' } });
    const a = createInstagramAdapter({ pageAccessToken: 'tok', fetchFn: f as unknown as typeof fetch });

    await expect(
      a.execute({ type: 'send_text', text: 'привет' }, { threadId: 'u1', userId: 'u1' }),
    ).rejects.toBeInstanceOf(PermanentDeliveryError);
  });

  it('5xx бросает обычную ошибку — её будут повторять', async () => {
    const f = fakeFetch(503);
    const a = createInstagramAdapter({ pageAccessToken: 'tok', fetchFn: f as unknown as typeof fetch });

    const err = await a
      .execute({ type: 'send_text', text: 'привет' }, { threadId: 'u1', userId: 'u1' })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Error);
    expect(err).not.toBeInstanceOf(PermanentDeliveryError);
  });

  it('S4: текст ошибки не содержит токен', async () => {
    const f = fakeFetch(400, { error: { message: 'плохо' } });
    const a = createInstagramAdapter({ pageAccessToken: 'super-secret', fetchFn: f as unknown as typeof fetch });

    const err = await a
      .execute({ type: 'send_text', text: 'привет' }, { threadId: 'u1', userId: 'u1' })
      .catch((e: unknown) => e as Error);
    expect((err as Error).message).not.toContain('super-secret');
  });
});
```

- [ ] **Step 2: Запустить тест, убедиться что падает**

Run: `npx vitest run tests/adapters/instagram/send.test.ts`
Expected: FAIL — модуль не найден

- [ ] **Step 3: Реализовать `src/adapters/instagram/send.ts`**

```ts
import type { DeliveryContext, OutgoingAction } from '../../core/types.js';
import { PermanentDeliveryError, type WebhookSource } from '../types.js';
import { parseInstagramWebhook } from './parse.js';

const GRAPH = 'https://graph.facebook.com/v21.0';

interface Deps {
  pageAccessToken: string;
  fetchFn?: typeof fetch;
}

export function createInstagramAdapter(deps: Deps): WebhookSource {
  const doFetch = deps.fetchFn ?? fetch;

  async function call(url: string, payload: unknown): Promise<void> {
    const res = await doFetch(url, {
      method: 'POST',
      // S4: токен в заголовке, не в query string — иначе он попадёт
      // в логи прокси, в историю и в Referer
      headers: {
        Authorization: `Bearer ${deps.pageAccessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload),
    });

    if (res.ok) return;

    // S4: в текст ошибки не попадает ни токен, ни тело запроса
    const detail = await res.text().catch(() => '');
    const message = `Instagram API ${res.status}: ${detail.slice(0, 200)}`;
    if (res.status >= 400 && res.status < 500) throw new PermanentDeliveryError(message);
    throw new Error(message);
  }

  return {
    platform: 'instagram',
    parseWebhook: parseInstagramWebhook,

    async execute(action: OutgoingAction, ctx: DeliveryContext): Promise<void> {
      switch (action.type) {
        case 'send_text':
          await call(`${GRAPH}/me/messages`, {
            recipient: { id: ctx.userId ?? ctx.threadId },
            message: { text: action.text },
          });
          return;

        case 'send_buttons':
          await call(`${GRAPH}/me/messages`, {
            recipient: { id: ctx.userId ?? ctx.threadId },
            message: {
              text: action.text,
              quick_replies: action.buttons.map((b) => ({
                content_type: 'text',
                title: b.label,
                payload: b.payload,
              })),
            },
          });
          return;

        case 'reply_comment': {
          if (ctx.commentId === undefined) {
            throw new PermanentDeliveryError('reply_comment без commentId');
          }
          await call(`${GRAPH}/${ctx.commentId}/replies`, { message: action.text });
          return;
        }

        case 'dm_the_commenter': {
          if (ctx.commentId === undefined) {
            throw new PermanentDeliveryError('dm_the_commenter без commentId');
          }
          await call(`${GRAPH}/me/messages`, {
            recipient: { comment_id: ctx.commentId },
            message: { text: action.text },
          });
          return;
        }

        case 'notify_operator':
          // Обрабатывается не адаптером платформы, а src/operator.ts
          return;
      }
    },
  };
}
```

- [ ] **Step 4: Запустить тест, убедиться что проходит**

Run: `npx vitest run tests/adapters/instagram/send.test.ts`
Expected: PASS, 6 тестов

- [ ] **Step 5: Коммит**

```bash
git add -A
git commit -m "feat(instagram): отправка сообщений и ответов на комментарии"
```

---

## Task 11: Уведомление оператора

**Files:**
- Create: `src/operator.ts`
- Test: `tests/operator.test.ts`

**Interfaces:**
- Consumes: `OutgoingAction` из `core/types.ts`
- Produces: `createOperatorNotifier(deps: { botToken?: string; chatId?: string; fetchFn?: typeof fetch; log: (msg: string) => void }): { notify(action: Extract<OutgoingAction, { type: 'notify_operator' }>): Promise<void> }`

- [ ] **Step 1: Написать падающий тест**

`tests/operator.test.ts`:

```ts
import { describe, it, expect, vi } from 'vitest';
import { createOperatorNotifier } from '../src/operator.js';

const action = {
  type: 'notify_operator' as const,
  reason: 'новая заявка',
  context: { phone: '+79991112233', product: 'кроссовки' },
};

describe('createOperatorNotifier', () => {
  it('шлёт сообщение в Telegram, когда настроен', async () => {
    const f = vi.fn(async () => new Response('{}', { status: 200 }));
    const n = createOperatorNotifier({
      botToken: 'bot-token',
      chatId: '42',
      fetchFn: f as unknown as typeof fetch,
      log: () => {},
    });
    await n.notify(action);

    expect(f).toHaveBeenCalledOnce();
    const body = JSON.parse(String((f.mock.calls[0]![1] as RequestInit).body));
    expect(body.chat_id).toBe('42');
    expect(body.text).toContain('новая заявка');
    expect(body.text).toContain('+79991112233');
  });

  it('без настроек пишет в лог и не падает', async () => {
    const log = vi.fn();
    const n = createOperatorNotifier({ log });
    await expect(n.notify(action)).resolves.toBeUndefined();
    expect(log).toHaveBeenCalledOnce();
  });

  it('ошибка Telegram не роняет обработку — лид уже в БД', async () => {
    const f = vi.fn(async () => new Response('fail', { status: 500 }));
    const log = vi.fn();
    const n = createOperatorNotifier({
      botToken: 't', chatId: '1', fetchFn: f as unknown as typeof fetch, log,
    });
    await expect(n.notify(action)).resolves.toBeUndefined();
    expect(log).toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Запустить тест, убедиться что падает**

Run: `npx vitest run tests/operator.test.ts`
Expected: FAIL — модуль не найден

- [ ] **Step 3: Реализовать `src/operator.ts`**

```ts
import type { OutgoingAction } from './core/types.js';

type NotifyAction = Extract<OutgoingAction, { type: 'notify_operator' }>;

interface Deps {
  botToken?: string;
  chatId?: string;
  fetchFn?: typeof fetch;
  log: (msg: string) => void;
}

/**
 * Минимальная передача лида живому человеку: сообщение в Telegram.
 * Воронка, собравшая телефон, но не позвавшая никого, тихо хоронит заявку.
 */
export function createOperatorNotifier(deps: Deps) {
  const doFetch = deps.fetchFn ?? fetch;

  return {
    async notify(action: NotifyAction): Promise<void> {
      const lines = [
        `🔔 ${action.reason}`,
        ...Object.entries(action.context).map(([k, v]) => `${k}: ${v}`),
      ];
      const text = lines.join('\n');

      if (deps.botToken === undefined || deps.chatId === undefined) {
        deps.log('Оператор не настроен, уведомление только в лог');
        return;
      }

      try {
        const res = await doFetch(`https://api.telegram.org/bot${deps.botToken}/sendMessage`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ chat_id: deps.chatId, text }),
        });
        // Провал уведомления не должен ронять обработку: лид уже сохранён в БД
        if (!res.ok) deps.log(`Не удалось уведомить оператора: HTTP ${res.status}`);
      } catch {
        deps.log('Не удалось уведомить оператора: сеть недоступна');
      }
    },
  };
}
```

- [ ] **Step 4: Запустить тест, убедиться что проходит**

Run: `npx vitest run tests/operator.test.ts`
Expected: PASS, 3 теста

- [ ] **Step 5: Коммит**

```bash
git add -A
git commit -m "feat: уведомление оператора о новом лиде"
```

---

## Task 12: Воркер — склейка очереди, движка и outbox

**Files:**
- Create: `src/worker.ts`
- Test: `tests/worker.test.ts`

**Interfaces:**
- Consumes: всё из `core/`, `storage/queries.ts`, `adapters/types.ts`, `operator.ts`
- Produces:
  - `processQueue(deps: WorkerDeps, now: Date): Promise<number>` — возвращает число обработанных событий
  - `flushOutbox(deps: WorkerDeps, now: Date): Promise<number>` — число отправленных
  - `interface WorkerDeps { db: Db; scenarios: Scenario[]; senders: Map<Platform, MessageSender>; throttle: ReplyThrottle; notifier: { notify(a): Promise<void> }; maxTextLength: number }`

- [ ] **Step 1: Написать падающий тест**

`tests/worker.test.ts`:

```ts
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { createDb, type Db } from '../src/storage/db.js';
import { enqueueEvent, markProcessed } from '../src/storage/queries.js';
import { parseScenario } from '../src/core/scenario.js';
import { ReplyThrottle } from '../src/core/throttle.js';
import { processQueue, flushOutbox, type WorkerDeps } from '../src/worker.js';
import type { IncomingEvent, Platform } from '../src/core/types.js';
import type { MessageSender } from '../src/adapters/types.js';

const scenario = parseScenario([
  'id: price',
  'trigger: { type: contains, value: цена }',
  'steps:',
  '  - id: ask_phone',
  '    say: "Оставьте номер"',
].join('\n'));

let db: Db;
let sent: { action: unknown }[];
let deps: WorkerDeps;

const fakeSender: MessageSender = {
  platform: 'instagram',
  execute: async (action) => { sent.push({ action }); },
};

function evt(text: string, key: string): IncomingEvent {
  return {
    platform: 'instagram', kind: 'direct_message',
    externalUserId: 'u1', externalThreadId: 'u1', externalCommentId: null,
    text, payload: null, dedupeKey: key,
    receivedAt: new Date('2026-08-26T10:00:00Z'),
  };
}

beforeEach(() => {
  db = createDb(':memory:');
  migrate(db, { migrationsFolder: './drizzle' });
  sent = [];
  deps = {
    db,
    scenarios: [scenario],
    senders: new Map<Platform, MessageSender>([['instagram', fakeSender]]),
    throttle: new ReplyThrottle(10),
    notifier: { notify: vi.fn(async () => {}) },
    maxTextLength: 2000,
  };
});

const now = new Date('2026-08-26T10:00:00Z');

describe('processQueue', () => {
  it('прогоняет событие через движок и кладёт ответ в outbox', async () => {
    enqueueEvent(db, evt('цена', 'k1'));
    expect(await processQueue(deps, now)).toBe(1);

    expect(await flushOutbox(deps, now)).toBe(1);
    expect(sent).toHaveLength(1);
    expect(sent[0]?.action).toEqual({ type: 'send_text', text: 'Оставьте номер' });
  });

  it('не обрабатывает повторно доставленное событие', async () => {
    markProcessed(db, 'k1');
    enqueueEvent(db, evt('цена', 'k1'));
    await processQueue(deps, now);
    await flushOutbox(deps, now);
    expect(sent).toHaveLength(0);
  });

  it('S8: троттлинг гасит ответы сверх лимита', async () => {
    deps.throttle = new ReplyThrottle(1);
    enqueueEvent(db, evt('цена', 'k1'));
    enqueueEvent(db, evt('цена', 'k2'));
    await processQueue(deps, now);
    await flushOutbox(deps, now);
    expect(sent).toHaveLength(1);
  });

  it('S7: обрезает слишком длинный текст перед движком', async () => {
    deps.maxTextLength = 5;
    enqueueEvent(db, evt('ц'.repeat(100) + 'цена', 'k1'));
    await processQueue(deps, now);
    await flushOutbox(deps, now);
    // после обрезки триггер не найден — бот молчит
    expect(sent).toHaveLength(0);
  });
});
```

- [ ] **Step 2: Запустить тест, убедиться что падает**

Run: `npx vitest run tests/worker.test.ts`
Expected: FAIL — модуль не найден

- [ ] **Step 3: Реализовать `src/worker.ts`**

```ts
import { step } from './core/engine.js';
import type { Scenario } from './core/scenario.js';
import type { ReplyThrottle } from './core/throttle.js';
import type { OutgoingAction, Platform } from './core/types.js';
import { PermanentDeliveryError, type MessageSender } from './adapters/types.js';
import type { Db } from './storage/db.js';
import {
  completeEvent, dequeueEvents, dueOutbox, enqueueOutbox,
  loadState, markFailedPermanently, markProcessed, markRetry, markSent, saveState,
} from './storage/queries.js';

type NotifyAction = Extract<OutgoingAction, { type: 'notify_operator' }>;

export interface WorkerDeps {
  db: Db;
  scenarios: Scenario[];
  senders: Map<Platform, MessageSender>;
  throttle: ReplyThrottle;
  notifier: { notify(action: NotifyAction): Promise<void> };
  maxTextLength: number;
}

const BATCH = 50;

export async function processQueue(deps: WorkerDeps, now: Date): Promise<number> {
  const rows = dequeueEvents(deps.db, BATCH);
  let handled = 0;

  for (const { id, event } of rows) {
    // Обе платформы гарантируют at-least-once — дубли реальны, не гипотетичны
    if (!markProcessed(deps.db, event.dedupeKey)) {
      completeEvent(deps.db, id, 'done');
      continue;
    }

    const contactKey = `${event.platform}:${event.externalUserId}`;
    if (!deps.throttle.allow(contactKey, now)) {
      completeEvent(deps.db, id, 'done');
      handled += 1;
      continue;
    }

    // S7: обрезка до матчинга — защита от катастрофического бэктрекинга
    const trimmed = {
      ...event,
      text: event.text === null ? null : event.text.slice(0, deps.maxTextLength),
    };

    const { conversationId, state } = loadState(
      deps.db, event.platform, event.externalUserId, event.externalThreadId,
    );
    const result = step(deps.scenarios, state, trimmed);
    saveState(deps.db, conversationId, result.state);

    for (const action of result.actions) {
      if (action.type === 'notify_operator') {
        await deps.notifier.notify(action);
        continue;
      }
      enqueueOutbox(deps.db, event.platform, action, {
        threadId: event.externalThreadId,
        userId: event.externalUserId,
        ...(event.externalCommentId === null ? {} : { commentId: event.externalCommentId }),
      });
    }

    completeEvent(deps.db, id, 'done');
    handled += 1;
  }
  return handled;
}

export async function flushOutbox(deps: WorkerDeps, now: Date): Promise<number> {
  const rows = dueOutbox(deps.db, now, BATCH);
  let delivered = 0;

  for (const row of rows) {
    const sender = deps.senders.get(row.platform);
    if (sender === undefined) {
      markFailedPermanently(deps.db, row.id, `Нет адаптера для ${row.platform}`);
      continue;
    }

    try {
      await sender.execute(row.action, row.deliveryContext);
      markSent(deps.db, row.id);
      delivered += 1;
    } catch (e) {
      const message = e instanceof Error ? e.message : 'неизвестная ошибка';
      // 4xx повторять бессмысленно, 5xx и сеть — повторяем с задержкой
      if (e instanceof PermanentDeliveryError) markFailedPermanently(deps.db, row.id, message);
      else markRetry(deps.db, row.id, message, now);
    }
  }
  return delivered;
}
```

- [ ] **Step 4: Запустить тест, убедиться что проходит**

Run: `npx vitest run tests/worker.test.ts`
Expected: PASS, 4 теста

- [ ] **Step 5: Коммит**

```bash
git add -A
git commit -m "feat: воркер — очередь, движок, outbox"
```

---

## Task 13: HTTP-сервер и запуск — первый живой бот

**Files:**
- Create: `src/server.ts`, `src/index.ts`
- Test: `tests/server.test.ts`

**Interfaces:**
- Consumes: `verifyMetaSignature`, `verifyHandshakeToken`, `parseInstagramWebhook`, `enqueueEvent`, `Config`
- Produces: `buildServer(deps: ServerDeps): FastifyInstance`, где `interface ServerDeps { db: Db; appSecret: string; verifyToken: string }`

- [ ] **Step 1: Написать падающий тест**

`tests/server.test.ts`:

```ts
import { describe, it, expect, beforeEach } from 'vitest';
import { createHmac } from 'node:crypto';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { createDb, type Db } from '../src/storage/db.js';
import { dequeueEvents } from '../src/storage/queries.js';
import { buildServer } from '../src/server.js';

const SECRET = 'app-secret';
const VERIFY = 'verify-token';
let db: Db;
let app: ReturnType<typeof buildServer>;

const payload = {
  object: 'instagram',
  entry: [{
    id: 'page', time: 1787000000,
    messaging: [{ sender: { id: 'u1' }, timestamp: 1787000000000, message: { mid: 'mid.a', text: 'цена' } }],
  }],
};

const sign = (raw: string) => 'sha256=' + createHmac('sha256', SECRET).update(raw).digest('hex');

beforeEach(async () => {
  db = createDb(':memory:');
  migrate(db, { migrationsFolder: './drizzle' });
  app = buildServer({ db, appSecret: SECRET, verifyToken: VERIFY });
  await app.ready();
});

describe('GET /webhooks/instagram — хендшейк Meta', () => {
  it('возвращает challenge при верном токене', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/webhooks/instagram?hub.mode=subscribe&hub.verify_token=verify-token&hub.challenge=12345',
    });
    expect(res.statusCode).toBe(200);
    expect(res.body).toBe('12345');
  });

  it('S2: отвергает неверный verify token', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/webhooks/instagram?hub.mode=subscribe&hub.verify_token=wrong&hub.challenge=12345',
    });
    expect(res.statusCode).toBe(403);
  });
});

describe('POST /webhooks/instagram', () => {
  it('принимает подписанный запрос и кладёт событие в очередь', async () => {
    const raw = JSON.stringify(payload);
    const res = await app.inject({
      method: 'POST',
      url: '/webhooks/instagram',
      headers: { 'content-type': 'application/json', 'x-hub-signature-256': sign(raw) },
      payload: raw,
    });
    expect(res.statusCode).toBe(200);
    expect(dequeueEvents(db, 10)).toHaveLength(1);
  });

  it('S1: отвергает запрос без подписи и НЕ кладёт в очередь', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/webhooks/instagram',
      headers: { 'content-type': 'application/json' },
      payload: JSON.stringify(payload),
    });
    expect(res.statusCode).toBe(403);
    expect(dequeueEvents(db, 10)).toHaveLength(0);
  });

  it('S1: отвергает подделанную подпись', async () => {
    const raw = JSON.stringify(payload);
    const forged = 'sha256=' + createHmac('sha256', 'wrong-secret').update(raw).digest('hex');
    const res = await app.inject({
      method: 'POST',
      url: '/webhooks/instagram',
      headers: { 'content-type': 'application/json', 'x-hub-signature-256': forged },
      payload: raw,
    });
    expect(res.statusCode).toBe(403);
    expect(dequeueEvents(db, 10)).toHaveLength(0);
  });

  it('S1: подпись проверяется по сырым байтам — лишние пробелы ломают её', async () => {
    const raw = JSON.stringify(payload);
    const spaced = raw.replace('{"object"', '{ "object"');
    const res = await app.inject({
      method: 'POST',
      url: '/webhooks/instagram',
      headers: { 'content-type': 'application/json', 'x-hub-signature-256': sign(raw) },
      payload: spaced,
    });
    expect(res.statusCode).toBe(403);
  });

  it('не отдаёт стек-трейс наружу при битом JSON', async () => {
    const raw = 'не json';
    const res = await app.inject({
      method: 'POST',
      url: '/webhooks/instagram',
      headers: { 'content-type': 'application/json', 'x-hub-signature-256': sign(raw) },
      payload: raw,
    });
    expect(res.statusCode).toBe(200);
    expect(res.body).not.toContain('at ');
  });
});
```

- [ ] **Step 2: Запустить тест, убедиться что падает**

Run: `npx vitest run tests/server.test.ts`
Expected: FAIL — модуль не найден

- [ ] **Step 3: Реализовать `src/server.ts`**

```ts
import Fastify, { type FastifyInstance, type FastifyRequest } from 'fastify';
import { z } from 'zod';
import { parseInstagramWebhook } from './adapters/instagram/parse.js';
import { verifyHandshakeToken, verifyMetaSignature } from './adapters/instagram/verify.js';
import type { Db } from './storage/db.js';
import { enqueueEvent } from './storage/queries.js';

export interface ServerDeps {
  db: Db;
  appSecret: string;
  verifyToken: string;
}

interface RawBodyRequest extends FastifyRequest {
  rawBody?: Buffer;
}

const HandshakeSchema = z.object({
  'hub.mode': z.string().optional(),
  'hub.verify_token': z.string().optional(),
  'hub.challenge': z.string().optional(),
});

export function buildServer(deps: ServerDeps): FastifyInstance {
  const app = Fastify({ logger: false });

  // S1: критично. Fastify по умолчанию отдаёт распарсенный объект, а подпись
  // считается от сырых байт. Поэтому сохраняем Buffer до парсинга.
  app.addContentTypeParser('application/json', { parseAs: 'buffer' }, (req, body, done) => {
    (req as RawBodyRequest).rawBody = body as Buffer;
    try {
      done(null, JSON.parse((body as Buffer).toString('utf8')));
    } catch {
      // Битый JSON не должен ронять запрос стек-трейсом наружу
      done(null, undefined);
    }
  });

  app.get('/health', async () => ({ status: 'ok' }));

  app.get('/webhooks/instagram', async (req, reply) => {
    const q = HandshakeSchema.safeParse(req.query);
    if (!q.success) return reply.code(403).send();

    const token = q.data['hub.verify_token'];
    const challenge = q.data['hub.challenge'];
    if (!verifyHandshakeToken(token, deps.verifyToken) || challenge === undefined) {
      return reply.code(403).send();
    }
    return reply.code(200).type('text/plain').send(challenge);
  });

  app.post('/webhooks/instagram', async (req, reply) => {
    const raw = (req as RawBodyRequest).rawBody;
    const header = req.headers['x-hub-signature-256'];
    const signature = typeof header === 'string' ? header : undefined;

    if (raw === undefined || !verifyMetaSignature(raw, signature, deps.appSecret)) {
      // Без тела: не подсказываем атакующему, что именно не сошлось
      return reply.code(403).send();
    }

    // Meta отключает подписку у медленных приложений — поэтому только
    // кладём в очередь и сразу отвечаем. Обработка идёт в воркере.
    for (const event of parseInstagramWebhook(req.body)) {
      enqueueEvent(deps.db, event);
    }
    return reply.code(200).send();
  });

  return app;
}
```

- [ ] **Step 4: Реализовать `src/index.ts` — точка входа**

```ts
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { loadConfig } from './config.js';
import { loadScenarios } from './core/scenario.js';
import { ReplyThrottle } from './core/throttle.js';
import type { Platform } from './core/types.js';
import type { MessageSender } from './adapters/types.js';
import { createInstagramAdapter } from './adapters/instagram/send.js';
import { createOperatorNotifier } from './operator.js';
import { createDb } from './storage/db.js';
import { buildServer } from './server.js';
import { flushOutbox, processQueue, type WorkerDeps } from './worker.js';

const cfg = loadConfig();
const db = createDb(cfg.DATABASE_URL);
migrate(db, { migrationsFolder: './drizzle' });

const instagram = createInstagramAdapter({ pageAccessToken: cfg.IG_PAGE_ACCESS_TOKEN });

const deps: WorkerDeps = {
  db,
  scenarios: loadScenarios('./scenarios'),
  senders: new Map<Platform, MessageSender>([['instagram', instagram]]),
  throttle: new ReplyThrottle(cfg.THROTTLE_MAX_REPLIES_PER_MINUTE),
  notifier: createOperatorNotifier({
    ...(cfg.OPERATOR_TELEGRAM_BOT_TOKEN === undefined ? {} : { botToken: cfg.OPERATOR_TELEGRAM_BOT_TOKEN }),
    ...(cfg.OPERATOR_TELEGRAM_CHAT_ID === undefined ? {} : { chatId: cfg.OPERATOR_TELEGRAM_CHAT_ID }),
    log: (msg) => console.log(msg),
  }),
  maxTextLength: cfg.MAX_INCOMING_TEXT_LENGTH,
};

const app = buildServer({
  db,
  appSecret: cfg.META_APP_SECRET,
  verifyToken: cfg.META_VERIFY_TOKEN,
});

await app.listen({ port: cfg.PORT, host: '0.0.0.0' });
console.log(`Слушаю порт ${cfg.PORT}`);

// Простой цикл вместо cron: воркер и так идемпотентен
setInterval(() => {
  void (async () => {
    const now = new Date();
    try {
      await processQueue(deps, now);
      await flushOutbox(deps, now);
    } catch (e) {
      console.error('Ошибка воркера:', e instanceof Error ? e.message : e);
    }
  })();
}, 2000);
```

- [ ] **Step 5: Добавить скрипты в `package.json`**

```json
{
  "scripts": {
    "dev": "tsx watch src/index.ts",
    "test": "vitest run",
    "typecheck": "tsc --noEmit"
  }
}
```

- [ ] **Step 6: Запустить весь набор тестов**

Run: `npx vitest run && npx tsc --noEmit`
Expected: PASS, всё зелёное, ошибок типов нет

- [ ] **Step 7: Коммит**

```bash
git add -A
git commit -m "feat: HTTP-сервер вебхуков и точка входа"
```

**Контрольная точка фазы 3.** Бот работоспособен для Instagram. Чтобы проверить
вживую: поднять туннель (`npx localtunnel --port 3000` или ngrok), указать его
URL в настройках вебхука приложения Meta, подписаться на поля `messages` и
`comments`, написать в директ тестового аккаунта. **Приложение при этом
остаётся в режиме Development — App Review нужен только для выхода на чужих
пользователей.**

---

# Фаза 4 — TikTok

## Task 14: Авторизация TikTok и ротация токена

**Files:**
- Create: `src/adapters/tiktok/auth.ts`
- Test: `tests/adapters/tiktok/auth.test.ts`

**Interfaces:**
- Consumes: `encrypt`/`decrypt` из `storage/crypto.ts`, таблица `platformCredentials`, `Db`
- Produces: `createTikTokAuth(deps: { db: Db; clientKey: string; clientSecret: string; encKey: string; fetchFn?: typeof fetch }): { getAccessToken(now: Date): Promise<string>; saveInitialTokens(t: { accessToken: string; refreshToken: string; expiresAt: Date }): void }`

- [ ] **Step 1: Написать падающий тест**

`tests/adapters/tiktok/auth.test.ts`:

```ts
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { createDb, type Db } from '../../../src/storage/db.js';
import { createTikTokAuth } from '../../../src/adapters/tiktok/auth.js';
import { platformCredentials } from '../../../src/storage/schema.js';

const ENC = 'd'.repeat(64);
let db: Db;

beforeEach(() => {
  db = createDb(':memory:');
  migrate(db, { migrationsFolder: './drizzle' });
});

const now = new Date('2026-08-26T10:00:00Z');
const later = (h: number) => new Date(now.getTime() + h * 3600_000);

describe('createTikTokAuth', () => {
  it('S4: токены в БД лежат зашифрованными', () => {
    const auth = createTikTokAuth({ db, clientKey: 'ck', clientSecret: 'cs', encKey: ENC });
    auth.saveInitialTokens({ accessToken: 'access-plain', refreshToken: 'refresh-plain', expiresAt: later(24) });

    const row = db.select().from(platformCredentials).get();
    expect(row?.accessTokenEnc).not.toContain('access-plain');
    expect(row?.refreshTokenEnc).not.toContain('refresh-plain');
  });

  it('возвращает действующий токен без обращения к сети', async () => {
    const f = vi.fn();
    const auth = createTikTokAuth({
      db, clientKey: 'ck', clientSecret: 'cs', encKey: ENC, fetchFn: f as unknown as typeof fetch,
    });
    auth.saveInitialTokens({ accessToken: 'access-plain', refreshToken: 'r', expiresAt: later(24) });

    expect(await auth.getAccessToken(now)).toBe('access-plain');
    expect(f).not.toHaveBeenCalled();
  });

  it('обновляет токен, когда до истечения меньше пяти минут', async () => {
    const f = vi.fn(async () => new Response(JSON.stringify({
      access_token: 'new-access', refresh_token: 'new-refresh', expires_in: 86400,
    }), { status: 200 }));
    const auth = createTikTokAuth({
      db, clientKey: 'ck', clientSecret: 'cs', encKey: ENC, fetchFn: f as unknown as typeof fetch,
    });
    auth.saveInitialTokens({ accessToken: 'old', refreshToken: 'old-refresh', expiresAt: later(0.01) });

    expect(await auth.getAccessToken(now)).toBe('new-access');
    expect(f).toHaveBeenCalledOnce();
    // новый refresh-токен должен быть сохранён — иначе следующее обновление провалится
    expect(await auth.getAccessToken(later(1))).toBe('new-access');
  });

  it('S4: ошибка обновления не раскрывает секреты', async () => {
    const f = vi.fn(async () => new Response('bad', { status: 400 }));
    const auth = createTikTokAuth({
      db, clientKey: 'ck', clientSecret: 'super-secret', encKey: ENC, fetchFn: f as unknown as typeof fetch,
    });
    auth.saveInitialTokens({ accessToken: 'old', refreshToken: 'old-refresh', expiresAt: later(0.01) });

    const err = await auth.getAccessToken(now).catch((e: unknown) => e as Error);
    expect((err as Error).message).not.toContain('super-secret');
    expect((err as Error).message).not.toContain('old-refresh');
  });
});
```

- [ ] **Step 2: Запустить тест, убедиться что падает**

Run: `npx vitest run tests/adapters/tiktok/auth.test.ts`
Expected: FAIL — модуль не найден

- [ ] **Step 3: Реализовать `src/adapters/tiktok/auth.ts`**

```ts
import { eq } from 'drizzle-orm';
import { decrypt, encrypt } from '../../storage/crypto.js';
import type { Db } from '../../storage/db.js';
import { platformCredentials } from '../../storage/schema.js';

const TOKEN_URL = 'https://open.tiktokapis.com/v2/oauth/token/';
const REFRESH_MARGIN_MS = 5 * 60_000;

interface Deps {
  db: Db;
  clientKey: string;
  clientSecret: string;
  encKey: string;
  fetchFn?: typeof fetch;
}

/**
 * S4. Причина, по которой токены TikTok живут в БД, а не в .env:
 * они ротируются. Процесс обязан сам обновлять access-токен по refresh-токену
 * и сохранять НОВЫЙ refresh-токен — переменную окружения он переписать не может.
 * Раз секрет лежит на диске, он шифруется.
 */
export function createTikTokAuth(deps: Deps) {
  const doFetch = deps.fetchFn ?? fetch;

  function save(accessToken: string, refreshToken: string, expiresAt: Date): void {
    deps.db
      .insert(platformCredentials)
      .values({
        platform: 'tiktok',
        accessTokenEnc: encrypt(accessToken, deps.encKey),
        refreshTokenEnc: encrypt(refreshToken, deps.encKey),
        expiresAt,
      })
      .onConflictDoUpdate({
        target: platformCredentials.platform,
        set: {
          accessTokenEnc: encrypt(accessToken, deps.encKey),
          refreshTokenEnc: encrypt(refreshToken, deps.encKey),
          expiresAt,
        },
      })
      .run();
  }

  return {
    saveInitialTokens(t: { accessToken: string; refreshToken: string; expiresAt: Date }): void {
      save(t.accessToken, t.refreshToken, t.expiresAt);
    },

    async getAccessToken(now: Date): Promise<string> {
      const row = deps.db
        .select()
        .from(platformCredentials)
        .where(eq(platformCredentials.platform, 'tiktok'))
        .get();
      if (row === undefined) throw new Error('TikTok не авторизован');

      const fresh = row.expiresAt !== null && row.expiresAt.getTime() - now.getTime() > REFRESH_MARGIN_MS;
      if (fresh) return decrypt(row.accessTokenEnc, deps.encKey);

      if (row.refreshTokenEnc === null) throw new Error('TikTok: нет refresh-токена');
      const refreshToken = decrypt(row.refreshTokenEnc, deps.encKey);

      const res = await doFetch(TOKEN_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          client_key: deps.clientKey,
          client_secret: deps.clientSecret,
          grant_type: 'refresh_token',
          refresh_token: refreshToken,
        }),
      });

      // S4: ни секрет, ни токен не попадают в текст ошибки
      if (!res.ok) throw new Error(`TikTok: обновление токена не удалось, HTTP ${res.status}`);

      const body = (await res.json()) as {
        access_token?: string;
        refresh_token?: string;
        expires_in?: number;
      };
      if (body.access_token === undefined || body.refresh_token === undefined) {
        throw new Error('TikTok: ответ обновления токена без токенов');
      }

      const expiresAt = new Date(now.getTime() + (body.expires_in ?? 86400) * 1000);
      save(body.access_token, body.refresh_token, expiresAt);
      return body.access_token;
    },
  };
}
```

- [ ] **Step 4: Запустить тест, убедиться что проходит**

Run: `npx vitest run tests/adapters/tiktok/auth.test.ts`
Expected: PASS, 4 теста

- [ ] **Step 5: Коммит**

```bash
git add -A
git commit -m "feat(tiktok): авторизация и ротация токенов"
```

---

## Task 15: Опрос комментариев TikTok и ответ на них

**Files:**
- Create: `src/adapters/tiktok/poll.ts` (опрос и отправка в одном адаптере), `src/scheduler.ts`
- Test: `tests/adapters/tiktok/poll.test.ts`, `tests/adapters/tiktok/send.test.ts` (два файла тестов на один модуль — по зонам ответственности)

**Interfaces:**
- Consumes: `PollingSource` из `adapters/types.ts`, `createTikTokAuth`
- Produces: `createTikTokAdapter(deps: { auth: { getAccessToken(now: Date): Promise<string> }; videoIds: string[]; fetchFn?: typeof fetch }): PollingSource`; `startScheduler(deps, intervalSec): () => void`

> **Проверить перед реализацией:** точные URL и имена полей эндпоинтов
> «Business comment list» и «Business comment reply create» в портале
> business-api.tiktok.com. Форма ответа ниже основана на публичной
> документации и может отличаться в деталях — фикстуру нужно снять с
> реального ответа API и обновить тест.

- [ ] **Step 1: Написать падающий тест опроса**

`tests/adapters/tiktok/poll.test.ts`:

```ts
import { describe, it, expect, vi } from 'vitest';
import { createTikTokAdapter } from '../../../src/adapters/tiktok/poll.js';

const auth = { getAccessToken: async () => 'access-token' };

const apiResponse = {
  data: {
    comments: [
      { comment_id: 'c1', video_id: 'v1', text: 'цена?', user_id: 'tt-user-1', create_time: 1787000000 },
      { comment_id: 'c2', video_id: 'v1', text: 'огонь', user_id: 'tt-user-2', create_time: 1787000100 },
    ],
  },
};

describe('TikTok poll', () => {
  it('превращает комментарии в IncomingEvent', async () => {
    const f = vi.fn(async () => new Response(JSON.stringify(apiResponse), { status: 200 }));
    const a = createTikTokAdapter({ auth, videoIds: ['v1'], fetchFn: f as unknown as typeof fetch });

    const events = await a.poll(new Date('2026-08-26T09:00:00Z'));
    expect(events).toHaveLength(2);
    expect(events[0]?.platform).toBe('tiktok');
    expect(events[0]?.kind).toBe('comment');
    expect(events[0]?.externalCommentId).toBe('c1');
    expect(events[0]?.externalUserId).toBe('tt-user-1');
    expect(events[0]?.dedupeKey).toBe('tiktok:comment:c1');
  });

  it('отбрасывает комментарии старше since — иначе бот ответит на весь архив', async () => {
    const f = vi.fn(async () => new Response(JSON.stringify(apiResponse), { status: 200 }));
    const a = createTikTokAdapter({ auth, videoIds: ['v1'], fetchFn: f as unknown as typeof fetch });

    const events = await a.poll(new Date(1787000050 * 1000));
    expect(events).toHaveLength(1);
    expect(events[0]?.externalCommentId).toBe('c2');
  });

  it('S4: токен уходит в заголовке, не в URL', async () => {
    const f = vi.fn(async () => new Response(JSON.stringify(apiResponse), { status: 200 }));
    const a = createTikTokAdapter({ auth, videoIds: ['v1'], fetchFn: f as unknown as typeof fetch });
    await a.poll(new Date(0));

    expect(String(f.mock.calls[0]![0])).not.toContain('access-token');
  });

  it('ошибка API не роняет опрос — возвращает пустой список', async () => {
    const f = vi.fn(async () => new Response('fail', { status: 500 }));
    const a = createTikTokAdapter({ auth, videoIds: ['v1'], fetchFn: f as unknown as typeof fetch });
    await expect(a.poll(new Date(0))).resolves.toEqual([]);
  });
});
```

- [ ] **Step 2: Написать падающий тест отправки с деградацией кнопок**

`tests/adapters/tiktok/send.test.ts`:

```ts
import { describe, it, expect, vi } from 'vitest';
import { createTikTokAdapter } from '../../../src/adapters/tiktok/poll.js';

const auth = { getAccessToken: async () => 'access-token' };
const ok = () => vi.fn(async () => new Response('{}', { status: 200 }));

describe('TikTok execute', () => {
  it('отвечает на комментарий', async () => {
    const f = ok();
    const a = createTikTokAdapter({ auth, videoIds: [], fetchFn: f as unknown as typeof fetch });
    await a.execute({ type: 'reply_comment', text: 'ответ' }, { threadId: 'v1', commentId: 'c1' });

    const body = JSON.parse(String((f.mock.calls[0]![1] as RequestInit).body));
    expect(body.comment_id).toBe('c1');
    expect(body.text).toBe('ответ');
  });

  it('send_text превращается в ответ на комментарий — DM в TikTok недоступны', async () => {
    const f = ok();
    const a = createTikTokAdapter({ auth, videoIds: [], fetchFn: f as unknown as typeof fetch });
    await a.execute({ type: 'send_text', text: 'привет' }, { threadId: 'v1', commentId: 'c1' });

    expect(JSON.parse(String((f.mock.calls[0]![1] as RequestInit).body)).text).toBe('привет');
  });

  it('ДЕГРАДАЦИЯ: кнопки становятся нумерованным списком', async () => {
    const f = ok();
    const a = createTikTokAdapter({ auth, videoIds: [], fetchFn: f as unknown as typeof fetch });
    await a.execute(
      { type: 'send_buttons', text: 'Что интересует?', buttons: [
        { label: 'Цены', payload: 'p' },
        { label: 'Доставка', payload: 'd' },
      ] },
      { threadId: 'v1', commentId: 'c1' },
    );

    const text = JSON.parse(String((f.mock.calls[0]![1] as RequestInit).body)).text as string;
    expect(text).toContain('Что интересует?');
    expect(text).toContain('1. Цены');
    expect(text).toContain('2. Доставка');
  });

  it('dm_the_commenter молча пропускается — API директа у TikTok нет', async () => {
    const f = ok();
    const a = createTikTokAdapter({ auth, videoIds: [], fetchFn: f as unknown as typeof fetch });
    await a.execute({ type: 'dm_the_commenter', text: 'привет' }, { threadId: 'v1', commentId: 'c1' });
    expect(f).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 3: Запустить тесты, убедиться что падают**

Run: `npx vitest run tests/adapters/tiktok/`
Expected: FAIL — модуль не найден

- [ ] **Step 4: Реализовать `src/adapters/tiktok/poll.ts`**

```ts
import { z } from 'zod';
import type { DeliveryContext, IncomingEvent, OutgoingAction } from '../../core/types.js';
import type { PollingSource } from '../types.js';

const API = 'https://business-api.tiktok.com/open_api/v1.3/business/comment';

const CommentSchema = z.object({
  comment_id: z.string(),
  video_id: z.string().optional(),
  text: z.string().optional(),
  user_id: z.string().optional(),
  create_time: z.number(),
});

const ListSchema = z.object({
  data: z.object({ comments: z.array(CommentSchema).optional() }).optional(),
});

interface Deps {
  auth: { getAccessToken(now: Date): Promise<string> };
  videoIds: string[];
  fetchFn?: typeof fetch;
}

/**
 * У TikTok НЕТ вебхука на новый комментарий — его webhooks покрывают лиды,
 * модерацию рекламы и заказы Creator Marketplace. Поэтому здесь опрос.
 * Наружу это различие не протекает: ядро получает тот же IncomingEvent,
 * что и от Instagram.
 */
export function createTikTokAdapter(deps: Deps): PollingSource {
  const doFetch = deps.fetchFn ?? fetch;

  async function authHeaders(now: Date): Promise<Record<string, string>> {
    // S4: токен в заголовке, не в query string
    return {
      'Access-Token': await deps.auth.getAccessToken(now),
      'Content-Type': 'application/json',
    };
  }

  return {
    platform: 'tiktok',

    async poll(since: Date): Promise<IncomingEvent[]> {
      const now = new Date();
      const events: IncomingEvent[] = [];

      for (const videoId of deps.videoIds) {
        try {
          const res = await doFetch(`${API}/list/?video_id=${encodeURIComponent(videoId)}`, {
            method: 'GET',
            headers: await authHeaders(now),
          });
          if (!res.ok) continue;

          const parsed = ListSchema.safeParse(await res.json());
          if (!parsed.success) continue;

          for (const c of parsed.data.data?.comments ?? []) {
            const createdAt = new Date(c.create_time * 1000);
            // Без этой отсечки бот при первом запуске ответит на весь архив
            if (createdAt <= since) continue;
            if (c.user_id === undefined) continue;

            events.push({
              platform: 'tiktok',
              kind: 'comment',
              externalUserId: c.user_id,
              externalThreadId: c.video_id ?? videoId,
              externalCommentId: c.comment_id,
              text: c.text ?? null,
              payload: null,
              dedupeKey: `tiktok:comment:${c.comment_id}`,
              receivedAt: createdAt,
            });
          }
        } catch {
          // Сбой опроса одного видео не должен ронять весь цикл
          continue;
        }
      }
      return events;
    },

    async execute(action: OutgoingAction, ctx: DeliveryContext): Promise<void> {
      if (ctx.commentId === undefined) return;

      // Деградация: у TikTok нет ни кнопок, ни директа. Ядро об этом не знает
      // и не должно знать — приведение к возможностям платформы живёт здесь.
      let text: string | null = null;
      switch (action.type) {
        case 'send_text':
        case 'reply_comment':
          text = action.text;
          break;
        case 'send_buttons':
          text = [action.text, ...action.buttons.map((b, i) => `${i + 1}. ${b.label}`)].join('\n');
          break;
        case 'dm_the_commenter':
        case 'notify_operator':
          return; // API директа у TikTok не существует
      }
      if (text === null) return;

      await doFetch(`${API}/reply/`, {
        method: 'POST',
        headers: await authHeaders(new Date()),
        body: JSON.stringify({ comment_id: ctx.commentId, text }),
      });
    },
  };
}
```

- [ ] **Step 5: Реализовать `src/scheduler.ts`**

```ts
import type { PollingSource } from './adapters/types.js';
import type { Db } from './storage/db.js';
import { enqueueEvent } from './storage/queries.js';

/**
 * Опрос TikTok. Дубли отсекаются позже, в воркере, по dedupeKey —
 * поэтому пересечение окон опроса безопасно.
 */
export function startScheduler(
  deps: { db: Db; source: PollingSource; intervalSec: number; log: (msg: string) => void },
): () => void {
  let since = new Date();

  const timer = setInterval(() => {
    void (async () => {
      try {
        const events = await deps.source.poll(since);
        for (const e of events) enqueueEvent(deps.db, e);
        since = new Date();
      } catch (e) {
        deps.log(`Опрос ${deps.source.platform} не удался: ${e instanceof Error ? e.message : ''}`);
      }
    })();
  }, deps.intervalSec * 1000);

  return () => clearInterval(timer);
}
```

- [ ] **Step 6: Запустить тесты, убедиться что проходят**

Run: `npx vitest run tests/adapters/tiktok/`
Expected: PASS, 8 тестов

- [ ] **Step 7: Подключить TikTok в `src/index.ts`**

Добавить после создания `instagram`:

```ts
import { createTikTokAuth } from './adapters/tiktok/auth.js';
import { createTikTokAdapter } from './adapters/tiktok/poll.js';
import { startScheduler } from './scheduler.js';

if (cfg.TIKTOK_CLIENT_KEY !== undefined && cfg.TIKTOK_CLIENT_SECRET !== undefined) {
  const auth = createTikTokAuth({
    db,
    clientKey: cfg.TIKTOK_CLIENT_KEY,
    clientSecret: cfg.TIKTOK_CLIENT_SECRET,
    encKey: cfg.CREDENTIALS_ENC_KEY,
  });
  const tiktok = createTikTokAdapter({ auth, videoIds: [] });
  deps.senders.set('tiktok', tiktok);
  startScheduler({
    db,
    source: tiktok,
    intervalSec: cfg.TIKTOK_POLL_INTERVAL_SEC,
    log: (msg) => console.log(msg),
  });
}
```

- [ ] **Step 8: Коммит**

```bash
git add -A
git commit -m "feat(tiktok): опрос комментариев и ответы с деградацией кнопок"
```

---

# Фаза 5 — сквозная проверка

## Task 16: Интеграционный тест полной воронки

**Files:**
- Test: `tests/integration/funnel.test.ts`

**Interfaces:**
- Consumes: всё готовое
- Produces: ничего нового, только проверка

- [ ] **Step 1: Написать интеграционный тест**

`tests/integration/funnel.test.ts`:

```ts
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { createHmac } from 'node:crypto';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { createDb, type Db } from '../../src/storage/db.js';
import { buildServer } from '../../src/server.js';
import { parseScenario } from '../../src/core/scenario.js';
import { ReplyThrottle } from '../../src/core/throttle.js';
import { flushOutbox, processQueue, type WorkerDeps } from '../../src/worker.js';
import type { MessageSender } from '../../src/adapters/types.js';
import type { OutgoingAction, Platform } from '../../src/core/types.js';

const SECRET = 'app-secret';
let db: Db;
let app: ReturnType<typeof buildServer>;
let sent: OutgoingAction[];
let notified: unknown[];
let deps: WorkerDeps;

const scenario = parseScenario([
  'id: price',
  'trigger: { type: contains, value: цена }',
  'steps:',
  '  - id: ask_phone',
  '    say: "Оставьте номер"',
  '    save_reply_as: phone',
  '    next: done',
  '  - id: done',
  '    say: "Спасибо!"',
  '    notify_operator: "новая заявка"',
].join('\n'));

function dm(mid: string, text: string) {
  return JSON.stringify({
    object: 'instagram',
    entry: [{ id: 'page', time: 1787000000, messaging: [
      { sender: { id: 'u1' }, timestamp: 1787000000000, message: { mid, text } },
    ] }],
  });
}

async function deliver(raw: string) {
  const sig = 'sha256=' + createHmac('sha256', SECRET).update(raw).digest('hex');
  const res = await app.inject({
    method: 'POST', url: '/webhooks/instagram',
    headers: { 'content-type': 'application/json', 'x-hub-signature-256': sig },
    payload: raw,
  });
  expect(res.statusCode).toBe(200);
  const now = new Date();
  await processQueue(deps, now);
  await flushOutbox(deps, now);
}

beforeEach(async () => {
  db = createDb(':memory:');
  migrate(db, { migrationsFolder: './drizzle' });
  sent = [];
  notified = [];

  const fake: MessageSender = {
    platform: 'instagram',
    execute: async (a) => { sent.push(a); },
  };
  deps = {
    db, scenarios: [scenario],
    senders: new Map<Platform, MessageSender>([['instagram', fake]]),
    throttle: new ReplyThrottle(100),
    notifier: { notify: async (a) => { notified.push(a); } },
    maxTextLength: 2000,
  };
  app = buildServer({ db, appSecret: SECRET, verifyToken: 'v' });
  await app.ready();
});

describe('сквозная воронка', () => {
  it('проходит от триггера до уведомления оператора', async () => {
    await deliver(dm('mid.1', 'какая цена?'));
    expect(sent).toEqual([{ type: 'send_text', text: 'Оставьте номер' }]);

    await deliver(dm('mid.2', '+7 999 111 22 33'));
    expect(sent[1]).toEqual({ type: 'send_text', text: 'Спасибо!' });
    expect(notified).toEqual([
      { type: 'notify_operator', reason: 'новая заявка', context: { phone: '+7 999 111 22 33' } },
    ]);
  });

  it('повторная доставка того же mid не даёт второго ответа', async () => {
    await deliver(dm('mid.1', 'какая цена?'));
    await deliver(dm('mid.1', 'какая цена?'));
    expect(sent).toHaveLength(1);
  });

  it('состояние переживает перезапуск процесса', async () => {
    await deliver(dm('mid.1', 'какая цена?'));

    // тот же файл БД, новый сервер — имитация рестарта
    app = buildServer({ db, appSecret: SECRET, verifyToken: 'v' });
    await app.ready();

    await deliver(dm('mid.2', '+79991112233'));
    expect(notified).toHaveLength(1);
  });
});
```

- [ ] **Step 2: Запустить тест, убедиться что проходит**

Run: `npx vitest run tests/integration/funnel.test.ts`
Expected: PASS, 3 теста

- [ ] **Step 3: Запустить весь набор и проверку типов**

Run: `npx vitest run && npx tsc --noEmit`
Expected: всё зелёное

- [ ] **Step 4: Коммит**

```bash
git add -A
git commit -m "test: сквозной интеграционный тест воронки"
```

---

## Task 17: 24-часовое окно Instagram и гигиена логов

**Files:**
- Modify: `src/worker.ts` — функция `flushOutbox`
- Test: `tests/worker-window.test.ts`

**Interfaces:**
- Consumes: `OutboxRow.createdAt` из Task 7
- Produces: константа `IG_MESSAGING_WINDOW_MS`, поведение пропуска протухших DM

> Спека требует: выход за 24-часовое окно — не сетевая ошибка, а бизнес-ситуация.
> Без этой задачи `lastUserMessageAt` и `createdAt` сохраняются, но ни на что не
> влияют, и бот будет бесконечно ретраить заведомо отклоняемые сообщения.

- [ ] **Step 1: Написать падающий тест**

`tests/worker-window.test.ts`:

```ts
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { eq } from 'drizzle-orm';
import { createDb, type Db } from '../src/storage/db.js';
import { enqueueOutbox } from '../src/storage/queries.js';
import { outbox } from '../src/storage/schema.js';
import { ReplyThrottle } from '../src/core/throttle.js';
import { flushOutbox, type WorkerDeps } from '../src/worker.js';
import type { MessageSender } from '../src/adapters/types.js';
import type { Platform } from '../src/core/types.js';

let db: Db;
let sentCount: number;
let notified: unknown[];
let deps: WorkerDeps;

const t0 = new Date('2026-08-26T10:00:00Z');

beforeEach(() => {
  db = createDb(':memory:');
  migrate(db, { migrationsFolder: './drizzle' });
  sentCount = 0;
  notified = [];

  const fake: MessageSender = {
    platform: 'instagram',
    execute: async () => { sentCount += 1; },
  };
  deps = {
    db, scenarios: [],
    senders: new Map<Platform, MessageSender>([['instagram', fake]]),
    throttle: new ReplyThrottle(100),
    notifier: { notify: async (a) => { notified.push(a); } },
    maxTextLength: 2000,
  };
});

describe('24-часовое окно Instagram', () => {
  it('внутри окна сообщение уходит', async () => {
    enqueueOutbox(db, 'instagram', { type: 'send_text', text: 'привет' }, { threadId: 'u1', userId: 'u1' });
    expect(await flushOutbox(deps, new Date(t0.getTime() + 3600_000))).toBe(1);
    expect(sentCount).toBe(1);
  });

  it('за пределами окна DM не отправляется, а помечается failed', async () => {
    enqueueOutbox(db, 'instagram', { type: 'send_text', text: 'привет' }, { threadId: 'u1', userId: 'u1' });
    db.update(outbox).set({ createdAt: new Date(t0.getTime() - 25 * 3600_000) }).run();

    expect(await flushOutbox(deps, t0)).toBe(0);
    expect(sentCount).toBe(0);
    expect(db.select().from(outbox).get()?.status).toBe('failed');
  });

  it('оператор узнаёт о протухшем сообщении — лид иначе потеряется', async () => {
    enqueueOutbox(db, 'instagram', { type: 'send_text', text: 'привет' }, { threadId: 'u1', userId: 'u1' });
    db.update(outbox).set({ createdAt: new Date(t0.getTime() - 25 * 3600_000) }).run();

    await flushOutbox(deps, t0);
    expect(notified).toHaveLength(1);
  });

  it('на ответ в комментарии окно не распространяется', async () => {
    enqueueOutbox(db, 'instagram', { type: 'reply_comment', text: 'ответ' }, { threadId: 'm1', commentId: 'c1' });
    db.update(outbox).set({ createdAt: new Date(t0.getTime() - 25 * 3600_000) }).run();

    expect(await flushOutbox(deps, t0)).toBe(1);
  });

  it('на TikTok окно не распространяется', async () => {
    const tk: MessageSender = { platform: 'tiktok', execute: async () => { sentCount += 1; } };
    deps.senders.set('tiktok', tk);
    enqueueOutbox(db, 'tiktok', { type: 'reply_comment', text: 'ответ' }, { threadId: 'v1', commentId: 'c1' });
    db.update(outbox).set({ createdAt: new Date(t0.getTime() - 25 * 3600_000) }).run();

    expect(await flushOutbox(deps, t0)).toBe(1);
  });
});

describe('S9: гигиена логов', () => {
  it('исходный код нигде не логирует тела сообщений и токены', async () => {
    const { readFileSync, readdirSync, statSync } = await import('node:fs');
    const { join } = await import('node:path');

    const walk = (dir: string): string[] =>
      readdirSync(dir).flatMap((f) => {
        const p = join(dir, f);
        return statSync(p).isDirectory() ? walk(p) : p.endsWith('.ts') ? [p] : [];
      });

    const FORBIDDEN = [
      /console\.log\([^)]*\baction\b/,
      /console\.log\([^)]*\bevent\b/,
      /console\.log\([^)]*[Tt]oken/,
      /console\.log\([^)]*\.text\b/,
    ];
    for (const file of walk('src')) {
      const text = readFileSync(file, 'utf8');
      for (const re of FORBIDDEN) {
        expect(re.test(text), `${file} логирует чувствительные данные: ${re}`).toBe(false);
      }
    }
  });
});
```

- [ ] **Step 2: Запустить тест, убедиться что падает**

Run: `npx vitest run tests/worker-window.test.ts`
Expected: FAIL — протухшие сообщения пока отправляются

- [ ] **Step 3: Изменить `flushOutbox` в `src/worker.ts`**

Добавить константу рядом с `BATCH`:

```ts
/**
 * Instagram позволяет писать пользователю только 24 часа с его последнего
 * сообщения. Отправка позже не сетевая ошибка, а гарантированный отказ —
 * ретраить её бессмысленно, а лид при этом молча теряется.
 * На ответы в комментариях и на TikTok правило не распространяется.
 */
const IG_MESSAGING_WINDOW_MS = 24 * 3600_000;

function isExpiredDirectMessage(row: OutboxRow, now: Date): boolean {
  if (row.platform !== 'instagram') return false;
  if (row.action.type !== 'send_text' && row.action.type !== 'send_buttons') return false;
  return now.getTime() - row.createdAt.getTime() > IG_MESSAGING_WINDOW_MS;
}
```

Добавить импорт `OutboxRow` к остальным из `./storage/queries.js`, затем в теле
цикла `flushOutbox`, сразу после получения `sender`:

```ts
    if (isExpiredDirectMessage(row, now)) {
      markFailedPermanently(deps.db, row.id, 'Вне 24-часового окна Instagram');
      await deps.notifier.notify({
        type: 'notify_operator',
        reason: 'Не удалось ответить: истекло 24-часовое окно Instagram',
        context: { threadId: row.deliveryContext.threadId },
      });
      continue;
    }
```

- [ ] **Step 4: Запустить тест, убедиться что проходит**

Run: `npx vitest run tests/worker-window.test.ts`
Expected: PASS, 6 тестов

- [ ] **Step 5: Прогнать весь набор**

Run: `npx vitest run && npx tsc --noEmit`
Expected: всё зелёное

- [ ] **Step 6: Коммит**

```bash
git add -A
git commit -m "feat: учёт 24-часового окна Instagram и тест гигиены логов"
```

---

## Чек-лист готовности к продакшену

Перед выкатом на живой аккаунт пройти по пунктам:

- [ ] `.env` отсутствует в git (`git log --all --full-history -- .env` пусто)
- [ ] `CREDENTIALS_ENC_KEY` сгенерирован: `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`
- [ ] `npx vitest run` — зелёный, включая все тесты с пометкой S1–S10
- [ ] `npm audit` — нет высоких и критических уязвимостей
- [ ] Вебхук работает только по HTTPS
- [ ] Права на файл БД ограничены владельцем процесса
- [ ] Подтверждена политика жизни токенов TikTok Business API в портале разработчика
- [ ] Для выхода на чужих пользователей Instagram пройден App Review у Meta

## Что осознанно отложено

| Отложено | Когда возвращаться |
|---|---|
| WhatsApp-адаптер | когда канал реально понадобится: один новый файл |
| Redis вместо очереди в БД | когда одного процесса перестанет хватать |
| Веб-панель оператора | **тогда же вернуться к IDOR — он станет риском №1** |
| AI-fallback на несработавший триггер | когда наберётся статистика промахов матчера |
| Регулярки в триггерах | только с защитой от ReDoS (re2 или таймаут) |
