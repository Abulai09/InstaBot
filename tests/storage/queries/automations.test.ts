import { describe, it, expect } from 'vitest';
import { createTestDb } from '../helpers.js';
import { createUser } from '../../../src/storage/queries/users.js';
import {
  createAutomation, listAutomations, getAutomation, loadEnabledScenarios, setEnabled,
} from '../../../src/storage/queries/automations.js';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll } from 'vitest';
import { saveFile } from '../../../src/storage/files.js';

// Файлам нужен диск: воронка ссылается на строку в files, а её создаёт saveFile
const FILES_DIR = mkdtempSync(join(tmpdir(), 'automations-files-'));
afterAll(() => { rmSync(FILES_DIR, { recursive: true, force: true }); });

function seed() {
  const db = createTestDb();
  const a = createUser(db, { email: 'a@x.c', passwordHash: 'h' });
  const b = createUser(db, { email: 'b@x.c', passwordHash: 'h' });
  const id = createAutomation(db, a, {
    name: 'Прайс',
    triggerType: 'contains',
    triggerValue: 'цена',
    steps: [
      { say: 'Какой товар?', saveReplyAs: 'product' },
      { say: 'Оставьте номер', saveReplyAs: 'phone' },
      { say: 'Спасибо!' },
    ],
  });
  return { db, a, b, id };
}

describe('воронки', () => {
  it('сохраняет шаги в заданном порядке', () => {
    const { db, a, id } = seed();
    const found = getAutomation(db, a, id);
    expect(found?.steps.map((s) => s.say)).toEqual(['Какой товар?', 'Оставьте номер', 'Спасибо!']);
  });

  it('собирает Scenario, связывая шаги по порядку', () => {
    const { db, a } = seed();
    const [scenario] = loadEnabledScenarios(db, a);
    expect(scenario?.trigger).toEqual({ type: 'contains', value: 'цена' });
    expect(scenario?.steps).toHaveLength(3);
    expect(scenario?.steps[0]?.next).toBe(scenario?.steps[1]?.id);
    expect(scenario?.steps[2]?.next).toBeUndefined();
  });

  it('выключенная воронка не попадает в исполняемые', () => {
    const { db, a, id } = seed();
    setEnabled(db, a, id, false);
    expect(loadEnabledScenarios(db, a)).toEqual([]);
  });

  it('S11: чужая воронка не видна в списке', () => {
    const { db, b } = seed();
    expect(listAutomations(db, b)).toEqual([]);
  });

  it('S11: чужую воронку нельзя достать по id', () => {
    const { db, b, id } = seed();
    expect(getAutomation(db, b, id)).toBeUndefined();
  });

  it('S11: чужую воронку нельзя выключить', () => {
    const { db, a, b, id } = seed();
    setEnabled(db, b, id, false);
    expect(loadEnabledScenarios(db, a)).toHaveLength(1);
  });

  it('S11: чужие воронки не попадают в исполняемые сценарии', () => {
    const { db, b } = seed();
    expect(loadEnabledScenarios(db, b)).toEqual([]);
  });

  it('S6: имя переменной __proto__ отвергается при сборке сценария', () => {
    const db = createTestDb();
    const u = createUser(db, { email: 'c@x.c', passwordHash: 'h' });
    createAutomation(db, u, {
      name: 'x', triggerType: 'exact', triggerValue: 'x',
      steps: [{ say: 'привет', saveReplyAs: '__proto__' }],
    });
    expect(() => loadEnabledScenarios(db, u)).toThrow();
  });

  it('переносит кнопки шага в сценарий', () => {
    const db = createTestDb();
    const u = createUser(db, { email: 'd@x.c', passwordHash: 'h' });
    createAutomation(db, u, {
      name: 'y', triggerType: 'exact', triggerValue: 'y',
      steps: [{ say: 'Выберите', buttons: [{ label: 'Да', payload: 'yes' }] }],
    });
    const [scenario] = loadEnabledScenarios(db, u);
    expect(scenario?.steps[0]?.buttons).toEqual([{ label: 'Да', payload: 'yes' }]);
  });

  it('две воронки одного клиента грузятся без запроса на каждую', () => {
    const { db, a } = seed();
    createAutomation(db, a, {
      name: 'Доставка', triggerType: 'contains', triggerValue: 'доставка',
      steps: [{ say: 'Куда везти?' }],
    });
    const scenarios = loadEnabledScenarios(db, a);
    expect(scenarios).toHaveLength(2);
    expect(scenarios.map((s) => s.steps.length).sort()).toEqual([1, 3]);
  });
});

describe('файл в шаге воронки', () => {
  it('fileId шага доезжает до собранного Scenario', () => {
    const db = createTestDb();
    const userId = createUser(db, { email: 'f@f.f', passwordHash: 'x' });
    const fileId = saveFile(
      db, userId,
      { originalName: 'ч.pdf', mimeType: 'application/pdf', bytes: Buffer.from('%PDF-1.7\n') },
      FILES_DIR,
    );
    createAutomation(db, userId, {
      name: 'Чеклист', triggerType: 'contains', triggerValue: 'чеклист',
      steps: [{ say: 'Держите', fileId }],
    });

    const scenarios = loadEnabledScenarios(db, userId);
    expect(scenarios[0]?.steps[0]?.file_id).toBe(fileId);
  });

  it('шаг без файла приходит без file_id', () => {
    const db = createTestDb();
    const userId = createUser(db, { email: 'g@g.g', passwordHash: 'x' });
    createAutomation(db, userId, {
      name: 'Прайс', triggerType: 'contains', triggerValue: 'цена',
      steps: [{ say: 'Ответ' }],
    });

    expect(loadEnabledScenarios(db, userId)[0]?.steps[0]?.file_id).toBeUndefined();
  });
});
