import { describe, it, expect } from 'vitest';
import { parseScenario, buildScenario } from '../../src/core/scenario.js';

const valid = [
  'id: price',
  'trigger:',
  '  type: contains',
  '  value: цена',
  'steps:',
  '  - id: ask_phone',
  '    say: "Оставьте номер"',
  '    save_reply_as: phone',
  '    next: done',
  '  - id: done',
  '    say: "Спасибо!"',
  '    notify_operator: "новая заявка"',
].join('\n');

describe('parseScenario', () => {
  it('разбирает корректный сценарий', () => {
    const s = parseScenario(valid);
    expect(s.id).toBe('price');
    expect(s.trigger.type).toBe('contains');
    expect(s.steps).toHaveLength(2);
  });

  it('S7: отвергает regex как тип триггера', () => {
    expect(() => parseScenario(valid.replace('type: contains', 'type: regex'))).toThrow();
  });

  it('отвергает next на несуществующий шаг', () => {
    expect(() => parseScenario(valid.replace('next: done', 'next: nowhere'))).toThrow(/nowhere/);
  });

  it('S5: не выполняет небезопасные YAML-теги', () => {
    const attack = [
      'id: x',
      'trigger: { type: exact, value: x }',
      'steps:',
      '  - id: a',
      '    say: !!js/function "function(){ return 1 }"',
    ].join('\n');
    expect(() => parseScenario(attack)).toThrow();
  });

  it('S6: отвергает __proto__ как имя переменной', () => {
    expect(() => parseScenario(valid.replace('save_reply_as: phone', 'save_reply_as: __proto__'))).toThrow();
  });
});

describe('buildScenario', () => {
  it('связывает шаги по порядку, последний остаётся без next', () => {
    const s = buildScenario({
      id: 'a1',
      trigger: { type: 'contains', value: 'цена' },
      steps: [
        { id: 's1', say: 'Какой товар?', saveReplyAs: 'product' },
        { id: 's2', say: 'Оставьте номер', saveReplyAs: 'phone' },
        { id: 's3', say: 'Спасибо!' },
      ],
    });
    expect(s.steps[0]?.next).toBe('s2');
    expect(s.steps[1]?.next).toBe('s3');
    expect(s.steps[2]?.next).toBeUndefined();
    expect(s.steps[0]?.save_reply_as).toBe('product');
  });

  it('S7: не пропускает regex как тип триггера', () => {
    expect(() => buildScenario({
      id: 'a1',
      trigger: { type: 'regex', value: '.*' },
      steps: [{ id: 's1', say: 'привет' }],
    })).toThrow();
  });

  it('S6: отвергает __proto__ как имя переменной', () => {
    expect(() => buildScenario({
      id: 'a1',
      trigger: { type: 'exact', value: 'x' },
      steps: [{ id: 's1', say: 'привет', saveReplyAs: '__proto__' }],
    })).toThrow();
  });

  it('отвергает воронку без шагов', () => {
    expect(() => buildScenario({
      id: 'a1',
      trigger: { type: 'exact', value: 'x' },
      steps: [],
    })).toThrow();
  });
});
