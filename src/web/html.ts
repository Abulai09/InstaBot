/**
 * Экранирование по умолчанию — единственная защита от XSS, которую нельзя забыть
 * применить (S21). Сырой HTML требует явного `raw()`, и это видно в месте вызова.
 *
 * Амперсанд заменяется первым: если сделать это после `<`, уже вставленные
 * `&lt;` экранируются повторно и разметка поедет.
 */
export function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

/** Готовая разметка: строка, которая уже безопасна и не экранируется повторно. */
export class Html {
  constructor(readonly value: string) {}
}

/**
 * Явное «этот HTML написал я». На данных, пришедших от пользователя,
 * не вызывается никогда — в этом весь смысл отдельной функции.
 */
export function raw(value: string): Html {
  return new Html(value);
}

function render(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (value instanceof Html) return value.value;
  if (Array.isArray(value)) return value.map(render).join('');
  return escapeHtml(String(value));
}

export function html(strings: TemplateStringsArray, ...values: unknown[]): Html {
  let out = '';
  strings.forEach((part, i) => {
    out += part;
    if (i < values.length) out += render(values[i]);
  });
  return new Html(out);
}
