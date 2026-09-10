import { describe, expect, it } from 'vitest';
import { csrfToken, csrfValid } from '../../src/web/csrf.js';

const SECRET = 'a'.repeat(32);

describe('CSRF-токен', () => {
  it('один и тот же для одной сессии', async () => {
    expect(csrfToken('сессия-1', SECRET)).toBe(csrfToken('сессия-1', SECRET));
  });

  it('S15: разный для разных сессий', async () => {
    expect(csrfToken('сессия-1', SECRET)).not.toBe(csrfToken('сессия-2', SECRET));
  });

  it('S15: не выводится без секрета', async () => {
    expect(csrfToken('сессия-1', SECRET)).not.toBe(csrfToken('сессия-1', 'b'.repeat(32)));
  });

  it('свой токен проходит проверку', async () => {
    expect(csrfValid('сессия-1', csrfToken('сессия-1', SECRET), SECRET)).toBe(true);
  });

  it('S15: токен чужой сессии не проходит', async () => {
    expect(csrfValid('сессия-1', csrfToken('сессия-2', SECRET), SECRET)).toBe(false);
  });

  it('S15: отсутствие токена — это отказ, а не пропуск', async () => {
    expect(csrfValid('сессия-1', undefined, SECRET)).toBe(false);
    expect(csrfValid('сессия-1', '', SECRET)).toBe(false);
  });

  it('токен другой длины не роняет сравнение', async () => {
    expect(csrfValid('сессия-1', 'коротко', SECRET)).toBe(false);
  });
});
