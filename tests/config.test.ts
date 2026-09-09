import { describe, it, expect } from 'vitest';
import { loadConfig } from '../src/config.js';

const valid = {
  META_APP_SECRET: 'app-secret',
  META_VERIFY_TOKEN: 'verify-token',
  CREDENTIALS_ENC_KEY: 'a'.repeat(64),
  SESSION_SECRET: 'a'.repeat(32),
  PUBLIC_BASE_URL: 'https://bot.example.com',
} as unknown as NodeJS.ProcessEnv;

describe('loadConfig', () => {
  it('подставляет значения по умолчанию', () => {
    const cfg = loadConfig(valid);
    expect(cfg.PORT).toBe(3000);
    expect(cfg.NODE_ENV).toBe('development');
  });

  it('подставляет значения по умолчанию для настроек воркера', () => {
    const cfg = loadConfig(valid);
    expect(cfg.WORKER_INTERVAL_MS).toBe(2000);
    expect(cfg.OUTBOX_MAX_ATTEMPTS).toBe(8);
  });

  it('падает, если обязательная переменная отсутствует', () => {
    const { META_APP_SECRET, ...missing } = valid;
    expect(() => loadConfig(missing as NodeJS.ProcessEnv)).toThrow(/META_APP_SECRET/);
  });

  it('не требует общий токен Instagram: он свой у каждого клиента и лежит в БД', () => {
    const cfg = loadConfig(valid);
    expect(Object.keys(cfg)).not.toContain('IG_PAGE_ACCESS_TOKEN');
    expect(Object.keys(cfg)).not.toContain('OPERATOR_TELEGRAM_BOT_TOKEN');
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

  it('подставляет каталог файлов по умолчанию', () => {
    expect(loadConfig(valid).FILES_DIR).toBe('./data/files');
  });

  it('подставляет значения по умолчанию для входа', () => {
    const cfg = loadConfig(valid);
    expect(cfg.SESSION_TTL_DAYS).toBe(7);
    expect(cfg.LOGIN_MAX_ATTEMPTS).toBe(5);
    expect(cfg.LOGIN_WINDOW_MINUTES).toBe(15);
  });

  it('S10: короткий SESSION_SECRET отвергается по имени, без значения', () => {
    const bad = { ...valid, SESSION_SECRET: 'коротко' };
    try {
      loadConfig(bad as unknown as NodeJS.ProcessEnv);
      throw new Error('должно было упасть');
    } catch (error) {
      const msg = error instanceof Error ? error.message : '';
      expect(msg).toContain('SESSION_SECRET');
      expect(msg).not.toContain('коротко');
    }
  });

  it('подставляет срок жизни приглашения по умолчанию', () => {
    expect(loadConfig(valid).INVITE_TTL_HOURS).toBe(48);
  });

  it('PUBLIC_BASE_URL обязательна: из заголовка Host её брать нельзя', () => {
    const { PUBLIC_BASE_URL, ...missing } = valid;
    expect(() => loadConfig(missing as NodeJS.ProcessEnv)).toThrow(/PUBLIC_BASE_URL/);
  });

  it('S10: непохожий на URL адрес отвергается по имени, без значения', () => {
    const bad = { ...valid, PUBLIC_BASE_URL: 'ne-url-a-musor' };
    try {
      loadConfig(bad as NodeJS.ProcessEnv);
      throw new Error('должно было упасть');
    } catch (e) {
      const msg = (e as Error).message;
      expect(msg).toContain('PUBLIC_BASE_URL');
      expect(msg).not.toContain('ne-url-a-musor');
    }
  });
});
