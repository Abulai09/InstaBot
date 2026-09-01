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
connectAccount(
  db, userId,
  { platform: 'instagram', externalAccountId, token },
  cfg.CREDENTIALS_ENC_KEY,
);
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
