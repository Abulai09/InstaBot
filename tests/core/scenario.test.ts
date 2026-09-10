import { describe, it, expect } from 'vitest';
import { buildScenario } from '../../src/core/scenario.js';

describe('buildScenario', () => {
  it('связывает шаги по порядку, последний остаётся без next', async () => {
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

  it('S7: не пропускает regex как тип триггера', async () => {
    expect(() => buildScenario({
      id: 'a1',
      trigger: { type: 'regex', value: '.*' },
      steps: [{ id: 's1', say: 'привет' }],
    })).toThrow();
  });

  it('S6: отвергает __proto__ как имя переменной', async () => {
    expect(() => buildScenario({
      id: 'a1',
      trigger: { type: 'exact', value: 'x' },
      steps: [{ id: 's1', say: 'привет', saveReplyAs: '__proto__' }],
    })).toThrow();
  });

  it('отвергает воронку без шагов', async () => {
    expect(() => buildScenario({
      id: 'a1',
      trigger: { type: 'exact', value: 'x' },
      steps: [],
    })).toThrow();
  });
});

describe('buildScenario и файлы', () => {
  it('переносит fileId шага в собранный сценарий', async () => {
    const built = buildScenario({
      id: 'a1',
      trigger: { type: 'contains', value: 'чеклист' },
      steps: [{ id: 's1', say: 'Держите', fileId: 'f-123' }],
    });
    expect(built.steps[0]?.file_id).toBe('f-123');
  });

  it('шаг без файла остаётся без file_id, а не с null', async () => {
    const built = buildScenario({
      id: 'a1',
      trigger: { type: 'contains', value: 'цена' },
      steps: [{ id: 's1', say: 'Держите', fileId: null }],
    });
    expect(built.steps[0]?.file_id).toBeUndefined();
  });

  it('отвергает пустой fileId: ссылка на файл либо есть, либо её нет', async () => {
    expect(() => buildScenario({
      id: 'a1',
      trigger: { type: 'contains', value: 'цена' },
      steps: [{ id: 's1', say: 'Держите', fileId: '' }],
    })).toThrow();
  });
});
