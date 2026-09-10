import Fastify from 'fastify';
import { describe, expect, it } from 'vitest';
import { registerStyleRoute } from '../../src/web/routes/style.js';
import { layout } from '../../src/web/views/layout.js';
import { html } from '../../src/web/html.js';

describe('стили', () => {
  it('отдаются отдельным файлом', async () => {
    const app = Fastify();
    registerStyleRoute(app);

    const res = await app.inject({ method: 'GET', url: '/app.css' });

    expect(res.statusCode).toBe(200);
    expect(String(res.headers['content-type'])).toContain('text/css');
    expect(res.body).toContain('body');
  });

  it('файл стилей кэшируется: он одинаков для всех и не содержит ПД', async () => {
    const app = Fastify();
    registerStyleRoute(app);

    const res = await app.inject({ method: 'GET', url: '/app.css' });

    expect(String(res.headers['cache-control'])).toContain('max-age=');
  });

  it('страницы подключают файл, а не инлайновый стиль: CSP запрещает второе', async () => {
    const page = layout('Проверка', html`<p>тело</p>`).value;

    expect(page).toContain('<link rel="stylesheet" href="/app.css">');
    expect(page).not.toContain('<style');
  });
});
