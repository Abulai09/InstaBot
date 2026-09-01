import type { Config } from 'drizzle-kit';

export default {
  schema: './src/storage/schema.ts',
  out: './drizzle',
  dialect: 'sqlite',
} satisfies Config;
