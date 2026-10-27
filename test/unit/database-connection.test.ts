import { describe, expect, it } from 'vitest';
import { databaseConnectionUrl } from '../../src/database-connection.js';
describe('hosted database connections', () => {
  it('preserves local PostgreSQL connections', () => {
    const local = 'postgresql://symbio:local@localhost:55439/symbiochain_test';
    expect(databaseConnectionUrl(local)).toBe(local);
  });
  it('requires verified TLS for Supabase and preserves encoded credentials and CA settings', () => {
    const url = new URL(
      databaseConnectionUrl(
        'postgresql://postgres.test:fake%40password@aws-0-ap-south-1.pooler.supabase.com:5432/postgres?sslmode=disable&sslrootcert=%2Ftmp%2Ftest-ca.crt',
      ),
    );
    expect(url.searchParams.get('sslmode')).toBe('verify-full');
    expect(url.searchParams.get('sslrootcert')).toBe('/tmp/test-ca.crt');
    expect(url.password).toBe('fake%40password');
  });
  it('rejects transaction pooling for this persistent backend', () => {
    expect(() =>
      databaseConnectionUrl(
        'postgresql://test:fake@aws-0-ap-south-1.pooler.supabase.com:6543/postgres',
      ),
    ).toThrow('session pooler');
  });
  it('uses the bundled provider CA by default', () => {
    const url = new URL(
      databaseConnectionUrl(
        'postgresql://test:fake@aws-0-ap-south-1.pooler.supabase.com:5432/postgres',
      ),
    );
    expect(url.searchParams.get('sslrootcert')).toMatch(/\/certs\/supabase-root\.crt$/);
    expect(url.searchParams.get('sslmode')).toBe('verify-full');
  });
  it('does not include a malformed secret in connection errors', () => {
    const secret = 'not-a-url-with-private-password';
    try {
      databaseConnectionUrl(secret);
      throw new Error('Expected rejection');
    } catch (error) {
      expect(String(error)).not.toContain(secret);
    }
    expect(() => databaseConnectionUrl('https://example.com')).toThrow('PostgreSQL');
  });
});
