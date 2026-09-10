import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Fastify, { type FastifyInstance } from 'fastify';
import { describe, expect, it } from 'vitest';
import { createTestDb } from '../storage/helpers.js';
import { createUser } from '../../src/storage/queries/users.js';
import { createSession } from '../../src/storage/queries/sessions.js';
import { listFiles, saveFile } from '../../src/storage/files.js';
import { createAutomation } from '../../src/storage/queries/automations.js';
import { loadConfig } from '../../src/config.js';
import { ReplyThrottle } from '../../src/core/throttle.js';
import { csrfToken } from '../../src/web/csrf.js';
import { registerFormParser } from '../../src/web/http.js';
import { registerFilesRoutes } from '../../src/web/routes/files.js';
import type { AppDb } from '../../src/storage/db.js';

const SECRET = 'a'.repeat(32);
const NOW = new Date('2026-09-02T12:00:00Z');
const DAY = 86_400_000;
const PDF = Buffer.concat([Buffer.from([0x25, 0x50, 0x44, 0x46]), Buffer.from('-1.4 тест')]);
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00]);

function config(filesDir: string) {
  return loadConfig({
    DATABASE_URL: 'postgresql://u:p@localhost:5432/test',
    META_APP_SECRET: 's', META_VERIFY_TOKEN: 'v',
    CREDENTIALS_ENC_KEY: 'a'.repeat(64), SESSION_SECRET: SECRET, FILES_DIR: filesDir,
    PUBLIC_BASE_URL: 'https://bot.example.com',
  } as unknown as NodeJS.ProcessEnv);
}

function build(db: AppDb): { app: FastifyInstance; dir: string } {
  const dir = mkdtempSync(join(tmpdir(), 'files-test-'));
  const app = Fastify();
  registerFormParser(app);
  registerFilesRoutes(app, { db, cfg: config(dir), throttle: new ReplyThrottle(5) });
  return { app, dir };
}

async function login(db: AppDb, userId: string) {
  // Сессия выдаётся от текущего момента: маршрут проверяет срок по реальному
  // времени (`new Date()` внутри `currentSession`), и фиксированная дата
  // протухает через неделю после написания теста
  const token = await createSession(db, userId, new Date(), 7 * DAY);
  return { cookie: `sid=${token}`, csrf: csrfToken(token, SECRET) };
}

/**
 * Готовый запрос на загрузку. Тело multipart собирается вручную: инъекция
 * принимает только готовые байты, а порядок частей здесь важен — токен должен
 * идти до файла.
 *
 * Boundary только из ASCII: RFC 2046 ограничивает его набор символов,
 * на кириллице в нём разбора не происходит вовсе.
 *
 * Cookie кладётся в тот же объект заголовков, а не рядом в вызове inject:
 * спред заголовков затирает соседний ключ `headers` целиком, и сессия
 * тогда не доезжает до маршрута.
 */
function upload(
  cookie: string,
  fields: Record<string, string>,
  file?: { name: string; type: string; bytes: Buffer },
) {
  const boundary = '----granica';
  const parts: Buffer[] = [];
  for (const [key, value] of Object.entries(fields)) {
    parts.push(Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="${key}"\r\n\r\n${value}\r\n`,
    ));
  }
  if (file !== undefined) {
    parts.push(Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${file.name}"\r\n`
      + `Content-Type: ${file.type}\r\n\r\n`,
    ));
    parts.push(file.bytes);
    parts.push(Buffer.from('\r\n'));
  }
  parts.push(Buffer.from(`--${boundary}--\r\n`));

  return {
    method: 'POST' as const,
    url: '/files',
    headers: { cookie, 'content-type': `multipart/form-data; boundary=${boundary}` },
    payload: Buffer.concat(parts),
  };
}

describe('файлы клиента', () => {
  it('без сессии уводит на форму входа', async () => {
    const { app } = build(await createTestDb());
    expect((await app.inject({ method: 'GET', url: '/files' })).statusCode).toBe(303);
  });

  it('загруженный PDF появляется в списке', async () => {
    const db = await createTestDb();
    const userId = await createUser(db, { email: 'a@a.a', passwordHash: 'x' });
    const { app } = build(db);
    const { cookie, csrf } = await login(db, userId);

    const res = await app.inject(
      upload(cookie, { csrf }, { name: 'прайс.pdf', type: 'application/pdf', bytes: PDF }),
    );

    expect(res.statusCode).toBe(303);
    expect((await listFiles(db, userId)).map((f) => f.originalName)).toEqual(['прайс.pdf']);
  });

  it('S15: без CSRF-токена файл не сохраняется', async () => {
    const db = await createTestDb();
    const userId = await createUser(db, { email: 'a@a.a', passwordHash: 'x' });
    const { app } = build(db);
    const { cookie } = await login(db, userId);

    const res = await app.inject(
      upload(cookie, {}, { name: 'прайс.pdf', type: 'application/pdf', bytes: PDF }),
    );

    expect(res.statusCode).toBe(403);
    expect(await listFiles(db, userId)).toHaveLength(0);
  });

  it('содержимое не того типа отвергается, а не сохраняется', async () => {
    const db = await createTestDb();
    const userId = await createUser(db, { email: 'a@a.a', passwordHash: 'x' });
    const { app } = build(db);
    const { cookie, csrf } = await login(db, userId);

    // Имя и заявленный тип говорят «PDF», байты — PNG
    const res = await app.inject(
      upload(cookie, { csrf }, { name: 'обман.pdf', type: 'application/pdf', bytes: PNG }),
    );

    expect(res.statusCode).toBe(400);
    expect(await listFiles(db, userId)).toHaveLength(0);
  });

  it('S9: отказ не пересказывает клиенту внутреннее сообщение', async () => {
    const db = await createTestDb();
    const userId = await createUser(db, { email: 'a@a.a', passwordHash: 'x' });
    const { app } = build(db);
    const { cookie, csrf } = await login(db, userId);

    const res = await app.inject(
      upload(cookie, { csrf }, { name: 'скрипт.exe', type: 'application/pdf', bytes: PDF }),
    );

    expect(res.body).not.toContain('белого списка');
    expect(res.body).toContain('PDF');
  });

  it('S11: клиент видит только свои файлы', async () => {
    const db = await createTestDb();
    const a = await createUser(db, { email: 'a@a.a', passwordHash: 'x' });
    const b = await createUser(db, { email: 'b@b.b', passwordHash: 'x' });
    const { app, dir } = build(db);
    await saveFile(db, a, { originalName: 'моё.pdf', mimeType: 'application/pdf', bytes: PDF }, dir);
    await saveFile(db, b, { originalName: 'чужое.pdf', mimeType: 'application/pdf', bytes: PDF }, dir);

    const res = await app.inject({
      method: 'GET', url: '/files', headers: { cookie: (await login(db, a)).cookie },
    });

    expect(res.body).toContain('моё.pdf');
    expect(res.body).not.toContain('чужое.pdf');
  });

  it('S21: имя файла со скриптом выводится текстом', async () => {
    const db = await createTestDb();
    const userId = await createUser(db, { email: 'a@a.a', passwordHash: 'x' });
    const { app, dir } = build(db);
    await saveFile(db, userId, {
      originalName: '<script>alert(1)</script>.pdf', mimeType: 'application/pdf', bytes: PDF,
    }, dir);

    const res = await app.inject({
      method: 'GET', url: '/files', headers: { cookie: (await login(db, userId)).cookie },
    });

    expect(res.body).not.toContain('<script>alert(1)</script>');
    expect(res.body).toContain('&lt;script&gt;');
  });

  it('кнопка удаления убирает файл из списка', async () => {
    const db = await createTestDb();
    const userId = await createUser(db, { email: 'a@a.a', passwordHash: 'x' });
    const { app, dir } = build(db);
    const fileId = await saveFile(db, userId, {
      originalName: 'прайс.pdf', mimeType: 'application/pdf', bytes: PDF,
    }, dir);
    const { cookie, csrf } = await login(db, userId);

    const res = await app.inject({
      method: 'POST',
      url: `/files/${fileId}/delete`,
      headers: { cookie, 'content-type': 'application/x-www-form-urlencoded' },
      payload: new URLSearchParams({ csrf }).toString(),
    });

    expect(res.statusCode).toBe(303);
    expect(await listFiles(db, userId)).toHaveLength(0);
  });

  it('S15: удаление без CSRF-токена отвечает 403 и файл цел', async () => {
    const db = await createTestDb();
    const userId = await createUser(db, { email: 'a@a.a', passwordHash: 'x' });
    const { app, dir } = build(db);
    const fileId = await saveFile(db, userId, {
      originalName: 'прайс.pdf', mimeType: 'application/pdf', bytes: PDF,
    }, dir);
    const { cookie } = await login(db, userId);

    const res = await app.inject({
      method: 'POST',
      url: `/files/${fileId}/delete`,
      headers: { cookie, 'content-type': 'application/x-www-form-urlencoded' },
      payload: new URLSearchParams({}).toString(),
    });

    expect(res.statusCode).toBe(403);
    expect(await listFiles(db, userId)).toHaveLength(1);
  });

  it('S11: клиент B не удаляет файл клиента A', async () => {
    const db = await createTestDb();
    const a = await createUser(db, { email: 'a@a.a', passwordHash: 'x' });
    const b = await createUser(db, { email: 'b@b.b', passwordHash: 'x' });
    const { app, dir } = build(db);
    const fileId = await saveFile(db, a, {
      originalName: 'моё.pdf', mimeType: 'application/pdf', bytes: PDF,
    }, dir);
    const { cookie, csrf } = await login(db, b);

    await app.inject({
      method: 'POST',
      url: `/files/${fileId}/delete`,
      headers: { cookie, 'content-type': 'application/x-www-form-urlencoded' },
      payload: new URLSearchParams({ csrf }).toString(),
    });

    expect(await listFiles(db, a)).toHaveLength(1);
  });

  it('файл, использованный в воронке, не удаляется и клиент видит почему', async () => {
    const db = await createTestDb();
    const userId = await createUser(db, { email: 'a@a.a', passwordHash: 'x' });
    const { app, dir } = build(db);
    const fileId = await saveFile(db, userId, {
      originalName: 'прайс.pdf', mimeType: 'application/pdf', bytes: PDF,
    }, dir);
    await createAutomation(db, userId, {
      name: 'Прайс', triggerType: 'contains', triggerValue: 'цена',
      steps: [{ say: 'Держите', fileId }],
    });
    const { cookie, csrf } = await login(db, userId);

    const res = await app.inject({
      method: 'POST',
      url: `/files/${fileId}/delete`,
      headers: { cookie, 'content-type': 'application/x-www-form-urlencoded' },
      payload: new URLSearchParams({ csrf }).toString(),
    });

    expect(res.statusCode).toBe(409);
    expect(res.body).toContain('используется');
    expect(await listFiles(db, userId)).toHaveLength(1);
  });
});
