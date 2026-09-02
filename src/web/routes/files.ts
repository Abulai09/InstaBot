import multipart, { type MultipartFields } from '@fastify/multipart';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { deleteFile, listFiles, saveFile } from '../../storage/files.js';
import { csrfToken, csrfValid } from '../csrf.js';
import { currentSession, redirectToLogin, type WebDeps } from '../session.js';
import { filesPage } from '../views/files.js';

const MB = 1024 * 1024;

const DeleteForm = z.object({ csrf: z.string().optional() });
const Params = z.object({ id: z.string().min(1) });

/**
 * Значение поля формы из multipart. Написано отдельной функцией, потому что
 * в `fields` лежит объединение типов: поле, файл или массив — и разбирать его
 * приведением типа запрещено правилами проекта.
 */
function fieldValue(fields: MultipartFields, name: string): string | undefined {
  const found = fields[name];
  if (found === undefined || Array.isArray(found)) return undefined;
  if (found.type !== 'field') return undefined;
  return typeof found.value === 'string' ? found.value : undefined;
}

export function registerFilesRoutes(app: FastifyInstance, deps: WebDeps): void {
  // Плагин обёрнут в fastify-plugin: разбор multipart появляется на этом же
  // экземпляре, а не в дочернем контексте, и маршруты ниже его видят.
  // Лимит на уровне плагина — первый рубеж: файл выше него не дочитывается
  // в память вообще, до всякой проверки содержимого
  void app.register(multipart, { limits: { fileSize: 25 * MB, files: 1, fields: 6 } });

  app.get('/files', (request, reply) => {
    const session = currentSession(deps, request, new Date());
    if (session === undefined) return redirectToLogin(reply);

    return reply
      .header('cache-control', 'no-store')
      .type('text/html; charset=utf-8')
      .send(filesPage(
        listFiles(deps.db, session.userId),
        csrfToken(session.token, deps.cfg.SESSION_SECRET),
        undefined,
      ).value);
  });

  app.post('/files', async (request, reply) => {
    const session = currentSession(deps, request, new Date());
    if (session === undefined) return redirectToLogin(reply);

    const uploaded = await request.file();
    if (uploaded === undefined) return reply.code(400).send();

    // Поле csrf в разметке стоит до поля файла: busboy отдаёт части по порядку,
    // и к моменту появления файла токен уже разобран
    if (!csrfValid(session.token, fieldValue(uploaded.fields, 'csrf'), deps.cfg.SESSION_SECRET)) {
      return reply.code(403).send();
    }

    try {
      saveFile(deps.db, session.userId, {
        originalName: uploaded.filename,
        mimeType: uploaded.mimetype,
        bytes: await uploaded.toBuffer(),
      }, deps.cfg.FILES_DIR);
    } catch {
      // Сообщения saveFile написаны для лога, не для клиента: они называют
      // сработавшую проверку. Клиенту хватает списка разрешённого (S9)
      return reply.code(400).header('cache-control', 'no-store')
        .type('text/html; charset=utf-8')
        .send(filesPage(
          listFiles(deps.db, session.userId),
          csrfToken(session.token, deps.cfg.SESSION_SECRET),
          'Файл не принят. Разрешены PDF до 25 МБ, PNG и JPEG до 8 МБ',
        ).value);
    }

    return reply.code(303).header('location', '/files').send();
  });

  app.post('/files/:id/delete', (request, reply) => {
    const session = currentSession(deps, request, new Date());
    if (session === undefined) return redirectToLogin(reply);

    const form = DeleteForm.safeParse(request.body);
    const params = Params.safeParse(request.params);
    if (!form.success || !params.success) return reply.code(400).send();

    if (!csrfValid(session.token, form.data.csrf, deps.cfg.SESSION_SECRET)) {
      return reply.code(403).send();
    }

    const result = deleteFile(deps.db, session.userId, params.data.id, deps.cfg.FILES_DIR);
    if (result === 'in_use') {
      return reply.code(409).header('cache-control', 'no-store')
        .type('text/html; charset=utf-8')
        .send(filesPage(
          listFiles(deps.db, session.userId),
          csrfToken(session.token, deps.cfg.SESSION_SECRET),
          'Файл используется в воронке. Сначала уберите его из шага',
        ).value);
    }

    // `not_found` отвечает тем же редиректом, что и успех: разный ответ выдал бы,
    // что такой файл существует у другого клиента (S11)
    return reply.code(303).header('location', '/files').send();
  });
}
