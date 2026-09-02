import { z } from 'zod';
import type { NewStep } from '../storage/queries/automations.js';

export const MAX_STEPS = 20;
export const MAX_BUTTONS = 3;
const MAX_NAME = 100;
const MAX_TRIGGER = 100;
const MAX_SAY = 1000;
const MAX_LABEL = 20;

/** Та же форма имени, что у `VariableName` в `core/scenario.ts`. */
const VARIABLE = /^[a-z][a-z0-9_]*$/i;

/**
 * Типы триггеров перечислены, а не приняты строкой: regex в триггерах запрещён
 * (ReDoS, S7), и запрет держится схемой, а не памятью того, кто пишет форму.
 */
const Head = z.object({
  name: z.string().trim().min(1).max(MAX_NAME),
  trigger_type: z.enum(['exact', 'contains', 'starts_with']),
  trigger_value: z.string().trim().min(1).max(MAX_TRIGGER),
});

export interface ConstructorForm {
  name: string;
  triggerType: 'exact' | 'contains' | 'starts_with';
  triggerValue: string;
  steps: NewStep[];
}

export type FormResult =
  | { ok: true; form: ConstructorForm }
  | { ok: false; error: string };

function text(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

/**
 * Клиент вводит только подпись кнопки, по одной на строку. Payload генерируется:
 * это внутренний идентификатор для платформы, придумывать его клиенту незачем,
 * а два одинаковых payload сломали бы разбор нажатия.
 *
 * Подпись обрезается: длинная не помещается в кнопку Instagram. Значение
 * ограничения — наше, платформенное уточняется при первой живой отправке.
 */
function parseButtons(raw: string, stepIndex: number): { label: string; payload: string }[] {
  return raw
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((label, i) => ({
      label: label.slice(0, MAX_LABEL),
      payload: `step_${stepIndex}_btn_${i}`,
    }));
}

/**
 * Индексы шагов приходят в именах полей: `say_0`, `say_1`. Повторяющиеся имена
 * не годятся — разборщик форм (`Object.fromEntries` над `URLSearchParams`)
 * оставляет от них только последнее значение, и все шаги, кроме последнего,
 * молча пропали бы.
 */
export function parseConstructorForm(body: unknown): FormResult {
  if (typeof body !== 'object' || body === null) {
    return { ok: false, error: 'Форма не разобрана' };
  }
  const fields: Record<string, unknown> = { ...body };

  const head = Head.safeParse(fields);
  if (!head.success) {
    return { ok: false, error: 'Заполните название и слово-триггер' };
  }

  const indexes = Object.keys(fields)
    .map((key) => /^say_(\d+)$/.exec(key))
    .filter((match): match is RegExpExecArray => match !== null)
    .map((match) => Number(match[1]))
    // Числовая сортировка, а не алфавитная: иначе шаг 10 встанет между 1 и 2
    .sort((a, b) => a - b);

  if (indexes.length > MAX_STEPS) {
    return { ok: false, error: `Шагов в одной воронке не больше ${MAX_STEPS}` };
  }

  const steps: NewStep[] = [];
  for (const index of indexes) {
    const say = text(fields[`say_${index}`]).trim();
    // Пустой шаг не отбрасывается: отбрасывание сдвинуло бы нумерацию,
    // и «вниз» у третьего шага применилось бы ко второму
    if (say.length === 0) {
      return { ok: false, error: 'Текст шага не может быть пустым' };
    }
    if (say.length > MAX_SAY) {
      return { ok: false, error: `Текст шага длиннее ${MAX_SAY} символов` };
    }

    const reply = text(fields[`reply_${index}`]).trim();
    if (reply.length > 0 && !VARIABLE.test(reply)) {
      return {
        ok: false,
        error: 'Имя переменной: латинская буква, дальше буквы, цифры и подчёркивание',
      };
    }

    const buttons = parseButtons(text(fields[`buttons_${index}`]), index);
    if (buttons.length > MAX_BUTTONS) {
      return { ok: false, error: `Кнопок в шаге не больше ${MAX_BUTTONS}` };
    }

    const fileId = text(fields[`file_${index}`]).trim();

    steps.push({
      say,
      ...(reply.length === 0 ? {} : { saveReplyAs: reply }),
      ...(fileId.length === 0 ? {} : { fileId }),
      ...(buttons.length === 0 ? {} : { buttons }),
    });
  }

  return {
    ok: true,
    form: {
      name: head.data.name,
      triggerType: head.data.trigger_type,
      triggerValue: head.data.trigger_value,
      steps,
    },
  };
}
