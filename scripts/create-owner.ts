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
const { db, close } = openDb(cfg.DATABASE_URL);

if (await findUserByEmail(db, email) !== undefined) {
  console.error('Пользователь с такой почтой уже есть');
  await close();
  process.exit(1);
}

// Пароль не принимается аргументом: он остался бы в истории оболочки и в списке
// процессов. Владелец ставит его той же формой приглашения, что и клиенты —
// один путь установки пароля на весь сервис
const userId = await createUser(db, {
  email, passwordHash: await hashPassword(randomUUID()), role: 'owner',
});
const token = await createInvite(db, userId, new Date(), cfg.INVITE_TTL_HOURS * 3_600_000);

console.log(`Владелец ${email} заведён.`);
console.log(`Ссылка (действует ${cfg.INVITE_TTL_HOURS} ч, показывается один раз):`);
console.log(`${cfg.PUBLIC_BASE_URL.replace(/\/+$/, '')}/invite/${token}`);

// Пул держит сокет открытым: без этого скрипт не завершится
await close();
