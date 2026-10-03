import { describe, it, expect } from 'vitest';
import { step } from '../../src/core/engine.js';
import type { Scenario } from '../../src/core/scenario.js';
import { emptyState, type IncomingEvent } from '../../src/core/types.js';

const scenario: Scenario = {
  id: 'price',
  trigger: { type: 'contains', value: 'цена' },
  steps: [
    { id: 'ask_phone', say: 'Оставьте номер', save_reply_as: 'phone', next: 'done' },
    { id: 'done', say: 'Спасибо!', notify_operator: 'новая заявка' },
  ],
};

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
  it('запускает сценарий по триггеру и отдаёт первый шаг', async () => {
    const r = step([scenario], emptyState(), evt('какая цена?'));
    expect(r.state.stepId).toBe('ask_phone');
    expect(r.actions).toEqual([{ type: 'send_text', text: 'Оставьте номер' }]);
  });

  it('молчит, если ни один триггер не сработал', async () => {
    const r = step([scenario], emptyState(), evt('добрый день'));
    expect(r.state.stepId).toBeNull();
    expect(r.actions).toEqual([]);
  });

  it('сохраняет ответ пользователя в контекст', async () => {
    const started = step([scenario], emptyState(), evt('цена'));
    const r = step([scenario], started.state, evt('+7 999 111 22 33'));
    expect(r.state.context.get('phone')).toBe('+7 999 111 22 33');
    // шаг done не имеет next — значит воронка завершена, stepId сбрасывается
    expect(r.state.stepId).toBeNull();
  });

  it('на последнем шаге зовёт оператора и завершает диалог', async () => {
    const s1 = step([scenario], emptyState(), evt('цена'));
    const s2 = step([scenario], s1.state, evt('+7 999 111 22 33'));
    expect(s2.actions).toEqual([
      { type: 'send_text', text: 'Спасибо!' },
      { type: 'notify_operator', reason: 'новая заявка', context: { phone: '+7 999 111 22 33' } },
    ]);
    expect(s2.state.stepId).toBeNull();
  });

  it('не мутирует переданное состояние', async () => {
    const before = emptyState();
    step([scenario], before, evt('цена'));
    expect(before.stepId).toBeNull();
    expect(before.context.size).toBe(0);
  });

});

describe('комментарий: публичный ответ, цепочка в директе', () => {
  const withReply: Scenario = { ...scenario, comment_reply: 'Отправили в директ' };

  function comment(text: string): IncomingEvent {
    return { ...evt(text), kind: 'comment', externalCommentId: 'c1' };
  }

  it('отвечает под комментарием и шлёт первый шаг личным сообщением', async () => {
    const r = step([withReply], emptyState(), comment('цена'));
    expect(r.actions).toEqual([
      { type: 'reply_comment', text: 'Отправили в директ' },
      { type: 'dm_the_commenter', text: 'Оставьте номер' },
    ]);
    expect(r.state.stepId).toBe('ask_phone');
  });

  it('без текста ответа под комментарием молчит публично, но пишет в директ', async () => {
    const r = step([scenario], emptyState(), comment('цена'));
    expect(r.actions).toEqual([{ type: 'dm_the_commenter', text: 'Оставьте номер' }]);
  });

  it('текст шага никогда не уходит публичным комментарием', async () => {
    const r = step([withReply], emptyState(), comment('цена'));
    expect(r.actions.filter((a) => a.type === 'reply_comment'))
      .toEqual([{ type: 'reply_comment', text: 'Отправили в директ' }]);
  });

  it('кнопки первого шага едут в личном сообщении', async () => {
    const buttons = [{ label: 'PDF алу', payload: 'pdf' }];
    const withButtons: Scenario = {
      ...withReply,
      steps: [{ id: 'hello', say: 'Нажмите кнопку', buttons, next: 'give' }, { id: 'give', say: 'Держите' }],
    };
    const r = step([withButtons], emptyState(), comment('цена'));
    expect(r.actions).toContainEqual({ type: 'dm_the_commenter', text: 'Нажмите кнопку', buttons });
  });

  it('повторный комментарий посреди диалога запускает воронку заново, а не двигает её', async () => {
    const started = step([withReply], emptyState(), evt('цена'));
    const r = step([withReply], started.state, comment('цена'));
    expect(r.actions).toEqual([
      { type: 'reply_comment', text: 'Отправили в директ' },
      { type: 'dm_the_commenter', text: 'Оставьте номер' },
    ]);
    expect(r.state.stepId).toBe('ask_phone');
    // текст комментария — не ответ на вопрос шага
    expect(r.state.context.has('phone')).toBe(false);
  });

  it('посторонний комментарий посреди диалога ничего не шлёт и диалог не сбрасывает', async () => {
    const started = step([withReply], emptyState(), evt('цена'));
    const r = step([withReply], started.state, comment('классный пост'));
    expect(r.actions).toEqual([]);
    expect(r.state.stepId).toBe('ask_phone');
  });
});

describe('шаг с файлом', () => {
  const withFile: Scenario = {
    id: 'checklist',
    trigger: { type: 'contains', value: 'чеклист' },
    steps: [{ id: 'give', say: 'Держите чеклист', file_id: 'f-123' }],
  };

  it('порождает два действия: сначала текст, потом файл', async () => {
    const r = step([withFile], emptyState(), evt('хочу чеклист'));
    // Одно сообщение Instagram несёт либо текст, либо вложение — значит их два
    expect(r.actions).toEqual([
      { type: 'send_text', text: 'Держите чеклист' },
      { type: 'send_file', fileId: 'f-123' },
    ]);
  });

  it('на комментарий файл первого шага не уходит: до ответа человека разрешено одно сообщение', async () => {
    const commentEvent: IncomingEvent = { ...evt('чеклист'), kind: 'comment', externalCommentId: 'c1' };
    const r = step([withFile], emptyState(), commentEvent);
    expect(r.actions).toEqual([{ type: 'dm_the_commenter', text: 'Держите чеклист' }]);
  });

  it('шаг без файла действия send_file не порождает', async () => {
    const r = step([scenario], emptyState(), evt('цена'));
    expect(r.actions.some((a) => a.type === 'send_file')).toBe(false);
  });
});
