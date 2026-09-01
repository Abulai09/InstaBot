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

  if (next.stepId === null) {
    const scenario = scenarios.find((s) => matches(s.trigger, text));
    if (scenario === undefined) return { state: next, actions: [] };

    const first = scenario.steps[0];
    if (first === undefined) return { state: next, actions: [] };
    next.stepId = first.id;
    return { state: next, actions: renderStep(first, next, event) };
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

  const actions = renderStep(following, next, event);
  next.stepId = following.next === undefined ? null : following.id;
  return { state: next, actions };
}

function renderStep(
  target: ScenarioStep,
  state: ConversationState,
  event: IncomingEvent,
): OutgoingAction[] {
  const actions: OutgoingAction[] = [];

  if (target.buttons !== undefined && target.buttons.length > 0) {
    actions.push({
      type: "send_buttons",
      text: target.say,
      buttons: target.buttons,
    });
  } else if (event.kind === "comment") {
    actions.push({ type: "reply_comment", text: target.say });
  } else {
    actions.push({ type: "send_text", text: target.say });
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
