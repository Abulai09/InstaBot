import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // PGlite — это настоящий Postgres в WASM: старт одной базы стоит около
    // секунды, и при параллельных файлах тестов первый запрос в файле легко
    // выходит за стандартные 5 с. Таймаут поднят под старт базы, а не потому,
    // что тесты долгие: сами проверки идут миллисекунды
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
