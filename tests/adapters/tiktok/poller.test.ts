import { describe, expect, it } from 'vitest';
import { createTestDb } from '../../storage/helpers.js';
import { createUser, setUserDisabled } from '../../../src/storage/queries/users.js';
import { connectAccount } from '../../../src/storage/queries/accounts.js';
import { takePendingEvents } from '../../../src/storage/queries/runtime.js';
import { TikTokAdapter } from '../../../src/adapters/tiktok/adapter.js';
import { pollAllTikTokAccounts } from '../../../src/adapters/tiktok/poller.js';

const KEY = 'a'.repeat(64);

describe('pollAllTikTokAccounts: фоновый опрос TikTok', () => {
  it('опрашивает подключённые TikTok-аккаунты и ставит новые события в очередь', async () => {
    const db = await createTestDb();
    const userId = await createUser(db, { email: 'client@tt.c', passwordHash: 'x' });
    await connectAccount(db, userId, { platform: 'tiktok', externalAccountId: 'biz-1', token: 'tt-tok' }, KEY);

    const fetchFn = async (): Promise<Response> => {
      return new Response(JSON.stringify({
        code: 0,
        message: 'OK',
        data: {
          comments: [
            {
              comment_id: 'c-100',
              video_id: 'v-100',
              user_id: 'u-100',
              text: 'Сколько стоит?',
              create_time: 1725800000,
            },
          ],
        },
      }));
    };

    const adapter = new TikTokAdapter({ fetchFn, maxTextLength: 2000 });

    const count = await pollAllTikTokAccounts(db, adapter, KEY);
    expect(count).toBe(1);

    const events = await takePendingEvents(db);
    expect(events).toHaveLength(1);
    expect(events[0]?.userId).toBe(userId);
    expect(events[0]?.platform).toBe('tiktok');
    const parsed = JSON.parse(events[0]?.payloadJson ?? '{}');
    expect(parsed.text).toBe('Сколько стоит?');
    expect(parsed.dedupeKey).toBe('tiktok:comment:c-100');
  });

  it('дедупликация: повторный опрос тех же комментариев не дублирует события', async () => {
    const db = await createTestDb();
    const userId = await createUser(db, { email: 'client2@tt.c', passwordHash: 'x' });
    await connectAccount(db, userId, { platform: 'tiktok', externalAccountId: 'biz-2', token: 'tt-tok' }, KEY);

    const fetchFn = async (): Promise<Response> => {
      return new Response(JSON.stringify({
        code: 0,
        message: 'OK',
        data: {
          comments: [
            {
              comment_id: 'c-101',
              video_id: 'v-101',
              user_id: 'u-101',
              text: 'Цена',
              create_time: 1725800000,
            },
          ],
        },
      }));
    };

    const adapter = new TikTokAdapter({ fetchFn, maxTextLength: 2000 });

    const firstRun = await pollAllTikTokAccounts(db, adapter, KEY);
    expect(firstRun).toBe(1);

    const secondRun = await pollAllTikTokAccounts(db, adapter, KEY);
    expect(secondRun).toBe(0);

    expect(await takePendingEvents(db)).toHaveLength(1);
  });

  it('игнорирует отключённых клиентов (S17)', async () => {
    const db = await createTestDb();
    const userId = await createUser(db, { email: 'disabled@tt.c', passwordHash: 'x' });
    await connectAccount(db, userId, { platform: 'tiktok', externalAccountId: 'biz-dis', token: 'tt-tok' }, KEY);
    await setUserDisabled(db, userId, new Date('2026-09-09T12:00:00Z'));

    const fetchFn = async (): Promise<Response> => {
      return new Response(JSON.stringify({
        code: 0,
        message: 'OK',
        data: {
          comments: [{ comment_id: 'c-dis', video_id: 'v-dis', user_id: 'u-1', text: 'x', create_time: 1725800000 }],
        },
      }));
    };

    const adapter = new TikTokAdapter({ fetchFn, maxTextLength: 2000 });
    const count = await pollAllTikTokAccounts(db, adapter, KEY);
    expect(count).toBe(0);
    expect(await takePendingEvents(db)).toHaveLength(0);
  });
});
