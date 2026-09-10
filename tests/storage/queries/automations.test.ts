import { describe, it, expect } from 'vitest';
import { createTestDb } from '../helpers.js';
import { createUser } from '../../../src/storage/queries/users.js';
import {
  createAutomation, listAutomations, getAutomation, loadEnabledScenarios, setEnabled,
  updateAutomation, stepCounts,
} from '../../../src/storage/queries/automations.js';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll } from 'vitest';
import { saveFile } from '../../../src/storage/files.js';

// Файлам нужен диск: воронка ссылается на строку в files, а её создаёт saveFile
const FILES_DIR = mkdtempSync(join(tmpdir(), 'automations-files-'));
afterAll(async () => { rmSync(FILES_DIR, { recursive: true, force: true }); });

async function seed() {
  const db = await createTestDb();
  const a = await createUser(db, { email: 'a@x.c', passwordHash: 'h' });
  const b = await createUser(db, { email: 'b@x.c', passwordHash: 'h' });
  const id = await createAutomation(db, a, {
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
  it('сохраняет шаги в заданном порядке', async () => {
    const { db, a, id } = await seed();
    const found = await getAutomation(db, a, id);
    expect(found?.steps.map((s) => s.say)).toEqual(['Какой товар?', 'Оставьте номер', 'Спасибо!']);
  });

  it('собирает Scenario, связывая шаги по порядку', async () => {
    const { db, a } = await seed();
    const [scenario] = await loadEnabledScenarios(db, a);
    expect(scenario?.trigger).toEqual({ type: 'contains', value: 'цена' });
    expect(scenario?.steps).toHaveLength(3);
    expect(scenario?.steps[0]?.next).toBe(scenario?.steps[1]?.id);
    expect(scenario?.steps[2]?.next).toBeUndefined();
  });

  it('выключенная воронка не попадает в исполняемые', async () => {
    const { db, a, id } = await seed();
    await setEnabled(db, a, id, false);
    expect(await loadEnabledScenarios(db, a)).toEqual([]);
  });

  it('S11: чужая воронка не видна в списке', async () => {
    const { db, b } = await seed();
    expect(await listAutomations(db, b)).toEqual([]);
  });

  it('S11: чужую воронку нельзя достать по id', async () => {
    const { db, b, id } = await seed();
    expect(await getAutomation(db, b, id)).toBeUndefined();
  });

  it('S11: чужую воронку нельзя выключить', async () => {
    const { db, a, b, id } = await seed();
    await setEnabled(db, b, id, false);
    expect(await loadEnabledScenarios(db, a)).toHaveLength(1);
  });

  it('S11: чужие воронки не попадают в исполняемые сценарии', async () => {
    const { db, b } = await seed();
    expect(await loadEnabledScenarios(db, b)).toEqual([]);
  });

  it('S6: имя переменной __proto__ отвергается при сборке сценария', async () => {
    const db = await createTestDb();
    const u = await createUser(db, { email: 'c@x.c', passwordHash: 'h' });
    await createAutomation(db, u, {
      name: 'x', triggerType: 'exact', triggerValue: 'x',
      steps: [{ say: 'привет', saveReplyAs: '__proto__' }],
    });
    await expect(loadEnabledScenarios(db, u)).rejects.toThrow();
  });

  it('переносит кнопки шага в сценарий', async () => {
    const db = await createTestDb();
    const u = await createUser(db, { email: 'd@x.c', passwordHash: 'h' });
    await createAutomation(db, u, {
      name: 'y', triggerType: 'exact', triggerValue: 'y',
      steps: [{ say: 'Выберите', buttons: [{ label: 'Да', payload: 'yes' }] }],
    });
    const [scenario] = await loadEnabledScenarios(db, u);
    expect(scenario?.steps[0]?.buttons).toEqual([{ label: 'Да', payload: 'yes' }]);
  });

  it('две воронки одного клиента грузятся без запроса на каждую', async () => {
    const { db, a } = await seed();
    await createAutomation(db, a, {
      name: 'Доставка', triggerType: 'contains', triggerValue: 'доставка',
      steps: [{ say: 'Куда везти?' }],
    });
    const scenarios = await loadEnabledScenarios(db, a);
    expect(scenarios).toHaveLength(2);
    expect(scenarios.map((s) => s.steps.length).sort()).toEqual([1, 3]);
  });
});

describe('файл в шаге воронки', () => {
  it('fileId шага доезжает до собранного Scenario', async () => {
    const db = await createTestDb();
    const userId = await createUser(db, { email: 'f@f.f', passwordHash: 'x' });
    const fileId = await saveFile(
      db, userId,
      { originalName: 'ч.pdf', mimeType: 'application/pdf', bytes: Buffer.from('%PDF-1.7\n') },
      FILES_DIR,
    );
    await createAutomation(db, userId, {
      name: 'Чеклист', triggerType: 'contains', triggerValue: 'чеклист',
      steps: [{ say: 'Держите', fileId }],
    });

    const scenarios = await loadEnabledScenarios(db, userId);
    expect(scenarios[0]?.steps[0]?.file_id).toBe(fileId);
  });

  it('шаг без файла приходит без file_id', async () => {
    const db = await createTestDb();
    const userId = await createUser(db, { email: 'g@g.g', passwordHash: 'x' });
    await createAutomation(db, userId, {
      name: 'Прайс', triggerType: 'contains', triggerValue: 'цена',
      steps: [{ say: 'Ответ' }],
    });

    expect((await loadEnabledScenarios(db, userId))[0]?.steps[0]?.file_id).toBeUndefined();
  });

  it('включённая воронка без шагов пропускается, а не роняет загрузку', async () => {
    const db = await createTestDb();
    const userId = await createUser(db, { email: 'h@h.h', passwordHash: 'x' });
    const withSteps = await createAutomation(db, userId, {
      name: 'С шагами', triggerType: 'contains', triggerValue: 'цена',
      steps: [{ say: 'Ответ' }],
    });
    // Так выглядит только что созданная в конструкторе воронка
    await createAutomation(db, userId, {
      name: 'Черновик', triggerType: 'contains', triggerValue: 'цена', steps: [],
    });

    const scenarios = await loadEnabledScenarios(db, userId);

    expect(scenarios).toHaveLength(1);
    expect(scenarios[0]?.id).toBe(withSteps);
  });
});

describe('правка воронки', () => {
  async function seedTwo() {
    const db = await createTestDb();
    const a = await createUser(db, { email: 'a@a.a', passwordHash: 'x' });
    const b = await createUser(db, { email: 'b@b.b', passwordHash: 'x' });
    const automationA = await createAutomation(db, a, {
      name: 'Было', triggerType: 'contains', triggerValue: 'цена',
      steps: [{ say: 'Шаг 1' }, { say: 'Шаг 2' }, { say: 'Шаг 3' }],
    });
    return { db, a, b, automationA };
  }

  it('меняет название и триггер', async () => {
    const { db, a, automationA } = await seedTwo();

    expect(await updateAutomation(db, a, automationA, {
      name: 'Стало', triggerType: 'exact', triggerValue: 'прайс', steps: [{ say: 'Шаг' }],
    })).toBe(true);

    const found = await getAutomation(db, a, automationA);
    expect(found?.automation.name).toBe('Стало');
    expect(found?.automation.triggerType).toBe('exact');
    expect(found?.automation.triggerValue).toBe('прайс');
  });

  it('заменяет шаги целиком и сохраняет их порядок', async () => {
    const { db, a, automationA } = await seedTwo();

    await updateAutomation(db, a, automationA, {
      name: 'Было', triggerType: 'contains', triggerValue: 'цена',
      steps: [{ say: 'Новый первый' }, { say: 'Новый второй', saveReplyAs: 'name' }],
    });

    const steps = (await getAutomation(db, a, automationA))?.steps ?? [];
    expect(steps.map((s) => s.say)).toEqual(['Новый первый', 'Новый второй']);
    expect(steps.map((s) => s.position)).toEqual([0, 1]);
    expect(steps[1]?.saveReplyAs).toBe('name');
  });

  it('пустой список шагов допустим: это черновик', async () => {
    const { db, a, automationA } = await seedTwo();

    expect(await updateAutomation(db, a, automationA, {
      name: 'Черновик', triggerType: 'contains', triggerValue: 'цена', steps: [],
    })).toBe(true);
    expect((await getAutomation(db, a, automationA))?.steps).toHaveLength(0);
  });

  it('S11: клиент B не правит воронку клиента A', async () => {
    const { db, a, b, automationA } = await seedTwo();

    expect(await updateAutomation(db, b, automationA, {
      name: 'Взломано', triggerType: 'exact', triggerValue: 'моё', steps: [{ say: 'Моё' }],
    })).toBe(false);

    const found = await getAutomation(db, a, automationA);
    expect(found?.automation.name).toBe('Было');
    expect(found?.steps.map((s) => s.say)).toEqual(['Шаг 1', 'Шаг 2', 'Шаг 3']);
  });

  it('считает шаги каждой воронки клиента', async () => {
    const { db, a, b, automationA } = await seedTwo();
    const emptyOne = await createAutomation(db, a, {
      name: 'Черновик', triggerType: 'contains', triggerValue: 'ц', steps: [],
    });
    await createAutomation(db, b, {
      name: 'Чужая', triggerType: 'contains', triggerValue: 'ц', steps: [{ say: 'Чужой' }],
    });

    const counts = await stepCounts(db, a);

    expect(counts.get(automationA)).toBe(3);
    // Воронки без шагов в результате нет вовсе: для представления это «черновик»
    expect(counts.get(emptyOne)).toBeUndefined();
    expect(counts.size).toBe(1);
  });
});
