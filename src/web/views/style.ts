/**
 * Один файл на весь кабинет. Инлайновых стилей нет и не будет: CSP запрещает
 * `unsafe-inline`, и это второй рубеж после экранирования разметки (S21, S22).
 */
export const APP_CSS = `
:root { color-scheme: light dark; }

body {
  margin: 0 auto;
  padding: 1.5rem 1rem 4rem;
  max-width: 46rem;
  font: 16px/1.5 system-ui, sans-serif;
}

h1 { font-size: 1.5rem; margin-bottom: 0.5rem; }

a { color: inherit; }

table { width: 100%; border-collapse: collapse; margin: 1rem 0; }
th, td { padding: 0.5rem; text-align: left; border-bottom: 1px solid currentColor; }
th { font-weight: 600; }

fieldset { margin: 1rem 0; padding: 1rem; border: 1px solid currentColor; }
legend { padding: 0 0.4rem; font-weight: 600; }

label { display: block; margin-bottom: 0.75rem; }
input, select, textarea {
  display: block;
  width: 100%;
  margin-top: 0.25rem;
  padding: 0.5rem;
  font: inherit;
  box-sizing: border-box;
}
textarea { resize: vertical; }

button { padding: 0.5rem 1rem; font: inherit; cursor: pointer; }

/* Формы-кнопки в таблице не должны растягивать строку на всю ширину */
td form { display: inline; }

[role="alert"] { padding: 0.75rem; border: 2px solid currentColor; font-weight: 600; }
`;
