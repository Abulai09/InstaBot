import { html, type Html } from '../html.js';
import type { AutomationRow } from '../../storage/queries/automations.js';
import { layout } from './layout.js';

export function dashboardPage(rows: AutomationRow[], csrf: string): Html {
  const items = rows.map((row) => html`
<tr>
  <td>${row.name}</td>
  <td>${row.triggerType} «${row.triggerValue}»</td>
  <td>${row.enabled ? 'включена' : 'выключена'}</td>
  <td>
    <form method="post" action="/automations/${row.id}/toggle">
      <input type="hidden" name="csrf" value="${csrf}">
      <input type="hidden" name="enabled" value="${row.enabled ? 'false' : 'true'}">
      <button type="submit">${row.enabled ? 'Выключить' : 'Включить'}</button>
    </form>
  </td>
</tr>`);

  return layout('Мои воронки', html`
<h1>Мои воронки</h1>
<p><a href="/leads">Заявки</a></p>
${rows.length === 0 ? html`<p>Воронок пока нет.</p>` : html`
<table>
  <thead><tr><th>Название</th><th>Триггер</th><th>Состояние</th><th></th></tr></thead>
  <tbody>${items}</tbody>
</table>`}
<form method="post" action="/logout"><button type="submit">Выйти</button></form>`);
}
