# Deployment

The selected demo stack is Supabase PostgreSQL, a Render Docker web service, and an optional cron-job.org availability check. LIVE and PAPER share code but never share accounting modes. Use separate databases/environments for demonstrations and funded operation.

## Verified deployment

The PAPER service is live at [operator dashboard](https://symbiochain-core.onrender.com/dashboard), [API documentation](https://symbiochain-core.onrender.com/docs), and [public readiness](https://symbiochain-core.onrender.com/readyz). Source is the private [GitHub repository](https://github.com/SuyashAlphaC/symbiochain-core). Deployment `dep-dbhn8a0473hc73aeabpg` runs revision `10964bb497bcdb283a2fe3fc30569f89b1c187dd`; automatic deployments are disabled.

The [hosted verification record](../artifacts/hosted-paper-verification.json) captures authenticated HTTPS and WSS replay, three fresh worker heartbeats, a closed PAPER cycle and balanced journals. Supabase has seven applied migrations, verified client TLS, RLS on 18 backend tables and no Data API table grants. Application tokens and the persistent evidence key remain in the ignored local `.env` and Render runtime variables. The Render/cron management keys stay local.

cron-job.org job `8735734` is enabled every five minutes against `/readyz`, with email notifications disabled. Its configuration was read back and checked; the first two scheduled requests returned HTTP 200. Scheduled-execution evidence is recorded separately in the [hosting preflight](../artifacts/hosting-preflight.json). The bundled dashboard uses the same origin and needs no additional CORS entry. Configure `CORS_ORIGINS` for a separately hosted teammate frontend.

## Supabase and Render

Use a dedicated Supabase database. Set `DATABASE_URL` to the **session pooler on port 5432** from the project's Connect dialog. Persistent workers and migration sessions need session semantics; this backend rejects transaction-pooler port 6543. Percent-encode reserved characters in passwords and replace placeholder brackets. An optional `DIRECT_DATABASE_URL` overrides the migration/hardening connection only. Supabase direct endpoints can require IPv6; the session pooler supports IPv4 without that add-on. See [Supabase connection guidance](https://supabase.com/docs/guides/database/connecting-to-postgres).

Supabase connections use `sslmode=verify-full` and the [bundled public provider CA](../certs/README.md); a supplied `sslrootcert` path takes precedence. Certificate and hostname verification stay enabled. `DATABASE_POOL_MAX=3` caps each process's pool; the combined service can therefore hold up to six runtime connections, plus a temporary migration/hardening connection during startup.

After migrations, `npm run db:harden` enables RLS on the backend's tables and removes public, anonymous, authenticated and service-role Data API grants from those tables and their owned sequences. It does not alter unrelated tables. Native table-owner access remains available to Prisma. This is a server-only database: the frontend calls Fastify, never Supabase directly. Disable the project's Data API in its dashboard if it is unused. See [securing the Data API](https://supabase.com/docs/guides/api/securing-your-api).

[`render.yaml`](../render.yaml) defines one free Docker web service in PAPER mode. It uses [`scripts/start-render.sh`](../scripts/start-render.sh) to apply migrations and table protection before starting the API and all three worker lanes. The supervisor stops both processes when either exits, and forwards termination to both. The database holds jobs, event cursors, encrypted evidence and balances across service restarts; no persistent Render disk is needed.

Connect the dedicated GitHub repository to Render, then create a Blueprint from `render.yaml`, or create an equivalent Docker web service. Use `bash scripts/start-render.sh` as its Docker command and `/readyz` as its health check. Supply the following through Render's environment settings, never source or build arguments:

- `DATABASE_URL`: the dedicated session-pooler connection.
- `ADMIN_TOKEN` and `READ_TOKEN`: different random tokens, at least 32 characters. The Blueprint can generate these.
- `EVIDENCE_ENCRYPTION_KEY`: exactly 64 hex characters, shared by API/worker and preserved with database backups. Render's generated base64 values are unsuitable for this field.
- `CORS_ORIGINS`: comma-separated exact frontend origins. Leave empty until the frontend's origin is known if browser access is not needed yet.

Keep `EXECUTION_MODE=PAPER` and `LIVE_TRADING_ENABLED=false`. Render supplies `PORT`. Observe the actual deploy reaching `live`, then check public readiness, unauthenticated 401 responses, authenticated REST, all three heartbeats, and WSS replay. A successful build alone is insufficient.

The free service is suitable for a demonstrator, with [documented limitations](https://render.com/docs/free): it can sleep after 15 minutes without inbound traffic, restart, exhaust shared free hours, or be suspended for high outbound traffic. A continuous background worker requires a supported paid or independently managed host. A heartbeat does not guarantee uninterrupted execution. WebSocket clients must reconnect using their last durable event cursor; see [Render WebSockets](https://render.com/docs/websocket).

## cron-job.org heartbeat

Use [`deploy/cron-job.example.json`](../deploy/cron-job.example.json) as a REST API creation body after substituting the real HTTPS URL. It is disabled by default. Enable it only after `/readyz` responds successfully. The schedule checks readiness every five minutes; it does not execute trades or authenticate as an administrator. Configure no wallet keys or application tokens in the monitor.

The free monitor's request timeout can expire during a Render cold start. Its success proves API/database availability at that instant, not healthy workers, attested inference, profit or permanent uptime. Worker activity is visible in authenticated `/api/swarm` responses. See the [cron API](https://docs.cron-job.org/rest-api.html) and [service limits](https://cron-job.org/en/faq/). The API requires a separate `CRON_JOB_API_KEY`; an example file alone does not create a job.

## Docker

```bash
docker build -t symbiochain-core .
docker compose -p symbiochain up -d postgres
```

The image runs as the non-root `node` user. It contains compiled TypeScript, generated Prisma code and the migration CLI. Its `.dockerignore` excludes keys, `.env`, local data, private artifacts and Rust build directories. Runtime environment variables must be injected by the host.

Run `npm run db:migrate` once per release against the target database before starting the new workers. The API starts with `node dist/main.js`; workers start with `node dist/worker-main.js`. Optionally set `WORKER_ROLE=SCOUT`, `BRAIN`, or `HAND` for separate services. Leave it unset to run all three lanes in one worker.

For an isolated Linux PAPER smoke test with the local PostgreSQL port:

```bash
docker run --rm --network host --env-file .env -e PORT=3102 symbiochain-core
```

Do not use host networking for public hosting. Bind behind a TLS reverse proxy, restrict the database network, and configure exact CORS origins. `/healthz` tests process liveness; `/readyz` tests database access. Worker heartbeat is shown by `/api/swarm`.

## Railway

Railway remains an alternative configuration. On 2026-10-27, dedicated project and service creation were rejected with a provisioning-limit error despite Hobby metadata. Follow-up showed no created services or pending deployment work. No subscription was changed; this restriction does not apply to the selected Render/Supabase path.

The single configuration is [`.railway/railway.ts`](../.railway/railway.ts), with an isolated, locked Railway SDK package. New services use Infrastructure as Code; the legacy TOML files were removed after semantic preservation checks. The CLI reports legacy Config as Code retirement on 2026-12-01. No remote legacy service was found or cut over.

Install with `npm ci --prefix .railway`, then run `npm run infra:check`. Link the intended project/environment explicitly before `railway config plan`. The current reviewed plan proposes exactly three additions: `symbiochain-postgres`, `symbiochain-api`, and `symbiochain-worker`; zero changes and zero destructions. It has not been applied. See the [authoring guide](../.railway/README.md) and [public plan summary](../artifacts/infrastructure-plan.json).

Initial application secrets are supplied through the CLI process environment, not source. Dedicated PAPER deployment values are kept locally in `.data/railway-paper-secrets.json` and `.data/railway-paper-secrets.env`, with mode 0600. The private saved plan can contain those values and is also mode 0600; only its redacted summary belongs in submission evidence. Preserve the deployed evidence key on later runs. The API and worker reference the same database and application keys.

After account provisioning is enabled, review/approve the exact plan before applying it. Source upload is a separate `railway up` operation from this local repository, targeted explicitly at each new service; no GitHub source or repository has been assumed. Observe `SUCCESS` for the submitted deployment IDs, then verify public readiness, REST authorization, all three worker heartbeats and event replay before claiming a hosted demonstration.

The API config builds the Dockerfile, runs migrations before deployment, starts `dist/main.js`, and checks `/readyz`. The worker starts `dist/worker-main.js` and has no HTTP health-check path. If using three worker services, set each role explicitly. PostgreSQL leases distribute work; HTTP replica count does not create duplicate job ownership.

Set `HOST=0.0.0.0`; Railway provides `PORT` to the API. Set `CORS_ORIGINS` to the actual frontend origin and use HTTPS/WSS URLs in the frontend. Generate new admin/read tokens and a 32-byte encryption key. Keep all wallet/API/session credentials in Railway variables, not repository files or build arguments. The offline treasury owner key does not belong on the service.

Begin with PAPER and verify API authorization, event replay and recovery after stopping/restarting a worker. Dedicated funded mainnet credentials and measurement approvals are prerequisites for LIVE; changing a mode variable alone is insufficient.

## Neon/PostgreSQL

Use PostgreSQL 16-compatible semantics and TLS for remote connections. The Prisma runtime uses `@prisma/adapter-pg`, with a small connection pool and transaction timeouts. Prefer a direct database connection for migrations; use a provider-supported runtime endpoint that preserves the interactive transaction semantics used by the worker.

Run migrations against an isolated staging branch first. The tests deliberately truncate their database and require a name ending in `_test`. They must never use the production URL. Back up the database and its evidence-encryption key together; restoring one without the other loses evidence access.

The outbox and job queue are stored in PostgreSQL, not in process memory. No Redis dependency or in-memory database-change emitter is required. Event retention is currently indefinite; archive older events before implementing pruning so reconnect cursors are handled deliberately.

## PM2 alternative

After installing PM2 on a managed VM:

```bash
npm ci
npm run db:generate
npm run db:migrate
npm run build
pm2 start ecosystem.config.cjs
pm2 save
```

The config runs the API and three separate worker lanes. Do not nest PM2 inside Railway's restart supervisor. On process shutdown workers finish their current iteration and stop claiming jobs; abandoned leases expire and are recovered. A blocked external call can take up to its request timeout before shutdown.

## Release checks

Use the CI workflow under `.github/workflows/ci.yml`: TypeScript checks, unit/integration tests, migration replay, paper demo, npm high/critical audit gate, Rust tests, WASM build and local chain integration. Re-run contract/adapter checks after dependency or network-protocol changes. Pin the resulting WASM hash in release evidence, review contract policy, and keep mainnet execution evidence separate from sandbox output.

The deployed PAPER operator profile explicitly enables `ENABLE_CHAOS_DEMO=true` and uses `NFT_SHARE_BPS=100` for simulated cost-gated receipt rights. Hosted Chromium verification records a real worker crash, automatic host recovery, the same Scout job on attempt two, secure WebSocket reconnection, approved costs and a closed cycle. See [hosted operator evidence](../artifacts/operator-hosted-verification.json). LIVE refuses chaos controls; this demonstration performs no mainnet trade or actual NFT mint.
