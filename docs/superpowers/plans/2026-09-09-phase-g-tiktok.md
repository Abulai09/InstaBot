# TikTok-адаптер — план реализации (фаза G)

> **Для агентов-исполнителей:** ОБЯЗАТЕЛЬНЫЙ СУБ-СКИЛЛ: `superpowers:subagent-driven-development`
> или `superpowers:executing-plans`. Шаги отмечаются чекбоксами `- [ ]`.
> Обязательны `modern-architecture` и `web-security` — правила CLAUDE.md.

**Цель:** реализовать поддержку второй платформы (TikTok) в мультитенантном режиме: периодический опрос комментариев (polling) через Business API, постановка в очередь `event_queue` с владельцем и отправка ответов на комментарии (`reply_comment`).

**Спека:** `docs/superpowers/specs/2026-09-09-phase-g-tiktok-design.md`

## Глобальные ограничения
- ESM (импорты с `.js`).
- Строгий TypeScript, никаких `any`, `!`, `as unknown as` в `src/`.
- Владелец — первый аргумент в запросах к данным (`userId` в `WHERE`).
- Секреты и ПД не логируются выше `debug` (S4, S9).

---

## Задача 1: Интерфейс PollingSource и типизация TikTok API

**Файлы:**
- Правка: `src/adapters/types.ts`
- Создание: `src/adapters/tiktok/adapter.ts`
- Тест: `tests/adapters/tiktok/adapter.test.ts`

- [x] **Шаг 1: Написать падающий тест для TikTokAdapter**
В `tests/adapters/tiktok/adapter.test.ts` проверить:
- парсинг ответа списка комментариев TikTok в `IncomingEvent[]`;
- отправку ответа на комментарий через `reply_comment`;
- отклонение действий директа (`send_text`, `send_file`, `send_buttons`) как неподдерживаемых;
- гигиену логов и секретов (токен не раскрывается в ошибках).

- [x] **Шаг 2: Добавить интерфейс `PollingSource` в `src/adapters/types.ts`**

- [x] **Шаг 3: Реализовать `TikTokAdapter` в `src/adapters/tiktok/adapter.ts`**
Методы:
- `pollComments(token, businessId)` — запрос к TikTok Business API, возврат `IncomingEvent[]`.
- `send(action, delivery, token)` — отправка `reply_comment` в TikTok.

- [x] **Шаг 4: Запустить тесты, убедиться что проходят**
`npx vitest run tests/adapters/tiktok/adapter.test.ts`

---

## Задача 2: Модуль опроса TikTok и интеграция в сервер/воркер

**Файлы:**
- Создание: `src/adapters/tiktok/poller.ts`
- Правка: `src/server.ts`
- Тест: `tests/adapters/tiktok/poller.test.ts`

- [x] **Шаг 1: Написать тест на поллер TikTok-аккаунтов**
В `tests/adapters/tiktok/poller.test.ts`:
- выборка всех подключённых аккаунтов `platform = 'tiktok'`;
- расшифровка токенов;
- опрос каждого аккаунта через `adapter.pollComments`;
- дедупликация и запись новых комментариев в `event_queue` с `userId` владельца.

- [x] **Шаг 2: Реализовать `pollAllTikTokAccounts` в `src/adapters/tiktok/poller.ts`**

- [x] **Шаг 3: Подключить TikTokAdapter и интервал опроса в `src/server.ts`**
Добавить `tiktok` в карту `senders` воркера и запустить периодический таймер `pollAllTikTokAccounts` по `TIKTOK_POLL_INTERVAL_SEC`.

- [x] **Шаг 4: Запустить тесты, убедиться что проходят**
`npx vitest run tests/adapters/tiktok/`

---

## Задача 3: Подключение аккаунтов TikTok в UI админки и изоляция данных (S11)

**Файлы:**
- Правка: `src/web/views/admin.ts`, `src/web/routes/admin.ts`
- Тест: `tests/web/admin.test.ts`, `tests/web/isolation.test.ts`

- [x] **Шаг 1: Написать тест на выбор платформы (Instagram / TikTok) при подключении аккаунта**

- [x] **Шаг 2: Обновить форму подключения аккаунта в `src/web/views/admin.ts` и роут в `src/web/routes/admin.ts`**

- [x] **Шаг 3: Запустить полный набор тестов и проверок**
`npm run check`
