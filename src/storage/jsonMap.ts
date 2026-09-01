/**
 * Разбирает JSON-объект «строка → строка» в `Map` (S6).
 *
 * Почему не `z.record(...)`: Zod пересобирает объект присваиванием, и ключ
 * `__proto__` при этом молча исчезает — атаки нет, но данные теряются.
 * `Object.entries` видит его как обычное собственное свойство, а `Map.set`
 * к загрязнению прототипа невосприимчив: ключи хранятся отдельно от прототипа.
 */
export function parseStringMap(json: string, what: string): Map<string, string> {
  const parsed: unknown = JSON.parse(json);
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error(`${what}: ожидался JSON-объект`);
  }

  const result = new Map<string, string>();
  for (const [key, value] of Object.entries(parsed)) {
    if (typeof value !== 'string') {
      // Имя ключа безопасно, значение — нет: оно может быть телефоном (S9)
      throw new Error(`${what}: значение ключа "${key}" не строка`);
    }
    result.set(key, value);
  }
  return result;
}
