import Fastify from 'fastify';
import { describe, expect, it } from 'vitest';
import {
  clearedCookie, readCookie, registerFormParser, registerSecurityHeaders, sessionCookie,
} from '../../src/web/http.js';

const DAY = 86_400_000;

describe('cookie', () => {
  it('читает нужную cookie из заголовка с несколькими', () => {
    expect(readCookie('theme=dark; sid=abc123; lang=ru', 'sid')).toBe('abc123');
  });

  it('отсутствующая cookie — undefined, а не пустая строка', () => {
    expect(readCookie('theme=dark', 'sid')).toBeUndefined();
    expect(readCookie(undefined, 'sid')).toBeUndefined();
  });

  it('не путает cookie с похожим именем', () => {
    expect(readCookie('notsid=нет; sid=да', 'sid')).toBe('да');
  });

  it('S15: cookie сессии HttpOnly и SameSite=Lax', () => {
    const value = sessionCookie('токен', 7 * DAY, false);
    expect(value).toContain('HttpOnly');
    expect(value).toContain('SameSite=Lax');
    expect(value).toContain('Path=/');
    expect(value).toContain('Max-Age=604800');
  });

  it('S15: Secure появляется только в проде', () => {
    expect(sessionCookie('токен', DAY, true)).toContain('Secure');
    expect(sessionCookie('токен', DAY, false)).not.toContain('Secure');
  });

  it('выход обнуляет cookie', () => {
    expect(clearedCookie()).toContain('Max-Age=0');
  });
});

describe('тело формы', () => {
  it('разбирается в объект', async () => {
    const app = Fastify();
    registerFormParser(app);
    app.post('/echo', (request, reply) => reply.send(request.body));

    const res = await app.inject({
      method: 'POST', url: '/echo',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      payload: 'email=a%40a.a&password=%D0%BF%D0%B0%D1%80%D0%BE%D0%BB%D1%8C',
    });

    expect(res.json()).toEqual({ email: 'a@a.a', password: 'пароль' });
  });

  it('S6: __proto__ в теле формы не загрязняет прототип', async () => {
    const app = Fastify();
    registerFormParser(app);
    app.post('/echo', (request, reply) => reply.send({ ok: true }));

    await app.inject({
      method: 'POST', url: '/echo',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      payload: '__proto__[admin]=true',
    });

    expect(Object.prototype).not.toHaveProperty('admin');
  });
});

describe('заголовки безопасности', () => {
  it('S22: стоят на любом ответе', async () => {
    const app = Fastify();
    registerSecurityHeaders(app, false);
    app.get('/', (_request, reply) => reply.send('ок'));

    const res = await app.inject({ method: 'GET', url: '/' });

    expect(res.headers['x-frame-options']).toBe('DENY');
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['referrer-policy']).toBe('same-origin');
    expect(String(res.headers['content-security-policy'])).not.toContain('unsafe-inline');
  });

  it('S22: HSTS только в проде', async () => {
    const dev = Fastify();
    registerSecurityHeaders(dev, false);
    dev.get('/', (_request, reply) => reply.send('ок'));

    const prod = Fastify();
    registerSecurityHeaders(prod, true);
    prod.get('/', (_request, reply) => reply.send('ок'));

    expect((await dev.inject({ method: 'GET', url: '/' })).headers['strict-transport-security'])
      .toBeUndefined();
    expect((await prod.inject({ method: 'GET', url: '/' })).headers['strict-transport-security'])
      .toContain('max-age=');
  });
});
