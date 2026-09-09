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
  /** файл, который уходит вторым сообщением после текста */
  file_id: z.string().min(1).optional(),
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

/** Черновик воронки: то, что дал пользователь, до связывания шагов и валидации. */
export interface ScenarioDraft {
  id: string;
  trigger: { type: string; value: string };
  steps: {
    id: string;
    say: string;
    saveReplyAs?: string | null;
    fileId?: string | null;
    buttons?: unknown;
  }[];
}

/**
 * Собирает исполняемый `Scenario` из черновика: связывает шаги по порядку
 * (воронка линейная — ветвлений в v1 нет) и валидирует результат `ScenarioSchema`.
 * Правило «следующий шаг — следующий по порядку» живёт здесь, а не в хранилище:
 * это продуктовое решение, и его надо проверять без БД.
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
        ...(step.fileId === null || step.fileId === undefined
          ? {}
          : { file_id: step.fileId }),
        ...(following === undefined ? {} : { next: following.id }),
        ...(step.buttons === undefined ? {} : { buttons: step.buttons }),
      };
    }),
  };
  return ScenarioSchema.parse(raw);
}
