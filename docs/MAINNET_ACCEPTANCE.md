# Mainnet acceptance — November 9, 2026

The current public [evidence page](https://symbiochain.vercel.app/evidence) uses the strict, authenticated `/api/evidence/mainnet` projection. The frontend exposes it through the fixed same-origin `/api/swarm/mainnet/acceptance` proxy. Backend credentials never enter browser code. The packaged report is recorded evidence, not a live all-features certification; finalized live state is displayed separately. A reload does not rerun the audit.

## Recorded outcome

[Machine-readable report](../artifacts/mainnet-acceptance.json): **13 passed, 11 blocked, 1 not run**, at finalized mainnet block 223721506. The runner submitted zero transactions and purchased zero completions. Its 12 transaction records were rechecked against a mainnet archival RPC, including signer/receiver identities, finality and all returned outcomes.

Passing checks cover chain identity, executable identity, six deployed accounts, recovery custody, disabled execution permissions, paused state, reading spending policy, the hosted disarmed runtime, deployment receipts, capital funding, service escrow, provider hardware subchecks and signed quote admission. Reading policy does not exercise positive authorization or spending. Hardware subchecks do not approve application provenance. Signed indicative quotes do not establish market settlement or realized P&L.

## Completed owner-signed service test

Treasury: `treasury.symbio-fcef733893.near`. Funding wallet: `solidvideo4090.near`.

- [Deposit](https://nearblocks.io/txns/5TJYtz6mgKmLCUtm671nad5yLiUCGE3c7exe91WXgtiN): `fund_services({})`, 0.002 NEAR.
- [Withdrawal](https://nearblocks.io/txns/8yY6i69VtQgknNxzTEz3qR9uxWEyUojCAiQi3HzbLEAC): `withdraw_service_balance`, 0.0012 NEAR returned; callback and all outcomes succeeded.
- Storage collateral retained: 0.0008 NEAR.
- Combined fees: 0.0007785144816934 NEAR.
- Net wallet cost: 0.0015785144816934 NEAR, exactly reconciled to observed wallet balances.
- Final own service credit and total service liability: zero. Treasury paused, workers disabled and runtime disarmed throughout the observed test.

[Detailed public reconciliation](../artifacts/mainnet-service-roundtrip.json). The test proves self-funded service escrow and payout mechanics. It does not exercise agent-to-agent payment, Intents settlement, customer delivery, external demand or business profit. Storage collateral remains in the contract. Do not repeat a completed transaction to regenerate footage.

The separate [0.001 NEAR funding receipt](../artifacts/mainnet-funding-demo.json) is treasury capital, not revenue. The nine [foundation transactions](../artifacts/mainnet-paused-deployment.json) retain deployment-only classification.

## Incomplete mainnet coverage

| Check                                                                               | Outcome and prerequisite                                                                                                                |
| ----------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| Complete TEE deployment and paid response                                           | Blocked by independently approved provenance, measurements and deployment actions. No paid completion is requested.                     |
| Positive authorization, agent payment and treasury-controlled EVM/Solana signatures | Blocked by disabled workers, paused contract and missing valid approved cycle. An unrelated-account fixture is not substituted.         |
| Funded Intents settlement                                                           | Blocked by TEE approval, unset trading/gas limits, missing target-chain funding and a losing current quote.                             |
| Mainnet NFT and distribution/claim                                                  | Blocked by absence of genuinely reconciled profit, settlement-bound accounting and minted revenue shares.                               |
| External net revenue                                                                | Unproven; team capital and escrow return do not establish demand or complete operating costs.                                           |
| Automatic compute purchase                                                          | No publicly supported customer payment-to-credit API is integrated. Manual payment reports do not establish provider-purchased credits. |
| Recovery of an active mainnet agent job                                             | Not run; production workers remain stopped. Local PostgreSQL recovery tests retain local scope.                                         |

The fresh signed dry preview conservatively returns 9.842872 USDC from 10 USDC. After the 0.20 USDC preview cost allowance, net is -0.357128 USDC. Rejection is correct. This is an indicative quote, not an executed loss.

## Reproduce without spending

```sh
npm run mainnet:acceptance
```

The runner reads public finalized state and known receipts, then consumes already recorded private free-attestation and signed-preview results if they are less than six hours old. It constructs no signer or model client and does not load `.env`. It writes the strict public acceptance artifact and a private state snapshot. Missing/stale provider results are blocked; missing service evidence is not run. Unexpected receipt or RPC failures abort publication rather than fabricate success. RPC methods are limited to read operations and paced. The active archive endpoint replaces the deprecated NEAR-hosted archive; chain identity is still checked.

The signed quote and hardware audit probes require the existing provider credentials but do not buy completions or request an executable deposit. Do not publish their raw output. Full software provenance remains separately unapproved. The refreshed launcher record concerns its exact pinned digest, not a blanket approval of the current deployment.

## Publication and history

The existing Render and Vercel projects publish the report; no contract upgrade, migration, key grant or execution arming is required. Historical testnet results remain in Git for audit history, while `/testnet` redirects to the current evidence page. They are not included in the mainnet summary. Application source revisions and hosting identifiers are recorded in the release verification artifact after deployment; submission status is not inferred from a deployment.
