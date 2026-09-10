import { z } from 'zod';

const EnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(3000),
  // Строка подключения к Postgres, а не путь к файлу. Обязательная и без значения
  // по умолчанию: она содержит пароль, и подставлять за пользователя чужую базу
  // нельзя. Префикс проверяется здесь, чтобы забытый './data/bot.db' падал при
  // старте с понятным именем переменной, а не при первом запросе. В сообщении
  // об ошибке — только имя переменной, никогда её значение (S10)
  DATABASE_URL: z
    .string()
    .regex(/^postgres(ql)?:\/\//, 'ожидается строка подключения postgres://'),
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
  // Лизинг строки outbox: на столько секунд забранная строка становится невидимой
  // для других копий процесса. Должен быть заведомо больше времени одной отправки,
  // иначе вторая копия заберёт строку, пока первая ещё ждёт ответ платформы,
  // и человек получит сообщение дважды
  OUTBOX_LEASE_SEC: z.coerce.number().int().positive().default(60),
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
