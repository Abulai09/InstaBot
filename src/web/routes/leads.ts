import type { FastifyInstance } from 'fastify';
import { listLeads } from '../../storage/queries/leads.js';
import { leadsToCsv } from '../csv.js';
import { currentSession, redirectToLogin, type WebDeps } from '../session.js';
import { leadsPage } from '../views/leads.js';

export function registerLeadsRoutes(app: FastifyInstance, deps: WebDeps): void {
  app.get('/leads', (request, reply) => {
    const session = currentSession(deps, request, new Date());
    if (session === undefined) return redirectToLogin(reply);

    // S11: владелец из сессии, фильтр внутри запроса
    const rows = listLeads(deps.db, session.userId);
    return reply
      .header('cache-control', 'no-store')
      .type('text/html; charset=utf-8')
      .send(leadsPage(rows).value);
  });

  app.get('/leads.csv', (request, reply) => {
    const session = currentSession(deps, request, new Date());
    if (session === undefined) return redirectToLogin(reply);

    const rows = listLeads(deps.db, session.userId, 10_000);

    return reply
      .header('cache-control', 'no-store')
      // nosniff нужен именно здесь: без него браузер может решить, что файл —
      // это HTML, и выполнить его содержимое как страницу
      .header('x-content-type-options', 'nosniff')
      .header('content-disposition', 'attachment; filename="leads.csv"')
      .type('text/csv; charset=utf-8')
      // BOM: без него Excel открывает UTF-8 как windows-1251 и кириллица бьётся
      .send(`﻿${leadsToCsv(rows)}`);
  });
}
