import type { FileRow } from '../../storage/files.js';
import { html, type Html } from '../html.js';
import { layout, type Nav } from './layout.js';

/**
 * Список разрешённого показан прямо в форме: клиент должен видеть правила
 * до отказа, а не после. Сами правила живут в `storage/files.ts` — здесь
 * только их человеческая формулировка.
 */
export function filesPage(
  rows: FileRow[], csrf: string, error: string | undefined, nav: Nav,
): Html {
  const items = rows.map((row) => html`
<tr>
  <td data-label="Имя">${row.originalName}</td>
  <td data-label="Размер"><span class="muted">${Math.ceil(row.sizeBytes / 1024)} КБ</span></td>
  <td data-label="Действие">
    <div class="actions">
      <form method="post" action="/files/${row.id}/delete">
        <input type="hidden" name="csrf" value="${csrf}">
        <button class="btn btn--small btn--danger" type="submit">Удалить</button>
      </form>
    </div>
  </td>
</tr>`);

  const empty = html`
<div class="empty">
  <h2>Файлов пока нет</h2>
  <p>Сюда загружают то, что бот отправит человеку в директ: прайс, чек-лист, гайд.
  Файл выбирается в шаге воронки.</p>
</div>`;

  return layout('Файлы', html`
<div class="page__head">
  <h1>Файлы</h1>
</div>
${error === undefined ? '' : html`<p class="alert alert--error" role="alert">${error}</p>`}

<form class="card" method="post" action="/files" enctype="multipart/form-data">
  <input type="hidden" name="csrf" value="${csrf}">
  <label class="field">
    <span>Новый файл</span>
    <input type="file" name="file" accept=".pdf,.png,.jpg,.jpeg" required>
    <span class="muted">PDF до 25 МБ, PNG и JPEG до 8 МБ.</span>
  </label>
  <button class="btn btn--primary" type="submit">Загрузить</button>
</form>

${rows.length === 0 ? empty : html`
<div class="table-card">
  <table>
    <thead><tr><th>Имя</th><th>Размер</th><th></th></tr></thead>
    <tbody>${items}</tbody>
  </table>
</div>`}`, nav);
}
