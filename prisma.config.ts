import 'dotenv/config';
import { defineConfig } from 'prisma/config';
import { databaseConnectionUrl } from './src/database-connection.js';
export default defineConfig({
  schema: 'prisma/schema.prisma',
  migrations: { path: 'prisma/migrations' },
  datasource: {
    url: databaseConnectionUrl(
      process.env.DIRECT_DATABASE_URL ||
        process.env.DATABASE_URL ||
        'postgresql://symbio:symbio_local@localhost:55439/symbiochain',
    ),
  },
});
