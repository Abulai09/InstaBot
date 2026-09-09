import { loadConfig } from '../src/config.js';
import { TikTokAdapter } from '../src/adapters/tiktok/adapter.js';

const [businessId, flag] = process.argv.slice(2);
// Токен берётся из окружения, а не из аргумента: аргумент остаётся в истории
// оболочки и виден в списке процессов — та же причина, что у `npm run owner`
const token = process.env.TIKTOK_TEST_TOKEN;

if (businessId === undefined || token === undefined) {
  console.error('Использование: TIKTOK_TEST_TOKEN=<токен> npm run tiktok:check -- <business_id> [--show-text]');
  process.exit(1);
}

const cfg = loadConfig();
const adapter = new TikTokAdapter({ maxTextLength: cfg.MAX_INCOMING_TEXT_LENGTH });
const result = await adapter.pollComments(token, businessId);

if (!result.ok) {
  console.error(`Отказ: ${result.reason} (повторять: ${result.retry ? 'да' : 'нет'})`);
  process.exit(1);
}

console.log(`Комментариев получено: ${result.events.length}`);
for (const event of result.events) {
  // Текст комментария — данные живого человека, поэтому по умолчанию не печатается (S9).
  // Флаг нужен ровно один раз: убедиться, что кириллица и эмодзи доехали целыми
  const text = flag === '--show-text' ? ` ${JSON.stringify(event.text)}` : '';
  console.log(`  ${event.dedupeKey} видео=${event.externalThreadId} автор=${event.externalUserId}${text}`);
}
