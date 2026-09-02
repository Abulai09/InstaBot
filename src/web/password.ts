import { randomUUID } from 'node:crypto';
import { hash, verify } from '@node-rs/argon2';

export function hashPassword(plain: string): Promise<string> {
  return hash(plain);
}

/**
 * Заглушка для случая «такого email нет». Без неё ответ на несуществующий email
 * возвращается мгновенно, а на существующий — через десятки миллисекунд argon2,
 * и по времени ответа перебором собирается список аккаунтов сервиса (S13).
 *
 * Считается один раз за жизнь процесса: сам хэш ничего не защищает,
 * он нужен только чтобы потратить столько же времени.
 */
let dummy: Promise<string> | undefined;
function dummyHash(): Promise<string> {
  dummy ??= hashPassword(randomUUID());
  return dummy;
}

export async function verifyPassword(
  storedHash: string | undefined, plain: string,
): Promise<boolean> {
  const target = storedHash ?? await dummyHash();
  try {
    return await verify(target, plain);
  } catch {
    // Строка в колонке не является хэшем argon2 — вход просто не удался.
    // Объект ошибки не логируем: в нём оказывается сам хэш
    return false;
  }
}
