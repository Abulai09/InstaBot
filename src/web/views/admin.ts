import { html, type Html } from '../html.js';
import type { ClientRow } from '../../storage/queries/users.js';
import { layout } from './layout.js';

/**
 * Ссылка приглашения показывается один раз: в базе только хэш, восстановить
 * нечего — можно лишь перевыпустить. Поэтому это не «сообщение об успехе»,
 * а часть результата операции.
 */
export interface Notice {
  kind: 'error' | 'invite';
  text: string;
}

function row(client: ClientRow, csrf: string): Html {
  const state = client.disabledAt === null ? 'работает' : 'отключён';
  return html`
<tr>
  <td>${client.email}</td>
  <td>${state}</td>
  <td>${client.connected ? 'подключён' : 'нет'}</td>
  <td>${client.automationCount}</td>
  <td>
    <form method="post" action="/admin/clients/${client.id}/toggle">
      <input type="hidden" name="csrf" value="${csrf}">
      <button type="submit">${client.disabledAt === null ? 'Отключить' : 'Включить'}</button>
    </form>
    <form method="post" action="/admin/clients/${client.id}/invite">
      <input type="hidden" name="csrf" value="${csrf}">
      <button type="submit">Новая ссылка</button>
    </form>
    <form method="post" action="/admin/clients/${client.id}/accounts">
      <input type="hidden" name="csrf" value="${csrf}">
      <label>Платформа
        <select name="platform">
          <option value="instagram">Instagram</option>
          <option value="tiktok">TikTok</option>
        </select>
      </label>
      <label>ID аккаунта <input name="external_account_id" required></label>
      <label>Токен <input type="password" name="token" required autocomplete="off"></label>
      <button type="submit">Подключить</button>
    </form>
  </td>
</tr>`;
}

export function adminPage(
  clients: ClientRow[], csrf: string, notice: Notice | undefined,
): Html {
  return layout('Клиенты', html`
<h1>Клиенты</h1>
<p><a href="/">Мой кабинет</a></p>
${notice === undefined ? '' : html`<p role="alert">${notice.text}</p>`}
<form method="post" action="/admin/clients">
  <input type="hidden" name="csrf" value="${csrf}">
  <label>Почта нового клиента <input type="email" name="email" required></label>
  <button type="submit">Завести</button>
</form>
${clients.length === 0 ? html`<p>Клиентов пока нет.</p>` : html`
<table>
  <thead><tr><th>Почта</th><th>Состояние</th><th>Аккаунт</th><th>Воронок</th><th></th></tr></thead>
  <tbody>${clients.map((c) => row(c, csrf))}</tbody>
</table>`}`);
}
