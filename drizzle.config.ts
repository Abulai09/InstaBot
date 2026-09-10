import type { Config } from 'drizzle-kit';

export default {
  schema: './src/storage/schema.ts',
  out: './drizzle',
  dialect: 'postgresql',
  // `generate` обходится без подключения, `migrate` — нет. Это инструмент
  // сборки: он не входит в tsconfig.include и в рантайм приложения не попадает,
  // поэтому чтение process.env здесь не нарушает правило «env только в config.ts».
  // Значения по умолчанию нет: строка подключения содержит пароль, и подставлять
  // за пользователя чужую базу нельзя
  dbCredentials: { url: process.env.DATABASE_URL ?? '' },
} satisfies Config;
