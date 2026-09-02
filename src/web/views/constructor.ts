import { z } from 'zod';
import type { AutomationRow, StepRow } from '../../storage/queries/automations.js';
import type { FileRow } from '../../storage/files.js';
import { MAX_BUTTONS } from '../forms.js';
import { html, type Html } from '../html.js';
import { layout } from './layout.js';

const Buttons = z.array(z.object({ label: z.string(), payload: z.string() }));

/**
 * Строку писали мы сами, но представление не должно падать на испорченной:
 * страница правки — единственный способ такую воронку починить.
 */
function buttonLabels(json: string | null): string {
  if (json === null) return '';
  try {
    const parsed = Buttons.safeParse(JSON.parse(json));
    return parsed.success ? parsed.data.map((b) => b.label).join('\n') : '';
  } catch {
    return '';
  }
}

function triggerOptions(selected: string): Html {
  const kinds: [string, string][] = [
    ['contains', 'содержит слово'],
    ['exact', 'точное совпадение'],
    ['starts_with', 'начинается со слова'],
  ];
  return html`${kinds.map(([value, label]) => html`
<option value="${value}"${value === selected ? html` selected` : ''}>${label}</option>`)}`;
}

export function newAutomationPage(csrf: string, error: string | undefined): Html {
  return layout('Новая воронка', html`
<h1>Новая воронка</h1>
<p><a href="/">Мои воронки</a></p>
${error === undefined ? '' : html`<p role="alert">${error}</p>`}
<form method="post" action="/automations">
  <input type="hidden" name="csrf" value="${csrf}">
  <label>Название <input name="name" required maxlength="100"></label>
  <label>Триггер <select name="trigger_type">${triggerOptions('contains')}</select></label>
  <label>Слово <input name="trigger_value" required maxlength="100"></label>
  <button type="submit">Создать</button>
</form>
<p>Шаги добавляются после создания. Пока шагов нет, воронка выключена.</p>`);
}

export function notFoundPage(): Html {
  return layout('Не найдено', html`<h1>Не найдено</h1><p><a href="/">Мои воронки</a></p>`);
}

/**
 * Имена полей нумерованные (`say_0`, `say_1`), а не повторяющиеся: разборщик форм
 * оставляет от одинаковых имён только последнее значение.
 *
 * Кнопки действий отличаются значением одного поля `action`: браузер отправляет
 * значение только нажатой кнопки, поэтому сервер узнаёт, что именно нажали,
 * получив при этом всю форму целиком.
 */
export function constructorPage(
  automation: AutomationRow,
  steps: StepRow[],
  files: FileRow[],
  csrf: string,
  error: string | undefined,
): Html {
  const stepBlocks = steps.map((step, i) => html`
<fieldset>
  <legend>Шаг ${i + 1}</legend>
  <label>Текст
    <textarea name="say_${i}" rows="3" maxlength="1000" required>${step.say}</textarea>
  </label>
  <label>Файл
    <select name="file_${i}">
      <option value="">без файла</option>
      ${files.map((file) => html`
      <option value="${file.id}"${file.id === step.fileId ? html` selected` : ''}>${file.originalName}</option>`)}
    </select>
  </label>
  <label>Ответ сохранить как
    <input name="reply_${i}" value="${step.saveReplyAs ?? ''}" maxlength="40">
  </label>
  <label>Кнопки, по одной на строку (не больше ${MAX_BUTTONS})
    <textarea name="buttons_${i}" rows="3">${buttonLabels(step.buttonsJson)}</textarea>
  </label>
  <button type="submit" name="action" value="up_${i}">Вверх</button>
  <button type="submit" name="action" value="down_${i}">Вниз</button>
  <button type="submit" name="action" value="remove_${i}">Удалить шаг</button>
</fieldset>`);

  return layout(`Воронка: ${automation.name}`, html`
<h1>${automation.name}</h1>
<p><a href="/">Мои воронки</a> · <a href="/files">Файлы</a></p>
${automation.enabled ? '' : html`<p>Воронка выключена. Включить можно в списке воронок.</p>`}
${error === undefined ? '' : html`<p role="alert">${error}</p>`}

<form method="post" action="/automations/${automation.id}">
  <input type="hidden" name="csrf" value="${csrf}">
  <label>Название <input name="name" value="${automation.name}" required maxlength="100"></label>
  <label>Триггер
    <select name="trigger_type">${triggerOptions(automation.triggerType)}</select>
  </label>
  <label>Слово
    <input name="trigger_value" value="${automation.triggerValue}" required maxlength="100">
  </label>

  ${steps.length === 0 ? html`<p>Шагов пока нет.</p>` : stepBlocks}

  <button type="submit" name="action" value="add">Добавить шаг</button>
  <button type="submit" name="action" value="save">Сохранить</button>
</form>`);
}
