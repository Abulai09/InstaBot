import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

// Инфраструктура запрещена везде в core
// 'node:' — после удаления YAML-пути ядру нечего читать с диска: сценарии
// приходят из БД. Запрет держит это состояние — вернуть чтение файлов в core
// значит снова сделать движок непроверяемым без файловой системы
const FORBIDDEN_EVERYWHERE = ['fastify', 'drizzle', 'fetch(', 'process.env', 'import(', 'node:'];
// Имена платформ запрещены везде, КРОМЕ types.ts: там живёт union `Platform`,
// и это единственное законное место, где ядро вообще их перечисляет.
const FORBIDDEN_OUTSIDE_TYPES = ['instagram', 'tiktok', 'meta'];

describe('чистота слоя core', () => {
  it('core не упоминает платформы и инфраструктуру', async () => {
    const dir = 'src/core';
    for (const file of readdirSync(dir)) {
      const text = readFileSync(join(dir, file), 'utf8').toLowerCase();

      for (const word of FORBIDDEN_EVERYWHERE) {
        expect(text, `${file} содержит запрещённое "${word}"`).not.toContain(word);
      }
      if (file === 'types.ts') continue;
      for (const word of FORBIDDEN_OUTSIDE_TYPES) {
        expect(text, `${file} содержит имя платформы "${word}"`).not.toContain(word);
      }
    }
  });
});
