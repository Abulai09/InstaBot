import type { FastifyInstance } from 'fastify';
import { APP_CSS } from '../views/style.js';

/**
 * Маршрут, а не отдача каталога: файл ровно один, и ради него незачем брать
 * зависимость, которая умеет отдавать произвольные пути с диска (S18).
 *
 * Сессия здесь не нужна: в стилях нет ничего клиентского.
 */
export function registerStyleRoute(app: FastifyInstance): void {
  app.get('/app.css', (_request, reply) => reply
    .type('text/css; charset=utf-8')
    .header('cache-control', 'public, max-age=3600')
    .send(APP_CSS));
}
