import { describe, it, expect } from 'vitest';
import { ReplyThrottle } from '../../src/core/throttle.js';

const t0 = new Date('2026-08-26T10:00:00Z');
const plus = (sec: number) => new Date(t0.getTime() + sec * 1000);

describe('ReplyThrottle', () => {
  it('пропускает до лимита', async () => {
    const th = new ReplyThrottle(3);
    expect(th.allow('u1', t0)).toBe(true);
    expect(th.allow('u1', t0)).toBe(true);
    expect(th.allow('u1', t0)).toBe(true);
    expect(th.allow('u1', t0)).toBe(false);
  });

  it('считает лимит отдельно для каждого контакта', async () => {
    const th = new ReplyThrottle(1);
    expect(th.allow('u1', t0)).toBe(true);
    expect(th.allow('u2', t0)).toBe(true);
    expect(th.allow('u1', t0)).toBe(false);
  });

  it('освобождает лимит через минуту', async () => {
    const th = new ReplyThrottle(1);
    expect(th.allow('u1', t0)).toBe(true);
    expect(th.allow('u1', plus(30))).toBe(false);
    expect(th.allow('u1', plus(61))).toBe(true);
  });

  it('окно задаётся параметром: вход считают за 15 минут, а не за минуту', async () => {
    const throttle = new ReplyThrottle(2, 15 * 60_000);
    const start = new Date('2026-09-01T12:00:00Z');

    expect(throttle.allow('вход:a@a.a', start)).toBe(true);
    expect(throttle.allow('вход:a@a.a', start)).toBe(true);
    expect(throttle.allow('вход:a@a.a', start)).toBe(false);

    // Через 10 минут окно ещё не закрылось
    expect(throttle.allow('вход:a@a.a', new Date(start.getTime() + 10 * 60_000))).toBe(false);
    // Через 16 — закрылось
    expect(throttle.allow('вход:a@a.a', new Date(start.getTime() + 16 * 60_000))).toBe(true);
  });
});
