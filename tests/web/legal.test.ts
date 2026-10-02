import Fastify, { type FastifyInstance } from 'fastify';
import { describe, expect, it } from 'vitest';
import { registerLegalRoutes } from '../../src/web/routes/legal.js';
import { landingPage } from '../../src/web/views/landing.js';

function build(): FastifyInstance {
  const app = Fastify();
  registerLegalRoutes(app);
  return app;
}

describe('юридические страницы для публикации приложения Meta', () => {
  it.each(['/privacy', '/data-deletion'])('%s открывается гостю без сессии', async (url) => {
    const res = await build().inject({ method: 'GET', url });

    expect(res.statusCode).toBe(200);
    expect(String(res.headers['content-type'])).toContain('text/html');
    expect(res.body).toContain('<h1');
  });

  it('политика называет контакт и срок хранения обработанных событий', async () => {
    const res = await build().inject({ method: 'GET', url: '/privacy' });

    expect(res.body).toContain('rakhatulyabylai@gmail.com');
    expect(res.body).toContain('7 дней');
    expect(res.body).toContain('/data-deletion');
  });

  it('страница удаления объясняет, куда писать и в какой срок удалят', async () => {
    const res = await build().inject({ method: 'GET', url: '/data-deletion' });

    expect(res.body).toContain('mailto:rakhatulyabylai@gmail.com');
    expect(res.body).toContain('30 дней');
  });

  it('витрина ведёт на обе страницы: проверяющий Meta ищет их с главной', () => {
    const page = landingPage().value;

    expect(page).toContain('href="/privacy"');
    expect(page).toContain('href="/data-deletion"');
  });
});
