import { describe, expect, it } from 'vitest';
import { hashPassword, verifyPassword } from '../../src/web/password.js';

describe('пароли', () => {
  it('S13: хэш не содержит пароля', async () => {
    const stored = await hashPassword('очень-секретный-пароль');
    expect(stored).not.toContain('очень-секретный-пароль');
    expect(stored.startsWith('$argon2id$')).toBe(true);
  });

  it('S13: два хэша одного пароля различаются — соль случайная', async () => {
    expect(await hashPassword('один')).not.toBe(await hashPassword('один'));
  });

  it('верный пароль проходит', async () => {
    const stored = await hashPassword('верный');
    expect(await verifyPassword(stored, 'верный')).toBe(true);
  });

  it('неверный пароль не проходит', async () => {
    const stored = await hashPassword('верный');
    expect(await verifyPassword(stored, 'неверный')).toBe(false);
  });

  it('S13: несуществующий пользователь — тоже false, а не исключение', async () => {
    expect(await verifyPassword(undefined, 'любой')).toBe(false);
  });

  it('S13: битый хэш в БД не роняет вход', async () => {
    expect(await verifyPassword('не-хэш-вовсе', 'любой')).toBe(false);
  });
});
