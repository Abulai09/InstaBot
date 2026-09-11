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

  /**
   * Ключ приходит снаружи: у входа это присланная почта, у бота — идентификатор
   * комментатора. Процесс живёт месяцами, и без уборки каждый когда-либо
   * увиденный ключ оставался бы в памяти навсегда.
   */
  it('забывает ключи, чьё окно давно закрылось', async () => {
    const throttle = new ReplyThrottle(5, 60_000);

    for (let i = 0; i < 20_000; i += 1) throttle.allow(`почта-${i}@a.a`, t0);

    // Час спустя ни одно из тех окон не действует — держать их незачем
    throttle.allow('свежий', plus(3600));

    expect(throttle.tracked).toBeLessThan(1000);
  });

  it('уборка не трогает ключи внутри действующего окна', async () => {
    const throttle = new ReplyThrottle(1, 60_000);

    for (let i = 0; i < 20_000; i += 1) throttle.allow(`ключ-${i}`, t0);

    // Тот же момент времени: окна живы, лимит по каждому ключу уже исчерпан
    expect(throttle.allow('ключ-0', t0)).toBe(false);
    expect(throttle.allow('ключ-19999', t0)).toBe(false);
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
