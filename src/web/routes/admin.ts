import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { listClients } from '../../storage/queries/users.js';
import { csrfToken } from '../csrf.js';
import { currentSession, redirectToLogin, type WebDeps } from '../session.js';
import { adminPage, type Notice } from '../views/admin.js';

/**
 * Единственное место, которое рисует список: все POST-маршруты заканчиваются
 * им же, только с разным `notice`. Редиректа после POST нет намеренно —
 * ссылку приглашения нужно показать, а через редирект её пришлось бы
 * протаскивать в URL, то есть в лог и в историю браузера (S9).
 */
function renderList(
  deps: WebDeps, request: FastifyRequest, reply: FastifyReply, notice: Notice | undefined,
): FastifyReply {
  const session = currentSession(deps, request, new Date());
  if (session === undefined) return redirectToLogin(reply);

  return reply
    .header('cache-control', 'no-store')
    .type('text/html; charset=utf-8')
    .send(adminPage(
      listClients(deps.db),
      csrfToken(session.token, deps.cfg.SESSION_SECRET),
      notice,
    ).value);
}

/**
 * S12 — function-level авторизация. Хук живёт внутри плагина, а Fastify
 * инкапсулирует хуки: он действует на маршруты этого плагина и только на них.
 * Новый маршрут внутри защищён автоматически — забыть проверку физически нечего.
 *
 * Это другая проверка, чем S11: там «твой ли объект», тут «твоя ли роль».
 */
export function registerAdminRoutes(app: FastifyInstance, deps: WebDeps): void {
  app.register((admin, _opts, done) => {
    admin.addHook('onRequest', (request, reply, next) => {
      const session = currentSession(deps, request, new Date());
      if (session === undefined) {
        void redirectToLogin(reply);
        return;
      }
      if (session.role !== 'owner') {
        // 403, а не 404: скрывать существование админки бессмысленно,
        // а разные коды помогают владельцу понять, что он зашёл не тем входом
        void reply.code(403).send();
        return;
      }
      next();
    });

    // Обработчики зовут currentSession повторно: им нужен `token` для CSRF.
    // Это один индексированный SELECT — дешевле, чем протаскивать сессию
    // через декоратор запроса и подпирать его расширением типов Fastify
    admin.get('/', (request, reply) => renderList(deps, request, reply, undefined));

    done();
  }, { prefix: '/admin' });
}
