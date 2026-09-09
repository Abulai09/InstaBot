import { z } from 'zod';

const EnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(3000),
  DATABASE_URL: z.string().min(1).default('./data/bot.db'),
  // Каталог с файлами клиентов. Вне веб-корня: наружу они уходят только
  // маршрутом кабинета, который проверяет владельца (S16, S18)
  FILES_DIR: z.string().min(1).default('./data/files'),

  META_APP_SECRET: z.string().min(1),
  META_VERIFY_TOKEN: z.string().min(1),
  // Токен доступа не общий: он свой у каждого клиента и лежит в platform_accounts
  // зашифрованным (S4). В окружении его быть не должно.

  // 32 байта в hex — ключ AES-256-GCM
  CREDENTIALS_ENC_KEY: z.string().length(64),

  // Ключ для CSRF-токенов. Отдельный от CREDENTIALS_ENC_KEY: один ключ
  // на две разные задачи — плохая практика, компрометация одной ломает обе
  SESSION_SECRET: z.string().min(32),
  SESSION_TTL_DAYS: z.coerce.number().int().positive().default(7),
  LOGIN_MAX_ATTEMPTS: z.coerce.number().int().positive().default(5),
  LOGIN_WINDOW_MINUTES: z.coerce.number().int().positive().default(15),
  INVITE_TTL_HOURS: z.coerce.number().int().positive().default(48),
  // Основа ссылки приглашения. Обязательная и не выводится из заголовка `Host`:
  // он приходит от клиента, и ссылка увела бы токен на чужой домен
  PUBLIC_BASE_URL: z.url(),

  TIKTOK_CLIENT_KEY: z.string().optional(),
  TIKTOK_CLIENT_SECRET: z.string().optional(),
  TIKTOK_POLL_INTERVAL_SEC: z.coerce.number().int().positive().default(120),

  THROTTLE_MAX_REPLIES_PER_MINUTE: z.coerce.number().int().positive().default(6),
  THROTTLE_MAX_REPLIES_PER_CLIENT_PER_MINUTE: z.coerce.number().int().positive().default(60),
  MAX_INCOMING_TEXT_LENGTH: z.coerce.number().int().positive().default(2000),

  WORKER_INTERVAL_MS: z.coerce.number().int().positive().default(2000),
  OUTBOX_MAX_ATTEMPTS: z.coerce.number().int().positive().default(8),
});

export type Config = z.infer<typeof EnvSchema>;

export function loadConfig(raw: NodeJS.ProcessEnv = process.env): Config {
  const parsed = EnvSchema.safeParse(raw);
  if (!parsed.success) {
    // S10: только имена переменных, никогда значения — иначе секрет
    // окажется в логах и в трассировке падения при старте
    const names = parsed.error.issues.map((i) => i.path.join('.')).join(', ');
    throw new Error(`Некорректная конфигурация окружения: ${names}`);
  }
  return parsed.data;
}
