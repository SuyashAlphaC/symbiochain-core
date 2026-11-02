# Testnet rehearsal

This is an isolated contract and verification rehearsal. It does not arm the LIVE
workers, replace the PAPER deployment, purchase inference, or spend mainnet funds.
The public report is separate from the existing cycle, accounting and proof APIs.

## Run

```bash
npm run contract:build
npm run testnet:rehearse
npm run testnet:tee
```

The first command builds the production treasury. The rehearsal creates a fresh
testnet root through the official faucet, then separate Brain, Hand, accountant
and treasury accounts. It does not use the mainnet wallet or any production
signing keys from `.env`. Funding is capped at 12 test NEAR, including code storage
and role gas reserves; storage is calculated from the testnet protocol config.
The public faucet must be available and sufficiently funded.

The profile uses `https://test.rpc.fastnear.com`, listed in the
[NEAR RPC provider documentation](https://docs.near.org/api/rpc/providers).
It still verifies the returned network identity before every write.

Keys are saved before faucet registration in ignored
`.data/testnet-rehearsal/credentials.json` with private file permissions. Preserve
that directory to retain control of the accounts. Never commit its files.

`testnet:rehearse` checks the RPC network before every mutation and accepts only
dedicated `.testnet` accounts. The journal saves exact signed transaction bytes
before broadcast. An interrupted submission may reuse those same bytes; it never
creates a replacement nonce automatically. A legacy attempt without saved bytes,
an expired transaction or conflicting terms requires explicit reconciliation.
The runner lock prevents concurrent runs. After a process crash, inspect the
journal and process state before removing a stale lock. Do not delete credentials
or journal entries to bypass an uncertain outcome.

## Evidence boundaries

| Check                 | Actual execution                                                                          | Limit                                                           |
| --------------------- | ----------------------------------------------------------------------------------------- | --------------------------------------------------------------- |
| Treasury deployment   | Production WASM on NEAR testnet; code hash checked                                        | Uses faucet tokens                                              |
| Roles and policy      | Real unauthorized, over-limit, wrong-chain and paused calls                               | These are contract mechanics, not trade profitability           |
| Service payment       | Funded NEAR_LEDGER payment; duplicate request checked                                     | Does not claim an Intents transfer                              |
| EVM signing           | Real `v1.signer-prod.testnet` ECDSA response, payload equality and recovered signer       | Sepolia fixture transaction is not broadcast                    |
| Solana signing        | Real testnet MPC Ed25519 response over an exact devnet message                            | Devnet fixture transaction is not broadcast                     |
| Settlement            | Explicit `testnet:SIMULATED_SETTLEMENT` marker and synthetic accountant reconciliation    | No 1Click deposit, market execution or actual revenue           |
| Receipt and dividends | Real testnet NFT, fixed rights, test-token distribution and holder claim                  | Synthetic positive reported P&L; distribution is faucet capital |
| TEE audit             | Real gateway/model hardware evidence, nonce/TLS bindings and configured deployment policy | No paid completion or response signature is claimed             |

The existing PostgreSQL integration and browser suites separately exercise the
PAPER agent pipeline, durable recovery, accounting and operator controls. This
rehearsal does not establish an autonomous testnet agent trading against a real
solver market. The production 1Click adapter remains mainnet-only; its profit
floor and all LIVE gates are unchanged.

## TEE approval and credit budget

`testnet:tee` runs the existing free attestation probe and publishes only the strict
report to `artifacts/testnet-rehearsal.json`. Exit code 2 means a gate remains
blocked; it does not mean a paid request was attempted. Hardware verification,
deployment approval and signed inference are separate checks. Returned hashes
are never installed as approved measurements automatically.

Testnet does not resolve missing image build provenance. See the
[approval handoff](TEE_APPROVAL_HANDOFF.md). A paid signed completion still needs
independently reviewed measurements and action history, plus the existing durable
compute budget and billing reconciliation. It must not be replaced with a direct
SDK completion that skips those controls. Automatic purchase of Cloud credits
from trading proceeds remains unimplemented.

## Dashboard and publication

The authenticated read-only `GET /api/viewer/testnet` publishes the bounded report
when the backend runs PAPER. Missing evidence returns pending checks. Invalid,
oversized or expanded reports fail closed. This endpoint cannot start a run,
approve a deployment, sign transactions or spend credits.

The integrated frontend proxies it through `GET /api/swarm/testnet` using its
server-held read credential. `/testnet` shows historical checks and links only to
the NEAR testnet explorer. The existing overview and operator remain PAPER.
Refreshing the page reads stored evidence; it does not purchase fresh inference.

After changing the report, commit its sanitized artifact and deploy the existing
backend revision to publish it. Release the frontend through the existing Vercel
project once its owner resolves project access and merges the integration PR.
