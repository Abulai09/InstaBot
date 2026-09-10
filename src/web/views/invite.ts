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
<p class="muted">Это первый вход. Пароль нужен, чтобы возвращаться в кабинет
по обычному адресу — ссылка-приглашение больше не сработает.</p>
${error === undefined ? '' : html`<p class="alert alert--error" role="alert">${error}</p>`}
<form class="card" method="post" action="/invite/${token}">
  <label class="field">
    <span>Пароль</span>
    <input type="password" name="password" required minlength="12" autocomplete="new-password" autofocus>
    <span class="muted">Не короче 12 символов.</span>
  </label>
  <button class="btn btn--primary" type="submit">Сохранить и войти</button>
</form>`);
}

/**
 * Протухшая, погашенная и несуществующая ссылка дают одну страницу и один код:
 * по разнице ответов иначе перебором отделялись бы живые токены от мусора.
 */
export function inviteInvalidPage(): Html {
  return layout('Ссылка недействительна', html`
<h1>Ссылка недействительна</h1>
<p>Срок действия истёк или ссылкой уже воспользовались.</p>
<p class="muted">Попросите новую ссылку у того, кто завёл вам кабинет.
Если пароль вы уже задавали — просто войдите.</p>
<a class="btn btn--primary" href="/login">Перейти ко входу</a>`);
}
