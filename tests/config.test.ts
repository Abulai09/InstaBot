import { describe, it, expect } from 'vitest';
import { loadConfig } from '../src/config.js';

const valid = {
  DATABASE_URL: 'postgresql://user:pass@localhost:5432/bot',
  META_APP_SECRET: 'app-secret',
  META_VERIFY_TOKEN: 'verify-token',
  CREDENTIALS_ENC_KEY: 'a'.repeat(64),
  SESSION_SECRET: 'a'.repeat(32),
  PUBLIC_BASE_URL: 'https://bot.example.com',
} as unknown as NodeJS.ProcessEnv;

describe('loadConfig', () => {
  it('подставляет значения по умолчанию', async () => {
    const cfg = loadConfig(valid);
    expect(cfg.PORT).toBe(3000);
    expect(cfg.NODE_ENV).toBe('development');
  });

  it('подставляет значения по умолчанию для настроек воркера', async () => {
    const cfg = loadConfig(valid);
    expect(cfg.WORKER_INTERVAL_MS).toBe(2000);
    expect(cfg.OUTBOX_MAX_ATTEMPTS).toBe(8);
    expect(cfg.OUTBOX_LEASE_SEC).toBe(60);
    expect(cfg.THROTTLE_MAX_REPLIES_PER_CLIENT_PER_MINUTE).toBe(60);
  });

  it('требует строку подключения Postgres, а не путь к файлу', async () => {
    const { DATABASE_URL, ...missing } = valid;
    expect(() => loadConfig(missing as NodeJS.ProcessEnv)).toThrow(/DATABASE_URL/);

    const sqlitePath = { ...valid, DATABASE_URL: './data/bot.db' };
    expect(() => loadConfig(sqlitePath as NodeJS.ProcessEnv)).toThrow(/DATABASE_URL/);

    const short = { ...valid, DATABASE_URL: 'postgres://user:pass@host:5432/db' };
    expect(loadConfig(short as NodeJS.ProcessEnv).DATABASE_URL).toContain('postgres://');
  });

  it('S10: пароль из строки подключения не попадает в сообщение об ошибке', async () => {
    const bad = { ...valid, DATABASE_URL: 'mysql://user:sekret-parol@host/db' };
    try {
      loadConfig(bad as NodeJS.ProcessEnv);
      expect.unreachable('ожидалась ошибка конфигурации');
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      expect(message).toContain('DATABASE_URL');
      expect(message).not.toContain('sekret-parol');
    }
  });

  it('падает, если обязательная переменная отсутствует', async () => {
    const { META_APP_SECRET, ...missing } = valid;
    expect(() => loadConfig(missing as NodeJS.ProcessEnv)).toThrow(/META_APP_SECRET/);
  });

  it('не требует общий токен Instagram: он свой у каждого клиента и лежит в БД', async () => {
    const cfg = loadConfig(valid);
    expect(Object.keys(cfg)).not.toContain('IG_PAGE_ACCESS_TOKEN');
    expect(Object.keys(cfg)).not.toContain('OPERATOR_TELEGRAM_BOT_TOKEN');
  });

  it('S10: не печатает значения переменных в сообщении об ошибке', async () => {
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

  it('подставляет каталог файлов по умолчанию', async () => {
    expect(loadConfig(valid).FILES_DIR).toBe('./data/files');
  });

  it('подставляет значения по умолчанию для входа', async () => {
    const cfg = loadConfig(valid);
    expect(cfg.SESSION_TTL_DAYS).toBe(7);
    expect(cfg.LOGIN_MAX_ATTEMPTS).toBe(5);
    expect(cfg.LOGIN_WINDOW_MINUTES).toBe(15);
  });

  it('S10: короткий SESSION_SECRET отвергается по имени, без значения', async () => {
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

  it('подставляет срок жизни приглашения по умолчанию', async () => {
    expect(loadConfig(valid).INVITE_TTL_HOURS).toBe(48);
  });

  it('PUBLIC_BASE_URL обязательна: из заголовка Host её брать нельзя', async () => {
    const { PUBLIC_BASE_URL, ...missing } = valid;
    expect(() => loadConfig(missing as NodeJS.ProcessEnv)).toThrow(/PUBLIC_BASE_URL/);
  });

  it('S10: непохожий на URL адрес отвергается по имени, без значения', async () => {
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
