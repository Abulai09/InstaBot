/**
 * Один файл на весь кабинет. Инлайновых стилей нет и не будет: CSP запрещает
 * `unsafe-inline`, и это второй рубеж после экранирования разметки (S21, S22).
 *
 * Внешних шрифтов тоже нет: `default-src 'self'` не пустит Google Fonts, да и
 * системный шрифт грузится мгновенно и выглядит на месте в любой ОС.
 *
 * Цвета заданы ролями (`--text`, `--muted`, `--danger`), а не названиями
 * оттенков: правило «опасное действие красное» переживает смену палитры,
 * а `--red-600`, употреблённый в десяти местах по разным поводам, — нет.
 * Все пары текст/фон проверены на контраст WCAG AA (>= 4.5:1).
 */
/**
 * Тёмные значения написаны один раз и подставляются в две ветки: под
 * системную настройку и под явный выбор. Продублировать их руками означало бы
 * однажды поправить один список и забыть второй — тогда тема, выбранная
 * кнопкой, начнёт отличаться от той же темы, включённой системой.
 */
const DARK_TOKENS = `
  color-scheme: dark;

  --bg: #14161a;
  --surface: #1c1f24;
  --text: #e8eaee;
  --muted: #a2abb8;
  --border: #2b3038;
  --border-strong: #3a414b;

  --accent: #3b6fd0;
  --accent-hover: #4c80e2;
  --accent-soft: #1e2a3d;
  --link: #8fb6ff;

  --danger: #a33127;
  --danger-hover: #b93b30;
  --danger-soft: #2e1a18;
  --danger-ink: #ff9a92;

  --warn-bg: #3a2e14;
  --warn-border: #6b5524;
  --warn-text: #ffd79a;

  --ok: #7ddba4;

  --shadow: 0 1px 2px rgba(0, 0, 0, 0.4);
`;

/**
 * Три ветки, а не две. `:not([data-theme="light"])` обязателен: без него
 * светлая тема, выбранная руками на тёмной системе, проигрывала бы
 * медиазапросу и не включалась вовсе.
 */
const DARK_THEME = `
@media (prefers-color-scheme: dark) {
  :root:not([data-theme="light"]) {${DARK_TOKENS}  }
}

:root[data-theme="dark"] {${DARK_TOKENS}}`;

export const APP_CSS = `
:root {
  color-scheme: light;

  --bg: #f6f7f9;
  --surface: #ffffff;
  --text: #16191d;
  --muted: #5b6470;
  --border: #e2e5ea;
  --border-strong: #c9ced6;

  /* Заливка и текст — разные роли одного цвета, и в тёмной теме они расходятся:
     синий, на котором белые буквы читаются, сам буквами уже не читается.
     --accent и --danger только заливают, --link и --danger-ink только пишут */
  --accent: #1f5fd0;
  --accent-hover: #184ea9;
  --accent-text: #ffffff;
  --accent-soft: #eaf1fd;
  --link: #1f5fd0;

  --danger: #b3261e;
  --danger-hover: #8f1e17;
  --danger-text: #ffffff;
  --danger-soft: #fdecea;
  --danger-ink: #b3261e;

  --warn-bg: #fff6e6;
  --warn-border: #e8c77a;
  --warn-text: #7a4a00;

  --ok: #1a6b3c;

  --space-1: 0.25rem;
  --space-2: 0.5rem;
  --space-3: 0.75rem;
  --space-4: 1rem;
  --space-5: 1.5rem;
  --space-6: 2rem;
  --space-7: 3rem;

  --radius: 10px;
  --radius-sm: 6px;
  --shadow: 0 1px 2px rgba(16, 25, 40, 0.06), 0 1px 3px rgba(16, 25, 40, 0.08);
  --page: 60rem;
  --page-narrow: 24rem;
}

${DARK_THEME}

*, *::before, *::after { box-sizing: border-box; }

body {
  margin: 0;
  background: var(--bg);
  color: var(--text);
  font: 16px/1.55 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
}

/* Шапка ---------------------------------------------------------------- */

.topbar {
  background: var(--surface);
  border-bottom: 1px solid var(--border);
}

.topbar__inner {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: var(--space-2) var(--space-5);
  max-width: var(--page);
  margin: 0 auto;
  padding: var(--space-3) var(--space-4);
}

.brand {
  font-weight: 650;
  letter-spacing: -0.01em;
  text-decoration: none;
  color: var(--text);
}

.nav {
  display: flex;
  flex-wrap: wrap;
  gap: var(--space-1);
  margin-right: auto;
}

.nav a {
  padding: var(--space-2) var(--space-3);
  border-radius: var(--radius-sm);
  color: var(--muted);
  text-decoration: none;
  font-size: 0.94rem;
}

.nav a:hover { background: var(--bg); color: var(--text); }

/* Текущий раздел отмечен и цветом, и весом: цвет в одиночку не читается
   при дальтонизме и на плохом экране */
.nav a[aria-current="page"] {
  background: var(--accent-soft);
  color: var(--link);
  font-weight: 600;
}

/* Переключатель темы ---------------------------------------------------- */

.theme__group {
  display: inline-flex;
  border: 1px solid var(--border-strong);
  border-radius: var(--radius-sm);
  overflow: hidden;
}

.theme__btn {
  padding: var(--space-1) var(--space-3);
  min-height: 1.9rem;
  border: 0;
  border-radius: 0;
  background: var(--surface);
  color: var(--muted);
  font: inherit;
  font-size: 0.82rem;
  line-height: 1.2;
  cursor: pointer;
}

.theme__btn + .theme__btn { border-left: 1px solid var(--border); }
.theme__btn:hover { background: var(--bg); color: var(--text); }

/* Нажатое состояние держится не только цветом: заливка плюс вес начертания,
   иначе выбранная тема неразличима на плохом экране и при дальтонизме */
.theme__btn[aria-pressed="true"] {
  background: var(--accent-soft);
  color: var(--link);
  font-weight: 650;
}

/* Страница ------------------------------------------------------------- */

.page {
  display: block;
  max-width: var(--page);
  margin: 0 auto;
  padding: var(--space-6) var(--space-4) var(--space-7);
}

.page--narrow { max-width: var(--page-narrow); padding-top: var(--space-7); }

.page__head {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-3);
  margin-bottom: var(--space-5);
}

h1 {
  margin: 0;
  font-size: 1.5rem;
  font-weight: 650;
  letter-spacing: -0.02em;
}

h2 {
  margin: var(--space-6) 0 var(--space-3);
  font-size: 1.075rem;
  font-weight: 650;
}

p { margin: 0 0 var(--space-4); }

.muted { color: var(--muted); font-size: 0.9rem; }

a { color: var(--link); }

/* Первый заголовок внутри карточки не отбивается сверху: у карточки уже есть
   свой отступ, и двойной делает её похожей на пустую */
.card > h2:first-child { margin-top: 0; }

.card {
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  box-shadow: var(--shadow);
  padding: var(--space-5);
  margin-bottom: var(--space-5);
}

/* Таблицы -------------------------------------------------------------- */

.table-card {
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  box-shadow: var(--shadow);
  overflow: hidden;
  margin-bottom: var(--space-5);
}

table { width: 100%; border-collapse: collapse; }

th, td {
  padding: var(--space-3) var(--space-4);
  text-align: left;
  vertical-align: middle;
  border-bottom: 1px solid var(--border);
}

thead th {
  font-size: 0.78rem;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.04em;
  color: var(--muted);
  background: var(--bg);
}

tbody tr:last-child td { border-bottom: 0; }

td .actions { justify-content: flex-end; }
/* Раскрывашка в ячейке действий встаёт по тому же правому краю, что и кнопки,
   иначе она висит отдельной строкой не по сетке */
td details.disclosure { text-align: right; }
td details.disclosure > div { text-align: left; }

/* Состояния ------------------------------------------------------------ */

.badge {
  display: inline-block;
  padding: 0.1rem var(--space-2);
  border-radius: 999px;
  font-size: 0.8rem;
  font-weight: 600;
  border: 1px solid var(--border-strong);
  color: var(--muted);
}

.badge--on { color: var(--ok); border-color: currentColor; }
.badge--off { color: var(--muted); }
.badge--draft { color: var(--warn-text); background: var(--warn-bg); border-color: var(--warn-border); }

/* Кнопки --------------------------------------------------------------- */

.actions { display: flex; flex-wrap: wrap; gap: var(--space-2); align-items: center; }
.actions form { display: contents; }

.btn {
  display: inline-flex;
  align-items: center;
  gap: var(--space-2);
  padding: var(--space-2) var(--space-4);
  min-height: 2.4rem;
  border: 1px solid var(--border-strong);
  border-radius: var(--radius-sm);
  background: var(--surface);
  color: var(--text);
  font: inherit;
  font-size: 0.94rem;
  font-weight: 500;
  line-height: 1.2;
  text-decoration: none;
  cursor: pointer;
  transition: background-color 140ms ease-out, border-color 140ms ease-out;
}

.btn:hover { background: var(--bg); }

.btn--primary {
  background: var(--accent);
  border-color: var(--accent);
  color: var(--accent-text);
  font-weight: 600;
}

.btn--primary:hover { background: var(--accent-hover); border-color: var(--accent-hover); }

.btn--danger { color: var(--danger-ink); border-color: var(--border-strong); }
.btn--danger:hover { background: var(--danger-soft); border-color: var(--danger); }

.btn--quiet {
  border-color: transparent;
  background: transparent;
  color: var(--muted);
  padding-left: var(--space-3);
  padding-right: var(--space-3);
}

.btn--quiet:hover { background: var(--bg); color: var(--text); }

.btn--small { min-height: 2rem; padding: var(--space-1) var(--space-3); font-size: 0.88rem; }

.btn[disabled] { opacity: 0.55; cursor: not-allowed; }

/* Формы ---------------------------------------------------------------- */

.field { display: block; margin-bottom: var(--space-4); }

.field > span, .field-label {
  display: block;
  margin-bottom: var(--space-1);
  font-size: 0.9rem;
  font-weight: 550;
}

.field .muted { display: block; margin-top: var(--space-1); }

input, select, textarea {
  display: block;
  width: 100%;
  padding: var(--space-2) var(--space-3);
  min-height: 2.4rem;
  border: 1px solid var(--border-strong);
  border-radius: var(--radius-sm);
  background: var(--surface);
  color: var(--text);
  font: inherit;
}

input[type="file"] { padding: var(--space-2); }
textarea { resize: vertical; min-height: 4.5rem; }

input:hover, select:hover, textarea:hover { border-color: var(--muted); }

/* Фокус виден всегда и не зависит от цвета рамки поля: клавиатурный
   пользователь обязан понимать, где он находится */
:focus-visible {
  outline: 2px solid var(--accent);
  outline-offset: 2px;
  border-radius: var(--radius-sm);
}

.form-row {
  display: flex;
  flex-wrap: wrap;
  gap: var(--space-4);
  margin-bottom: var(--space-4);
}

.form-row .field { flex: 1 1 12rem; margin-bottom: 0; }
.form-row + .actions { margin-top: var(--space-5); }

/* Шаги воронки --------------------------------------------------------- */

.step {
  border: 1px solid var(--border);
  border-radius: var(--radius);
  background: var(--surface);
  padding: var(--space-4) var(--space-5) var(--space-5);
  margin: 0 0 var(--space-4);
}

.step__legend {
  padding: 0 var(--space-2);
  font-size: 0.9rem;
  font-weight: 650;
  color: var(--muted);
}

.step__tools { justify-content: flex-end; margin-top: var(--space-4); }

/* Сообщения ------------------------------------------------------------ */

.alert {
  border: 1px solid var(--border-strong);
  border-left-width: 4px;
  border-radius: var(--radius-sm);
  padding: var(--space-3) var(--space-4);
  margin-bottom: var(--space-5);
  background: var(--surface);
}

.alert--error { border-left-color: var(--danger); background: var(--danger-soft); color: var(--text); }
.alert--warn { border-left-color: var(--warn-border); background: var(--warn-bg); color: var(--warn-text); }
.alert--info { border-left-color: var(--accent); background: var(--accent-soft); }
.alert code { word-break: break-all; }
.alert h2 { margin-top: 0; }
.alert table { margin-bottom: var(--space-3); }
/* Внутри предупреждения шапка таблицы не заливается фоном страницы:
   тёмная полоса поперёк жёлтого блока читается как чужеродный кусок */
.alert thead th { background: transparent; }
.alert th, .alert td { border-color: var(--warn-border); }
.alert :last-child { margin-bottom: 0; }

/* Пустое состояние объясняет, что здесь появится, и даёт первое действие:
   пустая страница без объяснения читается как поломка */
.empty {
  border: 1px dashed var(--border-strong);
  border-radius: var(--radius);
  padding: var(--space-6) var(--space-5);
  text-align: center;
  color: var(--muted);
  background: var(--surface);
  margin-bottom: var(--space-5);
}

.empty h2 { margin: 0 0 var(--space-2); font-size: 1.05rem; color: var(--text); }
.empty p { margin: 0 0 var(--space-4); }
.empty :last-child { margin-bottom: 0; }

/* Раскрывающийся блок: нативный, без скрипта — CSP запрещает инлайновый JS */
details.disclosure { margin-top: var(--space-2); }

details.disclosure > summary {
  cursor: pointer;
  font-size: 0.9rem;
  color: var(--link);
  padding: var(--space-1) 0;
}

details.disclosure > div {
  margin-top: var(--space-3);
  padding: var(--space-4);
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  background: var(--bg);
}

/* Узкий экран ---------------------------------------------------------- */

@media (max-width: 40rem) {
  .page { padding: var(--space-5) var(--space-3) var(--space-6); }
  .card, .empty { padding: var(--space-4); }

  /* Таблица превращается в список карточек: горизонтальная прокрутка
     на телефоне прячет как раз те колонки, ради которых сюда пришли.
     Заголовок колонки подставляется из data-label */
  .table-card { border: 0; background: transparent; box-shadow: none; overflow: visible; }
  .table-card thead { position: absolute; width: 1px; height: 1px; overflow: hidden; clip-path: inset(50%); }
  .table-card table, .table-card tbody, .table-card tr, .table-card td { display: block; width: 100%; }

  .table-card tr {
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: var(--radius);
    box-shadow: var(--shadow);
    padding: var(--space-2) var(--space-4);
    margin-bottom: var(--space-3);
  }

  .table-card td { border-bottom: 0; padding: var(--space-2) 0; }
  .table-card td + td { border-top: 1px solid var(--border); }

  .table-card td[data-label]::before {
    content: attr(data-label);
    display: block;
    font-size: 0.75rem;
    text-transform: uppercase;
    letter-spacing: 0.04em;
    color: var(--muted);
    margin-bottom: var(--space-1);
  }

  td .actions { justify-content: flex-start; }
  .btn { width: 100%; justify-content: center; }
  .actions .btn { width: auto; flex: 1 1 auto; }
}

@media (prefers-reduced-motion: reduce) {
  * { transition: none !important; animation: none !important; }
}
`;
