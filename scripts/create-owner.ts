import { randomUUID } from 'node:crypto';
import { loadConfig } from '../src/config.js';
import { openDb } from '../src/storage/db.js';
import { createInvite, revokeUserInvites } from '../src/storage/queries/invites.js';
import { createUser, findUserByEmail } from '../src/storage/queries/users.js';
import { hashPassword } from '../src/web/password.js';

const args = process.argv.slice(2);
const reset = args.includes('--reset');
const rawEmail = args.find((arg) => !arg.startsWith('--'));

if (rawEmail === undefined) {
  console.error('Использование: npm run owner -- <email> [--reset]');
  process.exit(1);
}

const email = rawEmail.trim().toLowerCase();
const cfg = loadConfig();
const { db, close } = openDb(cfg.DATABASE_URL);
const ttlMs = cfg.INVITE_TTL_HOURS * 3_600_000;
const now = new Date();
const existing = await findUserByEmail(db, email);

let userId: string;
if (reset) {
  // Восстановление доступа владельца, забывшего пароль. В админке такого пути
  // нет намеренно: владельцы через неё не управляются (S12). Здесь защита —
  // сама возможность запустить скрипт: нужен пароль боевой базы.
  // Пароль не сбрасывается сразу — выдаётся ссылка, старый пароль работает,
  // пока по ней не поставят новый; установка пароля гасит все сессии (S15)
  if (existing === undefined || existing.role !== 'owner') {
    console.error('Владельца с такой почтой нет');
    await close();
    process.exit(1);
  }
  userId = existing.id;
  await revokeUserInvites(db, userId, now);
} else {
  if (existing !== undefined) {
    console.error('Пользователь с такой почтой уже есть. Забыли пароль — добавьте --reset');
    await close();
    process.exit(1);
  }
  // Пароль не принимается аргументом: он остался бы в истории оболочки и в списке
  // процессов. Владелец ставит его той же формой приглашения, что и клиенты —
  // один путь установки пароля на весь сервис
  userId = await createUser(db, {
    email, passwordHash: await hashPassword(randomUUID()), role: 'owner',
  });
}

const token = await createInvite(db, userId, now, ttlMs);

console.log(reset ? `Ссылка для смены пароля ${email}.` : `Владелец ${email} заведён.`);
console.log(`Ссылка (действует ${cfg.INVITE_TTL_HOURS} ч, показывается один раз):`);
console.log(`${cfg.PUBLIC_BASE_URL.replace(/\/+$/, '')}/invite/${token}`);

// Пул держит сокет открытым: без этого скрипт не завершится
await close();
