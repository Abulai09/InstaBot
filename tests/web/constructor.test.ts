import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Fastify, { type FastifyInstance } from 'fastify';
import { describe, expect, it } from 'vitest';
import { createTestDb } from '../storage/helpers.js';
import { createUser } from '../../src/storage/queries/users.js';
import {
  createAutomation, getAutomation, listAutomations,
} from '../../src/storage/queries/automations.js';
import { createSession } from '../../src/storage/queries/sessions.js';
import { saveFile } from '../../src/storage/files.js';
import { loadConfig } from '../../src/config.js';
import { ReplyThrottle } from '../../src/core/throttle.js';
import { csrfToken } from '../../src/web/csrf.js';
import { registerFormParser } from '../../src/web/http.js';
import { registerConstructorRoutes } from '../../src/web/routes/constructor.js';
import type { AppDb } from '../../src/storage/db.js';

const SECRET = 'a'.repeat(32);
const NOW = new Date('2026-09-02T12:00:00Z');
const DAY = 86_400_000;

function config() {
  return loadConfig({
    META_APP_SECRET: 's', META_VERIFY_TOKEN: 'v',
    CREDENTIALS_ENC_KEY: 'a'.repeat(64), SESSION_SECRET: SECRET,
  } as unknown as NodeJS.ProcessEnv);
}

function build(db: AppDb): FastifyInstance {
  const app = Fastify();
  registerFormParser(app);
  registerConstructorRoutes(app, { db, cfg: config(), throttle: new ReplyThrottle(5) });
  return app;
}

function login(db: AppDb, userId: string) {
  // Сессия выдаётся от текущего момента: маршрут проверяет срок по реальному
  // времени (`new Date()` внутри `currentSession`), и фиксированная дата
  // протухает через неделю после написания теста
  const token = createSession(db, userId, new Date(), 7 * DAY);
  return { cookie: `sid=${token}`, csrf: csrfToken(token, SECRET) };
}

/** Cookie кладётся в те же заголовки: спред затирает ключ headers целиком. */
function post(url: string, cookie: string, fields: Record<string, string>) {
  return {
    method: 'POST' as const,
    url,
    headers: { cookie, 'content-type': 'application/x-www-form-urlencoded' },
    payload: new URLSearchParams(fields).toString(),
  };
}

function seed() {
  const db = createTestDb();
  const a = createUser(db, { email: 'a@a.a', passwordHash: 'x' });
  const b = createUser(db, { email: 'b@b.b', passwordHash: 'x' });
  const automationA = createAutomation(db, a, {
    name: 'Прайс A', triggerType: 'contains', triggerValue: 'цена',
    steps: [{ say: 'Первый' }, { say: 'Второй' }, { say: 'Третий' }],
  });
  return { db, a, b, automationA };
}

describe('конструктор', () => {
  it('без сессии уводит на форму входа', async () => {
    const { db } = seed();
    const res = await build(db).inject({ method: 'GET', url: '/automations/new' });
    expect(res.statusCode).toBe(303);
  });

  it('создание заводит выключенную воронку без шагов и открывает её страницу', async () => {
    const db = createTestDb();
    const userId = createUser(db, { email: 'a@a.a', passwordHash: 'x' });
    const { cookie, csrf } = login(db, userId);

    const res = await build(db).inject(post('/automations', cookie, {
      name: 'Новая', trigger_type: 'contains', trigger_value: 'цена', csrf,
    }));

    const created = listAutomations(db, userId)[0];
    expect(res.statusCode).toBe(303);
    expect(res.headers.location).toBe(`/automations/${created?.id ?? ''}`);
    expect(created?.name).toBe('Новая');
    // Черновик не должен молча молчать в ответ на слово-триггер
    expect(created?.enabled).toBe(false);
    expect(getAutomation(db, userId, created?.id ?? '')?.steps).toHaveLength(0);
  });

  it('страница показывает шаги воронки', async () => {
    const { db, a, automationA } = seed();

    const res = await build(db).inject({
      method: 'GET', url: `/automations/${automationA}`, headers: { cookie: login(db, a).cookie },
    });

    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('Первый');
    expect(res.body).toContain('Третий');
    expect(res.headers['cache-control']).toBe('no-store');
  });

  it('S11: чужая воронка отвечает 404, как и несуществующая', async () => {
    const { db, b, automationA } = seed();
    const app = build(db);
    const { cookie } = login(db, b);

    const foreign = await app.inject({
      method: 'GET', url: `/automations/${automationA}`, headers: { cookie },
    });
    const missing = await app.inject({
      method: 'GET', url: '/automations/net-takoy', headers: { cookie },
    });

    expect(foreign.statusCode).toBe(404);
    expect(missing.statusCode).toBe(404);
    expect(foreign.body).toBe(missing.body);
  });

  it('сохранение записывает название, триггер и шаги', async () => {
    const { db, a, automationA } = seed();
    const { cookie, csrf } = login(db, a);

    const res = await build(db).inject(post(`/automations/${automationA}`, cookie, {
      name: 'Обновлённая', trigger_type: 'exact', trigger_value: 'прайс',
      say_0: 'Держите прайс', reply_0: '', file_0: '', buttons_0: '',
      say_1: 'Как вас зовут?', reply_1: 'name', file_1: '', buttons_1: '',
      action: 'save', csrf,
    }));

    expect(res.statusCode).toBe(303);
    const found = getAutomation(db, a, automationA);
    expect(found?.automation.name).toBe('Обновлённая');
    expect(found?.automation.triggerType).toBe('exact');
    expect(found?.steps.map((s) => s.say)).toEqual(['Держите прайс', 'Как вас зовут?']);
    expect(found?.steps[1]?.saveReplyAs).toBe('name');
  });

  it('«добавить шаг» не теряет уже набранный текст', async () => {
    const { db, a, automationA } = seed();
    const { cookie, csrf } = login(db, a);

    await build(db).inject(post(`/automations/${automationA}`, cookie, {
      name: 'Прайс A', trigger_type: 'contains', trigger_value: 'цена',
      say_0: 'Только что напечатал', action: 'add', csrf,
    }));

    const steps = getAutomation(db, a, automationA)?.steps ?? [];
    expect(steps.map((s) => s.say)).toEqual(['Только что напечатал', 'Новый шаг']);
  });

  it('«удалить шаг» убирает именно его', async () => {
    const { db, a, automationA } = seed();
    const { cookie, csrf } = login(db, a);

    await build(db).inject(post(`/automations/${automationA}`, cookie, {
      name: 'Прайс A', trigger_type: 'contains', trigger_value: 'цена',
      say_0: 'Первый', say_1: 'Второй', say_2: 'Третий', action: 'remove_1', csrf,
    }));

    expect(getAutomation(db, a, automationA)?.steps.map((s) => s.say))
      .toEqual(['Первый', 'Третий']);
  });

  it('«вверх» меняет шаг местами с предыдущим', async () => {
    const { db, a, automationA } = seed();
    const { cookie, csrf } = login(db, a);

    await build(db).inject(post(`/automations/${automationA}`, cookie, {
      name: 'Прайс A', trigger_type: 'contains', trigger_value: 'цена',
      say_0: 'Первый', say_1: 'Второй', say_2: 'Третий', action: 'up_2', csrf,
    }));

    expect(getAutomation(db, a, automationA)?.steps.map((s) => s.say))
      .toEqual(['Первый', 'Третий', 'Второй']);
  });

  it('«вверх» у первого шага ничего не ломает', async () => {
    const { db, a, automationA } = seed();
    const { cookie, csrf } = login(db, a);

    const res = await build(db).inject(post(`/automations/${automationA}`, cookie, {
      name: 'Прайс A', trigger_type: 'contains', trigger_value: 'цена',
      say_0: 'Первый', say_1: 'Второй', action: 'up_0', csrf,
    }));

    expect(res.statusCode).toBe(303);
    expect(getAutomation(db, a, automationA)?.steps.map((s) => s.say))
      .toEqual(['Первый', 'Второй']);
  });

  it('S11: клиент B не правит воронку клиента A', async () => {
    const { db, a, b, automationA } = seed();
    const { cookie, csrf } = login(db, b);

    const res = await build(db).inject(post(`/automations/${automationA}`, cookie, {
      name: 'Взломано', trigger_type: 'exact', trigger_value: 'моё',
      say_0: 'Моё', action: 'save', csrf,
    }));

    expect(res.statusCode).toBe(404);
    expect(getAutomation(db, a, automationA)?.automation.name).toBe('Прайс A');
  });

  it('S11: чужой файл в поле шага отвергается', async () => {
    const { db, a, b, automationA } = seed();
    const dir = mkdtempSync(join(tmpdir(), 'constructor-test-'));
    const foreignFile = saveFile(db, b, {
      originalName: 'чужое.pdf', mimeType: 'application/pdf',
      bytes: Buffer.concat([Buffer.from([0x25, 0x50, 0x44, 0x46]), Buffer.from('-1.4')]),
    }, dir);
    const { cookie, csrf } = login(db, a);

    const res = await build(db).inject(post(`/automations/${automationA}`, cookie, {
      name: 'Прайс A', trigger_type: 'contains', trigger_value: 'цена',
      say_0: 'Держите', file_0: foreignFile, action: 'save', csrf,
    }));

    expect(res.statusCode).toBe(400);
    // Ничего не сохранилось: подставленный id не должен попасть даже в текст шага
    expect(getAutomation(db, a, automationA)?.steps.map((s) => s.say))
      .toEqual(['Первый', 'Второй', 'Третий']);
  });

  it('S15: без CSRF-токена ничего не меняется', async () => {
    const { db, a, automationA } = seed();
    const { cookie } = login(db, a);

    const res = await build(db).inject(post(`/automations/${automationA}`, cookie, {
      name: 'Взломано', trigger_type: 'contains', trigger_value: 'цена',
      say_0: 'Первый', action: 'save',
    }));

    expect(res.statusCode).toBe(403);
    expect(getAutomation(db, a, automationA)?.automation.name).toBe('Прайс A');
  });

  it('пустой текст шага показывает ошибку и не сохраняет воронку', async () => {
    const { db, a, automationA } = seed();
    const { cookie, csrf } = login(db, a);

    const res = await build(db).inject(post(`/automations/${automationA}`, cookie, {
      name: 'Прайс A', trigger_type: 'contains', trigger_value: 'цена',
      say_0: '  ', action: 'save', csrf,
    }));

    expect(res.statusCode).toBe(400);
    expect(res.body).toContain('Текст шага');
    expect(getAutomation(db, a, automationA)?.steps).toHaveLength(3);
  });

  it('S21: название со скриптом выводится текстом', async () => {
    const db = createTestDb();
    const userId = createUser(db, { email: 'a@a.a', passwordHash: 'x' });
    const id = createAutomation(db, userId, {
      name: '<script>alert(1)</script>', triggerType: 'contains', triggerValue: 'ц',
      steps: [{ say: '<img src=x onerror=alert(1)>' }],
    });

    const res = await build(db).inject({
      method: 'GET', url: `/automations/${id}`, headers: { cookie: login(db, userId).cookie },
    });

    expect(res.body).not.toContain('<script>alert(1)</script>');
    expect(res.body).not.toContain('<img src=x');
    expect(res.body).toContain('&lt;script&gt;');
  });
});
