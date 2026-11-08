# SymbioChain Core

## Supply chain trust boundary: fail-closed policy

**TEE execution status: QUARANTINED. The inference gate is closed.** The hosted LIVE observer performs no inference. Historical PAPER inference uses local fixtures with no enclave or TEE signature.

The November 7 audit used unmodified [Brave near-verifier](https://github.com/brave/near-verifier) against `z-ai/glm-5.3-flash` in **provenance-only mode**. Intel TDX, NVIDIA and gateway TLS/binding subchecks passed. **The deployment was not approved:** the launcher had no accepted signed SLSA provenance; other image/source pins, OS measurements and required gateway services also differed from Brave's policy. Gateway, model and inference-proxy software are not claimed as fully verified. The launcher rebuild exemption does not waive signed provenance. [Raw report and audit scope](artifacts/brave-cli-verification.json).

Paid inference remains gated; we have not changed trust pins to force a pass. [Compose-manager issue #64](https://github.com/nearai/compose-manager/issues/64) concerns reproducible launcher builds and does not establish provenance for our observed digest. **Mainnet economics, external revenue and automatic provider credit purchases remain unproven.** See [the exact approval handoff](docs/TEE_APPROVAL_HANDOFF.md).

**Three agents, one treasury, measurable operating costs.** The [prepaid risk-report path](docs/SERVICE_LOOP.md) lets Scout gather quotes, Brain assess committed terms behind the unchanged TEE gate, and Hand deliver a report without trading. LIVE arbitrage admission defaults to disabled. The trading adapter retains constrained Chain Signatures, settlement reconciliation and internal Intents payments. An operational reserve and a separate inference-spending policy govern real execution.

The backend includes TypeScript/Fastify, PostgreSQL/Prisma, durable workers, a Rust NEAR treasury/NFT contract, EVM and native Solana transfer adapters, encrypted evidence, replayable WebSocket events, and Docker/CI configuration.

**Current production:** the [permanent frontend](https://symbiochain.vercel.app/dashboard) and [backend](https://symbiochain-core.onrender.com/docs) serve **LIVE mainnet observations with execution DISARMED**. Finalized balances, storage collateral, permissions, executable identity and known deployment receipts are real blockchain data. The API starts no worker, and mutations are disabled. [Exact release revisions and verification](artifacts/mainnet-production-verification.json); [activation and rollback runbook](docs/MAINNET_PRODUCTION.md).

**Evidence status:** PostgreSQL recovery tests, real local/testnet contract calls, public signed quotes and authenticated TEE hardware audits have run. Hardware evidence, deployment approval and signed inference remain separate gates; no funded mainnet round trip or verified paid completion is claimed. The [testnet rehearsal](docs/TESTNET_REHEARSAL.md) records its own actual checks and explicit simulations. This repository does not claim that an arbitrage opportunity exists or that the swarm has achieved financial self-sufficiency. See [implementation status](docs/IMPLEMENTATION.md).

**Mainnet foundation — November 7:** [treasury.symbio-fcef733893.near](https://nearblocks.io/address/treasury.symbio-fcef733893.near) is deployed and **paused**, with four funded agent accounts and disabled workers. The dedicated owner is `symbio-fcef733893.near`, controlled by the funding wallet’s existing Meteor recovery key; the temporary deployment key is revoked. [Final on-chain verification](artifacts/mainnet-paused-deployment.json) records nine successful known transactions, balances and the pinned executable. Hosted observation does not unpause this infrastructure or establish TEE-approved execution, trading, external revenue or compute purchases.

For the testnet entry, start with the [judge walkthrough](docs/TESTNET_SUBMISSION.md).
It includes real Sepolia/Solana transaction links, the resumable agent runner,
worker recovery, budget limits and the remaining TEE approval gate.

The [controlled demonstration](docs/CONTROLLED_DEMO.md) records a separate,
owner-signed 0.001 NEAR mainnet funding call while paused and rechecks the
historical faucet-funded testnet distribution/claim. Its 10% testnet allocation
is not a mainnet revenue split. No AI credit was spent.

## Business evidence

The current paired release includes the service, accounting and funding implementations. Exact deployed revisions are in [the production record](artifacts/mainnet-production-verification.json); [earlier service candidates](artifacts/service-loop-release-manifest.json) remain historical evidence. Deployment does not establish that disabled execution paths have completed a real-money cycle.

The [human-in-the-loop metabolic bridge](docs/SERVICE_LOOP.md#human-in-the-loop-metabolic-bridge) turns eligible reported net proceeds into a durable manual-purchase task. Optional Discord alerts and operator confirmation do not purchase or verify provider credits. The dashboard distinguishes **QUARANTINED**, **HUMAN IN THE LOOP** and **UNPROVEN revenue**. Local PAPER reports have no enclave or TEE signature. No organic demand or guaranteed profit is claimed.

The [business accounting feature](docs/BUSINESS_ACCOUNTING.md) adds performance-fee invoices, final Intents receipt checks, realized-cost reporting and proceeds reservations. It is a source-level addition, not evidence of a customer sale or released mainnet business. Confirmed customer revenue is unproven. The [proceeds-to-NFT workflow](docs/BUSINESS_FUNDING.md) now implements signed conversion, native withdrawal, verified treasury allocation and durable recovery; it is disabled and lacks funded mainnet proof. Automatic AI-credit purchasing remains provider-blocked and unimplemented under the public-interface-only policy. Private cost sources and customer identity are not exposed in the public status projection. Deployment revisions and evidence scope are recorded in [the release manifest](docs/RELEASE_REVISIONS.md).

## Run locally

Requires Node 24, npm and Docker. Rust is needed only for contract checks. PAPER requires no wallet, paid model key, or real funds.

```bash
npm ci
cp .env.example .env
docker compose -p symbiochain up -d postgres
npm run db:generate
npm run db:migrate
npm run demo
```

The demo deposits simulated capital, creates a proposal, runs all three lanes, accounts for synthetic trading/inference costs, and reaches `CLOSED`. It prints a simulation disclosure and does not contact a model or transfer tokens.

Start the API and workers in separate terminals:

```bash
npm run dev
```

```bash
npm run worker
```

API: `http://127.0.0.1:3001`; Swagger: `/docs`; readiness: `/readyz`. Application endpoints require the read/admin tokens in `.env`. Replace the example tokens and encryption key before hosting.

The operator panel is at `/dashboard` (also the root redirect). It shows the three agents, treasury, cycles, durable events, cost approvals and net after approved costs. Administrator controls pause/resume spending and agents. The colocated PAPER profile can crash a worker after it claims a specific job and demonstrate recovery after restart and lease expiry. See the [operator demonstration](docs/OPERATIONS.md#user-facing-fault-and-cost-demonstration). PAPER rights are simulated and never presented as an on-chain mint.

## Architecture

Service orders follow Scout quoting → prepaid Brain assessment → Hand report delivery, as described in the [service runbook](docs/SERVICE_LOOP.md). The following diagram and execution states describe the trading adapter, whose LIVE admission defaults to disabled.

```mermaid
flowchart LR
  S[Scout: signed 1Click previews] --> Q[(Durable jobs + proposal digest)]
  Q --> B[Brain: hardware checks + signed inference]
  B --> P[Deterministic policy + reserve]
  P --> C[NEAR treasury: construct permitted payload]
  C --> M[Chain Signatures MPC]
  M --> H[Hand: persist signed bytes, then broadcast]
  H --> R[Verify settlement + incoming transfers]
  R --> L[(Balanced journals + evidence + outbox)]
  L --> N[Execution receipt NFT]
  L --> F[REST + WebSocket frontend]
```

1. **Scout** reads a bounded route allowlist, obtains two signed dry quotes, and rejects routes whose conservative return after cost buffers misses the profit floor. Configure `SCOUT_ROUTES_FILE` for automatic discovery. Historical swaps are not treated as pending orders. API proposals enter the same pipeline.
2. **Brain** purchases the signal, verifies fresh gateway/model evidence against independently approved measurements, submits one paid inference, and verifies the signature over the exact request/response bytes. A model cannot override deterministic financial limits.
3. **Hand** purchases the assessment, reserves funds, obtains an executable quote meeting the approved minimum, and asks the contract to construct the permitted transfer. Signed material is encrypted and durable before broadcast. Recovery reconciles the existing identity.

The live strategy is an ERC-20 on the configured EVM network → **native SOL** → the original ERC-20. Return pricing is refreshed after receipt. An unavailable or unprofitable return leaves intermediate assets held for reconciliation. This asynchronous round trip has price risk between legs; its previews are not an atomic arbitrage guarantee.

A 1Click partner JWT is optional. Anonymous access uses the provider's unauthenticated fee schedule; signed-quote verification and the conservative profit gate still apply. See [live setup](docs/OPERATIONS.md).

### State and recovery

```text
DISCOVERED → QUOTED → ASSESSED → RESERVED → SUBMITTED → SETTLING → RECONCILED → CLOSED
                  ↘ REJECTED / EXPIRED         ↘ UNKNOWN → reconciliation
```

PostgreSQL job leases, fencing tokens, versioned transitions, serializable reservations, idempotent journals, and a transactional outbox preserve progress across processes/restarts. Unknown outcomes retain reserves. Unconfirmed sends can rebroadcast the same encrypted, persisted signed bytes under a durable cooldown and retry budget. No retry creates a replacement signature, nonce or target-chain transaction. Confirmed first-leg refunds also close the corresponding NEAR authorization and never mint profit rights.

A paid inference attempt is stored before the POST. A lost response becomes `INFERENCE_OUTCOME_UNKNOWN`; it does not trigger another purchase. Received bytes can resume billing/signature verification after restart. Billing uses `inference-id`, not the transport correlation ID.

Intents service payments use NEP-413, the verifier's current salt, a durable nonce and signed payload, and nonce-consumption reconciliation. Retrying an uncertain payment does not create a new nonce. The alternate `NEAR_LEDGER` rail settles funded service balances inside the treasury contract.

## What the proofs establish

| Evidence                             | Established                                                                            | Boundary                                                       |
| ------------------------------------ | -------------------------------------------------------------------------------------- | -------------------------------------------------------------- |
| 1Click quote signature               | Approved manager signed the quote/terms                                                | Future execution and profit remain uncertain                   |
| Intel DCAP + measurement checks      | Accepted TDX status, nonce/signer binding, compose hash, RTMR3 replay, debug rejection | Does not prove financial reasoning                             |
| NVIDIA NRAS over authenticated HTTPS | NVIDIA accepted the GPU evidence                                                       | Offline JWT signature verification is not implemented          |
| Model-serving response signature     | Exact request/response bytes and canonical model match a preflight identity            | Model instances can share signing identities                   |
| Treasury payload construction        | No arbitrary EVM calldata or Solana program can be signed                              | Contract trusts the Brain role; it does not verify DCAP itself |
| Finality/incoming-transfer checks    | Deposits and received amounts are corroborated on their chains                         | Complete dollar operating-cost valuation is separate           |
| Receipt NFT                          | Authorized accountant recorded reconciliation                                          | Not independent proof of cross-chain profitability             |

The hardware verifier uses patched `@phala/dcap-qvl`, not the vulnerable legacy Node binding. TLS connection binding and end-to-end encrypted inference transport are not implemented; proofs expose `tlsConnectionBinding: false`. Backend orchestration and function-call keys run in ordinary server processes. Chain Signatures keys remain with the MPC system.

See the [private inference verification runbook](docs/PRIVATE_INFERENCE.md) for model privacy tiers, the NVIDIA verdict trust boundary, non-billable preparation, and remaining transport work.

An independent cross-check uses [Brave's unmodified NEAR verifier](https://github.com/brave/near-verifier), which targets the NEAR AI Cloud backend behind Brave Leo. On November 7, its authenticated CLI returned **exit 1** in the documented provenance-only mode: CPU/GPU and TLS subchecks passed, but launcher provenance was unavailable and the live deployment differed from its source/OS/service pins. The launcher exemption skips rebuilding only after provenance verification. See the [unaltered CLI report](artifacts/brave-cli-provenance-only-report.json), [invocation and scope](artifacts/brave-cli-verification.json), and [launcher policy analysis](docs/TEE_LAUNCHER_POLICY.md). No image rebuild or paid inference was performed, and deployment approval remains false.

## PAPER, LIVE and REPLAY

| Mode   | Behavior                                                                         | Evidence                                        |
| ------ | -------------------------------------------------------------------------------- | ----------------------------------------------- |
| PAPER  | Synthetic market/model/settlement, persistent PostgreSQL                         | `SIMULATED`                                     |
| LIVE   | Finalized mainnet reads; provider execution requires separate arming and funding | Only checks actually passed are marked verified |
| REPLAY | Offline archived data; no new inference or transactions                          | `REPLAY` plus original source mode              |

Export an administrator-only evidence bundle and replay it:

```bash
npm run evidence:export -- CYCLE_UUID /tmp/symbio-private-evidence.json
npm run evidence:replay -- /tmp/symbio-private-evidence.json
```

Exports contain private inference evidence, use file mode `0600`, and must remain private. Their checksum checks file integrity relative to its recorded hash; it does not authenticate the exporter. Normal API/WebSocket responses omit encrypted evidence and signed transaction bytes.

## Verify the implementation

Create the isolated test database once, then migrate it:

```bash
docker compose -p symbiochain exec -T postgres psql -U symbio -d postgres -c 'CREATE DATABASE symbiochain_test;'
DATABASE_URL=postgresql://symbio:symbio_local@localhost:55439/symbiochain_test npm run db:migrate
npm run check
npm ci --prefix .railway --ignore-scripts
npm run infra:check
npm run test:integration
```

Integration tests require a database name ending in `_test` and truncate that database. Set `TEST_DATABASE_URL` for another isolated PostgreSQL database/Neon branch. Do not use a shared development or production database.

Contract verification on Linux x86_64:

```bash
npm run contract:test
npm run contract:build
bash scripts/build-mock.sh
bash scripts/install-sandbox.sh
npm run contract:integration
```

The sandbox checks real contract calls: role isolation, immutable authorization, payload equality against viem/web3.js, one signing request per authorization, NFT minting, revenue distribution/claim, and conserved service payments. Its MPC stub deliberately returns an invalid signature. Synthetic reported P&L is not external revenue.

The build script sets `--cfg near` for near-sdk 5.27 and emits a WASM SHA-256. The sandbox is pinned to NEAR 2.13.4 with a checked download hash. Cargo pins `near-sdk-core` 4.1.0 because floating 4.1.3 introduces an incompatible native testing type version.

### Public testnet rehearsal

```bash
npm run testnet:rehearse
npm run testnet:tee
```

This separate profile uses fresh faucet-funded accounts and the real testnet MPC.
It checks deployment, roles, policy, payments, signatures and receipt mechanics.
Settlement and P&L are explicitly synthetic. This original rehearsal does not
broadcast its signing fixtures. A separate `npm run testnet:execute` has now
confirmed real MPC-authorized Sepolia test-USDC and Solana devnet transfers; their
records appear under `executions`. `npm run testnet:swarm -- --watch` runs the
integrated guarded workflow and currently stops at TEE deployment approval.
The free TEE probe preserves approval gates and purchases no inference.
See [scope, recovery and publication](docs/TESTNET_REHEARSAL.md). The frontend's
`/testnet` page reads the separate historical report while agent operations remain PAPER.

The [captured report](artifacts/testnet-rehearsal.json) includes real testnet
deployment, EVM/Solana MPC signatures, NFT mint and test-token distribution/claim.
Hardware verification passes; deployment approval and signed inference remain
blocked. No mainnet funds or inference credits were spent in this rehearsal.

### Real market probe

```bash
npm run probe:market
```

This verifies real **dry quote** signatures using the official SDK and writes `artifacts/market-probe.json`. The captured probe returned `9,843,777` USDC atoms for `10,000,000` input atoms before operating costs. That preview fails the profit gate. No deposit, model call, MPC signature, or realized revenue is implied.

### Public gateway attestation probe

```bash
npm run probe:attestation
```

This read-only diagnostic needs no API key or model credits. It obtains a fresh public gateway token, verifies PS384 against Intel's pinned public key endpoint, and checks issuer, expiry, signed caller nonce, non-debug TDX claims and accepted platform status. `artifacts/public-attestation-probe.json` contains the public token, public keys and capture-time verification result.

The observed compose hash is **unapproved**. This diagnostic does not modify allowlists, authorize LIVE, exercise the production DCAP verifier, or prove a model completion. Its short-lived token is historical evidence after expiry; rerun the command for a fresh check. See the official [public endpoint](https://docs.near.ai/api-reference/attestation/get-intel-trust-authority-attestation-token) and [Intel token profile](https://portal.trustauthority.intel.com/eat_profile.html).

## Frontend contract

See [API and WebSocket documentation](docs/API.md). Money is represented by integer strings in the stated asset's smallest units. `50` basis points means `0.5%`.

Reads use `Authorization: Bearer READ_TOKEN`. Writes require `ADMIN_TOKEN`; `POST /api/cycles` also requires an `Idempotency-Key`. Different terms under the same key return a conflict.

Connect to `/ws` and authenticate in the first frame, never a URL parameter:

```json
{ "type": "subscribe", "token": "YOUR_READ_TOKEN", "after": "0" }
```

Persist the last sequence and reconnect with it. Events replay from PostgreSQL; deduplicate by `seq`. Topics include `cycle.created`, `cycle.updated`, `agent.payment`, `new_transaction`, and treasury/worker controls.

## Economics and metabolism

Journals balance each asset independently and distinguish external capital, internal transfers, trading results, compute expense and chain costs. Deposits and intra-swarm payments are never business revenue.

Wallet reserves and provider credits are separate resources. Live inference uses either the default organization-balance guard or an explicit [durable application budget](docs/PRIVATE_INFERENCE.md#builders-keys-and-application-budgets) for Builders-issued keys without organization access. A local budget caps this backend's admitted spending and reconciles per-request billing; it does not verify the remaining provider balance. Optional staking-credit sync refreshes an **already configured** credit source; it does not stake funds or convert trade proceeds into credits. The [provider-funding decision](docs/PROVIDER_FUNDING.md) records the published API evidence and missing purchase protocol. Full-business `survivalHours` stays `null` until hosting/funding costs and all native fees are measured and valued.

Native EVM/Solana fees remain in settlement evidence. Gross trading P&L is separate from the receipt's net basis. With `NFT_SHARE_BPS=0`, receipts can use disclosed conservative cost buffers. With nonzero shares, minting waits for an immutable accountant-approved cost basis matching the exact settlement, native fee evidence and metered inference. The approval includes native/NEAR gas valuation, hosting, other costs and a receipt-gas budget. It is labeled `ACCOUNTANT_APPROVED`, not independently verified market truth. See the operations guide for the cost-approval endpoint.

Rights are fixed basis points of future explicit NEAR distributions, capped at 10,000 total bps. At most 128 nonzero rights-bearing NFTs participate in bounded distribution loops. Unclaimed dividends follow the NFT; failed payouts restore credit to the original claimant. Native owner withdrawals exclude storage, service/dividend liabilities and signing reserves, and require a pause.

## Guides and repository map

- [Hackathon submission](HACKATHON.md): idea pitch, entry point, execution loop, evidence and remaining milestones.
- [Operations and live setup](docs/OPERATIONS.md): accounts, derived wallets, credentials, policy and recovery.
- [Deployment](docs/DEPLOYMENT.md): Supabase, Render, cron-job.org, Docker and hosting alternatives.
- [Judge walkthrough](docs/JUDGING.md): reproducible proof, track mapping and boundaries.
- [Acceptance ledger](docs/IMPLEMENTATION.md): implemented behavior and external validation still needed.

```text
src/engine.ts         Workflow and reserve enforcement
src/store.ts          Jobs, serializable ledger, outbox
src/providers/        1Click, NEAR AI, hardware, wallets, Intents, paper/live
src/app.ts            REST, OpenAPI, WebSockets
prisma/               Schema and versioned migrations
contracts/treasury/   Policy, guarded MPC, services, NFTs, dividends
contracts/mpc-mock/   Sandbox-only transport stub
scripts/              Demo, export/replay, probes, contract build/tests
test/                 Unit and PostgreSQL recovery/adapter/API tests
```

The PAPER backend is deployed with Supabase and Render. [Hosted verification](artifacts/hosted-paper-verification.json) records a closed simulated cycle, balanced journals, fresh worker heartbeats, HTTPS authorization and secure WebSocket cursor replay. No wallet funds were spent or mainnet contracts deployed.

The selected hosting path uses Supabase's session pooler, a Render Docker web service, and an optional cron-job.org readiness monitor. Render deployment and Supabase migrations/TLS/RLS checks pass. The cron-job.org readiness check is enabled every five minutes. The alternative Railway IaC plan remains unapplied. Live validation also needs the dedicated credentials and approved measurements listed by `npm run live:preflight`. See [deployment status](docs/DEPLOYMENT.md) and the [acceptance ledger](docs/IMPLEMENTATION.md).

## Official sources

- [1Click lifecycle](https://docs.near-intents.org/integration/distribution-channels/1click-api/quickstart/introduction), [signed quotes](https://docs.near-intents.org/integration/distribution-channels/1click-api/verify-quote-signature), [SDK](https://docs.near-intents.org/integration/distribution-channels/1click-api/sdk)
- [Intents and nonce salt](https://docs.near-intents.org/integration/verifier-contract/intent-types-and-execution), [NEP-413](https://docs.near-intents.org/integration/verifier-contract/signing-intents), [key registration](https://docs.near-intents.org/integration/verifier-contract/account-abstraction)
- [Chain Signatures](https://docs.near.org/chain-abstraction/chain-signatures/getting-started), [access keys](https://docs.near.org/protocol/access-keys), [cargo-near flags](https://github.com/near/cargo-near)
- [NEAR AI response signatures](https://docs.near.ai/cloud/verification/cloud-api/response-signatures), [hardware bindings](https://docs.near.ai/cloud/verification/reference/quote-nonce-signer), [verification policy](https://docs.near.ai/cloud/verification/reference/verification-policy)
- [Request billing](https://docs.near.ai/api-reference/billing/get-costs-by-request-ids), [organization credits](https://docs.near.ai/api-reference/usage/get-organization-balance), [staking-credit sync](https://docs.near.ai/api-reference/staking-farm/sync-organization-staking-farm-credits)
- [Patched DCAP advisory](https://github.com/advisories/GHSA-796p-j2gh-9m2q), [NEP-171](https://nomicon.io/Standards/Tokens/NonFungibleToken/Core), [Prisma 7](https://www.prisma.io/docs/guides/upgrade-prisma-orm/v7)
