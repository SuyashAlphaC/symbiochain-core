import 'dotenv/config';
import { Pool } from 'pg';
import { Prisma } from './generated/prisma/client.js';
import { databaseConnectionUrl } from './database-connection.js';
import { hardenBackendTables } from './database-access.js';

async function main() {
  const url = process.env.DIRECT_DATABASE_URL || process.env.DATABASE_URL;
  if (!url) throw new Error('Database URL is required');
  const pool = new Pool({
    connectionString: databaseConnectionUrl(url),
    max: 1,
    connectionTimeoutMillis: 10000,
  });
  try {
    const client = await pool.connect();
    try {
      const result = await hardenBackendTables(client, [
        ...Object.values(Prisma.ModelName),
        '_prisma_migrations',
      ]);
      console.log(JSON.stringify({ databaseAccess: 'SERVER_ONLY', ...result }));
    } finally {
      client.release();
    }
  } finally {
    await pool.end();
  }
}
await main().catch((error) => {
  console.error(
    JSON.stringify({
      error: 'DATABASE_HARDENING_FAILED',
      code: typeof error?.code === 'string' ? error.code : 'SETUP_REQUIRED',
    }),
  );
  process.exitCode = 1;
});
