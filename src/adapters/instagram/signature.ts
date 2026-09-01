import { createHmac, timingSafeEqual } from 'node:crypto';

const PREFIX = 'sha256=';

/**
 * S1. Подпись считается от сырых байт тела: JSON.stringify(разобранного тела)
 * даёт другую строку — другой порядок ключей, другие пробелы — и подпись не сойдётся.
 *
 * Сравнение только timingSafeEqual: обычное === выходит на первом различии,
 * и по времени ответа подпись подбирается побайтно.
 * timingSafeEqual бросает на буферах разной длины, поэтому длина проверяется
 * заранее — сама длина секретом не является.
 */
export function verifySignature(
  rawBody: Buffer, header: string | undefined, appSecret: string,
): boolean {
  if (header === undefined || !header.startsWith(PREFIX)) return false;

  // Buffer.from(..., 'hex') не бросает на мусоре, а молча обрывает разбор:
  // такой буфер не совпадёт по длине и будет отвергнут строкой ниже
  const received = Buffer.from(header.slice(PREFIX.length), 'hex');
  const expected = createHmac('sha256', appSecret).update(rawBody).digest();
  if (received.length !== expected.length) return false;

  return timingSafeEqual(received, expected);
}

/**
 * S2. Токен из строки запроса сравнивается constant-time по той же причине,
 * что и подпись. Challenge возвращается только после совпадения — иначе адрес
 * превращается в отражатель произвольного текста.
 */
export function verifyHandshake(
  query: Record<string, unknown>, verifyToken: string,
): string | undefined {
  const mode = query['hub.mode'];
  const token = query['hub.verify_token'];
  const challenge = query['hub.challenge'];

  if (mode !== 'subscribe') return undefined;
  if (typeof token !== 'string' || typeof challenge !== 'string') return undefined;

  const received = Buffer.from(token, 'utf8');
  const expected = Buffer.from(verifyToken, 'utf8');
  if (received.length !== expected.length) return undefined;
  if (!timingSafeEqual(received, expected)) return undefined;

  return challenge;
}
