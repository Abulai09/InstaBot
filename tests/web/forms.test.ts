import { describe, expect, it } from 'vitest';
import { parseConstructorForm } from '../../src/web/forms.js';

function form(fields: Record<string, string>) {
  return { name: 'Прайс', trigger_type: 'contains', trigger_value: 'цена', ...fields };
}

describe('разбор формы конструктора', () => {
  it('собирает шаги по порядку', () => {
    const result = parseConstructorForm(form({
      say_0: 'Первый', say_1: 'Второй', say_2: 'Третий',
    }));

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.form.steps.map((s) => s.say)).toEqual(['Первый', 'Второй', 'Третий']);
    expect(result.form.name).toBe('Прайс');
    expect(result.form.triggerType).toBe('contains');
    expect(result.form.triggerValue).toBe('цена');
  });

  it('десятый шаг не встаёт между первым и вторым: сортировка числовая', () => {
    const result = parseConstructorForm(form({
      say_0: 'A', say_1: 'B', say_2: 'C', say_3: 'D', say_4: 'E',
      say_5: 'F', say_6: 'G', say_7: 'H', say_8: 'I', say_9: 'J', say_10: 'K',
    }));

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.form.steps.map((s) => s.say).join('')).toBe('ABCDEFGHIJK');
  });

  it('дыра в нумерации не ломает порядок', () => {
    const result = parseConstructorForm(form({ say_0: 'Первый', say_7: 'Второй' }));

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.form.steps.map((s) => s.say)).toEqual(['Первый', 'Второй']);
  });

  it('пустой текст шага — ошибка, а не пропуск: иначе сдвинется нумерация', () => {
    const result = parseConstructorForm(form({ say_0: 'Первый', say_1: '   ' }));

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain('Текст шага');
  });

  it('без названия форма отвергается', () => {
    const result = parseConstructorForm({ trigger_type: 'contains', trigger_value: 'цена' });
    expect(result.ok).toBe(false);
  });

  it('неизвестный тип триггера отвергается: regex в триггерах запрещён (S7)', () => {
    const result = parseConstructorForm({
      name: 'Прайс', trigger_type: 'regex', trigger_value: '.*', say_0: 'Ответ',
    });
    expect(result.ok).toBe(false);
  });

  it('имя переменной проверяется здесь, а не падением воркера позже', () => {
    const bad = parseConstructorForm(form({ say_0: 'Как вас зовут?', reply_0: '2имя' }));
    expect(bad.ok).toBe(false);

    const good = parseConstructorForm(form({ say_0: 'Как вас зовут?', reply_0: 'name' }));
    expect(good.ok).toBe(true);
    if (!good.ok) return;
    expect(good.form.steps[0]?.saveReplyAs).toBe('name');
  });

  it('пустое поле переменной и файла означает «нет», а не пустую строку', () => {
    const result = parseConstructorForm(form({ say_0: 'Ответ', reply_0: '', file_0: '' }));

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.form.steps[0]?.saveReplyAs).toBeUndefined();
    expect(result.form.steps[0]?.fileId).toBeUndefined();
  });

  it('кнопки берутся построчно, payload у каждой свой', () => {
    const result = parseConstructorForm(form({
      say_0: 'Выберите', buttons_0: 'Да\n Нет \n\n',
    }));

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const buttons = result.form.steps[0]?.buttons ?? [];
    expect(buttons.map((b) => b.label)).toEqual(['Да', 'Нет']);
    expect(new Set(buttons.map((b) => b.payload)).size).toBe(2);
  });

  it('кнопок больше трёх — ошибка', () => {
    const result = parseConstructorForm(form({
      say_0: 'Выберите', buttons_0: 'Раз\nДва\nТри\nЧетыре',
    }));
    expect(result.ok).toBe(false);
  });

  it('слишком длинный текст шага отвергается', () => {
    const result = parseConstructorForm(form({ say_0: 'я'.repeat(1001) }));
    expect(result.ok).toBe(false);
  });

  it('шагов больше двадцати — ошибка', () => {
    const fields: Record<string, string> = {};
    for (let i = 0; i < 21; i += 1) fields[`say_${i}`] = 'Шаг';
    expect(parseConstructorForm(form(fields)).ok).toBe(false);
  });

  it('S6: поле __proto__ в форме не загрязняет прототип', () => {
    parseConstructorForm(form({ say_0: 'Ответ', ['__proto__']: 'сломано' }));
    expect(Object.prototype).not.toHaveProperty('0');
    expect({}).not.toHaveProperty('сломано');
  });

  it('не объект вместо тела не роняет разбор', () => {
    expect(parseConstructorForm(undefined).ok).toBe(false);
    expect(parseConstructorForm('строка').ok).toBe(false);
    expect(parseConstructorForm(null).ok).toBe(false);
  });
});
