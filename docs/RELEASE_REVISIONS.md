# Deployment, candidate and submission revisions

The [machine-readable revision manifest](../artifacts/funding-release-manifest.json)
records the verified deployed baseline separately from the business-accounting and NFT-funding source.
A hackathon form submission has **not** been confirmed; no revision is falsely
labelled submitted. Update the submission section only after recording the actual
submitted commits and application receipt.

| Scope                                           | Frontend                                                                                                                                | Backend                                                                                                                                        |
| ----------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| Verified deployed application                   | [`83d46d8eb5db2257989bf1c831694da20617635e`](https://github.com/AviraL0013/SymbioChain/commit/83d46d8eb5db2257989bf1c831694da20617635e) | [`e1633c7ff16cb2ce3ce484aa44b12d09cc0117a5`](https://github.com/SuyashAlphaC/symbiochain-core/commit/e1633c7ff16cb2ce3ce484aa44b12d09cc0117a5) |
| Business/funding source candidate; not deployed | [`e6bbcfe57d608297447b068d11c4910456c016d7`](https://github.com/AviraL0013/SymbioChain/commit/e6bbcfe57d608297447b068d11c4910456c016d7) | [`bc5df4e4c67fde7cd336a466436d1b53dacf7dac`](https://github.com/SuyashAlphaC/symbiochain-core/commit/bc5df4e4c67fde7cd336a466436d1b53dacf7dac) |

Both repositories are public. The existing Vercel project serves `/testnet` and
has configured operator access; the owner verified login, PAPER state and logout.
The backend's `artifacts/frontend-production-release.json` separates independent
read checks from owner-reported verification. Initial deployment/publication is
complete. No new Vercel project was created.

The new backend migration and `/business` frontend have been tested locally.
Deploy the additive backend migration/application before that frontend update.
Neither a new production deployment nor a hosted Supabase migration was performed
for this feature. Subsequent documentation commits do not change the application
revisions frozen in the table. Preserve this distinction when choosing submission
commits or refreshing deployment evidence.

## Execution and business scope

Real evidence covers testnet contract safeguards, agent ledger payments, MPC
signatures and separate confirmed Sepolia/Solana devnet transfers. Those transfers
are authorization fixtures, independent of the blocked AI workflow. The integrated
runner stops at TEE deployment approval with zero paid requests. Market quotes,
settlement economics and positive NFT accounting fixtures are simulated.

New business accounting is implementation-tested, including finalized-receipt
parsing with injected RPC responses. The earlier invoice probe timed out; a later independent wNEAR-credit parser
check passed against a public third-party receipt, not project revenue. No actual customer fee, profitable mainnet round
trip, AI-credit purchase or business-funded NFT payment was performed. The owner
has no mainnet funds and has not selected an account or caps. Provider purchase
integration remains blocked under the public-interface-only requirement. Earned-proceeds
NFT conversion, withdrawal, allocation and recovery are implemented and tested,
but disabled without funded validation; see [funding scope](BUSINESS_FUNDING.md).
The [November 6 testnet upgrade](../artifacts/testnet-funding-upgrade.json) preserved
state and left the treasury paused. Earlier artifacts retain their historical code hash.
No Supabase/Render/Vercel production update was performed for this extension.
The prior [November 5 manifest](../artifacts/business-release-manifest.json) is retained
as a dated historical record, superseded by the funding manifest above.

## Accounting merge and funding follow-up

The earlier backend PR #1 and frontend PR #4 were merged on November 5 at
`6a6a2ba6e6e1a4b3ad39a62b46d10500201453d6` and
`b855671653e4ac8a188f512b3a879c2a1a527227`, respectively. They contain accounting,
not the new NFT payment path. The [November 6 read-only preflight](../artifacts/funding-production-preflight.json)
confirmed Render still serves `e1633c7`, and both hosted business endpoints return 404. The frontend baseline above is the last verified exact deployment revision;
a later repository merge does not prove its deployment. Apply the existing
business migration and deploy the paired backend APIs before releasing this page.

The funding extension reviews have been merged into their source repositories; this does not establish a hosted release:
[backend #2](https://github.com/SuyashAlphaC/symbiochain-core/pull/2) and
[frontend #5](https://github.com/AviraL0013/SymbioChain/pull/5). Earlier merged PRs
retain their original scope. No production deployment was performed in this task.

## November 7 service and manual funding candidate

The application revisions for this extension are backend [`e59d172`](https://github.com/SuyashAlphaC/symbiochain-core/commit/e59d172c30caab19f8ccf1d7e3a114d54ee57ff0) and frontend [`b879d05`](https://github.com/AviraL0013/SymbioChain/commit/b879d0514d2551eb53504b757dde9cdfaed27974). Later documentation/evidence commits do not change those application revisions. The [candidate manifest](../artifacts/service-loop-release-manifest.json) records the exact scope.

New behavior includes prepaid quote-risk reports, separate customer advances and delivered external revenue, disabled-by-default LIVE arbitrage, durable manual top-up tasks and unverified operator confirmations. The frontend displays recorded TEE quarantine and HITL status through a fixed server proxy and exposes PAPER-only reporting under the existing operator session. The NEAR contract executable did not change; additional tests cover small splits, rounding liabilities and distribution replay.

[Isolated validation](../artifacts/service-loop-validation.json) passed 129 unit, 80 PostgreSQL integration and 16 Rust contract tests. Frontend validation passed 25 tests, formatting, lint, type checks, production build and the local browser flow. Local source fixtures are not external revenue, paid inference, provider credits or mainnet proof. The [read-only hosted preflight](../artifacts/service-loop-production-preflight.json) records API availability separately from source changes. No production database, hosting service, TEE allowlist or wallet was modified by this extension.

See [the service and bridge runbook](SERVICE_LOOP.md). Existing business migrations are required, with no new migration. Release the backend and then the paired frontend before creating service cycles; older detail clients accept only the round-trip strategy. Manual reports remain unverified and their reservations stay held. Customer checkout/refund operations, actual mainnet revenue and supported automatic provider credit purchasing remain unfinished.
