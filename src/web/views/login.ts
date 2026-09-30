import { html, type Html } from '../html.js';
import { layout } from './layout.js';

/**
 * Текст ошибки один на все случаи: разные сообщения для «нет такого email»
 * и «неверный пароль» позволяют перебором собрать список клиентов сервиса (S13).
 */
export function loginPage(error: string | undefined, csrf: string): Html {
  return layout('Вход', html`
<h1>Вход в кабинет</h1>
<p class="muted">Почта и пароль, которые вы задали по ссылке-приглашению.</p>
${error === undefined ? '' : html`<p class="alert alert--error" role="alert">${error}</p>`}
<form class="card" method="post" action="/login">
  <input type="hidden" name="csrf" value="${csrf}">
  <label class="field">
    <span>Почта</span>
    <input type="email" name="email" required autocomplete="username" autofocus>
  </label>
  <label class="field">
    <span>Пароль</span>
    <input type="password" name="password" required autocomplete="current-password">
  </label>
  <button class="btn btn--primary" type="submit">Войти</button>
</form>`);
}
