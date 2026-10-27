import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Pool, type PoolClient } from 'pg';
import { hardenBackendTables } from '../../src/database-access.js';
const url =
  process.env.TEST_DATABASE_URL ||
  'postgresql://symbio:symbio_local@localhost:55439/symbiochain_test';
if (!new URL(url).pathname.endsWith('_test')) throw new Error('Isolated test database required');
const pool = new Pool({ connectionString: url, max: 1 });
let client: PoolClient;
const createdRoles: string[] = [];
const table = 'BackendAccessFixture';
beforeAll(async () => {
  client = await pool.connect();
  for (const role of ['anon', 'authenticated', 'service_role']) {
    const found = await client.query('SELECT 1 FROM pg_roles WHERE rolname=$1', [role]);
    if (!found.rowCount) {
      await client.query(`CREATE ROLE "${role}" NOLOGIN`);
      createdRoles.push(role);
    }
  }
});
beforeEach(async () => {
  await client.query(`CREATE TABLE "${table}" (id serial PRIMARY KEY, payload text NOT NULL)`);
  await client.query(`INSERT INTO "${table}" (payload) VALUES ('private')`);
  await client.query(`GRANT ALL ON TABLE "${table}" TO anon, authenticated, service_role`);
});
afterEach(async () => {
  await client.query('RESET ROLE');
  await client.query(`DROP TABLE IF EXISTS "${table}" CASCADE`);
});
afterAll(async () => {
  for (const role of createdRoles) await client.query(`DROP ROLE "${role}"`);
  client.release();
  await pool.end();
});
describe('server-only database access', () => {
  it('preserves backend data while revoking Data API table/sequence access', async () => {
    const result = await hardenBackendTables(client, [table]);
    expect(result.protectedTables).toBe(1);
    expect(result.protectedSequences).toBe(1);
    expect((await client.query(`SELECT payload FROM "${table}"`)).rows).toEqual([
      { payload: 'private' },
    ]);
    for (const role of ['anon', 'authenticated', 'service_role']) {
      expect(
        (
          await client.query(
            "SELECT has_table_privilege($1,$2::regclass,'SELECT,INSERT,UPDATE,DELETE') AS allowed",
            [role, `"public"."${table}"`],
          )
        ).rows[0].allowed,
      ).toBe(false);
    }
    await client.query('SET ROLE anon');
    await expect(client.query(`SELECT * FROM "${table}"`)).rejects.toMatchObject({ code: '42501' });
    await client.query('RESET ROLE');
  });
  it('keeps RLS default-deny if an anonymous SELECT grant is later reintroduced', async () => {
    await hardenBackendTables(client, [table]);
    await client.query(`GRANT SELECT ON TABLE "${table}" TO anon`);
    await client.query('SET ROLE anon');
    expect((await client.query(`SELECT * FROM "${table}"`)).rows).toEqual([]);
    await client.query('RESET ROLE');
    expect(
      (await client.query(`SELECT count(*)::int AS count FROM "${table}"`)).rows[0].count,
    ).toBe(1);
  });
  it('is idempotent and rolls back when the expected schema is incomplete', async () => {
    await expect(hardenBackendTables(client, [table, 'MissingBackendTable'])).rejects.toThrow(
      'migrations',
    );
    expect(
      (
        await client.query('SELECT relrowsecurity FROM pg_class WHERE oid=$1::regclass', [
          `"public"."${table}"`,
        ])
      ).rows[0].relrowsecurity,
    ).toBe(false);
    await hardenBackendTables(client, [table]);
    await hardenBackendTables(client, [table]);
    expect(
      (await client.query(`SELECT count(*)::int AS count FROM "${table}"`)).rows[0].count,
    ).toBe(1);
  });
});
