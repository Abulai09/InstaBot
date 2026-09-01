import { describe, it, expect } from 'vitest';
import { encryptSecret, decryptSecret } from '../../src/storage/crypto.js';

const key = 'a'.repeat(64);
const other = 'b'.repeat(64);

describe('шифрование секретов', () => {
  it('расшифровывает то же, что зашифровало', () => {
    const packed = encryptSecret('EAAG-token-123', key);
    expect(decryptSecret(packed, key)).toBe('EAAG-token-123');
  });

  it('S4: два шифрования одного текста дают разный результат', () => {
    expect(encryptSecret('one', key)).not.toBe(encryptSecret('one', key));
  });

  it('S4: подменённый шифротекст не расшифровывается', () => {
    const raw = Buffer.from(encryptSecret('one', key), 'base64');
    const last = raw[raw.length - 1];
    if (last === undefined) throw new Error('пустой шифротекст');
    raw[raw.length - 1] = last ^ 0xff;
    expect(() => decryptSecret(raw.toString('base64'), key)).toThrow();
  });

  it('S4: чужой ключ не расшифровывает', () => {
    const packed = encryptSecret('one', key);
    expect(() => decryptSecret(packed, other)).toThrow();
  });

  it('отвергает ключ неверной длины', () => {
    expect(() => encryptSecret('one', 'abcd')).toThrow(/ключ/i);
  });

  it('отвергает обрезанный шифротекст', () => {
    expect(() => decryptSecret('AAAA', key)).toThrow();
  });

  it('S10: сообщение об ошибке не содержит сам ключ', () => {
    try {
      encryptSecret('one', 'abcd');
      throw new Error('должно было упасть');
    } catch (e) {
      expect((e as Error).message).not.toContain('abcd');
    }
  });
});
