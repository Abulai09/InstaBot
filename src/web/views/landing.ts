import { html, type Html } from '../html.js';
import { landingLayout } from './layout.js';

/**
 * Витрина сервиса. Единственное действие, которое человек может здесь
 * совершить, — войти в кабинет: регистрации в продукте нет, клиента заводит
 * владелец сервиса и присылает ссылку-приглашение. Поэтому первичная кнопка
 * на странице ровно одна и повторяется дважды — в шапке и в конце страницы,
 * чтобы не заставлять прокручивать обратно.
 *
 * Разделы описаны списками, а не выписаны в разметке по одному: набор карточек
 * меняется чаще, чем их оформление, и править его в одном месте безопаснее.
 */
interface Step {
  title: string;
  text: string;
}

const HOW: Step[] = [
  {
    title: 'Человек пишет комментарий',
    text: 'Под постом появляется ключевое слово — «цена», «хочу», «гайд». Слово задаёте вы.',
  },
  {
    title: 'Бот отвечает и пишет в директ',
    text: 'Публичный ответ под комментарием и следом цепочка сообщений в личных: текст, файл, вопрос.',
  },
  {
    title: 'Заявка попадает в кабинет',
    text: 'Контакт и ответы человека сохраняются. Список заявок выгружается в CSV одной кнопкой.',
  },
];

const FEATURES: Step[] = [
  {
    title: 'Конструктор воронок',
    text: 'Триггер и шаги собираются в браузере, без кода и без правки файлов на сервере.',
  },
  {
    title: 'Файлы уходят в директ',
    text: 'Прайс, чек-лист или гайд приходят человеку вложением, а не ссылкой на чужой диск.',
  },
  {
    title: 'Заявки и выгрузка',
    text: 'Кто написал, по какой воронке и что ответил. Выгрузка в CSV для вашей CRM.',
  },
  {
    title: 'Отдельный кабинет',
    text: 'У каждого клиента свои воронки, файлы и заявки. Чужие данные не показываются нигде.',
  },
  {
    title: 'Правила площадок учтены',
    text: 'Окно в 24 часа у Instagram, ограничение частоты ответов, повтор доставки при сбое сети.',
  },
  {
    title: 'Без ИИ и сюрпризов',
    text: 'Сценарий детерминированный: что настроили, то человек и получит — слово в слово.',
  },
];

const START: Step[] = [
  {
    title: 'Заводим кабинет',
    text: 'Владелец сервиса создаёт клиента и выдаёт ссылку-приглашение.',
  },
  {
    title: 'Ставите пароль',
    text: 'По ссылке вы задаёте пароль и сразу попадаете внутрь. Ссылка одноразовая.',
  },
  {
    title: 'Подключаете аккаунт',
    text: 'Аккаунт Instagram подключается в кабинете, после этого собирается первая воронка.',
  },
];

function stepCards(items: Step[]): Html {
  return html`<div class="steps">${items.map((item, i) => html`
  <article class="step-card">
    <span class="step-card__num" aria-hidden="true">${i + 1}</span>
    <h3>${item.title}</h3>
    <p>${item.text}</p>
  </article>`)}</div>`;
}

/**
 * Демонстрация вместо описания: человек за две секунды видит, что именно
 * получит его подписчик. Это текст, а не картинка, — скринридер прочитает
 * его целиком, и он не размывается на экране любой плотности.
 */
function demo(): Html {
  return html`
<figure class="demo">
  <figcaption class="demo__cap">Как это выглядит у подписчика</figcaption>
  <div class="demo__block">
    <span class="demo__label">Комментарии под постом</span>
    <p class="bubble bubble--in">Сколько стоит?</p>
    <p class="bubble bubble--out">Отправили прайс вам в директ</p>
  </div>
  <div class="demo__block">
    <span class="demo__label">Личные сообщения</span>
    <p class="bubble bubble--out">Держите прайс на сентябрь. Подскажу по позициям, если нужно.</p>
    <p class="bubble bubble--file">price-2026-09.pdf</p>
  </div>
</figure>`;
}

function sectionHead(title: string, lead: string): Html {
  return html`
<div class="lsection__head">
  <h2>${title}</h2>
  <p class="lsection__lead">${lead}</p>
</div>`;
}

export function landingPage(): Html {
  const body = html`
<header class="lhead">
  <div class="lhead__inner">
    <a class="brand" href="/">Комментарий → Директ</a>
    <nav class="lnav" aria-label="Разделы страницы">
      <a href="#how">Как работает</a>
      <a href="#features">Возможности</a>
      <a href="#start">Как начать</a>
    </nav>
    <a class="btn btn--primary" href="/login">Войти</a>
  </div>
</header>

<main>
  <section class="hero">
    <div class="hero__inner">
      <div>
        <p class="eyebrow">Автоответы в Instagram</p>
        <h1>Комментарий под постом — <span class="gradient-text">заявка в директе</span></h1>
        <p class="hero__lead">
          Подписчик пишет ключевое слово в комментариях. Бот отвечает ему публично
          и тут же присылает в личные сообщения заготовленную цепочку с файлом.
          Вы получаете контакт, а не «ответьте в директ» под сотней комментариев.
        </p>
        <div class="actions hero__actions">
          <a class="btn btn--primary btn--lg" href="/login">Войти в кабинет</a>
          <a class="btn btn--outline btn--lg" href="#how">Как это работает</a>
        </div>
        <ul class="marks">
          <li>Ответ под комментарием за секунды</li>
          <li>Файл приходит в личные сообщения</li>
          <li>Контакт остаётся в кабинете</li>
        </ul>
      </div>
      ${demo()}
    </div>
  </section>

  <section class="lsection" id="how">
    ${sectionHead('Как это работает', 'Три шага, между которыми человеку не нужно ничего делать руками.')}
    ${stepCards(HOW)}
  </section>

  <div class="lband">
  <section class="lsection" id="features">
    ${sectionHead('Что внутри', 'Ровно то, что нужно для продаж в переписке, — и ничего сверх этого.')}
    <div class="cards">${FEATURES.map((item) => html`
      <article class="feature">
        <h3>${item.title}</h3>
        <p>${item.text}</p>
      </article>`)}</div>
  </section>
  </div>

  <section class="lsection" id="start">
    ${sectionHead('Как начать', 'Доступ выдаёт владелец сервиса — открытой регистрации нет.')}
    ${stepCards(START)}
    <div class="cta">
      <p class="cta__text">Ссылка-приглашение уже у вас? Пароль ставится по ней, входить можно сразу.</p>
      <a class="btn btn--primary btn--lg" href="/login">Войти в кабинет</a>
    </div>
  </section>
</main>

<footer class="lfoot">
  <div class="lfoot__inner">
    <span>Автоответы на комментарии и сообщения в Instagram</span>
    <a href="/login">Вход для клиентов</a>
  </div>
</footer>`;

  return landingLayout('Автоответы в Instagram: комментарий → заявка в директе', body);
}
