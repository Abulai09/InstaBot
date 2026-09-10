import type { FastifyInstance, FastifyReply } from 'fastify';
import { z } from 'zod';
import {
  createAutomation, getAutomation, setEnabled, updateAutomation,
  type NewStep,
} from '../../storage/queries/automations.js';
import { getFile, listFiles } from '../../storage/files.js';
import { csrfToken, csrfValid } from '../csrf.js';
import { parseConstructorForm } from '../forms.js';
import { pageNav, sectionNav } from '../nav.js';
import { currentSession, redirectToLogin, type WebDeps } from '../session.js';
import type { Nav } from '../views/layout.js';
import { constructorPage, newAutomationPage, notFoundPage } from '../views/constructor.js';

const Params = z.object({ id: z.string().min(1) });

/** S14: при создании читаются ровно эти поля. Шагов здесь нет вовсе. */
const CreateForm = z.object({
  name: z.string().trim().min(1).max(100),
  trigger_type: z.enum(['exact', 'contains', 'starts_with']),
  trigger_value: z.string().trim().min(1).max(100),
  csrf: z.string().optional(),
});

const ActionField = z.object({ action: z.string().optional(), csrf: z.string().optional() });
const ACTION = /^(save|add|up|down|remove)(?:_(\d+))?$/;

/**
 * Действие применяется к уже разобранным шагам, а не к строкам БД: клиент видит
 * результат сразу вместе с тем, что он напечатал до нажатия.
 */
function applyAction(steps: NewStep[], action: string): NewStep[] {
  const match = ACTION.exec(action);
  if (match === null) return steps;

  const kind = match[1];
  const index = match[2] === undefined ? -1 : Number(match[2]);
  const next = [...steps];

  if (kind === 'add') {
    // Текст, а не пустая строка: пустой шаг форма не принимает,
    // и клиент увидел бы ошибку сразу после нажатия «добавить»
    next.push({ say: 'Новый шаг' });
    return next;
  }

  const current = next[index];
  if (current === undefined) return next;

  if (kind === 'remove') {
    next.splice(index, 1);
    return next;
  }

  const target = kind === 'up' ? index - 1 : index + 1;
  const neighbour = next[target];
  // Край списка: «вверх» у первого и «вниз» у последнего просто ничего не делают
  if (neighbour === undefined) return next;

  next[index] = neighbour;
  next[target] = current;
  return next;
}

function notFound(reply: FastifyReply, nav: Nav): FastifyReply {
  return reply.code(404).type('text/html; charset=utf-8').send(notFoundPage(nav).value);
}

export function registerConstructorRoutes(app: FastifyInstance, deps: WebDeps): void {
  app.get('/automations/new', async (request, reply) => {
    const session = await currentSession(deps, request, new Date());
    if (session === undefined) return redirectToLogin(reply);

    return reply
      .header('cache-control', 'no-store')
      .type('text/html; charset=utf-8')
      .send(newAutomationPage(
        csrfToken(session.token, deps.cfg.SESSION_SECRET), undefined, pageNav(request, session, 'automations'),
      ).value);
  });

  app.post('/automations', async (request, reply) => {
    const session = await currentSession(deps, request, new Date());
    if (session === undefined) return redirectToLogin(reply);

    const form = CreateForm.safeParse(request.body);
    if (!form.success) {
      return reply.code(400).type('text/html; charset=utf-8').send(newAutomationPage(
        csrfToken(session.token, deps.cfg.SESSION_SECRET),
        'Заполните название и слово-триггер',
        pageNav(request, session, 'automations'),
      ).value);
    }
    if (!csrfValid(session.token, form.data.csrf, deps.cfg.SESSION_SECRET)) {
      return reply.code(403).send();
    }

    const id = await createAutomation(deps.db, session.userId, {
      name: form.data.name,
      triggerType: form.data.trigger_type,
      triggerValue: form.data.trigger_value,
      steps: [],
    });
    // Черновик без шагов включённым быть не должен: он молча не ответит
    // на слово-триггер, и клиент решит, что сломан бот
    await setEnabled(deps.db, session.userId, id, false);

    return reply.code(303).header('location', `/automations/${id}`).send();
  });

  app.get('/automations/:id', async (request, reply) => {
    const session = await currentSession(deps, request, new Date());
    if (session === undefined) return redirectToLogin(reply);

    const params = Params.safeParse(request.params);
    if (!params.success) return notFound(reply, sectionNav(request, session, 'automations'));

    // S11: владелец внутри запроса. Чужая воронка не находится, и ответ
    // такой же, как для несуществующей.
    //
    // Список файлов не зависит от воронки, поэтому оба запроса идут
    // параллельно: на облачной базе очередь из двух ожиданий — лишние
    // сотни миллисекунд на каждую правку воронки
    const [found, files] = await Promise.all([
      getAutomation(deps.db, session.userId, params.data.id),
      listFiles(deps.db, session.userId),
    ]);
    if (found === undefined) return notFound(reply, sectionNav(request, session, 'automations'));

    return reply
      .header('cache-control', 'no-store')
      .type('text/html; charset=utf-8')
      .send(constructorPage(
        found.automation, found.steps, files,
        csrfToken(session.token, deps.cfg.SESSION_SECRET), undefined, pageNav(request, session, 'automations'),
      ).value);
  });

  app.post('/automations/:id', async (request, reply) => {
    const session = await currentSession(deps, request, new Date());
    if (session === undefined) return redirectToLogin(reply);

    const params = Params.safeParse(request.params);
    const meta = ActionField.safeParse(request.body);
    if (!params.success || !meta.success) return reply.code(400).send();

    if (!csrfValid(session.token, meta.data.csrf, deps.cfg.SESSION_SECRET)) {
      return reply.code(403).send();
    }

    const found = await getAutomation(deps.db, session.userId, params.data.id);
    if (found === undefined) return notFound(reply, sectionNav(request, session, 'automations'));

    const parsed = parseConstructorForm(request.body);
    const files = await listFiles(deps.db, session.userId);
    const show = (code: number, error: string): FastifyReply => reply.code(code)
      .header('cache-control', 'no-store')
      .type('text/html; charset=utf-8')
      .send(constructorPage(
        found.automation, found.steps, files,
        csrfToken(session.token, deps.cfg.SESSION_SECRET), error, pageNav(request, session, 'automations'),
      ).value);

    if (!parsed.ok) return show(400, parsed.error);

    // S11: id файла приходит из формы, а поле формы подделывается. Без этой
    // проверки клиент подставил бы чужой id, и бот разослал бы чужой файл
    for (const step of parsed.form.steps) {
      if (step.fileId === undefined) continue;
      if (await getFile(deps.db, session.userId, step.fileId) === undefined) {
        return show(400, 'Файл не найден среди ваших');
      }
    }

    const steps = applyAction(parsed.form.steps, meta.data.action ?? 'save');
    await updateAutomation(deps.db, session.userId, params.data.id, { ...parsed.form, steps });

    return reply.code(303).header('location', `/automations/${params.data.id}`).send();
  });
}
