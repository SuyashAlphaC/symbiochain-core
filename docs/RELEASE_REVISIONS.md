# Deployment, candidate and submission revisions

The [machine-readable revision manifest](../artifacts/business-release-manifest.json)
records the verified deployed baseline separately from the business-accounting source.
A hackathon form submission has **not** been confirmed; no revision is falsely
labelled submitted. Update the submission section only after recording the actual
submitted commits and application receipt.

| Scope                                           | Frontend                                                                                                                                | Backend                                                                                                                                        |
| ----------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| Verified deployed application                   | [`83d46d8eb5db2257989bf1c831694da20617635e`](https://github.com/AviraL0013/SymbioChain/commit/83d46d8eb5db2257989bf1c831694da20617635e) | [`e1633c7ff16cb2ce3ce484aa44b12d09cc0117a5`](https://github.com/SuyashAlphaC/symbiochain-core/commit/e1633c7ff16cb2ce3ce484aa44b12d09cc0117a5) |
| Business feature source candidate; not deployed | [`be50793f719f8696736a648ad9ac9e4d3eb3a9a2`](https://github.com/AviraL0013/SymbioChain/commit/be50793f719f8696736a648ad9ac9e4d3eb3a9a2) | [`54883186106c70f2b83589f15f6003e9b87dbf92`](https://github.com/SuyashAlphaC/symbiochain-core/commit/54883186106c70f2b83589f15f6003e9b87dbf92) |

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
parsing with injected RPC responses. A public mainnet receipt probe timed out and
produced no verification verdict. No actual customer fee, profitable mainnet round
trip, AI-credit purchase or business-funded NFT payment was performed. The owner
has no mainnet funds and has not selected an account or caps. Provider purchase
integration and earned-proceeds NFT settlement remain unimplemented, as described
in [business accounting](BUSINESS_ACCOUNTING.md).
