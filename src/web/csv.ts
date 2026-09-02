import type { LeadRow } from '../storage/queries/leads.js';
import { leadData } from '../storage/queries/leads.js';

/** Символы, с которых Excel и LibreOffice начинают считать ячейку формулой. */
const FORMULA_START = ['=', '+', '-', '@', '\t', '\r'];

/**
 * Ответ человека в директе он пишет сам, а выгрузку открывает клиент сервиса
 * у себя на компьютере. Без апострофа значение `=HYPERLINK("http://зло")`
 * выполнится при открытии файла и уведёт данные наружу.
 *
 * Кавычки ставятся всегда: так запятая, перенос строки и кавычка внутри
 * значения не ломают структуру файла и не требуют отдельной ветки.
 */
export function csvCell(value: string): string {
  const safe = FORMULA_START.some((c) => value.startsWith(c)) ? `'${value}` : value;
  return `"${safe.replaceAll('"', '""')}"`;
}

/** CRLF, а не LF: этого разделителя ждёт Excel по RFC 4180. */
export function toCsv(rows: string[][]): string {
  return rows.map((row) => row.map(csvCell).join(',')).join('\r\n');
}

/**
 * Колонки собранных ответов — объединение ключей всех заявок, отсортированное:
 * у разных воронок разные поля, а файл должен быть один и предсказуемый.
 */
export function leadsToCsv(rows: LeadRow[]): string {
  const parsed = rows.map((row) => ({ row, data: leadData(row) }));

  const keys = [...new Set(parsed.flatMap(({ data }) => [...data.keys()]))].sort();
  const header = ['Дата', 'Платформа', 'Контакт', ...keys];

  const body = parsed.map(({ row, data }) => [
    row.createdAt.toISOString(),
    row.platform,
    row.externalUserId,
    ...keys.map((key) => data.get(key) ?? ''),
  ]);

  return toCsv([header, ...body]);
}
