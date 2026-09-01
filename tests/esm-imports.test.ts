import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

/**
 * ESM требует расширение в относительных импортах, но ни vitest, ни tsx, ни tsc
 * с moduleResolution "bundler" об этом не сообщают — падает только Node.
 * Тест переводит правило из разряда дисциплины в разряд проверяемого.
 */
function tsFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) return tsFiles(full);
    return full.endsWith('.ts') ? [full] : [];
  });
}

describe('импорты пригодны для Node ESM', () => {
  it('каждый относительный импорт в src/ заканчивается на .js', () => {
    const bad: string[] = [];
    for (const file of tsFiles('src')) {
      const text = readFileSync(file, 'utf8');
      for (const match of text.matchAll(/from\s+['"](\.[^'"]*)['"]/g)) {
        const spec = match[1];
        if (spec !== undefined && !spec.endsWith('.js')) bad.push(`${file}: ${spec}`);
      }
    }
    expect(bad, `импорты без расширения .js:\n${bad.join('\n')}`).toEqual([]);
  });
});
