import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { listAutomations, setEnabled, stepCounts } from '../../storage/queries/automations.js';
import { listDeliveryErrors } from '../../storage/queries/runtime.js';
import { csrfToken, csrfValid } from '../csrf.js';
import { pageNav } from '../nav.js';
import { currentSession, redirectToLogin, type WebDeps } from '../session.js';
import { dashboardPage } from '../views/dashboard.js';
import { landingPage } from '../views/landing.js';

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
  /**
   * Корень делят двое: гость видит витрину, клиент — свои воронки. Отдельного
   * маршрута у лендинга нет намеренно — Fastify не даёт зарегистрировать
   * второй обработчик того же пути, а разводить их по разным адресам значило бы,
   * что человек, набравший домен, витрину не увидит.
   *
   * Лендинг публичный и одинаковый для всех: `no-store` ему не нужен (ПД на нём
   * нет), а короткий кэш снимает повторный поход к базе за сессией.
   */
  app.get('/', async (request, reply) => {
    const session = await currentSession(deps, request, new Date());
    if (session === undefined) {
      return reply
        .header('cache-control', 'public, max-age=300')
        .type('text/html; charset=utf-8')
        .send(landingPage().value);
    }

    // Три независимых запроса — параллельно, а не по очереди. На облачной базе
    // за океаном один round-trip стоит сотни миллисекунд, и последовательное
    // ожидание складывало их в секунды на ровном месте
    const [rows, counts, errors] = await Promise.all([
      listAutomations(deps.db, session.userId),
      stepCounts(deps.db, session.userId),
      listDeliveryErrors(deps.db, session.userId),
    ]);
    return reply
      // Страницы кабинета содержат ПД: в кэше браузера на общем компьютере
      // им делать нечего
      .header('cache-control', 'no-store')
      .type('text/html; charset=utf-8')
      .send(dashboardPage(
        rows, counts, errors, csrfToken(session.token, deps.cfg.SESSION_SECRET),
        pageNav(request, session, 'automations'),
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
    await setEnabled(deps.db, session.userId, params.data.id, form.data.enabled === 'true');
    return reply.code(303).header('location', '/').send();
  });
}
