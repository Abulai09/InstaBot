import { describe, expect, it } from 'vitest';
import { createTestDb } from '../helpers.js';
import { allowAttempt } from '../../../src/storage/queries/attempts.js';
import { authAttempts } from '../../../src/storage/schema.js';

const NOW = new Date('2026-09-30T12:00:00Z');
const WINDOW = 15 * 60_000;

describe('счётчик попыток входа в базе (S22)', () => {
  it('пропускает лимит и отказывает сверх него', async () => {
    const db = await createTestDb();
    const results: boolean[] = [];
    for (let i = 0; i < 6; i += 1) {
      results.push(await allowAttempt(db, 'вход:email:a@a.a', NOW, 5, WINDOW));
    }
    expect(results).toEqual([true, true, true, true, true, false]);
  });

  it('счёт общий для всех копий процесса: он живёт в базе, а не в памяти', async () => {
    const db = await createTestDb();
    for (let i = 0; i < 5; i += 1) await allowAttempt(db, 'вход:ip:1.2.3.4', NOW, 5, WINDOW);

    // Вторая копия процесса или перезапуск: никакого своего состояния нет,
    // и лимит не обнуляется
    expect(await allowAttempt(db, 'вход:ip:1.2.3.4', NOW, 5, WINDOW)).toBe(false);
  });

  it('окно закрывается, и попытки снова разрешены', async () => {
    const db = await createTestDb();
    for (let i = 0; i < 5; i += 1) await allowAttempt(db, 'k', NOW, 5, WINDOW);

    const later = new Date(NOW.getTime() + WINDOW + 1);
    expect(await allowAttempt(db, 'k', later, 5, WINDOW)).toBe(true);
  });

  it('ключи считаются раздельно', async () => {
    const db = await createTestDb();
    for (let i = 0; i < 5; i += 1) await allowAttempt(db, 'вход:email:a@a.a', NOW, 5, WINDOW);

    expect(await allowAttempt(db, 'вход:email:b@b.b', NOW, 5, WINDOW)).toBe(true);
  });

  it('S9: почта и адрес не лежат в таблице открытым текстом', async () => {
    const db = await createTestDb();
    await allowAttempt(db, 'вход:email:secret@mail.ru', NOW, 5, WINDOW);

    const dump = JSON.stringify(await db.select().from(authAttempts));
    expect(dump).not.toContain('secret@mail.ru');
  });

  it('отказ не пишет строку: заваленный ключ не раздувает таблицу', async () => {
    const db = await createTestDb();
    for (let i = 0; i < 50; i += 1) await allowAttempt(db, 'k', NOW, 5, WINDOW);

    expect(await db.select().from(authAttempts)).toHaveLength(5);
  });

  it('истёкшие строки убираются, в том числе чужих ключей', async () => {
    const db = await createTestDb();
    for (let i = 0; i < 20; i += 1) await allowAttempt(db, `выдуманная:${i}`, NOW, 5, WINDOW);

    await allowAttempt(db, 'другой', new Date(NOW.getTime() + WINDOW + 1), 5, WINDOW);

    expect(await db.select().from(authAttempts)).toHaveLength(1);
  });
});
