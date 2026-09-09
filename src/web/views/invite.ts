import { html, type Html } from '../html.js';
import { layout } from './layout.js';

/**
 * CSRF-токена на форме нет по той же причине, что и на `/login`: он выводится
 * из сессии, а у гостя её нет. Защищают `SameSite=Lax`, `form-action 'self'`
 * в CSP и сам секрет в ссылке.
 */
export function invitePage(token: string, error: string | undefined): Html {
  return layout('Пароль для входа', html`
<h1>Придумайте пароль</h1>
${error === undefined ? '' : html`<p role="alert">${error}</p>`}
<form method="post" action="/invite/${token}">
  <label>Пароль <input type="password" name="password" required minlength="12"
    autocomplete="new-password"></label>
  <button type="submit">Войти</button>
</form>`);
}

/**
 * Протухшая, погашенная и несуществующая ссылка дают одну страницу и один код:
 * по разнице ответов иначе перебором отделялись бы живые токены от мусора.
 */
export function inviteInvalidPage(): Html {
  return layout('Ссылка недействительна', html`
<h1>Ссылка недействительна</h1>
<p>Срок действия истёк или ссылкой уже воспользовались. Попросите новую.</p>`);
}
