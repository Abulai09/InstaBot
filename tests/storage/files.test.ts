import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTestDb } from './helpers.js';
import { createUser } from '../../src/storage/queries/users.js';
import {
  deleteFile, getFile, listFiles, readFileBytes, saveFile, setAttachmentId,
} from '../../src/storage/files.js';
import { createAutomation } from '../../src/storage/queries/automations.js';
import type { AppDb } from '../../src/storage/db.js';

const PDF = Buffer.concat([Buffer.from('%PDF-1.7\n'), Buffer.alloc(64, 0x20)]);
const PNG = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.alloc(64, 0x00),
]);

let dir: string;
let db: AppDb;
let a: string;
let b: string;

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'files-test-'));
  db = await createTestDb();
  a = await createUser(db, { email: 'a@a.a', passwordHash: 'x' });
  b = await createUser(db, { email: 'b@b.b', passwordHash: 'x' });
});

afterEach(async () => {
  rmSync(dir, { recursive: true, force: true });
});

describe('сохранение файла', () => {
  it('кладёт байты на диск и возвращает их обратно', async () => {
    const id = await saveFile(db, a, { originalName: 'чеклист.pdf', mimeType: 'application/pdf', bytes: PDF }, dir);

    const row = await getFile(db, a, id);
    if (row === undefined) throw new Error('файл не сохранён');
    expect(readFileBytes(dir, row).equals(PDF)).toBe(true);
    expect(row.sizeBytes).toBe(PDF.length);
    expect(row.attachmentId).toBeNull();
  });

  it('S16: имя на диске генерируется, присланное имя только показывается', async () => {
    const id = await saveFile(db, a, { originalName: 'чеклист.pdf', mimeType: 'application/pdf', bytes: PDF }, dir);

    const row = await getFile(db, a, id);
    expect(row?.originalName).toBe('чеклист.pdf');
    expect(row?.storedName).not.toContain('чеклист');
    expect(row?.storedName).toMatch(/^[0-9a-f-]{36}\.pdf$/);
  });

  it('S18: путь в имени не уводит за каталог клиента', async () => {
    const id = await saveFile(
      db, a,
      { originalName: '../../../../etc/passwd.pdf', mimeType: 'application/pdf', bytes: PDF },
      dir,
    );

    const row = await getFile(db, a, id);
    if (row === undefined) throw new Error('файл не сохранён');
    // Единственный созданный каталог — каталог этого клиента, и файл лежит в нём
    expect(readdirSync(dir)).toEqual([a]);
    expect(readdirSync(join(dir, a))).toHaveLength(1);
    // Путь целиком остаётся внутри корня хранилища
    expect(resolve(dir, a, row.storedName).startsWith(resolve(dir))).toBe(true);
  });

  it('S16: расширение вне белого списка отвергается', async () => {
    await expect(saveFile(
      db, a, { originalName: 'вирус.exe', mimeType: 'application/pdf', bytes: PDF }, dir,
    )).rejects.toThrow();
  });

  it('S16: заявленный MIME вне белого списка отвергается', async () => {
    await expect(saveFile(
      db, a, { originalName: 'файл.pdf', mimeType: 'application/x-msdownload', bytes: PDF }, dir,
    )).rejects.toThrow();
  });

  it('S16: заявленный MIME, не совпадающий с сигнатурой, отвергается', async () => {
    // Клиент присылает PNG под видом PDF: content-type пишет он сам, ему нельзя верить
    await expect(saveFile(
      db, a, { originalName: 'подделка.pdf', mimeType: 'application/pdf', bytes: PNG }, dir,
    )).rejects.toThrow();
  });

  it('S16: файл больше лимита платформы отвергается', async () => {
    const huge = Buffer.concat([Buffer.from('%PDF-1.7\n'), Buffer.alloc(26 * 1024 * 1024, 0x20)]);
    await expect(saveFile(
      db, a, { originalName: 'толстый.pdf', mimeType: 'application/pdf', bytes: huge }, dir,
    )).rejects.toThrow();
  });

  it('S16: у изображения лимит свой, меньше чем у PDF', async () => {
    const png9mb = Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      Buffer.alloc(9 * 1024 * 1024, 0x00),
    ]);
    await expect(saveFile(
      db, a, { originalName: 'большая.png', mimeType: 'image/png', bytes: png9mb }, dir,
    )).rejects.toThrow();
  });

  it('пустой файл отвергается: сигнатуру проверять не в чем', async () => {
    await expect(saveFile(
      db, a, { originalName: 'пусто.pdf', mimeType: 'application/pdf', bytes: Buffer.alloc(0) }, dir,
    )).rejects.toThrow();
  });
});

describe('идентификатор вложения', () => {
  it('запоминается и потом читается', async () => {
    const id = await saveFile(db, a, { originalName: 'ч.pdf', mimeType: 'application/pdf', bytes: PDF }, dir);
    await setAttachmentId(db, a, id, 'att-777');
    expect((await getFile(db, a, id))?.attachmentId).toBe('att-777');
  });
});

describe('S11: изоляция клиентов', () => {
  it('клиент не достаёт чужой файл по id', async () => {
    const id = await saveFile(db, a, { originalName: 'ч.pdf', mimeType: 'application/pdf', bytes: PDF }, dir);
    expect(await getFile(db, b, id)).toBeUndefined();
  });

  it('клиент не видит чужие файлы в списке', async () => {
    await saveFile(db, a, { originalName: 'ч.pdf', mimeType: 'application/pdf', bytes: PDF }, dir);
    expect(await listFiles(db, a)).toHaveLength(1);
    expect(await listFiles(db, b)).toHaveLength(0);
  });

  it('клиент не проставляет attachment_id чужому файлу', async () => {
    const id = await saveFile(db, a, { originalName: 'ч.pdf', mimeType: 'application/pdf', bytes: PDF }, dir);
    await setAttachmentId(db, b, id, 'чужой-att');
    expect((await getFile(db, a, id))?.attachmentId).toBeNull();
  });
});

describe('удаление файла', () => {
  const ПРАЙС = { originalName: 'прайс.pdf', mimeType: 'application/pdf', bytes: PDF };

  it('удаляет строку и байты с диска', async () => {
    const fileId = await saveFile(db, a, ПРАЙС, dir);
    const row = await getFile(db, a, fileId);
    if (row === undefined) throw new Error('файл не сохранён');

    expect(await deleteFile(db, a, fileId, dir)).toBe('deleted');

    expect(await getFile(db, a, fileId)).toBeUndefined();
    expect(existsSync(join(dir, a, row.storedName))).toBe(false);
  });

  it('файл, на который ссылается шаг, не удаляется', async () => {
    const fileId = await saveFile(db, a, ПРАЙС, dir);
    await createAutomation(db, a, {
      name: 'Прайс', triggerType: 'contains', triggerValue: 'цена',
      steps: [{ say: 'Держите', fileId }],
    });

    expect(await deleteFile(db, a, fileId, dir)).toBe('in_use');
    expect(await getFile(db, a, fileId)).toBeDefined();
  });

  it('S11: чужой файл неотличим от несуществующего и остаётся цел', async () => {
    const fileId = await saveFile(db, a, ПРАЙС, dir);

    expect(await deleteFile(db, b, fileId, dir)).toBe('not_found');
    expect(await deleteFile(db, b, 'нет-такого', dir)).toBe('not_found');
    expect(await getFile(db, a, fileId)).toBeDefined();
  });
});
