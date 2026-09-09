# Запуск и надёжность — план реализации (фаза F, часть 2)

> **Для агентов-исполнителей:** ОБЯЗАТЕЛЬНЫЙ СУБ-СКИЛЛ: `superpowers:subagent-driven-development`
> или `superpowers:executing-plans`. Шаги отмечаются чекбоксами `- [ ]`.
> Обязательны `modern-architecture` и `web-security` — правила CLAUDE.md.

**Цель:** подготовить сервис к боевой эксплуатации: троттлинг на тенанта (S20), обработка 24-часового окна Meta, отображение постоянных ошибок доставки в кабинете (S11) и аудит логов (S9).

**Спека:** `docs/superpowers/specs/2026-09-09-phase-f-runtime-design.md`

## Глобальные ограничения
- ESM (импорты с `.js`).
- Строгий TypeScript, никаких `any`, `!`, `as unknown as` в `src/`.
- Владелец — первый аргумент в запросах к данным (`userId` в `WHERE`).
- Разметка — только тегом `html` из `src/web/html.ts`.
- Секреты и ПД не логируются выше `debug`.

---

## Задача 1: Троттлинг на клиента сервиса (S20)

**Файлы:**
- Правка: `src/config.ts`, `.env.example`, `tests/config.test.ts`
- Правка: `src/worker.ts`, `src/server.ts`
- Тест: `tests/worker.test.ts`

- [x] **Шаг 1: Написать падающий тест на троттлинг клиента (S20)**
В `tests/worker.test.ts` добавить тест: при превышении лимита отправки для одного `userId` действие не отправляется в адаптер, а переносится по времени (`nextAttemptAt > now`), счётчик `attempts` не инкрементируется.

- [x] **Шаг 2: Добавить параметр в `src/config.ts` и `.env.example`**
`THROTTLE_MAX_REPLIES_PER_CLIENT_PER_MINUTE` (default: 60).

- [x] **Шаг 3: Внедрить проверку в `runDelivery` в `src/worker.ts`**
Добавить `clientThrottle: ReplyThrottle` в `WorkerDeps`. Перед вызовом адаптера проверять `clientThrottle.allow(action.userId, now)`.

- [x] **Шаг 4: Запустить тесты, убедиться что проходят**
`npx vitest run tests/worker.test.ts tests/config.test.ts`

---

## Задача 2: Обработка 24-часового окна Meta и классификация 4xx

**Файлы:**
- Правка: `src/adapters/instagram/sender.ts`
- Правка: `src/worker.ts`
- Тест: `tests/adapters/instagram/sender.test.ts`, `tests/worker.test.ts`

- [x] **Шаг 1: Написать тест на классификацию постоянных ошибок Meta API**
В `tests/adapters/instagram/sender.test.ts` проверить распознавание ошибок `10` / `230` / `2018001` (окно истекло) и `190` (невалидный токен) как non-retryable.

- [x] **Шаг 2: Реализовать типизированный результат отправки в адаптере**
Возвращать результат: `{ ok: true } | { ok: false, retryable: boolean, reason: string }`.

- [x] **Шаг 3: Обработать non-retryable ошибки в воркере**
Если `retryable === false`, фиксировать `failedReason: outcome.reason`, `sentAt: now` в `outbox`.

- [x] **Шаг 4: Запустить тесты, убедиться что проходят**
`npx vitest run tests/adapters/instagram/ tests/worker.test.ts`

---

## Задача 3: Просмотр ошибок доставки в кабинете (S11, S21)

**Файлы:**
- Правка: `src/storage/queries/runtime.ts`
- Создание/правка: `src/web/routes/dashboard.ts`, `src/web/views/dashboard.ts`
- Тест: `tests/storage/queries/runtime.test.ts`, `tests/web/isolation.test.ts`

- [x] **Шаг 1: Написать падающий тест выборки ошибок доставки (S11)**
В `tests/storage/queries/runtime.test.ts`: `listDeliveryErrors(db, userId)` возвращает только ошибки указанного пользователя.

- [x] **Шаг 2: Реализовать `listDeliveryErrors` в `src/storage/queries/runtime.ts`**
Выборка из `outbox` по `user_id` где `failed_reason IS NOT NULL` с сортировкой по времени.

- [x] **Шаг 3: Отобразить блок ошибок доставки в кабинете**
В `src/web/views/dashboard.ts` выводить список недавних проблем с отправкой с понятным текстом (S21 экранирование).

- [x] **Шаг 4: Запустить тесты, убедиться что проходят**
`npx vitest run tests/web/isolation.test.ts`

---

## Задача 4: Аудит безопасности и гигиены логов (S4, S9)

**Файлы:**
- Правка: `src/server.ts`, `src/worker.ts`, `src/adapters/instagram/sender.ts`
- Тест: `tests/security/logging.test.ts`

- [x] **Шаг 1: Написать тесты на гигиену логов (S9)**
Проверка: при симуляции сетевых и бизнес-ошибок логгер не получает `token`, `payloadJson`, `actionJson` и сырые объекты исключений.

- [x] **Шаг 2: Провести ревизию всех мест вызова `app.log` и `console`**

- [x] **Шаг 3: Запустить полный набор проверок**
`npm run check` и `npm audit`
