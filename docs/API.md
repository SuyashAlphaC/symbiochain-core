# Frontend integration contract

The server uses Fastify and **raw WebSockets**, not Socket.IO. `/docs` exposes Swagger UI; `/openapi.json` requires read authentication. Amounts and sequence numbers are strings to preserve precision. Dates are UTC ISO 8601.

## Authentication

Send `Authorization: Bearer <token>` on REST calls. `READ_TOKEN` can inspect application data. `ADMIN_TOKEN` can inspect and mutate. Tokens must differ and contain at least 32 characters. Configure exact `CORS_ORIGINS`; the backend does not use browser cookies. Use HTTPS/WSS when hosted.

Normal responses omit signed transaction bytes, private keys, raw model prompts, and encrypted evidence. The evidence export is an administrator-only exception and sends `Cache-Control: no-store`.

## REST routes

| Method and path                         | Access | Result                                                                                           |
| --------------------------------------- | ------ | ------------------------------------------------------------------------------------------------ |
| `GET /healthz`                          | Public | API liveness                                                                                     |
| `GET /readyz`                           | Public | Database readiness; 503 when unavailable                                                         |
| `GET /api/health`, `/api/swarm`         | Read   | Reserves, gross P&L, measured inference cost, credit observation, worker heartbeat, cycle counts |
| `GET /api/policy`                       | Read   | Persisted backend policy and revision                                                            |
| `GET /api/cycles?limit=25&cursor=UUID`  | Read   | Bounded newest-first cycle list; maximum 100                                                     |
| `POST /api/cycles`                      | Admin  | Validate/create an idempotent proposal                                                           |
| `GET /api/cycles/:id`                   | Read   | Decisions, safe quote/assessment, transactions, proofs, job errors, inference and leg status     |
| `GET /api/proofs/:id`                   | Read   | Recorded proof hashes, measurement, signer, verification scope                                   |
| `GET /api/verify-tee?hash=HEX_SHA256`   | Read   | Matching recorded NEAR AI verification; explicitly not a fresh verification                      |
| `GET /api/cycles/:id/evidence`          | Admin  | Private archive with raw inference evidence; no signed wallet transactions                       |
| `GET /api/events?after=0&limit=100`     | Read   | Durable event replay; maximum 250                                                                |
| `POST /api/admin/fund`                  | Admin  | PAPER-only synthetic funding                                                                     |
| `POST /api/admin/policy`                | Admin  | Revision-checked backend policy update                                                           |
| `POST /api/admin/cycles/:id/cost-basis` | Admin  | Immutable settlement-bound accountant cost approval; required before nonzero revenue rights      |
| `POST /api/admin/pause`, `/resume`      | Admin  | Stop/resume new backend spending                                                                 |
| `POST /api/admin/agents/SCOUT/pause`    | Admin  | Pause a lane; role is SCOUT/BRAIN/HAND; action is pause/resume                                   |

Lane pause is a durable control, not a shell command that kills arbitrary processes. In-flight work can finish its current step. The independent NEAR contract pause is an owner operation; see the runbook.

## Create a paper cycle

Send `Idempotency-Key: frontend-demo-0001` plus the admin bearer token:

```json
{
  "strategy": "round-trip",
  "originChain": "near:paper",
  "destinationChain": "eip155:31337",
  "originAsset": "USDC",
  "intermediateAsset": "WNEAR",
  "amountAtoms": "5000000",
  "recipient": "paper.treasury",
  "refundTo": "paper.treasury",
  "slippageBps": 50,
  "expiresAt": "REPLACE_WITH_UTC_TIME_WITHIN_THE_NEXT_HOUR"
}
```

The first response is 201; a repeat with identical terms returns 200 and the same ID. A changed proposal under that key returns 409. Expired proposals and deadlines more than one hour away are refused. LIVE uses registry asset IDs and derived wallet recipients, not these paper placeholders.

Fund PAPER first with `{"amountAtoms":"20000000","reference":"frontend-capital-0001"}`. References are immutable: changing the amount under the same funding reference returns a conflict.

Update policy with the current `expectedRevision`, for example `{"expectedRevision":1,"maxTradeAtoms":"5000000"}`. Existing DB policy survives restarts; changing environment defaults does not replace it. The owner separately maintains the contract policy.

## WebSocket protocol

Open `/ws` and send within five seconds:

```json
{ "type": "subscribe", "token": "YOUR_READ_TOKEN", "after": "0" }
```

The server replies:

```json
{ "type": "ready", "mode": "PAPER", "cursor": "0" }
```

Then it streams:

```json
{
  "type": "event",
  "seq": "42",
  "mode": "PAPER",
  "topic": "cycle.updated",
  "cycleId": "cycle-uuid",
  "payload": { "id": "cycle-uuid", "state": "ASSESSED", "version": 2, "details": {} },
  "timestamp": "2026-10-27T00:00:00.000Z"
}
```

Persist `seq` after applying an event. Reconnect with the last sequence; deduplicate repeated events. Sequences are globally increasing and can contain gaps for another execution mode. Database event insertion is atomic with the associated state transition. The 250 ms poll interval is not a blockchain finality promise.

Slow clients close with 1013 and resume by cursor. Authentication/protocol failures use 1008; internal stream failure uses 1011; shutdown uses 1001. A subscribe token never appears in URLs. The server sends protocol pings every 20 seconds.

## Display rules

- Always show the execution mode and proof scope. PAPER profit is simulated; REPLAY is historical.
- Display `grossTradingPnlAtoms` as gross. Do not relabel it net profit.
- `survivalHours: null` means unknown; never render it as infinite life or zero hours.
- `LOW_COMPUTE_CREDIT`, `COMPUTE_CREDIT_UNKNOWN`, and `LOW_RESERVE` describe separate resource failures.
- `UNKNOWN`, a pending job, an unresolved inference, or a held return leg is not a successful cycle.
- A recorded TEE hash means the stored evidence passed checks at `verifiedAt`; it does not attest a current connection.
- Internal `agent.payment` events are not external revenue.

Errors are structured as `{ "error":"CODE", "message":"..." }` where appropriate. Validation uses 400, unauthorized calls 401, forbidden mode 403, missing records 404, and financial/idempotency conflicts 409. Request bodies are bounded to 64 KiB; route limits and rate limits remain enforced.

## Operator dashboard and recovery demonstration

`GET /dashboard` serves the operator panel; `/` redirects there. It uses the same-origin REST and WebSocket interfaces. Enter a read or administrator token; the page keeps it in memory and clears it on disconnect/reload. Credentials are never put in URLs or browser storage. Read access disables administrative controls.

`GET /api/capabilities` reports the authenticated caller's administrative capability, execution mode, configured receipt-share setting and whether crash controls are enabled. `GET /api/cycles/:id/economics` reports the exact settlement digest, billed inference, native fee evidence, separately recorded base-asset settlement fees, approved cost components and net after those costs and the receipt budget. Missing approvals produce `null` net values. `ACCOUNTANT_APPROVED` does not mean independently verified realized profit, and full-business runway remains unknown.

For nonzero `NFT_SHARE_BPS`, both PAPER and LIVE wait at `RECONCILED` until a settlement-bound cost approval is recorded. Approval wakes an unleased receipt job waiting on `COST_BASIS_REQUIRED`. PAPER receipts expose simulated rights and explicitly report `mintedOnChain: false`. The panel's simulated-cost prefill is available only for PAPER USDC with six decimals; it is never an actual provider invoice or native-chain valuation.

Administrator-only crash controls:

- `POST /api/admin/demo/crash-worker`, body `{ "cycleId": "UUID", "role": "SCOUT" }` (also BRAIN/HAND). The selected lane must be paused and have an unclaimed job for that cycle. The one-shot command targets that cycle and role.
- `POST /api/admin/demo/cancel-crash` cancels an unconsumed command.

Controls require PAPER, `ENABLE_CHAOS_DEMO=true`, and colocated API/worker processes. The Render supervisor declares colocation. The worker consumes the ephemeral command after claiming the matching durable job and sends **SIGKILL to itself**. It accepts no arbitrary process ID, executable or file path from the API. The host restarts the service; the expired PostgreSQL job lease can then be reclaimed. All three lanes share that worker process in this hosting profile. The dashboard reconnects with its event cursor; it does not describe an agent pause as a process crash. Crash controls are refused in LIVE.
