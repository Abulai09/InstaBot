import { createHash } from 'node:crypto';
import Fastify from 'fastify';
import { describe, expect, it } from 'vitest';
import { registerStyleRoute } from '../../src/web/routes/style.js';
import { layout } from '../../src/web/views/layout.js';
import { landingPage } from '../../src/web/views/landing.js';
import { loginPage } from '../../src/web/views/login.js';
import { APP_CSS, APP_CSS_VERSION } from '../../src/web/views/style.js';
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

  it('цвета заданы токенами и переопределяются для тёмной темы', () => {
    expect(APP_CSS).toContain('--accent');
    expect(APP_CSS).toContain('prefers-color-scheme: dark');
  });

  it('фокус виден: клавиатурный путь по кабинету не должен теряться', () => {
    expect(APP_CSS).toContain(':focus-visible');
  });

  it('узкий экран получает свою вёрстку, а не уменьшенную широкую', () => {
    expect(APP_CSS).toContain('@media (max-width:');
  });

  it('страницы подключают файл, а не инлайновый стиль: CSP запрещает второе', async () => {
    const page = layout('Проверка', html`<p>тело</p>`).value;

    expect(page).toContain(`<link rel="stylesheet" href="/app.css?v=${APP_CSS_VERSION}">`);
    expect(page).not.toContain('<style');
  });

  /**
   * Витрина и кабинет — один сервис, и выглядеть должны одинаково. Главная
   * кнопка у них общая по классу, а не похожая по цвету: отдельный класс
   * для лендинга разошёлся бы с кабинетом на первой же правке.
   */
  it('главная кнопка одна на весь сервис', () => {
    const cabinet = layout('Проверка', html`<a class="btn btn--primary" href="/">Кнопка</a>`).value;

    expect(landingPage().value).toContain('btn btn--primary');
    expect(cabinet).toContain('btn btn--primary');
    // Отдельной «фирменной» кнопки больше нет — она и есть главная
    expect(APP_CSS).not.toContain('.btn--brand');
    expect(APP_CSS).toContain('--brand-cta-gradient');
  });

  it('брендовая полоса есть и в кабинете, и на витрине, и на входе', () => {
    const nav = { current: 'leads', isOwner: false, theme: 'system', path: '/leads' } as const;

    for (const page of [layout('Заявки', html``, nav).value, loginPage(undefined).value, landingPage().value]) {
      expect(page).toContain('class="brandbar"');
    }
  });

  it('акцент кабинета взят из брендовой палитры, а не из прежнего синего', () => {
    expect(APP_CSS).toContain('--accent: #6246d6');
    expect(APP_CSS).toContain('--link: #c3b5ff');
  });

  /**
   * Адрес файла меняется вместе с его содержимым. Без этого браузер,
   * забравший стили на час, после выката показывает новую разметку
   * со старыми правилами — то есть страницу без вёрстки вообще.
   */
  it('версия в адресе считается от содержимого файла', () => {
    const expected = createHash('sha256').update(APP_CSS).digest('hex').slice(0, 8);

    expect(APP_CSS_VERSION).toBe(expected);
    expect(APP_CSS_VERSION).toMatch(/^[0-9a-f]{8}$/);
  });

  it('адрес с версией кэшируется надолго, без версии — коротко', async () => {
    const app = Fastify();
    registerStyleRoute(app);

    const versioned = await app.inject({ method: 'GET', url: `/app.css?v=${APP_CSS_VERSION}` });
    const plain = await app.inject({ method: 'GET', url: '/app.css' });

    expect(versioned.statusCode).toBe(200);
    expect(String(versioned.headers['cache-control'])).toContain('immutable');
    // Такой адрес сам не обновится при следующем выкате, поэтому держим его недолго
    expect(String(plain.headers['cache-control'])).not.toContain('immutable');
  });
});
