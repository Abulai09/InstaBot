import type { Config } from 'drizzle-kit';

export default {
  schema: './src/storage/schema.ts',
  out: './drizzle',
  dialect: 'sqlite',
  // `generate` обходится без подключения, `migrate` — нет. Это инструмент
  // сборки: он не входит в tsconfig.include и в рантайм приложения не попадает,
  // поэтому чтение process.env здесь не нарушает правило «env только в config.ts»
  dbCredentials: { url: process.env.DATABASE_URL ?? './data/bot.db' },
} satisfies Config;
