# Judge walkthrough

[Product overview](../README.md) · [Public dashboard](https://symbiochain.vercel.app/dashboard) · [Evidence](https://symbiochain.vercel.app/evidence)

## Hosted walkthrough

No login, wallet or judge token is required for public reads. Open the dashboard
for finalized treasury balances and current policy. On Evidence, expand
**Mainnet MPC transfer fixtures** for the Base/Solana links and eight NEAR
receipts. Expand **Manual AI API probe** for the recorded completion and charge;
other groups contain Intents funding and internal payments. The human authorized the mainnet scripts; the AI
engine did not initiate the transactions.

The [release record](../artifacts/mainnet-rpc-recovery.json) identifies exact
application deployments and hosted checks. Newer documentation-only frontend
commits are identified by [/api/release](https://symbiochain.vercel.app/api/release).
The consolidated [scope table](../README.md#4-simulated-vs-real) and
[unfinished claims](../README.md#5-not-yet-proven) apply to this walkthrough.

## Local PAPER replay

Use Node 24 and Docker in a fresh backend checkout:

```sh
npm ci
cp .env.example .env.paper
docker compose -p symbiochain up -d postgres --wait
DOTENV_CONFIG_PATH=.env.paper npm run db:generate
DOTENV_CONFIG_PATH=.env.paper npm run db:migrate
DOTENV_CONFIG_PATH=.env.paper npm run demo
```

Expected output: `state: "CLOSED"`, explicit PAPER labels and balanced persistent
accounting. The demo uses simulated model/market/settlement data. It requires no
provider or wallet key.

## Implementation checks

Use the separate PAPER environment for checks. Create the test database once:

```sh
docker compose -p symbiochain exec -T postgres psql -U symbio -d postgres -c 'CREATE DATABASE symbiochain_test;'
DATABASE_URL=postgresql://symbio:symbio_local@localhost:55439/symbiochain_test DOTENV_CONFIG_PATH=.env.paper npm run db:migrate
DOTENV_CONFIG_PATH=.env.paper npm run check
TEST_DATABASE_URL=postgresql://symbio:symbio_local@localhost:55439/symbiochain_test DOTENV_CONFIG_PATH=.env.paper npm run test:integration
```

The integration suite truncates its isolated `_test` database. Contract checks
use the pinned local sandbox on Linux x86_64:

```sh
npm run contract:test
npm run contract:build
bash scripts/build-mock.sh
bash scripts/install-sandbox.sh
npm run contract:integration
```

The latest validation comprises 162 backend unit, 81 PostgreSQL integration,
19 wallet-tool and 28 frontend tests, plus contract/sandbox checks. The local
sandbox uses an intentionally invalid-signature MPC stub; historical testnet
and mainnet records document their real signatures separately. For detailed
results see [VERIFICATION](VERIFICATION.md).

## Code map and deeper checks

- [Treasury contract](../contracts/treasury/src/lib.rs): roles, token caps, reserves and one-use payload construction.
- [Workflow](../src/engine.ts) and [store](../src/store.ts): admission, fencing, reservations and durable recovery.
- [Provider adapters](../src/providers): quotes, signing, settlement and inference verification.
- [Architecture](ARCHITECTURE.md), [API contract](API.md) and [operations/deployment](OPERATIONS.md).
- [Release identities](RELEASE_REVISIONS.md): current application baseline and dated deployment artifacts.
- [Private inference policy](PRIVATE_INFERENCE.md) and [recorded Brave audit](../artifacts/brave-cli-verification.json).
- [Human demo/X-post draft](DEMO_POST.md) and [idea field](../HACKATHON.md#idea-field-pitch).

Security and DeFi are the primary presentation tracks. Reviewer access is
read-only; private operator actions are separate from the public dashboard.
