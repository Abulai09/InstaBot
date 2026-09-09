# TikTok — дизайн адаптера опроса и ответов (фаза G)

Дата: 2026-09-09
Статус: проектирование

## 1. Контекст и ограничения платформы TikTok

В отличие от Instagram (push через webhook), TikTok не предоставляет открытого webhook для новых комментариев и не предоставляет общедоступного DM API:
1. **Приём событий:** только периодический опрос (polling) API комментариев TikTok Business (`https://business-api.tiktok.com/open_api/v1.3/business/comment/list/`).
2. **Исходящие действия:** только ответ на комментарий (`reply_comment`) через `https://business-api.tiktok.com/open_api/v1.3/business/comment/reply/`.
3. **Ограничения:**
   - Отправка в директ (`send_text`, `dm_the_commenter`), кнопки (`send_buttons`) и вложения (`send_file`) платформой не поддерживаются.
   - Адаптер возвращает `{ ok: false, retry: false, reason: 'TikTok поддерживает только ответы в комментариях' }` на любые попытки отправки директ-сообщений или файлов.

## 2. Архитектура и поток данных

```
Служба опроса (scheduler / worker)
   │
   ├─► Выборка всех подключённых аккаунтов с platform = 'tiktok'
   │
   ├─► Для каждого аккаунта: TikTokAdapter.poll(token, businessId)
   │     └─► Запрос списка комментариев к видео
   │     └─► Преобразование в IncomingEvent[]
   │     └─► Запись в eventQueue (с userId аккаунта и дедупликацией по dedupeKey)
   │
Воркер (runIntake -> engine.step -> outbox -> runDelivery)
   │
   └─► TikTokAdapter.send(action, delivery, token)
         └─► reply_comment -> POST /business/comment/reply/
```

## 3. Модель данных и интерфейсы

### Интерфейс `PollingSource` в `src/adapters/types.ts`:
```ts
export interface PolledCommentsResult {
  events: IncomingEvent[];
}

export interface PollingSource extends MessageSender {
  pollComments(
    token: string,
    businessId: string,
  ): Promise<{ ok: true; events: IncomingEvent[] } | { ok: false; retry: boolean; reason: string }>;
}
```

### Преобразование события TikTok в `IncomingEvent`:
- `platform`: `'tiktok'`
- `kind`: `'comment'`
- `externalUserId`: `comment.user_id`
- `externalThreadId`: `comment.video_id`
- `externalCommentId`: `comment.comment_id`
- `text`: `comment.text`
- `payload`: `null`
- `dedupeKey`: `tiktok:comment:<comment_id>`
- `receivedAt`: `new Date(comment.create_time * 1000)`

## 4. Безопасность и надежность

- **S1 (Изоляция тенантов):** Опрос выполняется отдельно для каждого аккаунта с его собственным токеном; события пишутся в `event_queue` строго с `userId` владельца аккаунта.
- **S4 (Шифрование):** Токены TikTok хранятся в `platform_accounts` зашифрованными AES-256-GCM.
- **S9 (Гигиена логов):** Токены передаются в заголовке `Access-Token`, ошибки сети и API парсятся без утечки токенов и тел запросов в лог.
- **S20 (Троттлинг):** Опрос выполняется по настраиваемому интервалу `TIKTOK_POLL_INTERVAL_SEC`, отправка ответов проходит общий `clientThrottle` воркера.

## 5. План фазы G
1. Реализация `TikTokAdapter` (`src/adapters/tiktok/adapter.ts`) с поддержкой `pollComments` и `send`.
2. Контрактные тесты адаптера (`tests/adapters/tiktok/adapter.test.ts`).
3. Модуль периодического опроса TikTok-аккаунтов (`src/adapters/tiktok/poller.ts`) и интеграция в цикл сервера (`src/server.ts`).
4. Подключение аккаунтов TikTok через админку / кабинет.
