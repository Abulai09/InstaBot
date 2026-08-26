import { describe, it, expect } from 'vitest';
import { loadConfig } from '../src/config.js';

const valid = {
  META_APP_SECRET: 'app-secret',
  META_VERIFY_TOKEN: 'verify-token',
  IG_PAGE_ACCESS_TOKEN: 'page-token',
  CREDENTIALS_ENC_KEY: 'a'.repeat(64),
} as unknown as NodeJS.ProcessEnv;

describe('loadConfig', () => {
  it('подставляет значения по умолчанию', () => {
    const cfg = loadConfig(valid);
    expect(cfg.PORT).toBe(3000);
    expect(cfg.NODE_ENV).toBe('development');
  });

  it('падает, если обязательная переменная отсутствует', () => {
    const { META_APP_SECRET, ...missing } = valid;
    expect(() => loadConfig(missing as NodeJS.ProcessEnv)).toThrow(/META_APP_SECRET/);
  });

  it('S10: не печатает значения переменных в сообщении об ошибке', () => {
    const bad = { ...valid, CREDENTIALS_ENC_KEY: 'korotkiy-klyuch' };
    try {
      loadConfig(bad as NodeJS.ProcessEnv);
      throw new Error('должно было упасть');
    } catch (e) {
      const msg = (e as Error).message;
      expect(msg).toContain('CREDENTIALS_ENC_KEY');
      expect(msg).not.toContain('korotkiy-klyuch');
      expect(msg).not.toContain('app-secret');
    }
  });
});
