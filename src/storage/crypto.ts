import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

/** GCM работает с 96-битным IV — это рекомендованный размер, не произвольный. */
const IV_LENGTH = 12;
/** Длина тега аутентификации GCM. */
const TAG_LENGTH = 16;
/** AES-256 требует ровно 32 байта ключа, то есть 64 hex-символа. */
const KEY_LENGTH = 32;

function toKey(keyHex: string): Buffer {
  const key = Buffer.from(keyHex, 'hex');
  if (key.length !== KEY_LENGTH) {
    // Ни в коем случае не печатаем сам ключ (S10)
    throw new Error(`Ключ шифрования должен быть ${KEY_LENGTH} байт в hex`);
  }
  return key;
}

/**
 * Шифрует секрет для хранения в БД (S4).
 * GCM выбран вместо CBC потому, что аутентифицирует шифротекст: подменённые байты
 * обнаруживаются при расшифровке, а не превращаются в мусор, который код примет за токен.
 *
 * @returns base64 от склейки IV + тег + шифротекст
 */
export function encryptSecret(plain: string, keyHex: string): string {
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv('aes-256-gcm', toKey(keyHex), iv);
  const body = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), body]).toString('base64');
}

export function decryptSecret(packed: string, keyHex: string): string {
  const raw = Buffer.from(packed, 'base64');
  if (raw.length <= IV_LENGTH + TAG_LENGTH) {
    throw new Error('Повреждённый шифротекст');
  }
  const iv = raw.subarray(0, IV_LENGTH);
  const tag = raw.subarray(IV_LENGTH, IV_LENGTH + TAG_LENGTH);
  const body = raw.subarray(IV_LENGTH + TAG_LENGTH);

  const decipher = createDecipheriv('aes-256-gcm', toKey(keyHex), iv);
  // Если тег не сойдётся, final() бросит исключение — это и есть проверка подлинности
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(body), decipher.final()]).toString('utf8');
}
