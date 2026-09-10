import type { AutomationRow } from '../../storage/queries/automations.js';

/**
 * Человеческие подписи для служебных значений. Общие для списка воронок и
 * конструктора: раньше в выпадающем списке было «содержит слово», а в таблице
 * рядом — сырое `contains`, и клиенту приходилось догадываться, что это одно
 * и то же. Служебные значения остаются в БД и в формах, наружу идут подписи.
 */
const TRIGGER_LABELS: Record<AutomationRow['triggerType'], string> = {
  contains: 'содержит слово',
  exact: 'точное совпадение',
  starts_with: 'начинается со слова',
};

export function triggerLabel(kind: AutomationRow['triggerType']): string {
  return TRIGGER_LABELS[kind];
}

/** Порядок пунктов в выпадающем списке: сначала самый частый выбор. */
export const TRIGGER_KINDS: AutomationRow['triggerType'][] = ['contains', 'exact', 'starts_with'];
