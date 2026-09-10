import { html, type Html } from '../html.js';
import { triggerLabel } from './labels.js';
import type { AutomationRow } from '../../storage/queries/automations.js';
import type { DeliveryErrorRow } from '../../storage/queries/runtime.js';
import { layout } from './layout.js';

/**
 * Воронка без шагов показывается черновиком без переключателя: включённой она
 * всё равно молчит в ответ на слово-триггер (её пропускает `loadEnabledScenarios`),
 * и переключатель обещал бы работу, которой не будет.
 */
function stateBadge(steps: number, enabled: boolean): Html {
  if (steps === 0) return html`<span class="badge badge--draft">черновик</span>`;
  return enabled
    ? html`<span class="badge badge--on">включена</span>`
    : html`<span class="badge badge--off">выключена</span>`;
}

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
  <td data-label="Воронка"><a href="/automations/${row.id}">${row.name}</a></td>
  <td data-label="Триггер"><span class="muted">${triggerLabel(row.triggerType)}</span> «${row.triggerValue}»</td>
  <td data-label="Состояние">${stateBadge(steps, row.enabled)}</td>
  <td data-label="Действие">
    <div class="actions">
    ${steps === 0 ? html`<a class="btn btn--small" href="/automations/${row.id}">Добавить шаги</a>` : html`
    <form method="post" action="/automations/${row.id}/toggle">
      <input type="hidden" name="csrf" value="${csrf}">
      <input type="hidden" name="enabled" value="${row.enabled ? 'false' : 'true'}">
      <button class="btn btn--small" type="submit">${row.enabled ? 'Выключить' : 'Включить'}</button>
    </form>`}
    </div>
  </td>
</tr>`;
  });

  /**
   * Молчащий бот — худшая поломка этого продукта, и узнать о ней человек может
   * только отсюда. Поэтому ошибки стоят выше списка воронок, но оформлены
   * предупреждением, а не основным содержимым страницы.
   */
  const errorSection = errors.length === 0 ? '' : html`
<section class="alert alert--warn" role="alert">
  <h2>Не доставлено: ${errors.length}</h2>
  <table>
    <thead><tr><th>Площадка</th><th>Причина</th><th>Попыток</th></tr></thead>
    <tbody>${errors.map((err) => html`
    <tr>
      <td data-label="Площадка">${err.platform}</td>
      <td data-label="Причина">${err.failedReason}</td>
      <td data-label="Попыток">${err.attempts}</td>
    </tr>`)}</tbody>
  </table>
  <p class="muted">Ошибки доставки: сообщение не ушло человеку. Проверьте подключение аккаунта и текст шага.</p>
</section>`;

  const empty = html`
<div class="empty">
  <h2>Воронок пока нет</h2>
  <p>Воронка — это слово-триггер в комментарии и цепочка сообщений, которую бот
  отправит в директ в ответ. Начните с одной.</p>
  <a class="btn btn--primary" href="/automations/new">Создать первую воронку</a>
</div>`;

  return layout('Воронки', html`
<div class="page__head">
  <h1>Воронки</h1>
  ${rows.length === 0 ? '' : html`<a class="btn btn--primary" href="/automations/new">Новая воронка</a>`}
</div>
${errorSection}
${rows.length === 0 ? empty : html`
<div class="table-card">
  <table>
    <thead><tr><th>Название</th><th>Триггер</th><th>Состояние</th><th></th></tr></thead>
    <tbody>${items}</tbody>
  </table>
</div>`}`, { current: 'automations', isOwner });
}
