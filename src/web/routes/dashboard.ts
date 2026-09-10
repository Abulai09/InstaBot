import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { listAutomations, setEnabled, stepCounts } from '../../storage/queries/automations.js';
import { listDeliveryErrors } from '../../storage/queries/runtime.js';
import { csrfToken, csrfValid } from '../csrf.js';
import { currentSession, redirectToLogin, type WebDeps } from '../session.js';
import { dashboardPage } from '../views/dashboard.js';

/**
 * S14: в форме переключателя разрешены ровно два поля.
 *
 * csrf необязателен в схеме намеренно: его отсутствие — это отказ в доступе (403),
 * а не кривой запрос (400). Обязательное поле схемы отвечало бы 400 и уводило
 * от настоящей причины
 */
const ToggleForm = z.object({
  enabled: z.enum(['true', 'false']),
  csrf: z.string().optional(),
});

const Params = z.object({ id: z.string().min(1) });

export function registerDashboardRoutes(app: FastifyInstance, deps: WebDeps): void {
  app.get('/', async (request, reply) => {
    const session = await currentSession(deps, request, new Date());
    if (session === undefined) return redirectToLogin(reply);

    const rows = await listAutomations(deps.db, session.userId);
    const counts = await stepCounts(deps.db, session.userId);
    const errors = await listDeliveryErrors(deps.db, session.userId);
    return reply
      // Страницы кабинета содержат ПД: в кэше браузера на общем компьютере
      // им делать нечего
      .header('cache-control', 'no-store')
      .type('text/html; charset=utf-8')
      .send(dashboardPage(
        rows, counts, errors, csrfToken(session.token, deps.cfg.SESSION_SECRET), session.role === 'owner',
      ).value);
  });

  app.post('/automations/:id/toggle', async (request, reply) => {
    const session = await currentSession(deps, request, new Date());
    if (session === undefined) return redirectToLogin(reply);

    const form = ToggleForm.safeParse(request.body);
    const params = Params.safeParse(request.params);
    if (!form.success || !params.success) return reply.code(400).send();

    if (!csrfValid(session.token, form.data.csrf, deps.cfg.SESSION_SECRET)) {
      return reply.code(403).send();
    }

    // S11: владелец из сессии и внутри запроса. Чужая воронка просто не найдётся,
    // и ответ будет тот же, что для своей — существование объекта не раскрывается
    setEnabled(deps.db, session.userId, params.data.id, form.data.enabled === 'true');
    return reply.code(303).header('location', '/').send();
  });
}
