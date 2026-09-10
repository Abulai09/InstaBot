import { z } from 'zod';
import type { AutomationRow, StepRow } from '../../storage/queries/automations.js';
import type { FileRow } from '../../storage/files.js';
import { MAX_BUTTONS } from '../forms.js';
import { html, type Html } from '../html.js';
import { TRIGGER_KINDS, triggerLabel } from './labels.js';
import { layout, type Nav } from './layout.js';

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
  return html`${TRIGGER_KINDS.map((value) => html`
<option value="${value}"${value === selected ? html` selected` : ''}>${triggerLabel(value)}</option>`)}`;
}

export function newAutomationPage(csrf: string, error: string | undefined, nav: Nav): Html {
  return layout('Новая воронка', html`
<div class="page__head">
  <h1>Новая воронка</h1>
</div>
${error === undefined ? '' : html`<p class="alert alert--error" role="alert">${error}</p>`}
<form class="card" method="post" action="/automations">
  <input type="hidden" name="csrf" value="${csrf}">
  <label class="field">
    <span>Название</span>
    <input name="name" required maxlength="100" autofocus>
    <span class="muted">Видите только вы — чтобы отличать воронки в списке.</span>
  </label>
  <div class="form-row">
    <label class="field">
      <span>Комментарий</span>
      <select name="trigger_type">${triggerOptions('contains')}</select>
    </label>
    <label class="field">
      <span>Слово-триггер</span>
      <input name="trigger_value" required maxlength="100">
    </label>
  </div>
  <div class="actions form-row">
    <button class="btn btn--primary" type="submit">Создать</button>
    <a class="btn btn--quiet" href="/">Отмена</a>
  </div>
</form>
<p class="muted">Шаги добавляются после создания. Пока шагов нет, воронка молчит.</p>`,
  nav);
}

export function notFoundPage(nav: Nav): Html {
  return layout('Не найдено', html`
<div class="empty">
  <h2>Воронка не найдена</h2>
  <p>Её удалили, либо ссылка ведёт на чужую воронку.</p>
  <a class="btn btn--primary" href="/">К списку воронок</a>
</div>`, nav);
}

/**
 * Имена полей нумерованные (`say_0`, `say_1`), а не повторяющиеся: разборщик форм
 * оставляет от одинаковых имён только последнее значение.
 *
 * Кнопки действий отличаются значением одного поля `action`: браузер отправляет
 * значение только нажатой кнопки, поэтому сервер узнаёт, что именно нажали,
 * получив при этом всю форму целиком.
 *
 * Отсюда же и подпись под шагами: «Вверх» и «Удалить» отправляют форму целиком
 * и заодно сохраняют несохранённые правки. Раньше это было неочевидно, а кнопки
 * выглядели одинаково — теперь порядок и удаление визуально тише, чем
 * «Сохранить», и человек предупреждён, что произойдёт.
 */
export function constructorPage(
  automation: AutomationRow,
  steps: StepRow[],
  files: FileRow[],
  csrf: string,
  error: string | undefined,
  nav: Nav,
): Html {
  const stepBlocks = steps.map((step, i) => html`
<fieldset class="step">
  <legend class="step__legend">Шаг ${i + 1}</legend>
  <label class="field">
    <span>Текст сообщения</span>
    <textarea name="say_${i}" rows="3" maxlength="1000" required>${step.say}</textarea>
  </label>
  <div class="form-row">
    <label class="field">
      <span>Файл</span>
      <select name="file_${i}">
        <option value="">без файла</option>
        ${files.map((file) => html`
        <option value="${file.id}"${file.id === step.fileId ? html` selected` : ''}>${file.originalName}</option>`)}
      </select>
    </label>
    <label class="field">
      <span>Ответ сохранить как</span>
      <input name="reply_${i}" value="${step.saveReplyAs ?? ''}" maxlength="40" placeholder="например, phone">
    </label>
  </div>
  <label class="field">
    <span>Кнопки</span>
    <textarea name="buttons_${i}" rows="3">${buttonLabels(step.buttonsJson)}</textarea>
    <span class="muted">По одной на строку, не больше ${MAX_BUTTONS}. Пусто — кнопок не будет.</span>
  </label>
  <div class="actions step__tools">
    <button class="btn btn--small btn--quiet" type="submit" name="action" value="up_${i}">Вверх</button>
    <button class="btn btn--small btn--quiet" type="submit" name="action" value="down_${i}">Вниз</button>
    <button class="btn btn--small btn--danger" type="submit" name="action" value="remove_${i}">Удалить шаг</button>
  </div>
</fieldset>`);

  const emptySteps = html`
<div class="empty">
  <h2>Шагов пока нет</h2>
  <p>Шаг — одно сообщение в директ: текст, при желании файл и кнопки.
  Пока шагов нет, воронка не ответит, даже если включить её.</p>
</div>`;

  return layout(`Воронка: ${automation.name}`, html`
<div class="page__head">
  <h1>${automation.name}</h1>
  <a class="btn btn--quiet" href="/">К списку воронок</a>
</div>
${automation.enabled ? '' : html`
<p class="alert alert--warn" role="status">Воронка выключена — на комментарии она сейчас не отвечает.
Включить можно в списке воронок.</p>`}
${error === undefined ? '' : html`<p class="alert alert--error" role="alert">${error}</p>`}

<form method="post" action="/automations/${automation.id}">
  <input type="hidden" name="csrf" value="${csrf}">

  <section class="card">
    <h2>Когда срабатывает</h2>
    <label class="field">
      <span>Название</span>
      <input name="name" value="${automation.name}" required maxlength="100">
    </label>
    <div class="form-row">
      <label class="field">
        <span>Комментарий</span>
        <select name="trigger_type">${triggerOptions(automation.triggerType)}</select>
      </label>
      <label class="field">
        <span>Слово-триггер</span>
        <input name="trigger_value" value="${automation.triggerValue}" required maxlength="100">
      </label>
    </div>
  </section>

  <h2>Что бот отправит в директ</h2>
  ${steps.length === 0 ? emptySteps : stepBlocks}

  <div class="actions">
    <button class="btn btn--primary" type="submit" name="action" value="save">Сохранить</button>
    <button class="btn" type="submit" name="action" value="add">Добавить шаг</button>
  </div>
  <p class="muted">Любая из кнопок отправляет форму целиком, поэтому правки в тексте
  не потеряются при добавлении, переносе или удалении шага.</p>
</form>`, nav);
}
