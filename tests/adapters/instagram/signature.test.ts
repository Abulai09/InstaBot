import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { verifyHandshake, verifySignature } from '../../../src/adapters/instagram/signature.js';

const SECRET = 'app-secret-для-тестов';
const body = Buffer.from(JSON.stringify({ object: 'instagram', entry: [] }), 'utf8');
const valid = 'sha256=' + createHmac('sha256', SECRET).update(body).digest('hex');

describe('S1: подпись вебхука', () => {
  it('принимает подпись, посчитанную от тех же байт', () => {
    expect(verifySignature(body, valid, SECRET)).toBe(true);
  });

  it('отвергает подпись от другого секрета', () => {
    const foreign = 'sha256=' + createHmac('sha256', 'чужой').update(body).digest('hex');
    expect(verifySignature(body, foreign, SECRET)).toBe(false);
  });

  it('отвергает подпись от изменённого тела', () => {
    const tampered = Buffer.from(JSON.stringify({ object: 'instagram', entry: [1] }), 'utf8');
    expect(verifySignature(tampered, valid, SECRET)).toBe(false);
  });

  it('отвергает отсутствующий, пустой и обрезанный заголовок', () => {
    expect(verifySignature(body, undefined, SECRET)).toBe(false);
    expect(verifySignature(body, '', SECRET)).toBe(false);
    expect(verifySignature(body, valid.slice(0, 20), SECRET)).toBe(false);
  });

  it('отвергает заголовок без префикса sha256= и с чужим алгоритмом', () => {
    expect(verifySignature(body, valid.replace('sha256=', ''), SECRET)).toBe(false);
    expect(verifySignature(body, valid.replace('sha256=', 'sha1='), SECRET)).toBe(false);
  });

  it('не падает на заголовке, который не является hex', () => {
    expect(verifySignature(body, 'sha256=зззз', SECRET)).toBe(false);
  });
});

describe('S2: GET-хендшейк', () => {
  const TOKEN = 'verify-token';

  it('возвращает challenge при совпадении токена', () => {
    const q = { 'hub.mode': 'subscribe', 'hub.verify_token': TOKEN, 'hub.challenge': '1158201444' };
    expect(verifyHandshake(q, TOKEN)).toBe('1158201444');
  });

  it('возвращает undefined при чужом токене', () => {
    const q = { 'hub.mode': 'subscribe', 'hub.verify_token': 'чужой', 'hub.challenge': '1158201444' };
    expect(verifyHandshake(q, TOKEN)).toBeUndefined();
  });

  it('возвращает undefined при mode не subscribe и при отсутствии полей', () => {
    const wrongMode = { 'hub.mode': 'unsubscribe', 'hub.verify_token': TOKEN, 'hub.challenge': '1' };
    expect(verifyHandshake(wrongMode, TOKEN)).toBeUndefined();
    expect(verifyHandshake({}, TOKEN)).toBeUndefined();
  });

  it('не отражает challenge, пока токен не совпал', () => {
    const q = { 'hub.mode': 'subscribe', 'hub.verify_token': '', 'hub.challenge': '<script>' };
    expect(verifyHandshake(q, TOKEN)).toBeUndefined();
  });
});
