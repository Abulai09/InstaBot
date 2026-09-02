import { html, type Html } from '../html.js';
import { layout } from './layout.js';

/**
 * Текст ошибки один на все случаи: разные сообщения для «нет такого email»
 * и «неверный пароль» позволяют перебором собрать список клиентов сервиса (S13).
 */
export function loginPage(error: string | undefined): Html {
  return layout('Вход', html`
<h1>Вход</h1>
${error === undefined ? '' : html`<p role="alert">${error}</p>`}
<form method="post" action="/login">
  <label>Почта <input type="email" name="email" required autocomplete="username"></label>
  <label>Пароль <input type="password" name="password" required autocomplete="current-password"></label>
  <button type="submit">Войти</button>
</form>`);
}
