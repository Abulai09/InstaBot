import { leadData, type LeadRow } from '../../storage/queries/leads.js';
import { html, type Html } from '../html.js';
import { layout } from './layout.js';

export function leadsPage(rows: LeadRow[]): Html {
  const parsed = rows.map((row) => ({ row, data: leadData(row) }));
  const keys = [...new Set(parsed.flatMap(({ data }) => [...data.keys()]))].sort();

  const head = html`<tr><th>Дата</th><th>Контакт</th>${keys.map((k) => html`<th>${k}</th>`)}</tr>`;
  const body = parsed.map(({ row, data }) => html`
<tr>
  <td>${row.createdAt.toISOString()}</td>
  <td>${row.externalUserId}</td>
  ${keys.map((key) => html`<td>${data.get(key) ?? ''}</td>`)}
</tr>`);

  return layout('Заявки', html`
<h1>Заявки</h1>
<p><a href="/">Мои воронки</a> · <a href="/leads.csv">Скачать CSV</a></p>
${rows.length === 0 ? html`<p>Заявок пока нет.</p>` : html`
<table><thead>${head}</thead><tbody>${body}</tbody></table>`}`);
}
