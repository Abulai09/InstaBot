import { describe, expect, it } from 'vitest';
import { withTls } from '../../src/storage/tls.js';

const TAIL = 'sslmode=verify-full&sslrootcert=./certs/supabase-prod-ca-2021.crt';

describe('шифрование до базы по умолчанию', () => {
  it('строка из Supabase без хвоста получает проверку сервера', () => {
    // Supabase отдаёт строку без sslmode, и без этой функции соединение
    // молча шло бы без проверки подлинности сервера
    expect(withTls('postgresql://u:p@aws-0-eu-central-1.pooler.supabase.com:5432/postgres'))
      .toBe(`postgresql://u:p@aws-0-eu-central-1.pooler.supabase.com:5432/postgres?${TAIL}`);
  });

  it('другие параметры строки сохраняются', () => {
    expect(withTls('postgres://u:p@db.example.com/x?application_name=bot'))
      .toBe(`postgres://u:p@db.example.com/x?application_name=bot&${TAIL}`);
  });

  it('явный sslmode в строке не трогается — решение владельца строки', () => {
    const url = 'postgresql://u:p@db.example.com/x?sslmode=verify-full&sslrootcert=./other.crt';
    expect(withTls(url)).toBe(url);
  });

  it('локальная база остаётся без TLS', () => {
    for (const host of ['localhost', '127.0.0.1', '[::1]']) {
      const url = `postgresql://u:p@${host}:5432/test`;
      expect(withTls(url)).toBe(url);
    }
  });

  it('пароль со спецсимволами не портится', () => {
    const url = 'postgresql://u:p%40ss%2Fw0rd@db.example.com:5432/x';
    expect(withTls(url)).toBe(`${url}?${TAIL}`);
  });
});
