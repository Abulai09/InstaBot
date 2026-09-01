import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTestDb } from './helpers.js';
import { createUser } from '../../src/storage/queries/users.js';
import {
  getFile, listFiles, readFileBytes, saveFile, setAttachmentId,
} from '../../src/storage/files.js';
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

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'files-test-'));
  db = createTestDb();
  a = createUser(db, { email: 'a@a.a', passwordHash: 'x' });
  b = createUser(db, { email: 'b@b.b', passwordHash: 'x' });
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('сохранение файла', () => {
  it('кладёт байты на диск и возвращает их обратно', () => {
    const id = saveFile(db, a, { originalName: 'чеклист.pdf', mimeType: 'application/pdf', bytes: PDF }, dir);

    const row = getFile(db, a, id);
    if (row === undefined) throw new Error('файл не сохранён');
    expect(readFileBytes(dir, row).equals(PDF)).toBe(true);
    expect(row.sizeBytes).toBe(PDF.length);
    expect(row.attachmentId).toBeNull();
  });

  it('S16: имя на диске генерируется, присланное имя только показывается', () => {
    const id = saveFile(db, a, { originalName: 'чеклист.pdf', mimeType: 'application/pdf', bytes: PDF }, dir);

    const row = getFile(db, a, id);
    expect(row?.originalName).toBe('чеклист.pdf');
    expect(row?.storedName).not.toContain('чеклист');
    expect(row?.storedName).toMatch(/^[0-9a-f-]{36}\.pdf$/);
  });

  it('S18: путь в имени не уводит за каталог клиента', () => {
    const id = saveFile(
      db, a,
      { originalName: '../../../../etc/passwd.pdf', mimeType: 'application/pdf', bytes: PDF },
      dir,
    );

    const row = getFile(db, a, id);
    if (row === undefined) throw new Error('файл не сохранён');
    // Единственный созданный каталог — каталог этого клиента, и файл лежит в нём
    expect(readdirSync(dir)).toEqual([a]);
    expect(readdirSync(join(dir, a))).toHaveLength(1);
    // Путь целиком остаётся внутри корня хранилища
    expect(resolve(dir, a, row.storedName).startsWith(resolve(dir))).toBe(true);
  });

  it('S16: расширение вне белого списка отвергается', () => {
    expect(() => saveFile(
      db, a, { originalName: 'вирус.exe', mimeType: 'application/pdf', bytes: PDF }, dir,
    )).toThrow();
  });

  it('S16: заявленный MIME вне белого списка отвергается', () => {
    expect(() => saveFile(
      db, a, { originalName: 'файл.pdf', mimeType: 'application/x-msdownload', bytes: PDF }, dir,
    )).toThrow();
  });

  it('S16: заявленный MIME, не совпадающий с сигнатурой, отвергается', () => {
    // Клиент присылает PNG под видом PDF: content-type пишет он сам, ему нельзя верить
    expect(() => saveFile(
      db, a, { originalName: 'подделка.pdf', mimeType: 'application/pdf', bytes: PNG }, dir,
    )).toThrow();
  });

  it('S16: файл больше лимита платформы отвергается', () => {
    const huge = Buffer.concat([Buffer.from('%PDF-1.7\n'), Buffer.alloc(26 * 1024 * 1024, 0x20)]);
    expect(() => saveFile(
      db, a, { originalName: 'толстый.pdf', mimeType: 'application/pdf', bytes: huge }, dir,
    )).toThrow();
  });

  it('S16: у изображения лимит свой, меньше чем у PDF', () => {
    const png9mb = Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      Buffer.alloc(9 * 1024 * 1024, 0x00),
    ]);
    expect(() => saveFile(
      db, a, { originalName: 'большая.png', mimeType: 'image/png', bytes: png9mb }, dir,
    )).toThrow();
  });

  it('пустой файл отвергается: сигнатуру проверять не в чем', () => {
    expect(() => saveFile(
      db, a, { originalName: 'пусто.pdf', mimeType: 'application/pdf', bytes: Buffer.alloc(0) }, dir,
    )).toThrow();
  });
});

describe('идентификатор вложения', () => {
  it('запоминается и потом читается', () => {
    const id = saveFile(db, a, { originalName: 'ч.pdf', mimeType: 'application/pdf', bytes: PDF }, dir);
    setAttachmentId(db, a, id, 'att-777');
    expect(getFile(db, a, id)?.attachmentId).toBe('att-777');
  });
});

describe('S11: изоляция клиентов', () => {
  it('клиент не достаёт чужой файл по id', () => {
    const id = saveFile(db, a, { originalName: 'ч.pdf', mimeType: 'application/pdf', bytes: PDF }, dir);
    expect(getFile(db, b, id)).toBeUndefined();
  });

  it('клиент не видит чужие файлы в списке', () => {
    saveFile(db, a, { originalName: 'ч.pdf', mimeType: 'application/pdf', bytes: PDF }, dir);
    expect(listFiles(db, a)).toHaveLength(1);
    expect(listFiles(db, b)).toHaveLength(0);
  });

  it('клиент не проставляет attachment_id чужому файлу', () => {
    const id = saveFile(db, a, { originalName: 'ч.pdf', mimeType: 'application/pdf', bytes: PDF }, dir);
    setAttachmentId(db, b, id, 'чужой-att');
    expect(getFile(db, a, id)?.attachmentId).toBeNull();
  });
});
