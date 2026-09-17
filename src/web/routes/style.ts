import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { APP_CSS, APP_CSS_VERSION } from '../views/style.js';

/** В адресе допустима только версия: остальные параметры запроса игнорируются. */
const Query = z.object({ v: z.string().optional() });

/**
 * Маршрут, а не отдача каталога: файл ровно один, и ради него незачем брать
 * зависимость, которая умеет отдавать произвольные пути с диска (S18).
 *
 * Сессия здесь не нужна: в стилях нет ничего клиентского.
 */
export function registerStyleRoute(app: FastifyInstance): void {
  app.get('/app.css', (request, reply) => {
    // Адрес с версией меняется вместе с содержимым, поэтому его можно кэшировать
    // навсегда. Адрес без версии сам не обновится при следующем выкате — его
    // браузер держит минуты, а не час
    const query = Query.safeParse(request.query);
    const versioned = query.success && query.data.v === APP_CSS_VERSION;

    return reply
      .type('text/css; charset=utf-8')
      .header(
        'cache-control',
        versioned ? 'public, max-age=31536000, immutable' : 'public, max-age=300',
      )
      .send(APP_CSS);
  });
}
