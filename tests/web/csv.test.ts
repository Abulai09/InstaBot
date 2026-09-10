import { describe, expect, it } from 'vitest';
import { csvCell, toCsv } from '../../src/web/csv.js';

describe('ячейка CSV', () => {
  it('обычное значение просто берётся в кавычки', async () => {
    expect(csvCell('Абылай')).toBe('"Абылай"');
  });

  it('кавычка внутри удваивается', async () => {
    expect(csvCell('он сказал "да"')).toBe('"он сказал ""да"""');
  });

  it('запятая и перенос строки не ломают строку файла', async () => {
    expect(csvCell('а, б')).toBe('"а, б"');
    expect(csvCell('первая\nвторая')).toBe('"первая\nвторая"');
  });

  it('CSV-инъекция: значение с = обезвреживается', async () => {
    expect(csvCell('=1+1')).toBe(`"'=1+1"`);
  });

  it('CSV-инъекция: +, -, @ и табуляция тоже', async () => {
    expect(csvCell('+79991234567')).toBe(`"'+79991234567"`);
    expect(csvCell('-5')).toBe(`"'-5"`);
    expect(csvCell('@SUM(A1)')).toBe(`"'@SUM(A1)"`);
    expect(csvCell('\tзло')).toBe(`"'\tзло"`);
  });

  it('CSV-инъекция: HYPERLINK не выполнится', async () => {
    expect(csvCell('=HYPERLINK("http://зло","клик")').startsWith(`"'=`)).toBe(true);
  });
});

describe('файл CSV', () => {
  it('строки разделяются CRLF — так ждёт Excel', async () => {
    expect(toCsv([['a', 'b'], ['c', 'd']])).toBe('"a","b"\r\n"c","d"');
  });

  it('пустая таблица даёт пустую строку', async () => {
    expect(toCsv([])).toBe('');
  });
});
