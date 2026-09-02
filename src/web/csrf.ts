import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * Токен выводится из сессии, а не хранится: подделать его без секрета нельзя,
 * а колонки в БД и её ротации не требуется (S15).
 *
 * Секрет отдельный от ключа шифрования токенов платформ: один ключ на две
 * задачи означает, что компрометация одной ломает обе.
 */
export function csrfToken(sessionToken: string, secret: string): string {
  return createHmac('sha256', secret).update(sessionToken, 'utf8').digest('hex');
}

/**
 * Сравнение constant-time по той же причине, что и подпись вебхука:
 * обычное === выходит на первом различии, и токен подбирается побайтно.
 */
export function csrfValid(
  sessionToken: string, provided: string | undefined, secret: string,
): boolean {
  if (provided === undefined || provided.length === 0) return false;

  const expected = Buffer.from(csrfToken(sessionToken, secret), 'utf8');
  const received = Buffer.from(provided, 'utf8');
  if (expected.length !== received.length) return false;

  return timingSafeEqual(expected, received);
}
