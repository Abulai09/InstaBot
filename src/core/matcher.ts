import type { Trigger } from "./scenario.js";

/**
 * Решает, сработал ли триггер сценария на сообщение пользователя.
 * Вызывается на КАЖДОЕ входящее сообщение и комментарий.
 *
 * Компромиссы, которые нужно взвесить:
 *  - регистр: для кириллицы нужен toLocaleLowerCase, не toLowerCase;
 *  - contains ловит и ложные срабатывания: триггер "цена" совпадёт с
 *    "цена меня не волнует, у вас брак" — и бот пришлёт прайс на претензию;
 *  - люди пишут "цена?", "цена!!!", "  цена  ", "цена 🙏" — exact без
 *    нормализации промахнётся почти всегда;
 *  - текст уже обрезан по MAX_INCOMING_TEXT_LENGTH вызывающей стороной (S7).
 *
 * @param trigger  правило из YAML
 * @param userText текст от пользователя
 * @returns        true если сценарий должен запуститься
 */
export function matches(trigger: Trigger, userText: string): boolean {
  const text = normalize(userText);
  if (text === "") return false;

  const value = normalize(trigger.value);
  switch (trigger.type) {
    case "exact":
      return text === value;
    case "contains":
      return text.includes(value);
    case "starts_with":
      return text.startsWith(value);
  }
}

function normalize(s: string): string {
  return s
    .toLocaleLowerCase()
    .trim()
    .replace(/[.,!?…]+$/u, "")
    .trim();
}
