# Release identities

[Overview](../README.md) · [Verification](VERIFICATION.md) · [Operations](OPERATIONS.md)

## Current application baseline

| Component            | Verified source / location                                                                                                                                                                                                    |
| -------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Backend              | [`df7bef86bc96d5e2d89444da46fd157e939e176e`](https://github.com/SuyashAlphaC/symbiochain-core/commit/df7bef86bc96d5e2d89444da46fd157e939e176e) on the existing [Render service](https://symbiochain-core.onrender.com/readyz) |
| Frontend application | [`201974014d45f7f9b06646788978beb46f0d28f2`](https://github.com/AviraL0013/SymbioChain/commit/201974014d45f7f9b06646788978beb46f0d28f2) on the existing [Vercel project](https://symbiochain.vercel.app)                      |
| Runtime              | LIVE observation, automatic execution DISARMED, AI QUARANTINED                                                                                                                                                                |
| Public source        | [Backend](https://github.com/SuyashAlphaC/symbiochain-core) and [frontend](https://github.com/AviraL0013/SymbioChain)                                                                                                         |

The [November 12 RPC recovery record](../artifacts/mainnet-rpc-recovery.json)
freezes the exact deployment IDs, paired application revisions, hosted checks
and evidence scope. Later documentation-only commits do not change those
recorded application results. Frontend deployments can therefore have a newer
source identity; [/api/release](https://symbiochain.vercel.app/api/release) reports
the active public commit and deployment. Render is deployed deliberately rather
than automatically on every documentation merge.

There is **no final submitted revision**: submission remains on hold. The public
repositories contain the judging material; private submission/contact drafts
are not release artifacts.

## Dated evidence records

| Record                                                                       | Purpose                                                                                       |
| ---------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| [Manual AI probe release](../artifacts/manual-ai-probe-release.json)         | Earlier paired release containing the single unverified completion and billing reconciliation |
| [Controlled mainnet release](../artifacts/mainnet-controlled-release.json)   | Owner-authorized Base/Solana transfers and destination-gas funding                            |
| [Mainnet preparation release](../artifacts/mainnet-preparation-release.json) | Internal Intents settlements and read-only preparation                                        |
| [Bounded activation](../artifacts/mainnet-bounded-activation.json)           | Original scoped key registration and owner-signed limits                                      |
| [Mainnet acceptance](../artifacts/mainnet-acceptance.json)                   | Service-balance round trip and finalized receipt checks                                       |
| [Paused foundation](../artifacts/mainnet-paused-deployment.json)             | Original account creation, WASM identity and deployment custody                               |
| [Funding manifest](../artifacts/funding-release-manifest.json)               | Earlier business-funding source, testnet and isolated validation boundaries                   |

These are immutable observations, not a list of pending deployments. Later
policy and funding evidence supersedes earlier status fields without rewriting
their history. Use [VERIFICATION](VERIFICATION.md) for what each record proves.
