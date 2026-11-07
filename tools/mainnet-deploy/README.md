# Mainnet deployment through a dedicated wallet

The local portal creates a separate, funded deployment wallet through NEAR’s official `near.create_account` factory. Meteor signs one function call for **6.38 NEAR**. A temporary local key controls that separate wallet, deploys the paused infrastructure, refunds excess funds to `solidvideo4090.near`, then revokes itself. The original Meteor account receives no new key or permission. Your existing Meteor recovery public key remains the sole full-access key on the new owner account and each child account.

This custody arrangement is shown explicitly before signing. The dedicated deployment wallet becomes the treasury’s **owner account**. Future owner operations must be signed as that account using the recovery key, rather than as the original funding account. Use Meteor’s account discovery/recovery facilities to select it. Keep recovery material offline; do not give it to the backend or put it on Render.

## Why the signing flow changed

The first five-transaction wallet batch contained full-access recovery-key grants to new subaccounts. Meteor blocked those actions. Nothing was deployed and the original 6.735041233785237412378082 NEAR balance remained unchanged. The original sandbox and transport artifacts remain historical evidence; they did not establish Meteor policy compatibility. The current flow uses the official account factory to provision a separate deployment wallet, with its temporary custody explained to the owner. It does not disable Meteor’s protection or export its owner key.

## Budget and account permissions

| Account                        | Funding (NEAR) | Final keys                       |
| ------------------------------ | -------------: | -------------------------------- |
| `treasury.<deployment-wallet>` |           6.10 | Meteor recovery public key       |
| `brain.<deployment-wallet>`    |           0.05 | Recovery plus scoped runtime key |
| `hand.<deployment-wallet>`     |           0.05 | Recovery plus scoped runtime key |
| `books.<deployment-wallet>`    |           0.05 | Recovery plus scoped runtime key |
| `scout.<deployment-wallet>`    |           0.02 | Meteor recovery public key       |

The five accounts receive **6.27 NEAR**. The new parent receives **6.38 NEAR** in total, covering those allocations, its own storage/recovery balance and deployment fees. An additional **0.02 NEAR owner-side fee contingency** gives a **6.40 NEAR planning ceiling**. Actual fees are protocol determined. The factory snapshot rehearsal left approximately **0.401 NEAR** in the original funding wallet and refunded approximately **0.054 NEAR** from the deployment wallet. It is local evidence, not a mainnet fee guarantee.

Deploy the treasury first to accommodate prepaid gas before allocating the smaller agent balances. Treasury creation, WASM deployment, initialization, pause and worker disablement are in one transaction. The deployed treasury is paused with one-atomic-unit trade caps. Paid inference, trading, Intents settlement, service sales, minting and distributions stay off. Hosted PAPER configuration and testnet evidence remain separate.

The pinned treasury executable is 582,885 bytes, SHA-256 `39f034e6ae16ddb9cf253ac977c4146989a0fee1fa7c33ba0944092bf41de3d5`. At the checked storage price of 10¹⁹ yoctoNEAR per byte, its code alone locks 5.82885 NEAR; initialized state also consumes storage. Storage collateral remains locked while the code/state exists. A different rebuild requires artifact review rather than silently changing the digest.

Only the new deployment wallet temporarily has a local full-access key. Each runtime key has an explicit treasury receiver, explicit method list and 0.04 NEAR allowance. Runtime keys cannot transfer funds, deploy code, change policy or unpause. The temporary deployment key is never added to a child account.

## Local setup and signing

Run from the backend repository root with Node 24 and the reviewed treasury artifact available:

```sh
npm ci
npm ci --prefix tools/mainnet-deploy
node --test tools/mainnet-deploy/*.test.mjs
bash scripts/install-sandbox.sh
node tools/mainnet-deploy/factory-rehearse.mjs
npm run build --prefix tools/mainnet-deploy
node tools/mainnet-deploy/server.mjs
```

The rehearsal reads the pinned public `near` factory bytecode if no snapshot is saved, then executes entirely in the local NEAR sandbox. It sends no mainnet transaction. The live factory hash is pinned to `HiyC5tB1gBDpgR4x1guEp1orBde5PXqUYGoWaZfX3JGX`; a change holds preflight for review.

Open **http://localhost:3417**, connect Meteor as **solidvideo4090.near**, review the generated deployment account and temporary-key custody, tick the authorization checkbox and choose **Create deployment wallet in Meteor**. Review one `near.create_account` call with a 6.38 NEAR deposit. After it confirms, the local runner creates the paused infrastructure, verifies it, refunds excess funds and revokes its temporary key. No further wallet permission grant is needed on the original account.

Run the browser fixture before funding, against the running portal:

```sh
CHROME_PATH=/path/to/chrome node tools/mainnet-deploy/browser-check.mjs
```

It uses an isolated browser and fake Meteor transport, verifies one unsigned factory function call and zero root key grants, then rejects signing. It checks protected endpoints, cross-origin rejection, browser errors and mobile overflow. This fixture does not establish the real wallet’s approval; record actual wallet outcomes separately.

## Custody, retries and recovery

Private files live in ignored `.data/mainnet-deployment-factory/` (directory 0700, files 0600). Keep a secure backup. The original `.data/mainnet-deployment/` contains the blocked batch’s historical state and the public browser build. Never upload private state, browser storage or `.env` to GitHub or Render. The helper is excluded from the production image.

The server binds to loopback, checks Host and Origin, requires a per-process token on control routes and never loads backend `.env`. The public manifest includes public keys only. Reads use the pinned public FastNEAR mainnet endpoint, with pacing and bounded rate-limit retries. The server can sign only for the funded deployment wallet, never the original Meteor account.

A saved manifest and credential pair are immutable. Existing account keys, code hash, policy, disabled workers, pause flag, balances and reserves are checked before resuming. Creation precedes transfer. A finalized deployment has no temporary key; rerunning it submits no transactions. If a wallet request is cancelled or deployment stops, refresh state and resume the existing plan. Do not create a replacement deployment wallet or fund twice. A process lock prevents concurrent local portals.

The final account set has six new accounts: the dedicated owner plus the treasury and four agent accounts. Excess funds return to the original Meteor wallet. The parent retains storage collateral and a small native recovery balance. After key revocation, owner operations require the offline recovery key. Leave the contract paused during recovery; no automatic deletion or withdrawal is implemented here.

## Evidence

- `artifacts/mainnet-factory-deployment-rehearsal.json`: exact live-factory snapshot exercised in a local sandbox, including recovery key retention, refund, temporary-key revocation and an idempotent repeat.
- `artifacts/mainnet-factory-browser-verification.json`: isolated unsigned funding-transaction check, zero actual mainnet transactions.
- `artifacts/mainnet-owner-deployment-rehearsal.json` and `mainnet-owner-browser-verification.json`: historical direct-batch tests, superseded after Meteor’s full-access policy rejection.
- `.data/mainnet-deployment-factory/status.json` and `transactions.json`: private local inspection and public transaction hashes, reviewed before publication.

Preparation is not a completed mainnet deployment. Final on-chain verification and recorded transaction links are required. A paused deployment proves neither TEE approval nor purchased credits, real revenue, net profit or NFT distributions.

The standard factory interface is documented in [NEAR’s linkdrop tutorial](https://docs.near.org/tutorials/crosswords/intermediate/linkdrop).
