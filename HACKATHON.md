# SymbioChain: hackathon notes

[Product and five-minute verification](README.md) · [Live evidence](https://symbiochain.vercel.app/evidence) · [Demo/X-post draft](docs/DEMO_POST.md)

## Idea-field pitch

AI agents need spending power without unrestricted custody. SymbioChain provides a policy-controlled treasury on NEAR: its contract enforces roles, asset limits, native reserves and one-use signing, while the application checks compute budgets, quote economics and TEE workload approval. We proved the rails on mainnet with owner-authorized Chain Signatures transfers on Base and Solana, real Intents gas conversions and internal agent payments. The current USDC policy is 0.25 per authorization and 0.50 daily, with separate native-SOL caps. One isolated manual Cloud AI probe returned a real completion and reconciled to $0.00000548. Automated AI remains disarmed because the complete workload/provenance policy is unmet; losing trade routes remain rejected independently. With 290 passing automated tests plus contract checks and public receipts, we demonstrate constrained execution mechanics. External revenue, profitable trading, automatic credit purchasing and profit-funded NFT payouts remain unproven.

## What a judge can verify

| Action                                          | Observable result                                                                          |
| ----------------------------------------------- | ------------------------------------------------------------------------------------------ |
| Open the public dashboard                       | Finalized NEAR balances, current owner policy and execution state                          |
| Inspect the mainnet execution panel             | Owner-initiated Base/Solana transfers, two closed contract cycles and eight NEAR receipts  |
| Inspect Intents funding/payment records         | Real destination-gas conversions and two internal agent settlements                        |
| Inspect Manual API Probe (Unverified Inference) | One successful Cloud completion with 31 input / 6 completion tokens and reconciled billing |
| Run the local PAPER demo                        | A repeatable three-agent workflow reaches `CLOSED` with simulated economics                |

The current contract policy permits **0.25 USDC per authorization / 0.50 USDC per
day**, **0.004 / 0.008 native SOL**, and protects a **0.10-NEAR native reserve**.
The human authorized the mainnet test scripts; the AI engine did not initiate
those actions. 1Click funded destination gas through real Intents swaps; the
separate controlled transfer fixtures used Chain Signatures directly.

## Enforcement layers

The NEAR contract enforces role permissions, approved assets/chains, token caps,
reserve protection and constructed one-use signing payloads. Receiver-scoped
function-call keys can call listed methods only on their designated contract.
Application checks enforce compute budgets, deterministic quote admission and
TEE workload acceptance. Cloud credits and TEE measurements are not verified by
the Rust contract itself.

The current Cloud deployment did not meet the full provenance/measurement
policy; automated execution remains disarmed. The manual probe is authenticated
but unverified inference. Its completion does not independently establish
configured organization membership or response-signature verification. See the
single [Not Yet Proven list](README.md#5-not-yet-proven) for unfinished claims.

## Reproduction and evidence

Follow [local setup](README.md#run-locally) and the [judge walkthrough](docs/JUDGING.md).
The latest validated code passes 162 backend unit tests, 81 isolated PostgreSQL
integration tests, 19 wallet-tool checks and 28 frontend tests, plus contract CI.
Hosted desktop/mobile checks preserve credentials on the server.

- [Owner-authorized MPC transfers](artifacts/mainnet-owned-execution.json)
- [Fresh Intents gas funding](artifacts/mainnet-fresh-gas-funding.json)
- [Internal agent payments](artifacts/mainnet-intents-settlement.json)
- [Manual AI probe](artifacts/manual-ai-probe.json)
- [Application release identity and checks](artifacts/mainnet-rpc-recovery.json)
- [Detailed verification record](docs/VERIFICATION.md)

## Tracks

**Security** and **DeFi** are the primary documented fits: contract-enforced
budgets, scoped signing, fail-closed AI admission, actual cross-chain transfer
rails and Intents settlement.

## Submission status

Documentation and the idea field are drafts. Submission remains **on hold** at
the owner's request. No submission request or X post is authorized by this document. Contact details, payout choice
and the human-published demo URL stay outside Git; any future submission needs
the user's explicit instruction and completed organizer requirements.
