import { readCookie } from './http.js';

/**
 * Тема кабинета. Три значения, а не два: «system» — это не «светлая по
 * умолчанию», а отсутствие выбора, и оно должно уметь вернуться. Пока выбора
 * нет, решает системная настройка через `prefers-color-scheme`.
 */
export type Theme = 'system' | 'light' | 'dark';

const THEME_COOKIE = 'theme';
const YEAR_SECONDS = 31_536_000;

function isTheme(value: string): value is Theme {
  return value === 'system' || value === 'light' || value === 'dark';
}

/** Значение из формы. Чужое или испорченное — не тема, и записывать нечего. */
export function parseTheme(value: unknown): Theme | undefined {
  return typeof value === 'string' && isTheme(value) ? value : undefined;
}

/**
 * Cookie приходит от браузера, то есть правится руками. Неизвестное значение
 * не подставляется в разметку и не логируется — просто откат к системной теме.
 */
export function readTheme(cookieHeader: string | undefined): Theme {
  const raw = readCookie(cookieHeader, THEME_COOKIE);
  if (raw === undefined) return 'system';
  return isTheme(raw) ? raw : 'system';
}

/**
 * «Системная» гасит cookie, а не пишет в неё третье значение: отсутствие
 * cookie и есть «выбора нет», и два способа сказать одно и то же со временем
 * разъезжаются.
 *
 * HttpOnly здесь не про секрет — читать тему скриптам всё равно незачем,
 * а скриптов в кабинете нет вовсе.
 */
export function themeCookie(theme: Theme, secure: boolean): string {
  const value = theme === 'system' ? '' : theme;
  const maxAge = theme === 'system' ? 0 : YEAR_SECONDS;
  const parts = [`${THEME_COOKIE}=${value}`, 'Path=/', 'HttpOnly', 'SameSite=Lax', `Max-Age=${maxAge}`];
  if (secure) parts.push('Secure');
  return parts.join('; ');
}

/**
 * Путь возврата приходит скрытым полем формы, а поле формы подделывается.
 * Без этой проверки вышел бы открытый редирект: ссылка на наш домен уводила бы
 * на чужой сайт, оформленный под кабинет.
 *
 * Разрешён только собственный абсолютный путь: один ведущий слэш и никакой
 * схемы. `//evil` и `/\evil` браузер трактует как чужой хост, поэтому они
 * отсекаются отдельно от проверки первого символа.
 *
 * Управляющие символы проверяются по кодам, а не классом в регулярке:
 * такой класс легко записать неправильно и не заметить этого.
 */
export function safeBackPath(raw: unknown): string {
  if (typeof raw !== 'string') return '/';
  if (raw.length === 0 || raw.length > 200) return '/';
  if (!raw.startsWith('/')) return '/';
  if (raw.startsWith('//') || raw.startsWith('/\\')) return '/';

  for (const char of raw) {
    const code = char.charCodeAt(0);
    // Перевод строки в заголовке Location — это расщепление ответа
    if (code < 0x20 || code === 0x7f) return '/';
  }
  return raw;
}
