import { describe, it, expect } from 'vitest';
import { matches } from '../../src/core/matcher.js';
import type { Trigger } from '../../src/core/scenario.js';

const contains: Trigger = { type: 'contains', value: 'цена' };
const exact: Trigger = { type: 'exact', value: 'цена' };
const starts: Trigger = { type: 'starts_with', value: 'привет' };

describe('matches', () => {
  it('contains ловит слово внутри фразы', async () => {
    expect(matches(contains, 'какая цена?')).toBe(true);
  });

  it('игнорирует регистр, включая кириллицу', async () => {
    expect(matches(contains, 'КАКАЯ ЦЕНА')).toBe(true);
    expect(matches(exact, 'Цена')).toBe(true);
  });

  it('exact терпит пробелы и пунктуацию вокруг', async () => {
    expect(matches(exact, '  цена?  ')).toBe(true);
    expect(matches(exact, 'цена!!!')).toBe(true);
  });

  it('exact не срабатывает на другую фразу', async () => {
    expect(matches(exact, 'цена товара')).toBe(false);
  });

  it('starts_with проверяет начало', async () => {
    expect(matches(starts, 'Привет, есть в наличии?')).toBe(true);
    expect(matches(starts, 'Скажите, привет всем')).toBe(false);
  });

  it('пустой ввод не матчится', async () => {
    expect(matches(contains, '')).toBe(false);
    expect(matches(contains, '   ')).toBe(false);
  });
});
