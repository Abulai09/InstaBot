import { describe, it, expect } from 'vitest';
import { ReplyThrottle } from '../../src/core/throttle.js';

const t0 = new Date('2026-08-26T10:00:00Z');
const plus = (sec: number) => new Date(t0.getTime() + sec * 1000);

describe('ReplyThrottle', () => {
  it('пропускает до лимита', () => {
    const th = new ReplyThrottle(3);
    expect(th.allow('u1', t0)).toBe(true);
    expect(th.allow('u1', t0)).toBe(true);
    expect(th.allow('u1', t0)).toBe(true);
    expect(th.allow('u1', t0)).toBe(false);
  });

  it('считает лимит отдельно для каждого контакта', () => {
    const th = new ReplyThrottle(1);
    expect(th.allow('u1', t0)).toBe(true);
    expect(th.allow('u2', t0)).toBe(true);
    expect(th.allow('u1', t0)).toBe(false);
  });

  it('освобождает лимит через минуту', () => {
    const th = new ReplyThrottle(1);
    expect(th.allow('u1', t0)).toBe(true);
    expect(th.allow('u1', plus(30))).toBe(false);
    expect(th.allow('u1', plus(61))).toBe(true);
  });
});
