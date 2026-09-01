import { z } from 'zod';

const EnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(3000),
  DATABASE_URL: z.string().min(1).default('./data/bot.db'),

  META_APP_SECRET: z.string().min(1),
  META_VERIFY_TOKEN: z.string().min(1),
  // Токен доступа не общий: он свой у каждого клиента и лежит в platform_accounts
  // зашифрованным (S4). В окружении его быть не должно.

  // 32 байта в hex — ключ AES-256-GCM
  CREDENTIALS_ENC_KEY: z.string().length(64),

  TIKTOK_CLIENT_KEY: z.string().optional(),
  TIKTOK_CLIENT_SECRET: z.string().optional(),
  TIKTOK_POLL_INTERVAL_SEC: z.coerce.number().int().positive().default(120),

  THROTTLE_MAX_REPLIES_PER_MINUTE: z.coerce.number().int().positive().default(6),
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
