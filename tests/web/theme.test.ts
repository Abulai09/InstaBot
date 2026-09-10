import Fastify from 'fastify';
import { describe, expect, it } from 'vitest';
import { loadConfig } from '../../src/config.js';
import { html } from '../../src/web/html.js';
import { registerFormParser } from '../../src/web/http.js';
import { readTheme, safeBackPath, themeCookie } from '../../src/web/theme.js';
import { registerThemeRoute } from '../../src/web/routes/theme.js';
import { APP_CSS } from '../../src/web/views/style.js';
import { layout } from '../../src/web/views/layout.js';

const cfg = loadConfig({
  DATABASE_URL: 'postgresql://u:p@localhost:5432/test',
  META_APP_SECRET: 's', META_VERIFY_TOKEN: 'v',
  CREDENTIALS_ENC_KEY: 'a'.repeat(64), SESSION_SECRET: 'a'.repeat(32),
  PUBLIC_BASE_URL: 'https://bot.example.com',
} as unknown as NodeJS.ProcessEnv);

function build() {
  const app = Fastify();
  registerFormParser(app);
  registerThemeRoute(app, cfg);
  return app;
}

const nav = (theme: 'system' | 'light' | 'dark') => ({
  current: 'automations' as const, isOwner: false, theme, path: '/',
});

describe('выбор темы', () => {
  it('без cookie тему выбирает система: атрибута на странице нет', () => {
    expect(readTheme(undefined)).toBe('system');
    expect(layout('Т', html``, nav('system')).value).not.toContain('data-theme');
  });

  it('выбранная тема попадает в атрибут корневого элемента', () => {
    expect(readTheme('theme=dark')).toBe('dark');
    expect(layout('Т', html``, nav('dark')).value).toContain('data-theme="dark"');
    expect(layout('Т', html``, nav('light')).value).toContain('data-theme="light"');
  });

  it('мусор в cookie не ломает страницу, а откатывается к системной теме', () => {
    expect(readTheme('theme=<script>')).toBe('system');
    expect(readTheme('theme=')).toBe('system');
    expect(readTheme('other=dark')).toBe('system');
  });

  /**
   * Три ветки, а не две: явный выбор обязан побеждать системную настройку
   * в обе стороны — светлая тема на тёмной ОС в том числе.
   */
  it('в стилях есть все три ветки темы', () => {
    expect(APP_CSS).toContain('@media (prefers-color-scheme: dark)');
    expect(APP_CSS).toContain(':root:not([data-theme="light"])');
    expect(APP_CSS).toContain(':root[data-theme="dark"]');
  });

  it('переключатель показывает текущую тему нажатой', () => {
    const page = layout('Т', html``, nav('dark')).value;

    expect(page).toContain('aria-pressed="true"');
    expect(page).toContain('name="theme" value="light"');
    expect(page).toContain('name="theme" value="system"');
  });

  it('ставит cookie и возвращает на ту же страницу', async () => {
    const res = await build().inject({
      method: 'POST', url: '/theme',
      payload: 'theme=dark&back=%2Fautomations%2Fabc',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
    });

    expect(res.statusCode).toBe(303);
    expect(res.headers['location']).toBe('/automations/abc');
    expect(String(res.headers['set-cookie'])).toContain('theme=dark');
    expect(String(res.headers['set-cookie'])).toContain('SameSite=Lax');
  });

  /**
   * Поле `back` приходит из формы, то есть подделывается. Без проверки
   * получился бы открытый редирект: ссылка на наш домен уводила бы на чужой,
   * и это готовая страница для фишинга под видом кабинета.
   */
  it('не уводит на чужой сайт через поле back', async () => {
    const app = build();
    const evil = [
      'https://evil.example', '//evil.example', '/\\evil.example',
      'javascript:alert(1)', 'http://evil.example/path',
    ];

    for (const back of evil) {
      const res = await app.inject({
        method: 'POST', url: '/theme',
        payload: `theme=light&back=${encodeURIComponent(back)}`,
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
      });

      expect(res.statusCode, back).toBe(303);
      expect(res.headers['location'], back).toBe('/');
    }
  });

  it('safeBackPath пропускает только собственные пути', () => {
    expect(safeBackPath('/leads')).toBe('/leads');
    expect(safeBackPath('/automations/a-1?x=2')).toBe('/automations/a-1?x=2');
    expect(safeBackPath(undefined)).toBe('/');
    expect(safeBackPath('//evil')).toBe('/');
    expect(safeBackPath('https://evil')).toBe('/');
  });

  it('неизвестное значение темы не записывается в cookie', async () => {
    const res = await build().inject({
      method: 'POST', url: '/theme',
      payload: 'theme=neon&back=%2F',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
    });

    expect(res.statusCode).toBe(400);
  });

  it('системная тема гасит cookie, а не пишет третье значение', () => {
    expect(themeCookie('system', false)).toContain('Max-Age=0');
    expect(themeCookie('dark', true)).toContain('Secure');
    expect(themeCookie('dark', false)).not.toContain('Secure');
  });
});
