import { html, type Html } from '../html.js';

/**
 * Разделы кабинета. Меню строится из этого списка, а не собирается вручную
 * на каждой странице: раньше набор ссылок отличался от страницы к странице,
 * и человек не понимал, где он находится и куда можно уйти.
 *
 * `isOwner` только прячет пункт из меню. Доступ к `/admin` решает хук роли
 * на маршрутах (S12) — меню его не заменяет и заменять не может.
 */
export interface Nav {
  current: 'automations' | 'leads' | 'files' | 'admin';
  isOwner: boolean;
}

const SECTIONS: { key: Nav['current']; href: string; label: string; ownerOnly: boolean }[] = [
  { key: 'automations', href: '/', label: 'Воронки', ownerOnly: false },
  { key: 'leads', href: '/leads', label: 'Заявки', ownerOnly: false },
  { key: 'files', href: '/files', label: 'Файлы', ownerOnly: false },
  { key: 'admin', href: '/admin', label: 'Клиенты', ownerOnly: true },
];

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
    <form method="post" action="/logout">
      <button class="btn btn--quiet btn--small" type="submit">Выйти</button>
    </form>
  </div>
</header>`;
}

/**
 * Шапки нет у гостевых страниц (вход, приглашение): вести неаутентифицированного
 * человека внутрь кабинета некуда, а кнопка «Выйти» на странице входа —
 * обещание сессии, которой нет.
 */
export function layout(title: string, body: Html, nav?: Nav): Html {
  return html`<!doctype html>
<html lang="ru">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<link rel="stylesheet" href="/app.css">
<title>${title}</title>
</head>
<body>
${nav === undefined ? '' : topbar(nav)}
<main class="${nav === undefined ? 'page page--narrow' : 'page'}">
${body}
</main>
</body>
</html>`;
}
