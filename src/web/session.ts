import type { FastifyReply, FastifyRequest } from 'fastify';
import type { Config } from '../config.js';
import type { ReplyThrottle } from '../core/throttle.js';
import type { AppDb } from '../storage/db.js';
import { loadSession, touchSession } from '../storage/queries/sessions.js';
import { readCookie, SESSION_COOKIE } from './http.js';

export interface WebDeps {
  db: AppDb;
  cfg: Config;
  throttle: ReplyThrottle;
}

export interface Session {
  token: string;
  userId: string;
  role: 'client' | 'owner';
}

export function ttlMs(cfg: Config): number {
  return cfg.SESSION_TTL_DAYS * 86_400_000;
}

/**
 * Единственный источник `userId` для всего кабинета. Из тела запроса владелец
 * не берётся нигде и никогда (S14) — этой функции достаточно, чтобы правило
 * держалось само собой.
 *
 * Продление здесь же: сессия скользящая, и каждый запрос отодвигает срок.
 */
export async function currentSession(
  deps: WebDeps, request: FastifyRequest, now: Date,
): Promise<Session | undefined> {
  const cookieHeader = request.headers.cookie;
  const token = readCookie(typeof cookieHeader === 'string' ? cookieHeader : undefined, SESSION_COOKIE);
  if (token === undefined) return undefined;

  const found = await loadSession(deps.db, token, now);
  if (found === undefined) return undefined;

  await touchSession(deps.db, token, now, ttlMs(deps.cfg));
  return { token, userId: found.userId, role: found.role };
}

export function redirectToLogin(reply: FastifyReply): FastifyReply {
  return reply.code(303).header('location', '/login').send();
}
