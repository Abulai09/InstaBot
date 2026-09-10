import { leadData, type LeadRow } from '../../storage/queries/leads.js';
import { html, type Html } from '../html.js';
import { layout } from './layout.js';

/**
 * Часовой пояс клиента серверу неизвестен, а угадывать его нечем: скриптов на
 * странице нет (CSP). Поэтому время показывается в UTC и подписано как UTC —
 * молча показать чужой пояс хуже, чем показать непривычный, но честный.
 * `datetime` оставляет машиночитаемую форму для копирования и парсинга.
 */
function stamp(at: Date): Html {
  const iso = at.toISOString();
  const date = iso.slice(0, 10).split('-').reverse().join('.');
  return html`<time datetime="${iso}">${date}, ${iso.slice(11, 16)} UTC</time>`;
}

export function leadsPage(rows: LeadRow[], isOwner: boolean): Html {
  const parsed = rows.map((row) => ({ row, data: leadData(row) }));
  const keys = [...new Set(parsed.flatMap(({ data }) => [...data.keys()]))].sort();

  const head = html`<tr><th>Когда</th><th>Контакт</th>${keys.map((k) => html`<th>${k}</th>`)}</tr>`;
  const body = parsed.map(({ row, data }) => html`
<tr>
  <td data-label="Когда"><span class="muted">${stamp(row.createdAt)}</span></td>
  <td data-label="Контакт">${row.externalUserId}</td>
  ${keys.map((key) => html`<td data-label="${key}">${data.get(key) ?? ''}</td>`)}
</tr>`);

  const empty = html`
<div class="empty">
  <h2>Заявок пока нет</h2>
  <p>Заявка появляется, когда человек проходит воронку до конца и отвечает на
  вопрос — например, оставляет телефон. Колонки собираются из ваших же вопросов.</p>
</div>`;

  return layout('Заявки', html`
<div class="page__head">
  <h1>Заявки</h1>
  ${rows.length === 0 ? '' : html`<a class="btn" href="/leads.csv">Скачать CSV</a>`}
</div>
${rows.length === 0 ? empty : html`
<div class="table-card">
  <table><thead>${head}</thead><tbody>${body}</tbody></table>
</div>`}`, { current: 'leads', isOwner });
}
