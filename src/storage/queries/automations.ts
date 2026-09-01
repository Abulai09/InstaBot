import { randomUUID } from 'node:crypto';
import { and, asc, eq, inArray } from 'drizzle-orm';
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

export function createAutomation(
  db: AppDb,
  userId: string,
  input: {
    name: string;
    triggerType: 'exact' | 'contains' | 'starts_with';
    triggerValue: string;
    steps: NewStep[];
  },
): string {
  const id = randomUUID();
  db.insert(automations).values({
    id,
    userId,
    name: input.name,
    triggerType: input.triggerType,
    triggerValue: input.triggerValue,
  }).run();

  input.steps.forEach((step, position) => {
    db.insert(automationSteps).values({
      id: randomUUID(),
      automationId: id,
      position,
      say: step.say,
      saveReplyAs: step.saveReplyAs ?? null,
      fileId: step.fileId ?? null,
      buttonsJson: step.buttons === undefined ? null : JSON.stringify(step.buttons),
    }).run();
  });
  return id;
}

export function listAutomations(db: AppDb, userId: string): AutomationRow[] {
  return db.select().from(automations).where(eq(automations.userId, userId)).all();
}

export function getAutomation(
  db: AppDb,
  userId: string,
  automationId: string,
): { automation: AutomationRow; steps: StepRow[] } | undefined {
  const automation = db.select().from(automations)
    .where(and(eq(automations.id, automationId), eq(automations.userId, userId)))
    .all()[0];
  if (automation === undefined) return undefined;

  const steps = db.select().from(automationSteps)
    .where(eq(automationSteps.automationId, automation.id))
    .orderBy(asc(automationSteps.position))
    .all();
  return { automation, steps };
}

/** S11: владелец в условии UPDATE — чужую воронку выключить нельзя. */
export function setEnabled(
  db: AppDb, userId: string, automationId: string, enabled: boolean,
): void {
  db.update(automations).set({ enabled })
    .where(and(eq(automations.id, automationId), eq(automations.userId, userId)))
    .run();
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
export function loadEnabledScenarios(db: AppDb, userId: string): Scenario[] {
  const rows = db.select().from(automations)
    .where(and(eq(automations.userId, userId), eq(automations.enabled, true)))
    .all();
  if (rows.length === 0) return [];

  const allSteps = db.select().from(automationSteps)
    .where(inArray(automationSteps.automationId, rows.map((r) => r.id)))
    .orderBy(asc(automationSteps.position))
    .all();

  const byAutomation = new Map<string, StepRow[]>();
  for (const step of allSteps) {
    const bucket = byAutomation.get(step.automationId);
    if (bucket === undefined) byAutomation.set(step.automationId, [step]);
    else bucket.push(step);
  }

  return rows.map((automation) =>
    buildScenario(toDraft(automation, byAutomation.get(automation.id) ?? [])),
  );
}
