import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { and, desc, eq } from 'drizzle-orm';
import type { AppDb } from './db.js';
import { automationSteps, files } from './schema.js';

export type FileRow = typeof files.$inferSelect;

const MB = 1024 * 1024;

/**
 * Белый список — по трём признакам сразу: расширение, заявленный MIME и первые
 * байты. Заявленный MIME присылает клиент, и он не значит ничего: `content-type`
 * — это утверждение, а не свойство файла. Лимиты взяты из ограничений платформы
 * (раздел 3 спеки): документ 25 МБ, изображение 8 МБ.
 */
const ALLOWED = [
  { ext: '.pdf', mime: 'application/pdf', maxBytes: 25 * MB, magic: [0x25, 0x50, 0x44, 0x46] },
  { ext: '.png', mime: 'image/png', maxBytes: 8 * MB, magic: [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a] },
  { ext: '.jpg', mime: 'image/jpeg', maxBytes: 8 * MB, magic: [0xff, 0xd8, 0xff] },
  { ext: '.jpeg', mime: 'image/jpeg', maxBytes: 8 * MB, magic: [0xff, 0xd8, 0xff] },
] as const;

export interface NewFile {
  /** Имя от клиента. Только для показа — на диск оно не попадает (S16). */
  originalName: string;
  mimeType: string;
  bytes: Buffer;
}

function startsWithMagic(bytes: Buffer, magic: readonly number[]): boolean {
  if (bytes.length < magic.length) return false;
  return magic.every((byte, i) => bytes[i] === byte);
}

/**
 * Расширение берётся из последней точки присланного имени и дальше служит только
 * ключом в белом списке: в путь уходит не оно, а значение `ext` из самого списка.
 * Поэтому «файл.pdf.exe» не пройдёт, а «../../passwd.pdf» не станет путём.
 */
function extensionOf(originalName: string): string {
  const dot = originalName.lastIndexOf('.');
  return dot === -1 ? '' : originalName.slice(dot).toLowerCase();
}

export async function saveFile(
  db: AppDb, userId: string, input: NewFile, dir: string,
): Promise<string> {
  const ext = extensionOf(input.originalName);
  const allowed = ALLOWED.find((a) => a.ext === ext && a.mime === input.mimeType);
  if (allowed === undefined) {
    // В сообщении нет ни имени файла, ни его содержимого — только то, что решали (S9)
    throw new Error('файл отвергнут: расширение или тип вне белого списка');
  }
  if (input.bytes.length === 0) throw new Error('файл отвергнут: пустой файл');
  if (input.bytes.length > allowed.maxBytes) {
    throw new Error('файл отвергнут: размер выше лимита платформы');
  }
  if (!startsWithMagic(input.bytes, allowed.magic)) {
    throw new Error('файл отвергнут: содержимое не совпадает с заявленным типом');
  }

  // Обе части пути наши: userId — наш UUID, storedName — сгенерирован здесь.
  // Присланное имя в путь не входит нигде (S18)
  const storedName = `${randomUUID()}${allowed.ext}`;
  const userDir = join(dir, userId);
  mkdirSync(userDir, { recursive: true });
  writeFileSync(join(userDir, storedName), input.bytes);

  const id = randomUUID();
  await db.insert(files).values({
    id,
    userId,
    originalName: input.originalName,
    storedName,
    mimeType: allowed.mime,
    sizeBytes: input.bytes.length,
  });
  return id;
}

export async function getFile(
  db: AppDb, userId: string, fileId: string,
): Promise<FileRow | undefined> {
  return (await db.select().from(files)
    .where(and(eq(files.id, fileId), eq(files.userId, userId))))[0];
}

export async function listFiles(
  db: AppDb, userId: string, limit = 100,
): Promise<FileRow[]> {
  return db.select().from(files)
    .where(eq(files.userId, userId))
    .orderBy(desc(files.createdAt))
    .limit(limit);
}

/**
 * Путь собирается из строки БД, а строка добыта запросом с владельцем в условии.
 * Другого способа получить путь в этом модуле нет — в этом и состоит S18.
 */
export function readFileBytes(dir: string, row: FileRow): Buffer {
  return readFileSync(join(dir, row.userId, row.storedName));
}

export async function setAttachmentId(
  db: AppDb, userId: string, fileId: string, attachmentId: string,
): Promise<void> {
  await db.update(files)
    .set({ attachmentId })
    .where(and(eq(files.id, fileId), eq(files.userId, userId)));
}

export type DeleteFileResult = 'deleted' | 'in_use' | 'not_found';

/**
 * S11: чужой файл возвращает `not_found`, а не отдельный отказ — по ответу нельзя
 * узнать, существует ли такой файл у кого-то другого.
 *
 * Проверка ссылок обязательна: внешний ключ объявлен с `set null`, поэтому без неё
 * удаление тихо отцепило бы файл от шага, и воронка продолжила бы работать,
 * отправляя текст без обещанного файла.
 */
export async function deleteFile(
  db: AppDb, userId: string, fileId: string, dir: string,
): Promise<DeleteFileResult> {
  const row = await getFile(db, userId, fileId);
  if (row === undefined) return 'not_found';

  const used = (await db.select({ id: automationSteps.id }).from(automationSteps)
    .where(eq(automationSteps.fileId, fileId)))[0];
  if (used !== undefined) return 'in_use';

  // Сначала строка, потом байты. Падение между ними оставит мусор на диске —
  // это лучше, чем строка, ведущая в пустоту: на ней споткнётся отправка
  await db.delete(files).where(and(eq(files.id, fileId), eq(files.userId, userId)));
  rmSync(join(dir, userId, row.storedName), { force: true });
  return 'deleted';
}
