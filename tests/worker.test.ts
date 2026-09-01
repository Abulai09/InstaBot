import { describe, expect, it } from 'vitest';
import { createTestDb } from './storage/helpers.js';
import { createUser } from '../src/storage/queries/users.js';
import { connectAccount } from '../src/storage/queries/accounts.js';
import { createAutomation } from '../src/storage/queries/automations.js';
import { enqueueEvent, takeDueOutbox } from '../src/storage/queries/runtime.js';
import { leadData, listLeads } from '../src/storage/queries/leads.js';
import { ReplyThrottle } from '../src/core/throttle.js';
import { loadConfig } from '../src/config.js';
import { runDelivery, runIntake, type WorkerDeps } from '../src/worker.js';
import type { AppDb } from '../src/storage/db.js';
import type { DeliveryContext, OutgoingAction, Platform } from '../src/core/types.js';
import type { MessageSender, SendResult } from '../src/adapters/types.js';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach } from 'vitest';
import { getFile, saveFile } from '../src/storage/files.js';
import type {
  AttachmentKind, AttachmentSender, AttachmentUpload, UploadResult,
} from '../src/adapters/types.js';

const KEY = 'a'.repeat(64);
const NOW = new Date('2026-08-28T12:00:01Z');

function config(extra: Record<string, string> = {}) {
  return loadConfig({
    META_APP_SECRET: 's', META_VERIFY_TOKEN: 'v', CREDENTIALS_ENC_KEY: KEY, ...extra,
  } as unknown as NodeJS.ProcessEnv);
}

interface Sent { action: OutgoingAction; delivery: DeliveryContext; token: string }

class FakeSender implements MessageSender {
  readonly platform: Platform = 'instagram';
  readonly sent: Sent[] = [];

  constructor(private readonly answer: SendResult = { ok: true }) {}

  async send(action: OutgoingAction, delivery: DeliveryContext, token: string): Promise<SendResult> {
    this.sent.push({ action, delivery, token });
    return this.answer;
  }
}

function deps(db: AppDb, sender: MessageSender, filesDir?: string): WorkerDeps {
  const cfg = config(filesDir === undefined ? {} : { FILES_DIR: filesDir });
  return {
    db, cfg,
    senders: new Map<Platform, MessageSender>([['instagram', sender]]),
    throttle: new ReplyThrottle(cfg.THROTTLE_MAX_REPLIES_PER_MINUTE),
  };
}

/** Событие лежит в очереди как JSON, поэтому receivedAt — строка, а не Date. */
function comment(text: string, commentId = '17900000000000009') {
  return {
    platform: 'instagram', kind: 'comment',
    externalUserId: '9988776655', externalThreadId: '9988776655',
    externalCommentId: commentId, text, payload: null,
    dedupeKey: `ig:comment:${commentId}`,
    receivedAt: new Date('2026-08-28T12:00:00Z').toISOString(),
  };
}

function directMessage(text: string, mid: string) {
  return {
    ...comment(text), kind: 'direct_message',
    externalCommentId: null, dedupeKey: `ig:msg:${mid}`,
  };
}

function priceFunnel(db: AppDb, userId: string, say = 'Ответ') {
  return createAutomation(db, userId, {
    name: 'Прайс', triggerType: 'contains', triggerValue: 'цена', steps: [{ say }],
  });
}

describe('intake: очередь → движок → outbox', () => {
  it('комментарий с ключевым словом превращается в исходящее действие', () => {
    const db = createTestDb();
    const userId = createUser(db, { email: 'a@a.a', passwordHash: 'x' });
    priceFunnel(db, userId, 'Отправил прайс в директ');
    enqueueEvent(db, userId, 'instagram', comment('сколько цена?'));

    expect(runIntake(deps(db, new FakeSender()), NOW)).toBe(1);

    const rows = takeDueOutbox(db, NOW);
    expect(rows).toHaveLength(1);
    expect(JSON.parse(rows[0]?.actionJson ?? '{}')).toEqual({
      type: 'reply_comment', text: 'Отправил прайс в директ',
    });
    expect(JSON.parse(rows[0]?.deliveryJson ?? '{}')).toMatchObject({
      threadId: '9988776655', commentId: '17900000000000009',
    });
  });

  it('событие обрабатывается один раз: повторный прогон ничего не добавляет', () => {
    const db = createTestDb();
    const userId = createUser(db, { email: 'b@b.b', passwordHash: 'x' });
    priceFunnel(db, userId);
    enqueueEvent(db, userId, 'instagram', comment('цена'));

    runIntake(deps(db, new FakeSender()), NOW);

    expect(runIntake(deps(db, new FakeSender()), NOW)).toBe(0);
    expect(takeDueOutbox(db, NOW)).toHaveLength(1);
  });

  it('S11: воронка клиента A не срабатывает на событие клиента B', () => {
    const db = createTestDb();
    const a = createUser(db, { email: 'a2@a.a', passwordHash: 'x' });
    const b = createUser(db, { email: 'b2@b.b', passwordHash: 'x' });
    priceFunnel(db, a, 'Ответ A');
    enqueueEvent(db, b, 'instagram', comment('цена'));

    runIntake(deps(db, new FakeSender()), NOW);

    expect(takeDueOutbox(db, NOW)).toHaveLength(0);
  });

  it('S8: сверх лимита в минуту события до движка не доходят', () => {
    const db = createTestDb();
    const userId = createUser(db, { email: 'c@c.c', passwordHash: 'x' });
    priceFunnel(db, userId);
    const worker = deps(db, new FakeSender());
    const limit = worker.cfg.THROTTLE_MAX_REPLIES_PER_MINUTE;

    // Все события — от одного контакта: троттлинг считает именно по контакту
    for (let i = 0; i <= limit; i += 1) {
      enqueueEvent(db, userId, 'instagram', comment('цена', `1790000000000${i}`));
    }

    // Считаем обработанные, а не действия: диалог после первого события
    // уходит в конец воронки и новых действий не порождает
    expect(runIntake(worker, NOW)).toBe(limit);
  });

  it('битое тело события не заклинивает очередь навсегда', () => {
    const db = createTestDb();
    const userId = createUser(db, { email: 'x@x.x', passwordHash: 'x' });
    priceFunnel(db, userId);
    enqueueEvent(db, userId, 'instagram', { мусор: true });

    expect(runIntake(deps(db, new FakeSender()), NOW)).toBe(0);
    expect(runIntake(deps(db, new FakeSender()), NOW)).toBe(0);
  });

  it('завершённая воронка со собранными ответами пишет заявку', () => {
    const db = createTestDb();
    const userId = createUser(db, { email: 'd@d.d', passwordHash: 'x' });
    const automationId = createAutomation(db, userId, {
      name: 'Заявка', triggerType: 'contains', triggerValue: 'запись',
      steps: [
        { say: 'Как вас зовут?', saveReplyAs: 'name' },
        { say: 'Спасибо, записал' },
      ],
    });
    const worker = deps(db, new FakeSender());

    enqueueEvent(db, userId, 'instagram', comment('хочу запись', '17900000000000001'));
    runIntake(worker, NOW);
    enqueueEvent(db, userId, 'instagram', directMessage('Абылай', 'm2'));
    runIntake(worker, NOW);
    enqueueEvent(db, userId, 'instagram', directMessage('ок', 'm3'));
    runIntake(worker, NOW);

    const leads = listLeads(db, userId);
    expect(leads).toHaveLength(1);

    const lead = leads[0];
    if (lead === undefined) throw new Error('заявка не записана');
    expect(lead.automationId).toBe(automationId);
    expect(leadData(lead).get('name')).toBe('Абылай');
  });
});

describe('delivery: outbox → адаптер', () => {
  function readyToSend(email: string, externalAccountId: string, token: string) {
    const db = createTestDb();
    const userId = createUser(db, { email, passwordHash: 'x' });
    connectAccount(db, userId, { platform: 'instagram', externalAccountId, token }, KEY);
    priceFunnel(db, userId);
    enqueueEvent(db, userId, 'instagram', comment('цена'));
    return { db, userId };
  }

  it('успешная отправка закрывает строку и несёт токен клиента', async () => {
    const { db } = readyToSend('e@e.e', '17841400000000001', 'токен-клиента');
    const sender = new FakeSender();
    const worker = deps(db, sender);
    runIntake(worker, NOW);

    expect(await runDelivery(worker, NOW)).toBe(1);
    expect(sender.sent[0]?.token).toBe('токен-клиента');
    expect(takeDueOutbox(db, NOW)).toHaveLength(0);
  });

  it('повторяемая ошибка откладывает строку, а не теряет её', async () => {
    const { db } = readyToSend('f@f.f', '17841400000000002', 'т');
    const worker = deps(db, new FakeSender({ ok: false, retry: true, reason: 'HTTP 503' }));
    runIntake(worker, NOW);
    await runDelivery(worker, NOW);

    expect(takeDueOutbox(db, NOW)).toHaveLength(0);
    expect(takeDueOutbox(db, new Date(NOW.getTime() + 10 * 60_000))).toHaveLength(1);
  });

  it('окончательная ошибка закрывает строку с причиной', async () => {
    const { db } = readyToSend('g@g.g', '17841400000000003', 'т');
    const worker = deps(db, new FakeSender({ ok: false, retry: false, reason: 'HTTP 400' }));
    runIntake(worker, NOW);
    await runDelivery(worker, NOW);

    expect(takeDueOutbox(db, new Date('2030-01-01T00:00:00Z'))).toHaveLength(0);
  });

  it('исчерпанные попытки закрывают строку, даже если ошибка повторяема', async () => {
    const { db } = readyToSend('i@i.i', '17841400000000004', 'т');
    const worker = deps(db, new FakeSender({ ok: false, retry: true, reason: 'HTTP 503' }));
    runIntake(worker, NOW);

    let at = NOW;
    for (let i = 0; i < worker.cfg.OUTBOX_MAX_ATTEMPTS; i += 1) {
      await runDelivery(worker, at);
      at = new Date(at.getTime() + 7 * 3_600_000);
    }

    expect(takeDueOutbox(db, new Date('2030-01-01T00:00:00Z'))).toHaveLength(0);
  });

  it('без подключённого аккаунта строка закрывается, а не висит вечно', async () => {
    const db = createTestDb();
    const userId = createUser(db, { email: 'h@h.h', passwordHash: 'x' });
    priceFunnel(db, userId);
    enqueueEvent(db, userId, 'instagram', comment('цена'));

    const sender = new FakeSender();
    const worker = deps(db, sender);
    runIntake(worker, NOW);
    await runDelivery(worker, NOW);

    expect(sender.sent).toHaveLength(0);
    expect(takeDueOutbox(db, new Date('2030-01-01T00:00:00Z'))).toHaveLength(0);
  });

  it('S11: клиенту A уходит его токен, клиенту B — его', async () => {
    const db = createTestDb();
    const a = createUser(db, { email: 'a3@a.a', passwordHash: 'x' });
    const b = createUser(db, { email: 'b3@b.b', passwordHash: 'x' });
    connectAccount(db, a, { platform: 'instagram', externalAccountId: '111', token: 'токен-A' }, KEY);
    connectAccount(db, b, { platform: 'instagram', externalAccountId: '222', token: 'токен-B' }, KEY);
    priceFunnel(db, a, 'Ответ A');
    priceFunnel(db, b, 'Ответ B');
    enqueueEvent(db, a, 'instagram', comment('цена', '17900000000000021'));
    enqueueEvent(db, b, 'instagram', comment('цена', '17900000000000022'));

    const sender = new FakeSender();
    const worker = deps(db, sender);
    runIntake(worker, NOW);
    await runDelivery(worker, NOW);

    expect(new Set(sender.sent.map((s) => s.token))).toEqual(new Set(['токен-A', 'токен-B']));
  });
});

class FakeAttachmentSender extends FakeSender implements AttachmentSender {
  readonly uploads: AttachmentUpload[] = [];
  readonly attachments: { attachmentId: string; kind: AttachmentKind; delivery: DeliveryContext }[] = [];

  constructor(private readonly upload: UploadResult = { ok: true, attachmentId: 'att-777' }) {
    super();
  }

  async uploadAttachment(file: AttachmentUpload, _token: string): Promise<UploadResult> {
    this.uploads.push(file);
    return this.upload;
  }

  async sendAttachment(
    attachmentId: string, kind: AttachmentKind, delivery: DeliveryContext, _token: string,
  ): Promise<SendResult> {
    this.attachments.push({ attachmentId, kind, delivery });
    return { ok: true };
  }
}

const PDF = Buffer.from('%PDF-1.7\n');

describe('delivery: файлы', () => {
  let dir: string;

  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'worker-files-')); });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  /** Клиент с подключённым аккаунтом, файлом и воронкой, которая этот файл отдаёт. */
  function seedWithFile(db: AppDb, email: string, accountId: string) {
    const userId = createUser(db, { email, passwordHash: 'x' });
    connectAccount(db, userId, { platform: 'instagram', externalAccountId: accountId, token: 'т' }, KEY);
    const fileId = saveFile(
      db, userId, { originalName: 'чеклист.pdf', mimeType: 'application/pdf', bytes: PDF }, dir,
    );
    createAutomation(db, userId, {
      name: 'Чеклист', triggerType: 'contains', triggerValue: 'чеклист',
      steps: [{ say: 'Держите чеклист', fileId }],
    });
    return { userId, fileId };
  }

  it('первая отправка выгружает файл и запоминает идентификатор вложения', async () => {
    const db = createTestDb();
    const { userId, fileId } = seedWithFile(db, 'a@a.a', '111');
    enqueueEvent(db, userId, 'instagram', comment('хочу чеклист'));

    const sender = new FakeAttachmentSender();
    const worker = deps(db, sender, dir);
    runIntake(worker, NOW);
    await runDelivery(worker, NOW);

    expect(sender.uploads).toHaveLength(1);
    expect(sender.uploads[0]?.bytes.equals(PDF)).toBe(true);
    expect(sender.attachments[0]?.attachmentId).toBe('att-777');
    expect(sender.attachments[0]?.kind).toBe('file');
    expect(getFile(db, userId, fileId)?.attachmentId).toBe('att-777');
  });

  it('вторая отправка того же файла выгрузку не повторяет', async () => {
    const db = createTestDb();
    const { userId } = seedWithFile(db, 'b@b.b', '222');
    const sender = new FakeAttachmentSender();
    const worker = deps(db, sender, dir);

    enqueueEvent(db, userId, 'instagram', comment('чеклист', '17900000000000001'));
    runIntake(worker, NOW);
    await runDelivery(worker, NOW);

    // Второй человек, тот же файл: байты платформе больше не передаются
    enqueueEvent(db, userId, 'instagram', {
      ...comment('чеклист', '17900000000000002'), externalUserId: '55', externalThreadId: '55',
    });
    runIntake(worker, NOW);
    await runDelivery(worker, NOW);

    expect(sender.uploads).toHaveLength(1);
    expect(sender.attachments).toHaveLength(2);
  });

  it('текст уходит раньше файла', async () => {
    const db = createTestDb();
    const { userId } = seedWithFile(db, 'c@c.c', '333');
    enqueueEvent(db, userId, 'instagram', comment('чеклист'));

    const sender = new FakeAttachmentSender();
    const worker = deps(db, sender, dir);
    runIntake(worker, NOW);
    await runDelivery(worker, NOW);

    expect(sender.sent[0]?.action).toEqual({ type: 'reply_comment', text: 'Держите чеклист' });
    expect(sender.attachments).toHaveLength(1);
  });

  it('пропавший файл закрывает строку, а не висит вечно', async () => {
    const db = createTestDb();
    const { userId } = seedWithFile(db, 'd@d.d', '444');
    enqueueEvent(db, userId, 'instagram', comment('чеклист'));

    const sender = new FakeAttachmentSender();
    const worker = deps(db, sender, dir);
    runIntake(worker, NOW);
    // Байты пропали с диска — например, том переехал
    rmSync(join(dir, userId), { recursive: true, force: true });
    await runDelivery(worker, NOW);

    expect(sender.attachments).toHaveLength(0);
    expect(takeDueOutbox(db, new Date('2030-01-01T00:00:00Z'))).toHaveLength(0);
  });

  it('повторяемая ошибка выгрузки откладывает строку и не запоминает идентификатор', async () => {
    const db = createTestDb();
    const { userId, fileId } = seedWithFile(db, 'e@e.e', '555');
    enqueueEvent(db, userId, 'instagram', comment('чеклист'));

    const sender = new FakeAttachmentSender({ ok: false, retry: true, reason: 'HTTP 503' });
    const worker = deps(db, sender, dir);
    runIntake(worker, NOW);
    await runDelivery(worker, NOW);

    expect(getFile(db, userId, fileId)?.attachmentId).toBeNull();
    expect(takeDueOutbox(db, NOW)).toHaveLength(0);
    expect(takeDueOutbox(db, new Date(NOW.getTime() + 10 * 60_000))).toHaveLength(1);
  });

  it('адаптер без поддержки вложений закрывает строку с причиной', async () => {
    const db = createTestDb();
    const { userId } = seedWithFile(db, 'f@f.f', '666');
    enqueueEvent(db, userId, 'instagram', comment('чеклист'));

    // Обычный отправитель текста — вложения он не умеет (так будет у TikTok)
    const sender = new FakeSender();
    const worker = deps(db, sender, dir);
    runIntake(worker, NOW);
    await runDelivery(worker, NOW);

    expect(takeDueOutbox(db, new Date('2030-01-01T00:00:00Z'))).toHaveLength(0);
  });

  it('S11: файл клиента A не уходит в диалоге клиента B', async () => {
    const db = createTestDb();
    const a = seedWithFile(db, 'a2@a.a', '777');
    const b = createUser(db, { email: 'b2@b.b', passwordHash: 'x' });
    connectAccount(db, b, { platform: 'instagram', externalAccountId: '888', token: 'т-B' }, KEY);

    // Клиент B ссылается на чужой файл — так может выглядеть подмена id в форме
    createAutomation(db, b, {
      name: 'Чужой чеклист', triggerType: 'contains', triggerValue: 'чеклист',
      steps: [{ say: 'Держите', fileId: a.fileId }],
    });
    enqueueEvent(db, b, 'instagram', comment('чеклист'));

    const sender = new FakeAttachmentSender();
    const worker = deps(db, sender, dir);
    runIntake(worker, NOW);
    await runDelivery(worker, NOW);

    expect(sender.uploads).toHaveLength(0);
    expect(sender.attachments).toHaveLength(0);
  });
});
