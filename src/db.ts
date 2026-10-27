import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from './generated/prisma/client.js';
import { databaseConnectionUrl } from './database-connection.js';
export function createDatabase(url: string, maxConnections = 10): PrismaClient {
  return new PrismaClient({
    adapter: new PrismaPg({
      connectionString: databaseConnectionUrl(url),
      max: maxConnections,
      connectionTimeoutMillis: 5000,
      idleTimeoutMillis: 30000,
    }),
  });
}
export type Database = ReturnType<typeof createDatabase>;
