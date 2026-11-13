# Verification and evidence

[Five-minute walkthrough](JUDGING.md) · [Release identities](RELEASE_REVISIONS.md) · [Public evidence](https://symbiochain.vercel.app/evidence)

## Recorded application checks

The latest validated application comprises **290 automated tests**: 162 backend
unit, 81 isolated PostgreSQL integration, 19 wallet-tool and 28 frontend tests.
Rust unit and local NEAR sandbox checks run separately. The
[RPC recovery release record](../artifacts/mainnet-rpc-recovery.json) identifies
the application revisions and hosted browser checks. These are recorded results,
not a claim that this documentation cleanup reran financial actions.

| Check                    | What it establishes                                                                                                     |
| ------------------------ | ----------------------------------------------------------------------------------------------------------------------- |
| Backend unit/integration | Admission, accounting, leases, exact-identity recovery, cost holds and credential/mode boundaries                       |
| Wallet-tool checks       | Reviewed transaction plans, fee/capital limits and receipt reconciliation without signing                               |
| Rust/local sandbox       | Roles, token/reserve caps, one-use payloads, distribution liabilities and pull claims                                   |
| Frontend/browser         | Strict schemas, operator session boundaries, desktop/mobile evidence, stale recovery and no exposed backend credentials |
| Isolated PAPER replay    | A simulated three-agent cycle reaches `CLOSED` with balanced persistent accounting                                      |

The sandbox's MPC stub produces an intentionally invalid signature. It tests
contract behavior; actual network signature evidence is listed separately below.
The [judge guide](JUDGING.md#implementation-checks) has isolated database and
contract commands. The [frontend test guide](https://github.com/AviraL0013/SymbioChain/blob/main/docs/testing.md)
keeps mutating browser tests on localhost PAPER backends.

## Mainnet mechanics — November 7–12, 2026

| Evidence                                                                    | Observed outcome and scope                                                                                                         |
| --------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| [Deployment](../artifacts/mainnet-paused-deployment.json)                   | Treasury WASM and dedicated accounts deployed; original paused foundation                                                          |
| [Acceptance](../artifacts/mainnet-acceptance.json)                          | Rechecked mainnet receipts and service-balance deposit/withdrawal; owner funding, not sales                                        |
| [Bounded activation](../artifacts/mainnet-bounded-activation.json)          | Scoped Intents registration and original owner policy; later limits supersede that policy                                          |
| [Permissions and funding](../artifacts/mainnet-wallet-provisioning.json)    | Reviewed capital, policy updates, original funding outcomes and refunds                                                            |
| [Internal Intents settlement](../artifacts/mainnet-intents-settlement.json) | Two real internal agent payments; not external revenue                                                                             |
| [Fresh gas funding](../artifacts/mainnet-fresh-gas-funding.json)            | Actual 1Click/Intents conversions to derived Base/Solana wallets                                                                   |
| [Owner-authorized MPC transfers](../artifacts/mainnet-owned-execution.json) | Confirmed Base USDC and Solana SOL fixtures, two closed cycles and eight successful NEAR receipts; zero gross P&L                  |
| [RPC read recovery](../artifacts/mainnet-rpc-recovery.json)                 | Mainnet-verified fallback after transient primary failure, preserved finalized block hashes and hosted HTTP 200 after cache expiry |

The owner authorized the controlled scripts using scoped agent-role keys. The
AI engine did not initiate those transactions. Funding failures/refunds remain
in their original records; capital plus recorded continuation NEAR fees stayed
within the 0.50-NEAR ceiling. This does not value all operating costs in USD.

## Manual API probe — November 12, 2026

One authorized [Manual API Probe (Unverified Inference)](../artifacts/manual-ai-probe.json)
returned HTTP 200 and `NEAR_AI_OK` from `z-ai/glm-5.3-flash`. Provider billing
reconciled 31 prompt / 6 completion tokens to **5,480 nano-USD ($0.00000548)**.
It used the newer configured user-owned Cloud key, not the Builders grant key.
The completion does not independently establish organization membership,
response-signature verification or TEE approval.

There was no retry, treasury invocation or blockchain action. The manual count
is one; automated paid requests remain zero. A rounded 6-micro-USD hold leaves
999,994 micro-USD of the shared $1 application allowance for automation. The
public evidence endpoint reads this artifact and cannot request inference.

## TEE audit — November 7, 2026

The unmodified pinned Brave CLI's provenance-only run exited **1**. Hardware,
GPU and TLS subchecks passed, but required launcher provenance, source/OS pins
and measured services did not meet the full policy. The
[invocation summary](../artifacts/brave-cli-verification.json) and
[raw report](../artifacts/brave-cli-provenance-only-report.json) preserve the
result. No paid completion was issued by that audit. See
[the policy explanation](PRIVATE_INFERENCE.md#launcher-provenance-and-the-brave-verifier).

## Historical testnet and PAPER records

- [Testnet rehearsal](../artifacts/testnet-rehearsal.json): real testnet contract/MPC checks with explicitly synthetic economics.
- [Hosted PAPER verification](../artifacts/hosted-paper-verification.json) and [operator recovery](../artifacts/operator-hosted-verification.json): earlier simulation and worker crash/reclaim checks.
- [Funding release manifest](../artifacts/funding-release-manifest.json): isolated conversion/distribution recovery checks and state-preserving testnet upgrade; no business-funded mainnet payout.

These artifacts retain their dates and scope. Separate Sepolia/devnet transfers
are authorization fixtures, not a complete profitable AI workflow. The current
public evidence route prioritizes mainnet; `/testnet` redirects to it.

## Interpretation

Current scope and unfinished business claims are consolidated in the
[README](../README.md#5-not-yet-proven). A passing unit test, owner deposit,
invoice, manual purchase report or sandbox payout cannot substitute for external
revenue, realized net profit or purchased provider credits. Automated execution
remains disarmed and TEE-quarantined. Submission remains on hold.
