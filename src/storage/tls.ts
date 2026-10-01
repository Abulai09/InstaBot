/**
 * Шифрование до базы по умолчанию, а не по памяти того, кто вставляет строку.
 * Supabase отдаёт строку подключения без `sslmode`, и без хвоста соединение
 * не проверяет подлинность сервера: пароль базы и токены клиентов уедут
 * любому, кто встанет посередине. Хвост дописывался руками — и забывался.
 *
 * Явный `sslmode` в строке не трогается: это решение владельца строки.
 * Локальная база остаётся без TLS — на своей машине его нет и не нужно.
 *
 * Путь к сертификату относительный, как и раньше: команды запускаются из
 * корня проекта, сертификат провайдера закоммичен в `certs/`.
 */
const TAIL = 'sslmode=verify-full&sslrootcert=./certs/supabase-prod-ca-2021.crt';

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);

export function withTls(url: string): string {
  const parsed = new URL(url);
  if (parsed.searchParams.has('sslmode')) return url;
  if (LOCAL_HOSTS.has(parsed.hostname)) return url;
  // Дописывается строкой, а не через `URL.toString()`: так пароль
  // со спецсимволами остаётся ровно в том виде, в каком его вставили
  return `${url}${parsed.search === '' ? '?' : '&'}${TAIL}`;
}
