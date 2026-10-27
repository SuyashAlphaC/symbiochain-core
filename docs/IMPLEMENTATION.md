# Implementation and acceptance ledger

This is a fresh local repository for the requested SymbioChain backend. The trading swarm remains the product: Scout, Brain, Hand, NEAR treasury, Chain Signatures, 1Click, confidential inference, agent payments, accounting, frontend APIs and deployment artifacts.

## Implemented and exercised

| Requirement                 | Implementation                                                                                                             | Verification                                                                                                                 |
| --------------------------- | -------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| Fresh repository and stack  | Node 24, TypeScript, Fastify, Prisma 7/PostgreSQL; locked npm/Cargo dependencies                                           | Install, generated client, migrations, typecheck, production build                                                           |
| Durable agents              | PostgreSQL jobs, leases, fencing, optimistic versions, bounded backoff, durable identical-byte rebroadcast, restart state  | Lost confirmations, sends dropped before/after acceptance, retry cooldown/budget, concurrent workers and stale leases        |
| 1Click integration          | Signed previews, exact terms, executable deposit quote, notification/status, two-leg strategy                              | Adapter tests and real public signed dry quotes                                                                              |
| NEAR AI                     | DCAP/compose/nonce/event-log checks, NRAS verdict, exact-byte model signature, paid-attempt persistence, request billing   | Malformed quote rejection, injected hardware-policy fixtures, real local response signatures, timeout/billing recovery tests |
| Agent economy               | NEP-413 service transfer, salt and persistent nonce, registration check, reconciliation; optional treasury balance rail    | Timeout recovery and registration tests; real local treasury service settlement                                              |
| Guarded Chain Signatures    | Treasury builds EIP-1559 ERC-20 transfer or native SOL message; one-use authorization, separate base/token caps            | Sandbox payload equality, offline valid signature assembly, both-leg LIVE orchestration with injected network/MPC transports |
| Contract roles and reserves | Owner/Brain/Hand/accountant, revocation, pause, limits, storage/liability reserves                                         | Rust adversarial tests and sandbox role/signing checks                                                                       |
| NFTs                        | NEP-171 core/metadata/enumeration; reported receipts, fixed rights, bounded allocation, pull claims, failed-payout credits | Rust tests and real sandbox mint/distribution/claim                                                                          |
| Accounting                  | Per-asset balanced journals, immutable references, separate capital/internal transfers/trading/compute/native fees         | PostgreSQL ledger and conflict tests                                                                                         |
| Frontend                    | Authenticated REST/OpenAPI/raw WebSocket, durable cursors, bounded queries, redacted evidence, policy/admin controls       | API authorization, policy revisions, WebSocket replay tests                                                                  |
| Honest evidence modes       | PAPER provider, private export, offline REPLAY with source mode and byte checks                                            | Closed paper cycle and archive mutation test                                                                                 |
| Deployment                  | Non-root Docker image, Render Blueprint/supervisor, Supabase TLS/RLS, optional cron monitor, Railway IaC alternative, CI   | Image smoke test; SDK typecheck, settings-preservation checks and read-only plan: three additions, no changes/destructions   |
| Documentation               | README, API, operations, deployment and judge walkthrough                                                                  | Commands exercised locally; code references and boundary review                                                              |

The test suite contains separate TypeScript unit, PostgreSQL integration and Rust contract tests, plus the local NEAR sandbox script. A separate `probe:attestation` command verified a real public gateway Intel Trust Authority token's PS384 signature, signed nonce, freshness and platform claims against pinned Intel keys. It leaves deployment approval and model inference unverified and does not substitute for the production DCAP/model checks. Current command results are recorded in [verification notes](VERIFICATION.md). No test fixture is presented as a funded mainnet transaction or a live hardware attestation.

## Material work not established by local verification

- A dedicated funded mainnet deployment, real MPC response from that deployment, and completed two-leg 1Click settlement have not been performed.
- A real authenticated NEAR AI run with independently approved gateway/model measurements has not been performed. Hardware-policy fixtures do not replace that evidence.
- Direct automatic conversion of trading proceeds into purchased NEAR AI credits is not implemented. The documented provider staking-credit sync supports an already linked source and is not a trade-profit purchase. The [provider funding decision](PROVIDER_FUNDING.md) records the inspected official interfaces and the missing customer payment protocol.
- Hosting/funding costs and all native gas values are not yet a complete realized cost basis. The API reports gross trading P&L and keeps full-business runway unknown.
- Nonzero revenue-share minting waits for an immutable, settlement-bound accountant cost approval and then proceeds automatically. The valuation inputs require an authorized accounting source; they are not an independent oracle or a demonstrated live cost valuation.
- External assets held after an expired/reverted/intermediate-refund operation require reviewed recovery; no blind signing bypass is included.
- Public hosting verification remains pending. Dedicated Supabase access and Render API access were supplied; private PAPER application keys were provisioned locally.

These boundaries are part of the acceptance record, not successful live demonstrations. The code should not be described as an already self-sustaining organism.

## External prerequisites

Dedicated NEAR accounts/keys, treasury policy, operational reserves, derived EVM/Solana balances/gas, registered/funded Intents agent balances, NEAR AI inference and credit-balance credentials, independently approved measurements, are required for funded external validation. A 1Click partner JWT is optional; unauthenticated access uses the provider's applicable fee schedule. Existing wallets and unrelated project credentials were not accessed or reused.

The current live preflight still reports 16 missing dedicated settings. The selected PAPER stack is Supabase PostgreSQL plus Render, with an optional cron-job.org readiness check. Render validated the free-service configuration; database login and verified client TLS pass. Hosted-runtime verification remains pending. Railway provisioning was rejected; its alternative three-resource plan remains unapplied. See [deployment status](DEPLOYMENT.md). The backend code and passing checks do not resolve these external prerequisites or the missing compute-purchase protocol.
