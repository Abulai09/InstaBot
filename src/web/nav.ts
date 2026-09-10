import type { FastifyRequest } from 'fastify';
import type { Session } from './session.js';
import { readTheme } from './theme.js';
import { SECTION_HREF, type Nav } from './views/layout.js';

/**
 * Всё, что шапка знает о запросе, собирается здесь, а не в каждом маршруте:
 * раньше представлениям передавали одну роль, теперь ещё тему и путь возврата,
 * и три отдельных аргумента в семи вызовах разъехались бы при первой же правке.
 *
 * Роль берётся из сессии и только оттуда (S14) — из тела запроса владение
 * не читается нигде.
 */
export function pageNav(
  request: FastifyRequest, session: Session, current: Nav['current'],
): Nav {
  const cookieHeader = request.headers.cookie;

  return {
    current,
    isOwner: session.role === 'owner',
    theme: readTheme(typeof cookieHeader === 'string' ? cookieHeader : undefined),
    // После смены темы браузер вернётся сюда. С POST возвращаться на тот же
    // адрес нельзя: страница ошибки формы живёт по адресу, у которого GET
    // может не быть вовсе, — поэтому для POST берётся адрес самого раздела
    path: request.method === 'GET' ? request.url : SECTION_HREF[current],
  };
}

/**
 * То же самое, но без адреса запроса: путь берётся канонический, по разделу.
 *
 * Нужно там, где ответ обязан быть побайтово одинаковым для разных адресов.
 * Страница «не найдено» именно такая (S11): чужая воронка и несуществующая
 * отвечают одним и тем же, и эхо запрошенного пути делает их различимыми.
 */
export function sectionNav(
  request: FastifyRequest, session: Session, current: Nav['current'],
): Nav {
  return { ...pageNav(request, session, current), path: SECTION_HREF[current] };
}
