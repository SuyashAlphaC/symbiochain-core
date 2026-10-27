import type { PoolClient } from 'pg';
const identifier = (value: string) => `"${value.replaceAll('"', '""')}"`;

/** Server-only tables have no public Data API grants or row policies. Owners retain native access. */
export async function hardenBackendTables(client: PoolClient, tables: readonly string[]) {
  if (!tables.length || new Set(tables).size !== tables.length)
    throw new Error('Invalid backend table list');
  await client.query('BEGIN');
  try {
    await client.query("SET LOCAL lock_timeout = '5s'");
    await client.query("SET LOCAL statement_timeout = '15s'");
    const found = await client.query<{ relname: string }>(
      "SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relkind IN ('r','p') AND c.relname=ANY($1::text[])",
      [tables],
    );
    if (found.rowCount !== tables.length)
      throw new Error('Run all Prisma migrations before database hardening');
    const roles = await client.query<{ rolname: string }>(
      'SELECT rolname FROM pg_roles WHERE rolname=ANY($1::text[])',
      [['anon', 'authenticated', 'service_role']],
    );
    const recipients = ['PUBLIC', ...roles.rows.map((role) => identifier(role.rolname))].join(', ');
    for (const table of tables) {
      const qualified = `${identifier('public')}.${identifier(table)}`;
      await client.query(`ALTER TABLE ${qualified} ENABLE ROW LEVEL SECURITY`);
      await client.query(`REVOKE ALL PRIVILEGES ON TABLE ${qualified} FROM ${recipients}`);
      for (const role of roles.rows) {
        const access = await client.query<{ allowed: boolean }>(
          "SELECT has_table_privilege($1, $2::regclass, 'SELECT,INSERT,UPDATE,DELETE') AS allowed",
          [role.rolname, qualified],
        );
        if (access.rows[0]?.allowed)
          throw new Error('A Data API role retains inherited access to backend tables');
      }
    }
    const sequences = await client.query<{ relname: string }>(
      "SELECT DISTINCT s.relname FROM pg_class s JOIN pg_namespace n ON n.oid=s.relnamespace JOIN pg_depend d ON d.objid=s.oid AND d.deptype IN ('a','i') JOIN pg_class t ON t.oid=d.refobjid JOIN pg_namespace tn ON tn.oid=t.relnamespace WHERE s.relkind='S' AND n.nspname='public' AND tn.nspname='public' AND t.relname=ANY($1::text[])",
      [tables],
    );
    for (const sequence of sequences.rows)
      await client.query(
        `REVOKE ALL PRIVILEGES ON SEQUENCE ${identifier('public')}.${identifier(sequence.relname)} FROM ${recipients}`,
      );
    await client.query('COMMIT');
    return {
      protectedTables: tables.length,
      protectedSequences: sequences.rowCount,
      dataApiRoles: roles.rows.map((role) => role.rolname),
    };
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  }
}
