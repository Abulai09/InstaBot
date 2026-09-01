import { randomUUID } from 'node:crypto';
import { desc, eq } from 'drizzle-orm';
import type { Platform } from '../../core/types.js';
import type { AppDb } from '../db.js';
import { parseStringMap } from '../jsonMap.js';
import { leads } from '../schema.js';

export type LeadRow = typeof leads.$inferSelect;

export function recordLead(
  db: AppDb,
  userId: string,
  input: {
    automationId: string;
    platform: Platform;
    externalUserId: string;
    data: Map<string, string>;
    /** Явное время нужно тестам и повторной обработке очереди; по умолчанию — сейчас. */
    createdAt?: Date;
  },
): string {
  const id = randomUUID();
  db.insert(leads).values({
    id,
    userId,
    automationId: input.automationId,
    platform: input.platform,
    externalUserId: input.externalUserId,
    dataJson: JSON.stringify(Object.fromEntries(input.data)),
    ...(input.createdAt === undefined ? {} : { createdAt: input.createdAt }),
  }).run();
  return id;
}

export function listLeads(db: AppDb, userId: string, limit = 100): LeadRow[] {
  return db.select().from(leads)
    .where(eq(leads.userId, userId))
    .orderBy(desc(leads.createdAt))
    .limit(limit)
    .all();
}

/** S6: наружу отдаём Map — ключи пришли от пользователя, литерал им доверять нельзя. */
export function leadData(row: LeadRow): Map<string, string> {
  return parseStringMap(row.dataJson, 'данные заявки');
}
