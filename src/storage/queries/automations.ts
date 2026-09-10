import { randomUUID } from 'node:crypto';
import { and, asc, count, eq, inArray } from 'drizzle-orm';
import { buildScenario, type Scenario, type ScenarioDraft } from '../../core/scenario.js';
import type { AppDb } from '../db.js';
import { automations, automationSteps } from '../schema.js';

export type AutomationRow = typeof automations.$inferSelect;
export type StepRow = typeof automationSteps.$inferSelect;

export interface NewStep {
  say: string;
  saveReplyAs?: string;
  /** id строки в files. Проверяется внешним ключом, а не этим слоем. */
  fileId?: string;
  buttons?: { label: string; payload: string }[];
}

/**
 * Одно место, где `NewStep` превращается в строку таблицы. Создание и правка
 * раскладывают поля одинаково, и новое поле нельзя забыть в одном из двух мест.
 */
function stepValues(automationId: string, step: NewStep, position: number) {
  return {
    id: randomUUID(),
    automationId,
    position,
    say: step.say,
    saveReplyAs: step.saveReplyAs ?? null,
    fileId: step.fileId ?? null,
    buttonsJson: step.buttons === undefined ? null : JSON.stringify(step.buttons),
  };
}

export async function createAutomation(
  db: AppDb,
  userId: string,
  input: {
    name: string;
    triggerType: 'exact' | 'contains' | 'starts_with';
    triggerValue: string;
    steps: NewStep[];
  },
): Promise<string> {
  const id = randomUUID();
  // Транзакция: воронка и её шаги появляются вместе. Иначе падение между
  // вставками оставило бы воронку без части шагов, и воркер отработал бы
  // обрезанную цепочку
  await db.transaction(async (tx) => {
    await tx.insert(automations).values({
      id,
      userId,
      name: input.name,
      triggerType: input.triggerType,
      triggerValue: input.triggerValue,
    });

    for (const [position, step] of input.steps.entries()) {
      await tx.insert(automationSteps).values(stepValues(id, step, position));
    }
  });
  return id;
}

export async function listAutomations(db: AppDb, userId: string): Promise<AutomationRow[]> {
  return db.select().from(automations).where(eq(automations.userId, userId));
}

export async function getAutomation(
  db: AppDb,
  userId: string,
  automationId: string,
): Promise<{ automation: AutomationRow; steps: StepRow[] } | undefined> {
  const automation = (await db.select().from(automations)
    .where(and(eq(automations.id, automationId), eq(automations.userId, userId))))[0];
  if (automation === undefined) return undefined;

  const steps = await db.select().from(automationSteps)
    .where(eq(automationSteps.automationId, automation.id))
    .orderBy(asc(automationSteps.position));
  return { automation, steps };
}

/** S11: владелец в условии UPDATE — чужую воронку выключить нельзя. */
export async function setEnabled(
  db: AppDb, userId: string, automationId: string, enabled: boolean,
): Promise<void> {
  await db.update(automations).set({ enabled })
    .where(and(eq(automations.id, automationId), eq(automations.userId, userId)));
}

/**
 * Полная замена: шаги удаляются и вставляются заново. Так форма конструктора,
 * где шаг добавляют, удаляют и переставляют, не превращается в вычисление
 * разницы по позициям.
 *
 * Цена — новые `id` у шагов. Диалог, застрявший на старом шаге, движок сбросит
 * в ноль (`engine.ts`: неизвестный `stepId` → `stepId = null`), а не уронит.
 *
 * S11: владелец и в проверке существования, и в условии UPDATE. Чужая воронка
 * не находится — функция возвращает false, не изменив ничего.
 */
export async function updateAutomation(
  db: AppDb,
  userId: string,
  automationId: string,
  input: {
    name: string;
    triggerType: 'exact' | 'contains' | 'starts_with';
    triggerValue: string;
    steps: NewStep[];
  },
): Promise<boolean> {
  const owned = (await db.select({ id: automations.id }).from(automations)
    .where(and(eq(automations.id, automationId), eq(automations.userId, userId))))[0];
  if (owned === undefined) return false;

  // Транзакция: между удалением старых шагов и вставкой новых воронка пуста,
  // и в этот момент её не должен увидеть воркер
  await db.transaction(async (tx) => {
    await tx.update(automations)
      .set({
        name: input.name,
        triggerType: input.triggerType,
        triggerValue: input.triggerValue,
      })
      .where(and(eq(automations.id, automationId), eq(automations.userId, userId)));

    await tx.delete(automationSteps).where(eq(automationSteps.automationId, automationId));

    for (const [position, step] of input.steps.entries()) {
      await tx.insert(automationSteps).values(stepValues(automationId, step, position));
    }
  });
  return true;
}

/**
 * Сколько шагов у каждой воронки клиента. Нужно кабинету, чтобы отличить готовую
 * воронку от черновика — одним запросом, а не запросом на каждую строку списка.
 */
export async function stepCounts(db: AppDb, userId: string): Promise<Map<string, number>> {
  const rows = await db.select({
    automationId: automationSteps.automationId,
    total: count(),
  })
    .from(automationSteps)
    .innerJoin(automations, eq(automations.id, automationSteps.automationId))
    .where(eq(automations.userId, userId))
    .groupBy(automationSteps.automationId);

  return new Map(rows.map((row) => [row.automationId, row.total]));
}

/** Строка БД -> черновик для ядра. Здесь только перекладывание полей, без правил. */
function toDraft(automation: AutomationRow, steps: StepRow[]): ScenarioDraft {
  return {
    id: automation.id,
    trigger: { type: automation.triggerType, value: automation.triggerValue },
    steps: steps.map((step) => ({
      id: step.id,
      say: step.say,
      saveReplyAs: step.saveReplyAs,
      fileId: step.fileId,
      buttons: step.buttonsJson === null ? undefined : JSON.parse(step.buttonsJson),
    })),
  };
}

/**
 * Загружает воронки одним запросом за воронками и одним за всеми их шагами.
 * Запрос на каждую воронку отдельно (N+1) здесь недопустим: функция вызывается
 * на каждое входящее сообщение.
 */
export async function loadEnabledScenarios(db: AppDb, userId: string): Promise<Scenario[]> {
  const rows = await db.select().from(automations)
    .where(and(eq(automations.userId, userId), eq(automations.enabled, true)));
  if (rows.length === 0) return [];

  const allSteps = await db.select().from(automationSteps)
    .where(inArray(automationSteps.automationId, rows.map((r) => r.id)))
    .orderBy(asc(automationSteps.position));

  const byAutomation = new Map<string, StepRow[]>();
  for (const step of allSteps) {
    const bucket = byAutomation.get(step.automationId);
    if (bucket === undefined) byAutomation.set(step.automationId, [step]);
    else bucket.push(step);
  }

  return rows.flatMap((automation) => {
    const steps = byAutomation.get(automation.id) ?? [];
    // Воронка без шагов — не ошибка, а черновик из конструктора: она создаётся
    // раньше своих шагов. buildScenario на ней бросает (steps.min(1) в схеме),
    // и это исключение прилетело бы в цикл приёма воркера, то есть в бота
    // всех клиентов сразу
    if (steps.length === 0) return [];
    return [buildScenario(toDraft(automation, steps))];
  });
}
