import { html, raw, type Html } from '../html.js';
import type { Theme } from '../theme.js';
import { APP_CSS_VERSION } from './style.js';

/**
 * Разделы кабинета. Меню строится из этого списка, а не собирается вручную
 * на каждой странице: раньше набор ссылок отличался от страницы к странице,
 * и человек не понимал, где он находится и куда можно уйти.
 *
 * `isOwner` только прячет пункт из меню. Доступ к `/admin` решает хук роли
 * на маршрутах (S12) — меню его не заменяет и заменять не может.
 *
 * `path` — куда вернуться после смены темы. Значение уходит в скрытое поле
 * формы, то есть обратно приходит от клиента, и на входе его перепроверяет
 * `safeBackPath`: доверять ему здесь нельзя даже при том, что написали его мы.
 */
export interface Nav {
  current: 'automations' | 'leads' | 'files' | 'admin';
  isOwner: boolean;
  theme: Theme;
  path: string;
}

const SECTIONS: { key: Nav['current']; href: string; label: string; ownerOnly: boolean }[] = [
  { key: 'automations', href: '/', label: 'Воронки', ownerOnly: false },
  { key: 'leads', href: '/leads', label: 'Заявки', ownerOnly: false },
  { key: 'files', href: '/files', label: 'Файлы', ownerOnly: false },
  { key: 'admin', href: '/admin', label: 'Клиенты', ownerOnly: true },
];

/** Адрес раздела по его ключу — нужен там, где возвращаться на текущий URL нельзя. */
export const SECTION_HREF: Record<Nav['current'], string> = {
  automations: '/',
  leads: '/leads',
  files: '/files',
  admin: '/admin',
};

const THEMES: { value: Theme; label: string; title: string }[] = [
  { value: 'system', label: 'Авто', title: 'Как в системе' },
  { value: 'light', label: 'Светлая', title: 'Всегда светлая' },
  { value: 'dark', label: 'Тёмная', title: 'Всегда тёмная' },
];

/**
 * Переключатель темы — форма, а не скрипт: CSP запрещает инлайновый JS,
 * а заводить первый в проекте файл скриптов ради настройки внешнего вида
 * дороже, чем один переход страницы.
 *
 * Три состояния, а не два: «Авто» — это отсутствие выбора, и вернуться к нему
 * человек должен уметь. `aria-pressed` объявляет текущее состояние
 * скринридеру, для которого заливка кнопки ничего не значит.
 */
function themeSwitch(nav: Nav): Html {
  const buttons = THEMES.map((option) => {
    const pressed = option.value === nav.theme;
    return html`
<button class="theme__btn" type="submit" name="theme" value="${option.value}"
  title="${option.title}" aria-pressed="${pressed ? 'true' : 'false'}">${option.label}</button>`;
  });

  return html`
<form class="theme" method="post" action="/theme">
  <input type="hidden" name="back" value="${nav.path}">
  <div class="theme__group" role="group" aria-label="Тема оформления">${buttons}</div>
</form>`;
}

/**
 * `aria-current="page"` вместо одного лишь цвета: скринридер обязан назвать
 * текущий раздел, а цвет он не произносит.
 */
function topbar(nav: Nav): Html {
  const links = SECTIONS
    .filter((section) => !section.ownerOnly || nav.isOwner)
    .map((section) => (section.key === nav.current
      ? html`<a href="${section.href}" aria-current="page">${section.label}</a>`
      : html`<a href="${section.href}">${section.label}</a>`));

  return html`
<header class="topbar">
  <div class="topbar__inner">
    <a class="brand" href="/">Кабинет</a>
    <nav class="nav" aria-label="Разделы кабинета">${links}</nav>
    ${themeSwitch(nav)}
    <form method="post" action="/logout">
      <button class="btn btn--quiet btn--small" type="submit">Выйти</button>
    </form>
  </div>
</header>`;
}

/** Общий каркас документа: `<head>`, файл стилей и атрибут темы на `<html>`. */
function documentShell(title: string, theme: Html | string, body: Html): Html {
  return html`<!doctype html>
<html lang="ru"${theme}>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<link rel="stylesheet" href="/app.css?v=${APP_CSS_VERSION}">
<title>${title}</title>
</head>
<body>
<div class="brandbar"></div>
${body}
</body>
</html>`;
}

/**
 * Шапки нет у гостевых страниц (вход, приглашение): вести неаутентифицированного
 * человека внутрь кабинета некуда, а кнопка «Выйти» на странице входа —
 * обещание сессии, которой нет. Тему гостю выбирает система: ради одной
 * настройки загромождать страницу входа незачем.
 */
export function layout(title: string, body: Html, nav?: Nav): Html {
  const theme = nav === undefined || nav.theme === 'system'
    ? ''
    : html` data-theme="${nav.theme}"`;

  return documentShell(title, theme, html`
${nav === undefined ? '' : topbar(nav)}
<main class="${nav === undefined ? 'page page--narrow' : 'page'}">
${body}
</main>`);
}

/**
 * Лендинг не влезает в `layout`: у него своя шапка вместо меню кабинета
 * и своя ширина — секции идут во весь экран, а `.page` ограничен `--page`.
 * Общее у них только сам документ: один `<head>`, один файл стилей.
 *
 * Тема витрине задана жёстко светлой, а не отдана системе: цвета здесь —
 * часть оформления, а не настройка рабочего места. Переключатель темы
 * остаётся в кабинете, где с ним работают часами.
 */
export function landingLayout(title: string, body: Html): Html {
  return documentShell(title, raw(' data-theme="light"'), body);
}
