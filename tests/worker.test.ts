import { describe, expect, it } from 'vitest';
import { createTestDb, pendingOutbox } from './storage/helpers.js';
import { createUser } from '../src/storage/queries/users.js';
import { connectAccount } from '../src/storage/queries/accounts.js';
import { createAutomation } from '../src/storage/queries/automations.js';
import { enqueueEvent, takePendingEvents } from '../src/storage/queries/runtime.js';
import { eventQueue } from '../src/storage/schema.js';
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
    DATABASE_URL: 'postgresql://u:p@localhost:5432/test',
    META_APP_SECRET: 's', META_VERIFY_TOKEN: 'v', CREDENTIALS_ENC_KEY: KEY, SESSION_SECRET: 'a'.repeat(32),
    PUBLIC_BASE_URL: 'https://bot.example.com', ...extra,
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

async function priceFunnel(db: AppDb, userId: string, say = 'Ответ') {
  return await createAutomation(db, userId, {
    name: 'Прайс', triggerType: 'contains', triggerValue: 'цена', steps: [{ say }],
  });
}

describe('intake: очередь → движок → outbox', () => {
  it('комментарий с ключевым словом превращается в исходящее действие', async () => {
    const db = await createTestDb();
    const userId = await createUser(db, { email: 'a@a.a', passwordHash: 'x' });
    await priceFunnel(db, userId, 'Отправил прайс в директ');
    await enqueueEvent(db, userId, 'instagram', comment('сколько цена?'));

    expect(await runIntake(deps(db, new FakeSender()), NOW)).toBe(1);

    const rows = await pendingOutbox(db, NOW);
    expect(rows).toHaveLength(1);
    expect(JSON.parse(rows[0]?.actionJson ?? '{}')).toEqual({
      type: 'reply_comment', text: 'Отправил прайс в директ',
    });
    expect(JSON.parse(rows[0]?.deliveryJson ?? '{}')).toMatchObject({
      threadId: '9988776655', commentId: '17900000000000009',
    });
  });

  /**
   * Событие, на котором обработка бросает исключение, не должно останавливать
   * очередь. Раньше вся пачка шла одной транзакцией, и такое событие уносило
   * с собой соседей: их пометки откатывались вместе с ним, а следующий тик
   * снова упирался в ту же строку — очередь вставала навсегда, у всех клиентов.
   */
  it('битое событие не роняет прогон и не блокирует очередь', async () => {
    const db = await createTestDb();
    const userId = await createUser(db, { email: 'poison@a.a', passwordHash: 'x' });
    await priceFunnel(db, userId, 'Отправил прайс');

    // Строка кладётся напрямую: enqueueEvent сам сериализует JSON и такого не создаст.
    // Это состояние из прода — запись, пережившая смену формата или обрыв записи
    await db.insert(eventQueue).values({
      id: 'битая-строка', userId, platform: 'instagram',
      payloadJson: 'это не JSON', createdAt: new Date(NOW.getTime() - 1000),
    });
    await enqueueEvent(db, userId, 'instagram', comment('сколько цена?'));

    // Прогон не падает, и живое событие обработано, хотя битое лежало первым
    expect(await runIntake(deps(db, new FakeSender()), NOW)).toBe(1);
    expect(await pendingOutbox(db, NOW)).toHaveLength(1);

    // Битая строка закрыта, а не оставлена на следующий круг
    expect(await takePendingEvents(db)).toHaveLength(0);
  });

  it('битое событие не откатывает уже обработанных соседей', async () => {
    const db = await createTestDb();
    const userId = await createUser(db, { email: 'poison2@a.a', passwordHash: 'x' });
    await priceFunnel(db, userId, 'Отправил прайс');

    // Живое событие идёт первым, битое — вторым: работа, сделанная до поломки,
    // обязана сохраниться
    await enqueueEvent(db, userId, 'instagram', comment('цена', '17900000000000031'));
    await db.insert(eventQueue).values({
      id: 'битая-строка-2', userId, platform: 'instagram',
      payloadJson: '{"platform": "instagram"',
      createdAt: new Date(NOW.getTime() + 1000),
    });

    expect(await runIntake(deps(db, new FakeSender()), NOW)).toBe(1);
    expect(await pendingOutbox(db, NOW)).toHaveLength(1);
    expect(await takePendingEvents(db)).toHaveLength(0);
  });

  it('событие обрабатывается один раз: повторный прогон ничего не добавляет', async () => {
    const db = await createTestDb();
    const userId = await createUser(db, { email: 'b@b.b', passwordHash: 'x' });
    await priceFunnel(db, userId);
    await enqueueEvent(db, userId, 'instagram', comment('цена'));

    await runIntake(deps(db, new FakeSender()), NOW);

    expect(await runIntake(deps(db, new FakeSender()), NOW)).toBe(0);
    expect(await pendingOutbox(db, NOW)).toHaveLength(1);
  });

  it('S11: воронка клиента A не срабатывает на событие клиента B', async () => {
    const db = await createTestDb();
    const a = await createUser(db, { email: 'a2@a.a', passwordHash: 'x' });
    const b = await createUser(db, { email: 'b2@b.b', passwordHash: 'x' });
    await priceFunnel(db, a, 'Ответ A');
    await enqueueEvent(db, b, 'instagram', comment('цена'));

    await runIntake(deps(db, new FakeSender()), NOW);

    expect(await pendingOutbox(db, NOW)).toHaveLength(0);
  });

  it('S8: сверх лимита в минуту события до движка не доходят', async () => {
    const db = await createTestDb();
    const userId = await createUser(db, { email: 'c@c.c', passwordHash: 'x' });
    await priceFunnel(db, userId);
    const worker = deps(db, new FakeSender());
    const limit = worker.cfg.THROTTLE_MAX_REPLIES_PER_MINUTE;

    // Все события — от одного контакта: троттлинг считает именно по контакту
    for (let i = 0; i <= limit; i += 1) {
      await enqueueEvent(db, userId, 'instagram', comment('цена', `1790000000000${i}`));
    }

    // Считаем обработанные, а не действия: диалог после первого события
    // уходит в конец воронки и новых действий не порождает
    expect(await runIntake(worker, NOW)).toBe(limit);
  });

  it('битое тело события не заклинивает очередь навсегда', async () => {
    const db = await createTestDb();
    const userId = await createUser(db, { email: 'x@x.x', passwordHash: 'x' });
    await priceFunnel(db, userId);
    await enqueueEvent(db, userId, 'instagram', { мусор: true });

    expect(await runIntake(deps(db, new FakeSender()), NOW)).toBe(0);
    expect(await runIntake(deps(db, new FakeSender()), NOW)).toBe(0);
  });

  it('завершённая воронка со собранными ответами пишет заявку', async () => {
    const db = await createTestDb();
    const userId = await createUser(db, { email: 'd@d.d', passwordHash: 'x' });
    const automationId = await createAutomation(db, userId, {
      name: 'Заявка', triggerType: 'contains', triggerValue: 'запись',
      steps: [
        { say: 'Как вас зовут?', saveReplyAs: 'name' },
        { say: 'Спасибо, записал' },
      ],
    });
    const worker = deps(db, new FakeSender());

    await enqueueEvent(db, userId, 'instagram', comment('хочу запись', '17900000000000001'));
    await runIntake(worker, NOW);
    await enqueueEvent(db, userId, 'instagram', directMessage('Абылай', 'm2'));
    await runIntake(worker, NOW);
    await enqueueEvent(db, userId, 'instagram', directMessage('ок', 'm3'));
    await runIntake(worker, NOW);

    const leads = await listLeads(db, userId);
    expect(leads).toHaveLength(1);

    const lead = leads[0];
    if (lead === undefined) throw new Error('заявка не записана');
    expect(lead.automationId).toBe(automationId);
    expect(leadData(lead).get('name')).toBe('Абылай');
  });
});

describe('delivery: outbox → адаптер', () => {
  async function readyToSend(email: string, externalAccountId: string, token: string) {
    const db = await createTestDb();
    const userId = await createUser(db, { email, passwordHash: 'x' });
    await connectAccount(db, userId, { platform: 'instagram', externalAccountId, token }, KEY);
    await priceFunnel(db, userId);
    await enqueueEvent(db, userId, 'instagram', comment('цена'));
    return { db, userId };
  }

  it('успешная отправка закрывает строку и несёт токен клиента', async () => {
    const { db } = await readyToSend('e@e.e', '17841400000000001', 'токен-клиента');
    const sender = new FakeSender();
    const worker = deps(db, sender);
    await runIntake(worker, NOW);

    expect(await runDelivery(worker, NOW)).toBe(1);
    expect(sender.sent[0]?.token).toBe('токен-клиента');
    expect(await pendingOutbox(db, NOW)).toHaveLength(0);
  });

  it('повторяемая ошибка откладывает строку, а не теряет её', async () => {
    const { db } = await readyToSend('f@f.f', '17841400000000002', 'т');
    const worker = deps(db, new FakeSender({ ok: false, retry: true, reason: 'HTTP 503' }));
    await runIntake(worker, NOW);
    await runDelivery(worker, NOW);

    expect(await pendingOutbox(db, NOW)).toHaveLength(0);
    expect(await pendingOutbox(db, new Date(NOW.getTime() + 10 * 60_000))).toHaveLength(1);
  });

  it('окончательная ошибка закрывает строку с причиной', async () => {
    const { db } = await readyToSend('g@g.g', '17841400000000003', 'т');
    const worker = deps(db, new FakeSender({ ok: false, retry: false, reason: 'HTTP 400' }));
    await runIntake(worker, NOW);
    await runDelivery(worker, NOW);

    expect(await pendingOutbox(db, new Date('2030-01-01T00:00:00Z'))).toHaveLength(0);
  });

  it('исчерпанные попытки закрывают строку, даже если ошибка повторяема', async () => {
    const { db } = await readyToSend('i@i.i', '17841400000000004', 'т');
    const worker = deps(db, new FakeSender({ ok: false, retry: true, reason: 'HTTP 503' }));
    await runIntake(worker, NOW);

    let at = NOW;
    for (let i = 0; i < worker.cfg.OUTBOX_MAX_ATTEMPTS; i += 1) {
      await runDelivery(worker, at);
      at = new Date(at.getTime() + 7 * 3_600_000);
    }

    expect(await pendingOutbox(db, new Date('2030-01-01T00:00:00Z'))).toHaveLength(0);
  });

  it('без подключённого аккаунта строка закрывается, а не висит вечно', async () => {
    const db = await createTestDb();
    const userId = await createUser(db, { email: 'h@h.h', passwordHash: 'x' });
    await priceFunnel(db, userId);
    await enqueueEvent(db, userId, 'instagram', comment('цена'));

    const sender = new FakeSender();
    const worker = deps(db, sender);
    await runIntake(worker, NOW);
    await runDelivery(worker, NOW);

    expect(sender.sent).toHaveLength(0);
    expect(await pendingOutbox(db, new Date('2030-01-01T00:00:00Z'))).toHaveLength(0);
  });

  it('S11: клиенту A уходит его токен, клиенту B — его', async () => {
    const db = await createTestDb();
    const a = await createUser(db, { email: 'a3@a.a', passwordHash: 'x' });
    const b = await createUser(db, { email: 'b3@b.b', passwordHash: 'x' });
    await connectAccount(db, a, { platform: 'instagram', externalAccountId: '111', token: 'токен-A' }, KEY);
    await connectAccount(db, b, { platform: 'instagram', externalAccountId: '222', token: 'токен-B' }, KEY);
    await priceFunnel(db, a, 'Ответ A');
    await priceFunnel(db, b, 'Ответ B');
    await enqueueEvent(db, a, 'instagram', comment('цена', '17900000000000021'));
    await enqueueEvent(db, b, 'instagram', comment('цена', '17900000000000022'));

    const sender = new FakeSender();
    const worker = deps(db, sender);
    await runIntake(worker, NOW);
    await runDelivery(worker, NOW);

    expect(new Set(sender.sent.map((s) => s.token))).toEqual(new Set(['токен-A', 'токен-B']));
  });

  it('S20: троттлинг на клиента откладывает доставку без роста attempts', async () => {
    const { db, userId } = await readyToSend('client-throttle@e.e', '17841400000000099', 'токен');
    const sender = new FakeSender();
    const worker = deps(db, sender);
    // Лимит 1 сообщение в минуту для теста
    worker.clientThrottle = new ReplyThrottle(1, 60_000);

    await enqueueEvent(db, userId, 'instagram', comment('цена', '17900000000000091'));
    await enqueueEvent(db, userId, 'instagram', comment('цена', '17900000000000092'));
    await runIntake(worker, NOW);

    const outboxBefore = await pendingOutbox(db, NOW);
    expect(outboxBefore).toHaveLength(2);

    expect(await runDelivery(worker, NOW)).toBe(1);
    expect(sender.sent).toHaveLength(1);

    const pendingLater = await pendingOutbox(db, new Date(NOW.getTime() + 15_000));
    expect(pendingLater).toHaveLength(1);
    expect(pendingLater[0]?.attempts).toBe(0);
  });

  it('24-часовое окно Meta: если окно истекло, сообщение не отправляется и не ретраится', async () => {
    const db = await createTestDb();
    const userId = await createUser(db, { email: 'expired-window@e.e', passwordHash: 'x' });
    await connectAccount(db, userId, { platform: 'instagram', externalAccountId: '17841400000000098', token: 'т' }, KEY);
    await priceFunnel(db, userId, 'Ответ в директ');

    const oldDate = new Date(NOW.getTime() - 25 * 3_600_000);
    await enqueueEvent(db, userId, 'instagram', {
      ...directMessage('привет', 'm-old'),
      receivedAt: oldDate.toISOString(),
    });

    const sender = new FakeSender();
    const worker = deps(db, sender);
    await runIntake(worker, oldDate);

    await runDelivery(worker, NOW);

    expect(sender.sent).toHaveLength(0);
    expect(await pendingOutbox(db, new Date('2030-01-01T00:00:00Z'))).toHaveLength(0);
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

describe('delivery: файлы', async () => {
  let dir: string;

  beforeEach(async () => { dir = mkdtempSync(join(tmpdir(), 'worker-files-')); });
  afterEach(async () => { rmSync(dir, { recursive: true, force: true }); });

  /** Клиент с подключённым аккаунтом, файлом и воронкой, которая этот файл отдаёт. */
  async function seedWithFile(db: AppDb, email: string, accountId: string) {
    const userId = await createUser(db, { email, passwordHash: 'x' });
    await connectAccount(db, userId, { platform: 'instagram', externalAccountId: accountId, token: 'т' }, KEY);
    const fileId = await saveFile(
      db, userId, { originalName: 'чеклист.pdf', mimeType: 'application/pdf', bytes: PDF }, dir,
    );
    await createAutomation(db, userId, {
      name: 'Чеклист', triggerType: 'contains', triggerValue: 'чеклист',
      steps: [{ say: 'Держите чеклист', fileId }],
    });
    return { userId, fileId };
  }

  it('первая отправка выгружает файл и запоминает идентификатор вложения', async () => {
    const db = await createTestDb();
    const { userId, fileId } = await seedWithFile(db, 'a@a.a', '111');
    await enqueueEvent(db, userId, 'instagram', comment('хочу чеклист'));

    const sender = new FakeAttachmentSender();
    const worker = deps(db, sender, dir);
    await runIntake(worker, NOW);
    await runDelivery(worker, NOW);

    expect(sender.uploads).toHaveLength(1);
    expect(sender.uploads[0]?.bytes.equals(PDF)).toBe(true);
    expect(sender.attachments[0]?.attachmentId).toBe('att-777');
    expect(sender.attachments[0]?.kind).toBe('file');
    expect((await getFile(db, userId, fileId))?.attachmentId).toBe('att-777');
  });

  it('вторая отправка того же файла выгрузку не повторяет', async () => {
    const db = await createTestDb();
    const { userId } = await seedWithFile(db, 'b@b.b', '222');
    const sender = new FakeAttachmentSender();
    const worker = deps(db, sender, dir);

    await enqueueEvent(db, userId, 'instagram', comment('чеклист', '17900000000000001'));
    await runIntake(worker, NOW);
    await runDelivery(worker, NOW);

    // Второй человек, тот же файл: байты платформе больше не передаются
    await enqueueEvent(db, userId, 'instagram', {
      ...comment('чеклист', '17900000000000002'), externalUserId: '55', externalThreadId: '55',
    });
    await runIntake(worker, NOW);
    await runDelivery(worker, NOW);

    expect(sender.uploads).toHaveLength(1);
    expect(sender.attachments).toHaveLength(2);
  });

  it('текст уходит раньше файла', async () => {
    const db = await createTestDb();
    const { userId } = await seedWithFile(db, 'c@c.c', '333');
    await enqueueEvent(db, userId, 'instagram', comment('чеклист'));

    const sender = new FakeAttachmentSender();
    const worker = deps(db, sender, dir);
    await runIntake(worker, NOW);
    await runDelivery(worker, NOW);

    expect(sender.sent[0]?.action).toEqual({ type: 'reply_comment', text: 'Держите чеклист' });
    expect(sender.attachments).toHaveLength(1);
  });

  it('пропавший файл закрывает строку, а не висит вечно', async () => {
    const db = await createTestDb();
    const { userId } = await seedWithFile(db, 'd@d.d', '444');
    await enqueueEvent(db, userId, 'instagram', comment('чеклист'));

    const sender = new FakeAttachmentSender();
    const worker = deps(db, sender, dir);
    await runIntake(worker, NOW);
    // Байты пропали с диска — например, том переехал
    rmSync(join(dir, userId), { recursive: true, force: true });
    await runDelivery(worker, NOW);

    expect(sender.attachments).toHaveLength(0);
    expect(await pendingOutbox(db, new Date('2030-01-01T00:00:00Z'))).toHaveLength(0);
  });

  it('повторяемая ошибка выгрузки откладывает строку и не запоминает идентификатор', async () => {
    const db = await createTestDb();
    const { userId, fileId } = await seedWithFile(db, 'e@e.e', '555');
    await enqueueEvent(db, userId, 'instagram', comment('чеклист'));

    const sender = new FakeAttachmentSender({ ok: false, retry: true, reason: 'HTTP 503' });
    const worker = deps(db, sender, dir);
    await runIntake(worker, NOW);
    await runDelivery(worker, NOW);

    expect((await getFile(db, userId, fileId))?.attachmentId).toBeNull();
    expect(await pendingOutbox(db, NOW)).toHaveLength(0);
    expect(await pendingOutbox(db, new Date(NOW.getTime() + 10 * 60_000))).toHaveLength(1);
  });

  it('адаптер без поддержки вложений закрывает строку с причиной', async () => {
    const db = await createTestDb();
    const { userId } = await seedWithFile(db, 'f@f.f', '666');
    await enqueueEvent(db, userId, 'instagram', comment('чеклист'));

    // Обычный отправитель текста — вложения он не умеет (так будет у TikTok)
    const sender = new FakeSender();
    const worker = deps(db, sender, dir);
    await runIntake(worker, NOW);
    await runDelivery(worker, NOW);

    expect(await pendingOutbox(db, new Date('2030-01-01T00:00:00Z'))).toHaveLength(0);
  });

  it('S11: файл клиента A не уходит в диалоге клиента B', async () => {
    const db = await createTestDb();
    const a = await seedWithFile(db, 'a2@a.a', '777');
    const b = await createUser(db, { email: 'b2@b.b', passwordHash: 'x' });
    await connectAccount(db, b, { platform: 'instagram', externalAccountId: '888', token: 'т-B' }, KEY);

    // Клиент B ссылается на чужой файл — так может выглядеть подмена id в форме
    await createAutomation(db, b, {
      name: 'Чужой чеклист', triggerType: 'contains', triggerValue: 'чеклист',
      steps: [{ say: 'Держите', fileId: a.fileId }],
    });
    await enqueueEvent(db, b, 'instagram', comment('чеклист'));

    const sender = new FakeAttachmentSender();
    const worker = deps(db, sender, dir);
    await runIntake(worker, NOW);
    await runDelivery(worker, NOW);

    expect(sender.uploads).toHaveLength(0);
    expect(sender.attachments).toHaveLength(0);
  });
});
