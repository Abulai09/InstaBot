import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Config } from '../../config.js';
import { parseTheme, safeBackPath, themeCookie } from '../theme.js';

/** S14: из формы читаются ровно два поля, и оба проверяются. */
const ThemeForm = z.object({ theme: z.unknown(), back: z.unknown() });

/**
 * Смена темы — POST, а не GET со ссылкой: GET обязан оставаться безопасным,
 * а этот запрос меняет состояние браузера.
 *
 * CSRF-токена здесь нет по той же причине, что и на `/logout`: подделанная
 * смена темы ничего не стоит владельцу, а защищают `SameSite=Lax`
 * и `form-action 'self'` в CSP. Токен потребовал бы сессии, а тему выбирают
 * в том числе на страницах, где её нет.
 *
 * Сессия не нужна и не проверяется: тема — настройка браузера, не данные
 * клиента, и подставить чужую нельзя, потому что подставлять некуда.
 */
export function registerThemeRoute(app: FastifyInstance, cfg: Config): void {
  app.post('/theme', (request, reply) => {
    const form = ThemeForm.safeParse(request.body);
    if (!form.success) return reply.code(400).send();

    const theme = parseTheme(form.data.theme);
    if (theme === undefined) return reply.code(400).send();

    return reply
      .header('set-cookie', themeCookie(theme, cfg.NODE_ENV === 'production'))
      .code(303)
      .header('location', safeBackPath(form.data.back))
      .send();
  });
}
