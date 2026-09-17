import { createHash } from 'node:crypto';

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

  --accent: #8a6dff;
  --accent-hover: #9a80ff;
  --accent-soft: #241f3d;
  --link: #c3b5ff;

  --danger: #a33127;
  --danger-hover: #b93b30;
  --danger-soft: #2e1a18;
  --danger-ink: #ff9a92;

  --warn-bg: #3a2e14;
  --warn-border: #6b5524;
  --warn-text: #ffd79a;

  --ok: #7ddba4;

  /* Холодный конец градиента на тёмном фоне не читается (#833AB4 даёт 2.8:1),
     поэтому акцентный текст здесь жёлтый — 9.8:1. Заливки остаются теми же */
  --brand-ink: #fcaf45;
  --brand-glow: rgba(225, 48, 108, 0.20);

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
  --accent: #6246d6;
  --accent-hover: #4f37b5;
  --accent-text: #ffffff;
  --accent-soft: #efeaff;
  --link: #6246d6;

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

  /* Палитра Instagram. Она живёт заливкой, а не текстом: белые буквы читаются
     только на холодной половине (синий 5.4:1, фиолетовый 6.5:1, розовый 5.1:1),
     а на оранжевом и жёлтом проваливаются до 2.8:1. Поэтому кнопки и пузыри
     красит --brand-cta-gradient из трёх холодных цветов, полный градиент
     из девяти достаётся декору без текста, а акцентный текст берёт
     --brand-ink, который в тёмной теме меняется на тёплый */
  --brand-1: #405de6;
  --brand-2: #5851db;
  --brand-3: #833ab4;
  --brand-4: #c13584;
  --brand-5: #e1306c;
  --brand-6: #fd1d1d;
  --brand-7: #f56040;
  --brand-8: #f77737;
  --brand-9: #fcaf45;
  --brand-gradient: linear-gradient(135deg,
    var(--brand-1), var(--brand-2) 16%, var(--brand-3) 34%, var(--brand-4) 50%,
    var(--brand-5) 63%, var(--brand-6) 74%, var(--brand-7) 85%, var(--brand-9));
  --brand-cta-gradient: linear-gradient(135deg, var(--brand-1), var(--brand-3) 55%, var(--brand-4));
  --brand-cta: #833ab4;
  --brand-cta-hover: #6b2f93;
  --brand-ink: #833ab4;
  --brand-glow: rgba(131, 58, 180, 0.14);
  /* Холст первого экрана и последней плашки: почти белый с лёгким уходом
     в сиреневый, чтобы подсветка градиентом легла на него заметно */
  --hero-bg: #faf9ff;

  --radius: 14px;
  --radius-sm: 8px;
  --shadow: 0 1px 2px rgba(16, 25, 40, 0.06), 0 1px 3px rgba(16, 25, 40, 0.08);
  --page: 60rem;
  --page-narrow: 24rem;
  --page-wide: 68rem;
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

.brand { font-size: 1.02rem; }

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
  font-size: 1.65rem;
  font-weight: 700;
  letter-spacing: -0.025em;
}

h2 {
  margin: var(--space-6) 0 var(--space-3);
  font-size: 1.1rem;
  font-weight: 650;
  letter-spacing: -0.01em;
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

/* Главное действие выглядит одинаково везде — и на витрине, и в кабинете.
   Градиент взят из холодной половины палитры: белый текст на синем,
   фиолетовом и розовом даёт 5.1-6.5:1, на оранжевом и жёлтом — 2.8:1 и ниже.
   На наведении градиент уступает сплошному цвету: так видно, что кнопка
   отреагировала, а не просто подсветилась */
.btn--primary {
  background: var(--brand-cta-gradient);
  border-color: transparent;
  color: #ffffff;
  font-weight: 600;
}

.btn--primary:hover { background: var(--brand-cta-hover); border-color: transparent; }

.btn--lg { min-height: 3.1rem; padding: var(--space-3) var(--space-6); font-size: 1.02rem; }

/* Вторая кнопка первого экрана: на светлом холсте ей хватает рамки —
   две заливки рядом спорили бы за внимание */
.btn--outline { background: var(--surface); border-color: var(--border-strong); }

.btn--outline:hover { background: var(--bg); border-color: var(--muted); }

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

/* Лендинг -------------------------------------------------------------- */

/* Витрина светлая всегда, независимо от темы в системе: landingLayout
   ставит data-theme="light" на <html>. Кабинет остаётся с выбором темы —
   в нём работают часами, витрину видят секунды, и она должна выглядеть
   одинаково у всех.

   Палитра здесь работает подсветкой, а не заливкой во весь экран: четыре
   пятна градиента поверх почти белого холста. Так цвет виден, а текст
   остаётся чёрным по белому — 14:1 */
.brandbar { height: 4px; background: var(--brand-gradient); }

.lhead {
  position: relative;
  z-index: 1;
  background: transparent;
  border-bottom: 0;
}

.lhead__inner {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: var(--space-2) var(--space-4);
  max-width: var(--page-wide);
  margin: 0 auto;
  padding: var(--space-4);
}

.lhead .brand { margin-right: auto; font-size: 1.02rem; }

.lnav { display: flex; gap: var(--space-1); }

.lnav a {
  padding: var(--space-2) var(--space-3);
  border-radius: var(--radius-sm);
  color: var(--muted);
  text-decoration: none;
  font-size: 0.94rem;
}

.lnav a:hover { background: var(--surface); color: var(--text); }

/* Первый экран --------------------------------------------------------- */

/* Шапка и первый экран стоят на одном холсте: .lhead прозрачна, фон общий
   лежит здесь и растянут вверх за её высоту */
.hero {
  position: relative;
  margin-top: calc(-1 * (2 * var(--space-4) + 2.4rem));
  padding-top: calc(2 * var(--space-4) + 2.4rem);
  overflow: hidden;
  background: var(--hero-bg);
}

/* Пятна вместо линейной заливки: линейный градиент во весь экран читается
   как баннер из шаблона. Всё на CSS-градиентах — картинок нет, потому что
   CSP не пустит ни внешний файл, ни data:-URI */
.hero::before {
  content: "";
  position: absolute;
  inset: -35% -10% -40% -25%;
  background:
    radial-gradient(36% 52% at 16% 20%, rgba(88, 81, 219, 0.20), transparent 70%),
    radial-gradient(40% 48% at 58% 4%, rgba(131, 58, 180, 0.17), transparent 72%),
    radial-gradient(42% 52% at 84% 72%, rgba(225, 48, 108, 0.16), transparent 70%),
    radial-gradient(34% 44% at 28% 96%, rgba(247, 119, 55, 0.14), transparent 72%);
  pointer-events: none;
}

.hero__inner {
  position: relative;
  display: grid;
  grid-template-columns: 1fr;
  gap: var(--space-6);
  max-width: var(--page-wide);
  margin: 0 auto;
  padding: var(--space-7) var(--space-4) calc(var(--space-7) + var(--space-5));
}

.hero h1 {
  margin: 0 0 var(--space-4);
  font-size: clamp(2.1rem, 1.2rem + 4.2vw, 3.6rem);
  font-weight: 700;
  line-height: 1.06;
  letter-spacing: -0.03em;
}

/* Градиентный текст берёт холодную половину палитры: на светлом фоне синий
   даёт 5.0:1, фиолетовый 6.1:1, розовый 4.8:1, а жёлтый — 1.7:1 и исчез бы.
   Прозрачный цвет назначается только там, где background-clip поддержан,
   иначе строка заголовка пропала бы целиком */
.gradient-text { color: var(--brand-3); }

@supports (background-clip: text) or (-webkit-background-clip: text) {
  .gradient-text {
    background: linear-gradient(104deg, var(--brand-1), var(--brand-3) 50%, var(--brand-4));
    -webkit-background-clip: text;
    background-clip: text;
    color: transparent;
  }
}

.hero__lead {
  max-width: 33rem;
  margin-bottom: var(--space-5);
  font-size: 1.1rem;
  line-height: 1.6;
  color: var(--muted);
}

.hero__actions { gap: var(--space-3); margin-bottom: var(--space-6); }

.eyebrow {
  display: inline-flex;
  align-items: center;
  gap: var(--space-2);
  margin-bottom: var(--space-5);
  padding: var(--space-1) var(--space-3);
  border: 1px solid var(--border-strong);
  border-radius: 999px;
  background: var(--surface);
  font-size: 0.82rem;
  font-weight: 600;
  color: var(--brand-ink);
}

.eyebrow::before {
  content: "";
  width: 0.55rem;
  height: 0.55rem;
  border-radius: 999px;
  background: var(--brand-gradient);
}

/* Три короткие выгоды под кнопками: держат нижний край первого экрана
   и отвечают на «а что я получу» до того, как человек начнёт прокручивать.
   Столбцом, а не строкой: разные по длине, они переносились по-разному
   на каждой ширине и рвали нижний край */
.marks {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
  margin: 0;
  padding: 0;
  list-style: none;
  font-size: 0.94rem;
  color: var(--muted);
}

.marks li { display: flex; align-items: center; gap: var(--space-2); }

.marks li::before {
  content: "";
  width: 0.5rem;
  height: 0.5rem;
  border-radius: 999px;
  background: var(--brand-cta-gradient);
  box-shadow: 0 0 0 3px var(--brand-glow);
}

/* Демонстрация переписки ----------------------------------------------- */

.demo {
  margin: 0;
  color: var(--text);
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  box-shadow: 0 24px 50px -30px rgba(23, 18, 38, 0.45);
  overflow: hidden;
}

.demo__cap {
  padding: var(--space-3) var(--space-4);
  border-bottom: 1px solid var(--border);
  font-size: 0.76rem;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.06em;
  color: var(--muted);
}

.demo__block { padding: var(--space-4); }
.demo__block + .demo__block { border-top: 1px solid var(--border); background: var(--bg); }

.demo__label {
  display: block;
  margin-bottom: var(--space-3);
  font-size: 0.78rem;
  font-weight: 600;
  color: var(--muted);
}

.bubble {
  max-width: 88%;
  margin: 0 0 var(--space-2);
  padding: var(--space-2) var(--space-3);
  border-radius: var(--radius);
  font-size: 0.94rem;
  line-height: 1.45;
}

.bubble:last-child { margin-bottom: 0; }

/* Фон страницы, а не карточки: пузырь лежит на поверхности карточки,
   и заливка того же цвета оставляла от него одну рамку */
.bubble--in { background: var(--bg); border: 1px solid var(--border); }

.bubble--out {
  margin-left: auto;
  background: var(--brand-cta-gradient);
  color: #ffffff;
  box-shadow: 0 6px 16px -8px rgba(131, 58, 180, 0.55);
}

.bubble--file {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  margin-left: auto;
  background: var(--surface);
  border: 1px solid var(--border-strong);
  font-weight: 550;
}

.bubble--file::before {
  content: "PDF";
  padding: 0.1rem 0.3rem;
  border-radius: 4px;
  background: var(--brand-cta);
  color: #ffffff;
  font-size: 0.66rem;
  font-weight: 700;
  letter-spacing: 0.04em;
}

/* Секции --------------------------------------------------------------- */

.lsection {
  max-width: var(--page-wide);
  margin: 0 auto;
  padding: calc(var(--space-7) + var(--space-4)) var(--space-4);
}

/* Полоса другого тона: без неё три секции подряд сливаются в один свиток
   и глазу не за что зацепиться при прокрутке */
.lband { background: var(--surface); border-block: 1px solid var(--border); }

.lsection__head { margin-bottom: var(--space-6); }

.lsection h2 {
  margin: 0 0 var(--space-3);
  font-size: clamp(1.6rem, 1.15rem + 1.8vw, 2.3rem);
  font-weight: 700;
  letter-spacing: -0.02em;
}

.lsection__lead { max-width: 40rem; margin: 0; font-size: 1.05rem; color: var(--muted); }

.lsection__head::after {
  content: "";
  display: block;
  width: 4rem;
  height: 4px;
  margin-top: var(--space-5);
  border-radius: 2px;
  background: var(--brand-gradient);
}

.steps { display: grid; grid-template-columns: 1fr; gap: var(--space-5); }

.step-card h3 { margin: 0 0 var(--space-2); font-size: 1.1rem; font-weight: 650; }
.step-card p { margin: 0; color: var(--muted); }

/* Номер шага — заливка холодной половиной палитры: на жёлтом конце белая
   цифра даёт 1.9:1 и исчезает, здесь 5.1:1 и выше */
.step-card__num {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 2.5rem;
  height: 2.5rem;
  margin-bottom: var(--space-4);
  border-radius: 999px;
  background: var(--brand-cta-gradient);
  box-shadow: 0 8px 20px -10px rgba(131, 58, 180, 0.6);
  color: #ffffff;
  font-size: 1.05rem;
  font-weight: 700;
}

.cards { display: grid; grid-template-columns: 1fr; gap: var(--space-4); }

/* Рамка карточки на наведении становится градиентной: два фона вместо
   border-image, иначе ломается скругление */
.feature {
  padding: var(--space-5);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  background: var(--bg);
  transition: transform 160ms ease-out, box-shadow 160ms ease-out;
}

.feature:hover {
  transform: translateY(-2px);
  border-color: transparent;
  background:
    linear-gradient(var(--bg), var(--bg)) padding-box,
    var(--brand-gradient) border-box;
  box-shadow: 0 18px 30px -22px rgba(16, 25, 40, 0.45);
}

.feature h3 { margin: 0 0 var(--space-2); font-size: 1.02rem; font-weight: 650; }
.feature p { margin: 0; color: var(--muted); font-size: 0.96rem; }

/* Последняя плашка: тот же приём, что и на первом экране — подсветка
   пятнами и градиентная рамка, чтобы она читалась как завершение,
   а не как ещё одна карточка */
.cta {
  position: relative;
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-4);
  margin-top: var(--space-7);
  padding: var(--space-6);
  border: 1px solid transparent;
  border-radius: var(--radius);
  background:
    linear-gradient(var(--hero-bg), var(--hero-bg)) padding-box,
    var(--brand-gradient) border-box;
  overflow: hidden;
}

.cta::before {
  content: "";
  position: absolute;
  inset: -70% 50% -70% -25%;
  background:
    radial-gradient(closest-side, rgba(131, 58, 180, 0.22), transparent),
    radial-gradient(closest-side, rgba(225, 48, 108, 0.16), transparent);
  pointer-events: none;
}

.cta__text {
  position: relative;
  flex: 1 1 18rem;
  margin: 0;
  font-size: 1.08rem;
}

.cta .btn { position: relative; }

.lfoot { background: var(--surface); border-top: 1px solid var(--border); }

.lfoot__inner {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-3);
  max-width: var(--page-wide);
  margin: 0 auto;
  padding: var(--space-6) var(--space-4);
  color: var(--muted);
  font-size: 0.92rem;
}

@media (min-width: 48rem) {
  .steps { grid-template-columns: repeat(3, 1fr); gap: var(--space-6); }
  .cards { grid-template-columns: repeat(2, 1fr); }
}

@media (min-width: 64rem) {
  .cards { grid-template-columns: repeat(3, 1fr); }
  .hero__inner { grid-template-columns: 1.02fr 0.98fr; align-items: center; gap: var(--space-7); }
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

  /* Якорные ссылки прячутся: страница короткая, её быстрее пролистать,
     чем целиться в мелкие ссылки рядом с кнопкой входа */
  .lnav { display: none; }
  .lhead__inner, .hero__inner, .lsection, .lfoot__inner {
    padding-left: var(--space-3);
    padding-right: var(--space-3);
  }
  .hero__inner, .lsection { padding-top: var(--space-6); padding-bottom: var(--space-6); }
  .lhead .btn { width: auto; min-height: 2.75rem; }
  .hero__actions .btn { flex: 1 1 100%; }
  .bubble { max-width: 100%; }
  .cta .btn { width: 100%; }
}

@media (prefers-reduced-motion: reduce) {
  * { transition: none !important; animation: none !important; }
}
`;

/**
 * Версия файла стилей — восемь символов хэша его содержимого. Она попадает
 * в адрес (`/app.css?v=...`), и это единственное, что заставляет браузер
 * забрать новые стили сразу: без неё он держит файл столько, сколько разрешил
 * `cache-control`, и показывает свежую разметку по старым правилам — то есть
 * страницу вообще без вёрстки.
 *
 * Считается один раз при импорте модуля: содержимое константы не меняется,
 * пересчитывать его на каждый запрос незачем.
 */
export const APP_CSS_VERSION = createHash('sha256').update(APP_CSS).digest('hex').slice(0, 8);
