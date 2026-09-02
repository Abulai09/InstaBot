import { basename } from 'node:path';
import { readFileSync } from 'node:fs';
import { loadConfig } from '../src/config.js';
import { openDb } from '../src/storage/db.js';
import { createUser } from '../src/storage/queries/users.js';
import { connectAccount } from '../src/storage/queries/accounts.js';
import { createAutomation, type NewStep } from '../src/storage/queries/automations.js';
import { saveFile } from '../src/storage/files.js';
import { hashPassword } from '../src/web/password.js';

// Пароль четвёртым, а не после пути к файлу: необязательный аргумент перед
// обязательным — ловушка, вызов без PDF принял бы пароль за путь
const [email, externalAccountId, token, password, filePath] = process.argv.slice(2);

if (
  email === undefined || externalAccountId === undefined
  || token === undefined || password === undefined
) {
  console.error(
    'Использование: npm run seed -- <email> <instagram-account-id> <token> <пароль> [путь-к-файлу.pdf]',
  );
  process.exit(1);
}

const cfg = loadConfig();
const db = openDb(cfg.DATABASE_URL);

const userId = createUser(db, { email, passwordHash: await hashPassword(password) });
connectAccount(
  db, userId,
  { platform: 'instagram', externalAccountId, token },
  cfg.CREDENTIALS_ENC_KEY,
);

// Загрузки через браузер ещё нет (фаза D), поэтому лид-магнит кладёт скрипт.
// saveFile проверит сигнатуру, размер и расширение — те же правила, что будут в форме
const fileId = filePath === undefined
  ? undefined
  : saveFile(db, userId, {
    originalName: basename(filePath),
    mimeType: 'application/pdf',
    bytes: readFileSync(filePath),
  }, cfg.FILES_DIR);

const first: NewStep = {
  say: 'Отправил в директ, посмотрите сообщения',
  ...(fileId === undefined ? {} : { fileId }),
};

createAutomation(db, userId, {
  name: 'Прайс по слову «цена»',
  triggerType: 'contains',
  triggerValue: 'цена',
  steps: [
    first,
    { say: 'Как вас зовут?', saveReplyAs: 'name' },
    { say: 'Спасибо! Скоро свяжемся.' },
  ],
});

// Токен не печатаем ни при каких условиях (S9)
console.log(`Клиент заведён: ${userId}`);
console.log(fileId === undefined ? 'Файл не приложен' : 'Файл приложен к первому шагу');
