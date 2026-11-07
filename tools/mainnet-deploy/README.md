# Owner-signed mainnet infrastructure deployment

This tool prepares five transactions for `solidvideo4090.near` to approve in Meteor. The backend cannot sign for the owner. It deploys a **paused treasury**, disables Brain/Hand/accountant on-chain and leaves the hosted backend in PAPER mode. It does not authorize trading, inference, cross-chain wallet funding, service sales, minting or distributions.

## Funding and custody

| Account                        | Funding (NEAR) | Keys                                   |
| ------------------------------ | -------------: | -------------------------------------- |
| `treasury.solidvideo4090.near` |           6.10 | Owner recovery public key              |
| `brain.solidvideo4090.near`    |           0.05 | Owner recovery plus scoped runtime key |
| `hand.solidvideo4090.near`     |           0.05 | Owner recovery plus scoped runtime key |
| `books.solidvideo4090.near`    |           0.05 | Owner recovery plus scoped runtime key |
| `scout.solidvideo4090.near`    |           0.02 | Owner recovery public key              |

Funding totals **6.27 NEAR**. A **0.13 NEAR fee contingency** gives a **6.40 NEAR planning ceiling**. The tool checks the current gas price and requires at least 0.30 NEAR remaining in the owner account after planned funding and fee contingency. Actual fees are set by the network; this is not a protocol-enforced gas-price cap. The sandbox rehearsal spent approximately 6.314 NEAR including funding and fees.

The 582,885-byte WASM is pinned to SHA-256 `39f034e6ae16ddb9cf253ac977c4146989a0fee1fa7c33ba0944092bf41de3d5`. At the checked storage price of 10¹⁹ yoctoNEAR per byte, the code alone locks 5.82885 NEAR; initialized state also uses storage. The treasury's 6.10 NEAR allocation includes this storage balance. Storage is collateral while state/code exists, not a deployment service charge.

Every account gets the owner's existing recovery public key. The owner private key stays in Meteor. Only three limited runtime keys are generated locally; their receiver is the treasury, their method lists are explicit, and each has a 0.04 NEAR allowance. They cannot transfer funds, deploy code, unpause the treasury or change policy. Private files live in ignored `.data/mainnet-deployment/` (directory mode 0700, files mode 0600). Keep a secure offline backup before deleting that directory. Never upload it, `.env`, browser storage or the owner key to GitHub or Render.

## Run locally

Use Node 24 and run from the backend repository root:

```sh
npm ci
npm ci --prefix tools/mainnet-deploy
node --test tools/mainnet-deploy/plan.test.mjs
node tools/mainnet-deploy/rehearse.mjs
npm run build --prefix tools/mainnet-deploy
node tools/mainnet-deploy/server.mjs
```

The sandbox rehearsal uses the repository's existing `.data/bin/Linux-x86_64` NEAR sandbox binary. It creates throwaway local accounts and sends no mainnet transactions. Obtain the sandbox through the existing testnet setup before running the rehearsal on a fresh workstation. The server refuses deployment preflight without a matching successful rehearsal artifact.

Open **http://localhost:3417** in the browser with Meteor installed. Connect **solidvideo4090.near**, review the account IDs and amounts, tick the review checkbox and choose **Sign deployment batch in Meteor**. Approve the five reviewed transactions in the wallet. Connection does not request a root full-access app key. Reject any unexpected permission or transaction.

Before asking the owner to sign, the local browser check can run against the running portal: `CHROME_PATH=/path/to/chrome node tools/mainnet-deploy/browser-check.mjs`. It uses an isolated browser context and a fake Meteor transport, decodes the five unsigned transactions to verify allocations, access keys and contract bytes, then rejects the signature request. It never connects to the real wallet and permits only read-only browser RPC methods. It expects all five accounts to be absent; run it before deployment. The manifest and an unsigned fixture capture stay in ignored local storage.

The server binds to loopback only, restricts Host/Origin, requires a per-process session token for control endpoints and never loads backend `.env`. Its public manifest contains public keys only. The browser checks the WASM digest before submitting it to Meteor. The helper is excluded from the production Docker image.

Read-only mainnet requests use the wallet selector's public FastNEAR endpoint, pinned in both the server and browser policy. The helper checks the returned chain ID, storage price and gas price. Server reads are paced with bounded rate-limit retries; an unavailable RPC holds signing rather than bypassing checks.

## Partial completion and recovery

The five transactions are not collectively atomic. Treasury creation, funding, deployment, initialization, pause and worker disablement are actions in one transaction. Existing accounts are checked against the frozen manifest before resuming. An account with a different key, code hash or treasury policy halts the deployment for review. The tool checks the treasury pause flag and all three disabled worker records. Creation precedes transfer, so replaying an already-created account transaction fails before funding it again.

If Meteor cancels or only some transactions confirm, refresh on-chain state before retrying. The next batch includes only missing accounts. Keep the original local manifest and scoped credentials; the tool refuses to replace half of a saved manifest/credential pair. A process lock prevents two local portals. After a crash, inspect the lock's PID before removing a stale lock.

After success, verify all five accounts, the pinned code hash, owner recovery keys, limited runtime permissions, paused state and treasury reserve. Preserve public transaction hashes and an on-chain verification report. Configure a separate mainnet profile only after these checks; do not overwrite the testnet profile or turn the hosted service LIVE as part of this deployment.

For a rollback, leave the contract paused and workers disabled. Only the owner wallet can change deployment code or recover funds, subject to storage and contract liabilities. This tool offers no automatic deletion or withdrawal.

## Evidence and limits

- `artifacts/mainnet-owner-deployment-rehearsal.json`: real local sandbox execution, not mainnet evidence.
- `artifacts/mainnet-owner-browser-verification.json`: fake wallet transport used to decode and inspect the unsigned mainnet batch, then deliberately reject signing. No real wallet or mainnet transaction is used in this check.
- `.data/mainnet-deployment/status.json`: latest read-only mainnet inspection, private local state until reviewed for publication.

**Preparation and tests do not establish a mainnet deployment.** Owner approval and successful final on-chain verification are required. A paused mainnet deployment also does not establish TEE approval, purchased compute credits, external revenue, net profit or NFT distributions. All of those retain their independent gates.
