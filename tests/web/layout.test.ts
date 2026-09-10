import { describe, expect, it } from 'vitest';
import { html } from '../../src/web/html.js';
import { layout } from '../../src/web/views/layout.js';
import { loginPage } from '../../src/web/views/login.js';
import { invitePage } from '../../src/web/views/invite.js';

describe('оболочка страницы', () => {
  it('в кабинете есть постоянная навигация, текущий раздел помечен', () => {
    const page = layout('Заявки', html`<p>тело</p>`, { current: 'leads', isOwner: false, theme: 'system', path: '/leads' }).value;

    expect(page).toContain('<nav');
    expect(page).toContain('aria-current="page"');
    expect(page).toContain('href="/leads"');
    expect(page).toContain('href="/files"');
  });

  /**
   * Меню — не замена проверке роли на маршруте (S12), а её видимая половина:
   * клиенту незачем показывать ссылку, которая ответит ему 403.
   */
  it('раздел владельца в меню клиента отсутствует', () => {
    const nav = { current: 'leads', isOwner: false, theme: 'system', path: '/leads' } as const;
    const asClient = layout('Заявки', html``, nav).value;
    const asOwner = layout('Заявки', html``, { ...nav, isOwner: true }).value;

    expect(asClient).not.toContain('href="/admin"');
    expect(asOwner).toContain('href="/admin"');
  });

  it('у гостевых страниц нет ни навигации, ни выхода: вести гостя внутрь некуда', () => {
    const login = loginPage(undefined).value;
    const invite = invitePage('токен', undefined).value;

    for (const page of [login, invite]) {
      expect(page).not.toContain('<nav');
      expect(page).not.toContain('/logout');
    }
  });

  it('содержимое лежит в <main>: шапку нужно уметь пропустить с клавиатуры', () => {
    const page = layout('Заявки', html`<p>тело</p>`, { current: 'leads', isOwner: false, theme: 'system', path: '/leads' }).value;

    expect(page).toContain('<main');
  });

  it('заголовок вкладки называет раздел, а не только продукт', () => {
    const page = layout('Заявки', html``, { current: 'leads', isOwner: false, theme: 'system', path: '/leads' }).value;

    expect(page).toContain('<title>Заявки');
  });
});
