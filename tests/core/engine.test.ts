import { describe, it, expect } from 'vitest';
import { step } from '../../src/core/engine.js';
import { parseScenario } from '../../src/core/scenario.js';
import { emptyState, type IncomingEvent } from '../../src/core/types.js';

const scenario = parseScenario([
  'id: price',
  'trigger: { type: contains, value: цена }',
  'steps:',
  '  - id: ask_phone',
  '    say: "Оставьте номер"',
  '    save_reply_as: phone',
  '    next: done',
  '  - id: done',
  '    say: "Спасибо!"',
  '    notify_operator: "новая заявка"',
].join('\n'));

function evt(text: string): IncomingEvent {
  return {
    platform: 'instagram',
    kind: 'direct_message',
    externalUserId: 'u1',
    externalThreadId: 't1',
    externalCommentId: null,
    text,
    payload: null,
    dedupeKey: `k-${text}`,
    receivedAt: new Date('2026-08-26T10:00:00Z'),
  };
}

describe('step', () => {
  it('запускает сценарий по триггеру и отдаёт первый шаг', () => {
    const r = step([scenario], emptyState(), evt('какая цена?'));
    expect(r.state.stepId).toBe('ask_phone');
    expect(r.actions).toEqual([{ type: 'send_text', text: 'Оставьте номер' }]);
  });

  it('молчит, если ни один триггер не сработал', () => {
    const r = step([scenario], emptyState(), evt('добрый день'));
    expect(r.state.stepId).toBeNull();
    expect(r.actions).toEqual([]);
  });

  it('сохраняет ответ пользователя в контекст', () => {
    const started = step([scenario], emptyState(), evt('цена'));
    const r = step([scenario], started.state, evt('+7 999 111 22 33'));
    expect(r.state.context.get('phone')).toBe('+7 999 111 22 33');
    // шаг done не имеет next — значит воронка завершена, stepId сбрасывается
    expect(r.state.stepId).toBeNull();
  });

  it('на последнем шаге зовёт оператора и завершает диалог', () => {
    const s1 = step([scenario], emptyState(), evt('цена'));
    const s2 = step([scenario], s1.state, evt('+7 999 111 22 33'));
    expect(s2.actions).toEqual([
      { type: 'send_text', text: 'Спасибо!' },
      { type: 'notify_operator', reason: 'новая заявка', context: { phone: '+7 999 111 22 33' } },
    ]);
    expect(s2.state.stepId).toBeNull();
  });

  it('не мутирует переданное состояние', () => {
    const before = emptyState();
    step([scenario], before, evt('цена'));
    expect(before.stepId).toBeNull();
    expect(before.context.size).toBe(0);
  });

  it('на комментарий отвечает комментарием, а не директом', () => {
    const commentEvent: IncomingEvent = { ...evt('цена'), kind: 'comment', externalCommentId: 'c1' };
    const r = step([scenario], emptyState(), commentEvent);
    expect(r.actions).toEqual([{ type: 'reply_comment', text: 'Оставьте номер' }]);
  });
});

describe('шаг с файлом', () => {
  const withFile = parseScenario([
    'id: checklist',
    'trigger: { type: contains, value: чеклист }',
    'steps:',
    '  - id: give',
    '    say: "Держите чеклист"',
    '    file_id: f-123',
  ].join('\n'));

  it('порождает два действия: сначала текст, потом файл', () => {
    const r = step([withFile], emptyState(), evt('хочу чеклист'));
    // Одно сообщение Instagram несёт либо текст, либо вложение — значит их два
    expect(r.actions).toEqual([
      { type: 'send_text', text: 'Держите чеклист' },
      { type: 'send_file', fileId: 'f-123' },
    ]);
  });

  it('на комментарий текст уходит комментарием, а файл всё равно отдельным действием', () => {
    const commentEvent: IncomingEvent = { ...evt('чеклист'), kind: 'comment', externalCommentId: 'c1' };
    const r = step([withFile], emptyState(), commentEvent);
    expect(r.actions).toEqual([
      { type: 'reply_comment', text: 'Держите чеклист' },
      { type: 'send_file', fileId: 'f-123' },
    ]);
  });

  it('шаг без файла действия send_file не порождает', () => {
    const r = step([scenario], emptyState(), evt('цена'));
    expect(r.actions.some((a) => a.type === 'send_file')).toBe(false);
  });
});
