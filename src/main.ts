import { loadConfig } from './config.js';
import { createDatabase } from './db.js';
import { Store } from './store.js';
import { createApp } from './app.js';

const config = loadConfig();
const db = createDatabase(config.DATABASE_URL, config.DATABASE_POOL_MAX);
const store = new Store(db, config);
await store.initialize();
const app = await createApp(store);
let stopping = false;
for (const signal of ['SIGTERM', 'SIGINT'] as const)
  process.on(signal, () => {
    if (stopping) return;
    stopping = true;
    void app
      .close()
      .then(() => db.$disconnect())
      .then(() => process.exit(0));
  });
await app.listen({ host: config.HOST, port: config.PORT });
