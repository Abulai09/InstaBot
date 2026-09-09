import { html, type Html } from '../html.js';
import type { AutomationRow } from '../../storage/queries/automations.js';
import type { DeliveryErrorRow } from '../../storage/queries/runtime.js';
import { layout } from './layout.js';

/**
 * Воронка без шагов показывается черновиком без переключателя: включённой она
 * всё равно молчит в ответ на слово-триггер (её пропускает `loadEnabledScenarios`),
 * и переключатель обещал бы работу, которой не будет.
 */
export function dashboardPage(
  rows: AutomationRow[],
  counts: Map<string, number>,
  errors: DeliveryErrorRow[],
  csrf: string,
  isOwner: boolean,
): Html {
  const items = rows.map((row) => {
    const steps = counts.get(row.id) ?? 0;
    return html`
<tr>
  <td><a href="/automations/${row.id}">${row.name}</a></td>
  <td>${row.triggerType} «${row.triggerValue}»</td>
  <td>${steps === 0 ? 'черновик' : row.enabled ? 'включена' : 'выключена'}</td>
  <td>
    ${steps === 0 ? html`<a href="/automations/${row.id}">Добавить шаги</a>` : html`
    <form method="post" action="/automations/${row.id}/toggle">
      <input type="hidden" name="csrf" value="${csrf}">
      <input type="hidden" name="enabled" value="${row.enabled ? 'false' : 'true'}">
      <button type="submit">${row.enabled ? 'Выключить' : 'Включить'}</button>
    </form>`}
  </td>
</tr>`;
  });

  const errorItems = errors.map((err) => html`
<tr>
  <td>${err.platform}</td>
  <td>${err.failedReason}</td>
  <td>${err.attempts}</td>
</tr>`);

  const errorSection = errors.length === 0 ? '' : html`
<h2>Ошибки доставки</h2>
<table>
  <thead><tr><th>Платформа</th><th>Причина</th><th>Попыток</th></tr></thead>
  <tbody>${errorItems}</tbody>
</table>`;

  return layout('Мои воронки', html`
<h1>Мои воронки</h1>
<p><a href="/leads">Заявки</a> · <a href="/files">Файлы</a> · <a href="/automations/new">Новая воронка</a>${isOwner ? html` · <a href="/admin">Клиенты</a>` : ''}</p>
${errorSection}
${rows.length === 0 ? html`<p>Воронок пока нет.</p>` : html`
<table>
  <thead><tr><th>Название</th><th>Триггер</th><th>Состояние</th><th></th></tr></thead>
  <tbody>${items}</tbody>
</table>`}
<form method="post" action="/logout"><button type="submit">Выйти</button></form>`);
}
