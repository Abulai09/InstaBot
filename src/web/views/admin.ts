import { html, type Html } from '../html.js';
import type { ClientRow } from '../../storage/queries/users.js';
import { layout, type Nav } from './layout.js';

/**
 * Ссылка приглашения показывается один раз: в базе только хэш, восстановить
 * нечего — можно лишь перевыпустить. Поэтому это не «сообщение об успехе»,
 * а часть результата операции.
 */
export interface Notice {
  kind: 'error' | 'invite';
  text: string;
}

function noticeBlock(notice: Notice): Html {
  if (notice.kind === 'error') {
    return html`<p class="alert alert--error" role="alert">${notice.text}</p>`;
  }
  return html`
<div class="alert alert--info" role="alert">
  <p>Ссылка на вход. Она показывается один раз — скопируйте и передайте клиенту.</p>
  <p><code>${notice.text}</code></p>
</div>`;
}

/**
 * Форма подключения аккаунта убрана под `<details>`: три формы в одной ячейке
 * превращали таблицу в кашу, а подключают аккаунт один раз за жизнь клиента.
 * Раскрытие нативное, без скрипта — инлайновый JS запрещён CSP (S22).
 */
function connectForm(client: ClientRow, csrf: string): Html {
  return html`
<details class="disclosure">
  <summary>${client.connected ? 'Заменить аккаунт' : 'Подключить аккаунт'}</summary>
  <div>
    <form method="post" action="/admin/clients/${client.id}/accounts">
      <input type="hidden" name="csrf" value="${csrf}">
      <div class="form-row">
        <label class="field">
          <span>Площадка</span>
          <select name="platform">
            <option value="instagram">Instagram</option>
            <option value="tiktok">TikTok</option>
          </select>
        </label>
        <label class="field">
          <span>ID аккаунта</span>
          <input name="external_account_id" required>
        </label>
      </div>
      <label class="field">
        <span>Токен доступа</span>
        <input type="password" name="token" required autocomplete="off">
        <span class="muted">Хранится в зашифрованном виде и обратно не показывается.</span>
      </label>
      <button class="btn btn--primary btn--small" type="submit">Подключить</button>
    </form>
  </div>
</details>`;
}

function row(client: ClientRow, csrf: string): Html {
  const active = client.disabledAt === null;
  return html`
<tr>
  <td data-label="Почта">${client.email}</td>
  <td data-label="Состояние">${active
    ? html`<span class="badge badge--on">работает</span>`
    : html`<span class="badge badge--off">отключён</span>`}</td>
  <td data-label="Аккаунт">${client.connected
    ? html`<span class="badge badge--on">подключён</span>`
    : html`<span class="badge badge--draft">нет</span>`}</td>
  <td data-label="Воронок">${client.automationCount}</td>
  <td data-label="Действия">
    <div class="actions">
      <form method="post" action="/admin/clients/${client.id}/toggle">
        <input type="hidden" name="csrf" value="${csrf}">
        <button class="btn btn--small${active ? ' btn--danger' : ''}" type="submit">
          ${active ? 'Отключить' : 'Включить'}</button>
      </form>
      <form method="post" action="/admin/clients/${client.id}/invite">
        <input type="hidden" name="csrf" value="${csrf}">
        <button class="btn btn--small" type="submit">Новая ссылка</button>
      </form>
    </div>
    ${connectForm(client, csrf)}
  </td>
</tr>`;
}

export function adminPage(
  clients: ClientRow[], csrf: string, notice: Notice | undefined, nav: Nav,
): Html {
  const empty = html`
<div class="empty">
  <h2>Клиентов пока нет</h2>
  <p>Заведите первого по почте — сервис выдаст одноразовую ссылку,
  по которой он задаст себе пароль.</p>
</div>`;

  return layout('Клиенты', html`
<div class="page__head">
  <h1>Клиенты</h1>
</div>
${notice === undefined ? '' : noticeBlock(notice)}
<form class="card" method="post" action="/admin/clients">
  <input type="hidden" name="csrf" value="${csrf}">
  <label class="field">
    <span>Почта нового клиента</span>
    <input type="email" name="email" required>
  </label>
  <button class="btn btn--primary" type="submit">Завести клиента</button>
</form>
${clients.length === 0 ? empty : html`
<div class="table-card">
  <table>
    <thead><tr><th>Почта</th><th>Состояние</th><th>Аккаунт</th><th>Воронок</th><th></th></tr></thead>
    <tbody>${clients.map((c) => row(c, csrf))}</tbody>
  </table>
</div>`}`, nav);
}
