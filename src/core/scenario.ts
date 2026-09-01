import { load, CORE_SCHEMA } from "js-yaml";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";

const TriggerSchema = z.object({
  type: z.enum(["exact", "contains", "starts_with"]),
  value: z.string().min(1),
});

const VariableName = z
  .string()
  .regex(
    /^[a-z][a-z0-9_]*$/i,
    "имя переменной: буква, затем буквы/цифры/подчёркивание",
  );

const StepSchema = z.object({
  id: z.string().min(1),
  say: z.string().min(1),
  buttons: z
    .array(z.object({ label: z.string().min(1), payload: z.string().min(1) }))
    .optional(),
  /** куда сохранить следующий ответ пользователя */
  save_reply_as: VariableName.optional(),
  next: z.string().optional(),
  notify_operator: z.string().optional(),
});

export const ScenarioSchema = z.object({
  id: z.string().min(1),
  trigger: TriggerSchema,
  steps: z.array(StepSchema).min(1),
});

export type Trigger = z.infer<typeof TriggerSchema>;
export type ScenarioStep = z.infer<typeof StepSchema>;
export type Scenario = z.infer<typeof ScenarioSchema>;

export function parseScenario(yamlText: string): Scenario {
  // S5: CORE_SCHEMA не умеет конструировать функции и произвольные объекты
  const raw = load(yamlText, { schema: CORE_SCHEMA });
  const scenario = ScenarioSchema.parse(raw);

  const ids = new Set(scenario.steps.map((s) => s.id));
  for (const step of scenario.steps) {
    if (step.next !== undefined && !ids.has(step.next)) {
      throw new Error(
        `Шаг "${step.id}" ссылается на несуществующий next: "${step.next}"`,
      );
    }
  }
  return scenario;
}

export function loadScenarios(dir: string): Scenario[] {
  return readdirSync(dir)
    .filter((f) => f.endsWith(".yaml") || f.endsWith(".yml"))
    .map((f) => parseScenario(readFileSync(join(dir, f), "utf8")));
}

/** Черновик воронки: то, что дал пользователь, до связывания шагов и валидации. */
export interface ScenarioDraft {
  id: string;
  trigger: { type: string; value: string };
  steps: {
    id: string;
    say: string;
    saveReplyAs?: string | null;
    buttons?: unknown;
  }[];
}

/**
 * Собирает исполняемый `Scenario` из черновика: связывает шаги по порядку
 * (воронка линейная — ветвлений в v1 нет) и валидирует результат той же схемой,
 * что и YAML. Правило «следующий шаг — следующий по порядку» живёт здесь, а не
 * в хранилище: это продуктовое решение, и его надо проверять без БД.
 */
export function buildScenario(draft: ScenarioDraft): Scenario {
  const raw = {
    id: draft.id,
    trigger: draft.trigger,
    steps: draft.steps.map((step, i) => {
      const following = draft.steps[i + 1];
      return {
        id: step.id,
        say: step.say,
        ...(step.saveReplyAs === null || step.saveReplyAs === undefined
          ? {}
          : { save_reply_as: step.saveReplyAs }),
        ...(following === undefined ? {} : { next: following.id }),
        ...(step.buttons === undefined ? {} : { buttons: step.buttons }),
      };
    }),
  };
  return ScenarioSchema.parse(raw);
}
