import type { FastifyInstance } from 'fastify';
import type { Config } from '../../config.js';
import type { WebhookSource } from '../../adapters/types.js';
import { verifyHandshake, verifySignature } from '../../adapters/instagram/signature.js';
import type { AppDb } from '../../storage/db.js';
import { resolveAccountOwner } from '../../storage/queries/accounts.js';
import { enqueueEvent, markEventSeen } from '../../storage/queries/runtime.js';

interface Deps {
  db: AppDb;
  cfg: Config;
  source: WebhookSource;
}

/** Тело на сотню мегабайт не должно доживать даже до проверки подписи. */
const BODY_LIMIT = 1_048_576;

export function registerWebhookRoutes(app: FastifyInstance, deps: Deps): void {
  /**
   * S1: подпись считается от сырых байт. Разобранное Fastify тело для этого
   * не годится — JSON.stringify(req.body) даёт другую строку.
   */
  app.addContentTypeParser(
    'application/json',
    { parseAs: 'buffer', bodyLimit: BODY_LIMIT },
    (_req, body, done) => { done(null, body); },
  );

  app.get('/webhooks/instagram', (request, reply) => {
    const query = request.query;
    const params = typeof query === 'object' && query !== null
      ? (query as Record<string, unknown>)
      : {};
    const challenge = verifyHandshake(params, deps.cfg.META_VERIFY_TOKEN);

    if (challenge === undefined) return reply.code(403).send();
    return reply.type('text/plain').send(challenge);
  });

  app.post('/webhooks/instagram', async (request, reply) => {
    const raw = Buffer.isBuffer(request.body) ? request.body : Buffer.alloc(0);
    const header = request.headers['x-hub-signature-256'];

    if (!verifySignature(raw, typeof header === 'string' ? header : undefined, deps.cfg.META_APP_SECRET)) {
      // Тело в ответе не нужно: подсказывать, что именно не сошлось, незачем
      return reply.code(403).send();
    }

    let body: unknown;
    try {
      body = JSON.parse(raw.toString('utf8'));
    } catch {
      // Подпись верна, значит это Meta; форму мы просто не поняли. Повтор не поможет
      return reply.code(200).send();
    }

    for (const account of deps.source.parseWebhook(body)) {
      const owner = await resolveAccountOwner(
        deps.db, deps.source.platform, account.externalAccountId,
      );
      // S17: неизвестный аккаунт — молча мимо. Код ответа тот же, что и для своего:
      // разные коды позволяют снаружи перебрать, кто у нас клиент
      if (owner === undefined) continue;

      for (const event of account.events) {
        if (!await markEventSeen(deps.db, owner.userId, event.dedupeKey)) continue;
        await enqueueEvent(deps.db, owner.userId, deps.source.platform, event);
      }
    }

    // Meta отключает медленные приложения: движок и сеть работают отдельным циклом
    return reply.code(200).send();
  });
}
