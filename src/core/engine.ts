import { matches } from "./matcher.js";
import type { Scenario, ScenarioStep } from "./scenario.js";
import type { ConversationState, IncomingEvent, OutgoingAction } from "./types.js";

export function step(
  scenarios: Scenario[],
  state: ConversationState,
  event: IncomingEvent,
): StepResult {
  const text = (event.text ?? "").trim();
  const next: ConversationState = {
    stepId: state.stepId,
    context: new Map(state.context),
    lastUserMessageAt: event.receivedAt,
  };

  // Комментарий всегда начинает воронку заново, даже посреди диалога: иначе он
  // продвинул бы цепочку, и следующий шаг ушёл бы публично под постом
  if (event.kind === "comment") return startFromComment(scenarios, next, text);

  if (next.stepId === null) {
    const scenario = scenarios.find((s) => matches(s.trigger, text));
    if (scenario === undefined) return { state: next, actions: [] };

    const first = scenario.steps[0];
    if (first === undefined) return { state: next, actions: [] };
    next.stepId = first.id;
    return { state: next, actions: renderStep(first, next) };
  }

  const scenario = scenarios.find((s) =>
    s.steps.some((st) => st.id === next.stepId),
  );
  const current = scenario?.steps.find((st) => st.id === next.stepId);
  if (scenario === undefined || current === undefined) {
    // Сценарий переименовали или удалили под работающим диалогом — сбрасываем
    return { state: { ...next, stepId: null }, actions: [] };
  }
  if (current.save_reply_as !== undefined && text.length > 0) {
    next.context.set(current.save_reply_as, text);
  }

  if (current.next === undefined) {
    return { state: { ...next, stepId: null }, actions: [] };
  }

  const following = scenario.steps.find((st) => st.id === current.next);
  if (following === undefined) {
    return { state: { ...next, stepId: null }, actions: [] };
  }

  const actions = renderStep(following, next);
  next.stepId = following.next === undefined ? null : following.id;
  return { state: next, actions };
}

/**
 * Под комментарием — только короткий публичный ответ, сама цепочка уходит в директ.
 * Первое сообщение адресуется по комментарию: человек боту ещё не писал, и до его
 * ответа платформа разрешает одно сообщение. Поэтому файл первого шага здесь
 * не отправляется — он ушёл бы вторым сообщением и был бы отклонён.
 */
function startFromComment(
  scenarios: Scenario[],
  state: ConversationState,
  text: string,
): StepResult {
  const scenario = scenarios.find((s) => matches(s.trigger, text));
  const first = scenario?.steps[0];
  if (scenario === undefined || first === undefined) return { state, actions: [] };

  const actions: OutgoingAction[] = [];
  if (scenario.comment_reply !== undefined) {
    actions.push({ type: "reply_comment", text: scenario.comment_reply });
  }
  actions.push({
    type: "dm_the_commenter",
    text: first.say,
    ...(first.buttons === undefined || first.buttons.length === 0
      ? {}
      : { buttons: first.buttons }),
  });
  return { state: { ...state, context: new Map(), stepId: first.id }, actions };
}

function renderStep(
  target: ScenarioStep,
  state: ConversationState,
): OutgoingAction[] {
  const actions: OutgoingAction[] = [];

  if (target.buttons !== undefined && target.buttons.length > 0) {
    actions.push({
      type: "send_buttons",
      text: target.say,
      buttons: target.buttons,
    });
  } else {
    actions.push({ type: "send_text", text: target.say });
  }

  // Отдельным действием, а не полем текстового: одно сообщение несёт либо текст,
  // либо вложение. Порядок важен — сначала объяснение, потом файл
  if (target.file_id !== undefined) {
    actions.push({ type: "send_file", fileId: target.file_id });
  }

  if (target.notify_operator !== undefined) {
    actions.push({
      type: "notify_operator",
      reason: target.notify_operator,
      context: Object.fromEntries(state.context),
    });
  }
  return actions;
}

export interface StepResult {
  state: ConversationState;
  actions: OutgoingAction[];
}
