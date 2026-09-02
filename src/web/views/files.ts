import type { FileRow } from '../../storage/files.js';
import { html, type Html } from '../html.js';
import { layout } from './layout.js';

/**
 * Список разрешённого показан прямо в форме: клиент должен видеть правила
 * до отказа, а не после. Сами правила живут в `storage/files.ts` — здесь
 * только их человеческая формулировка.
 */
export function filesPage(rows: FileRow[], csrf: string, error: string | undefined): Html {
  const items = rows.map((row) => html`
<tr>
  <td>${row.originalName}</td>
  <td>${Math.ceil(row.sizeBytes / 1024)} КБ</td>
  <td>
    <form method="post" action="/files/${row.id}/delete">
      <input type="hidden" name="csrf" value="${csrf}">
      <button type="submit">Удалить</button>
    </form>
  </td>
</tr>`);

  return layout('Файлы', html`
<h1>Файлы</h1>
<p><a href="/">Мои воронки</a></p>
${error === undefined ? '' : html`<p role="alert">${error}</p>`}

<form method="post" action="/files" enctype="multipart/form-data">
  <input type="hidden" name="csrf" value="${csrf}">
  <label>Файл <input type="file" name="file" accept=".pdf,.png,.jpg,.jpeg" required></label>
  <button type="submit">Загрузить</button>
</form>
<p>Разрешены PDF до 25 МБ, PNG и JPEG до 8 МБ.</p>

${rows.length === 0 ? html`<p>Файлов пока нет.</p>` : html`
<table>
  <thead><tr><th>Имя</th><th>Размер</th><th></th></tr></thead>
  <tbody>${items}</tbody>
</table>`}`);
}
