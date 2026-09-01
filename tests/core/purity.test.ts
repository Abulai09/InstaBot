import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

// Инфраструктура запрещена везде в core
const FORBIDDEN_EVERYWHERE = ['fastify', 'drizzle', 'fetch(', 'process.env', 'import(' ];
// Имена платформ запрещены везде, КРОМЕ types.ts: там живёт union `Platform`,
// и это единственное законное место, где ядро вообще их перечисляет.
const FORBIDDEN_OUTSIDE_TYPES = ['instagram', 'tiktok', 'meta'];

describe('чистота слоя core', () => {
  it('core не упоминает платформы и инфраструктуру', () => {
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
