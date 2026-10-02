import type { FastifyInstance } from 'fastify';
import { dataDeletionPage, privacyPage } from '../views/legal.js';

/**
 * Публичные страницы без сессии: их читает проверяющий Meta и любой человек,
 * которому бот написал. Клиентского в них ничего нет, поэтому кэш общий.
 */
export function registerLegalRoutes(app: FastifyInstance): void {
  app.get('/privacy', (_request, reply) =>
    reply
      .header('cache-control', 'public, max-age=3600')
      .type('text/html; charset=utf-8')
      .send(privacyPage().value));

  app.get('/data-deletion', (_request, reply) =>
    reply
      .header('cache-control', 'public, max-age=3600')
      .type('text/html; charset=utf-8')
      .send(dataDeletionPage().value));
}
