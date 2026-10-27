import { defineRailway, empty, postgres, preserve, project, service } from 'railway/iac';

// First provisioning supplies fresh values through the local environment. Later plans
// preserve the deployed values unless an operator explicitly supplies replacements.
const secret = (name: string) => process.env[name] || preserve();

export default defineRailway((ctx) => {
  const database = postgres('symbiochain-postgres');
  const api = service('symbiochain-api', {
    source: empty(),
    build: { builder: 'DOCKERFILE', dockerfilePath: 'Dockerfile' },
    start: 'node dist/main.js',
    preDeploy: 'npm run db:migrate',
    healthcheck: '/readyz',
    healthcheckTimeout: 30,
    deploy: { restartPolicyType: 'ON_FAILURE', restartPolicyMaxRetries: 10 },
    env: {
      NODE_ENV: 'production',
      HOST: '0.0.0.0',
      EXECUTION_MODE: 'PAPER',
      LIVE_TRADING_ENABLED: 'false',
      DATABASE_URL: database.env.DATABASE_URL,
      ADMIN_TOKEN: secret('SYMBIO_ADMIN_TOKEN'),
      READ_TOKEN: secret('SYMBIO_READ_TOKEN'),
      EVIDENCE_ENCRYPTION_KEY: secret('SYMBIO_EVIDENCE_ENCRYPTION_KEY'),
    },
  });
  const worker = service('symbiochain-worker', {
    source: empty(),
    build: { builder: 'DOCKERFILE', dockerfilePath: 'Dockerfile' },
    start: 'node dist/worker-main.js',
    deploy: { restartPolicyType: 'ON_FAILURE', restartPolicyMaxRetries: 10 },
    env: {
      NODE_ENV: 'production',
      EXECUTION_MODE: 'PAPER',
      LIVE_TRADING_ENABLED: 'false',
      DATABASE_URL: database.env.DATABASE_URL,
      ADMIN_TOKEN: api.env.ADMIN_TOKEN,
      READ_TOKEN: api.env.READ_TOKEN,
      EVIDENCE_ENCRYPTION_KEY: api.env.EVIDENCE_ENCRYPTION_KEY,
    },
  });
  // Keep the linked project's name; importing this config must not rename it.
  return project(ctx.projectName || 'symbiochain-core', { resources: [database, api, worker] });
});
