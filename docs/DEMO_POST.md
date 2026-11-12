# Demo and X-post draft

Draft only. The user publishes the post and attaches the demo; no X account is
accessed or posted to by this workflow. Submission remains on hold.

## Single-post text

```text
AI agents need spending limits.
Built SymbioChain at NEAR HACKATHON: bounded NEAR treasury + owner-run Base/Solana transfers. Manual AI probe passed; automated AI stays gated.
@NEARProtocol #NEARHackathon
https://symbiochain.vercel.app/evidence
https://github.com/AviraL0013/SymbioChain
```

The draft is 252 characters when each URL uses X's standard 23-character
URL allocation. It includes the event name, @NEARProtocol and #NEARHackathon.
Attach the video before publishing; the public X post URL becomes the demo link
only after the human has published it.

## Two-minute walkthrough

| Time      | Screen/action                                                         | Say/show                                                                                                                                                                         |
| --------- | --------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 0:00–0:15 | Public dashboard, without logging in                                  | Agents need bounded spending authority. Show finalized balances, 0.25/0.50-USDC limits and DISARMED runtime.                                                                     |
| 0:15–0:45 | Evidence → Mainnet MPC transfer fixtures → Base/Solana explorer links | The owner authorized these tests; scoped agent-role keys and Chain Signatures executed them. Show both finalized transfers and closed contract cycles.                           |
| 0:45–1:05 | Intents settlement and funding panels                                 | Show real gas-funding conversions and internal agent payments, separately from the direct MPC transfer fixtures.                                                                 |
| 1:05–1:25 | Manual API Probe (Unverified Inference)                               | One actual Cloud response, one reconciled $0.00000548 charge, no treasury funds used.                                                                                            |
| 1:25–1:50 | Activation/TEE state and README enforcement layers                    | The contract enforces permissions and native/token budgets; the application checks compute budgets and TEE approval. Automated AI remains gated by the complete workload policy. |
| 1:50–2:10 | README → Not Yet Proven, then public source                           | Show the remaining business claims once, then invite reviewers to inspect the public receipts and reproduce the PAPER workflow.                                                  |

Suggested narration: “We tested the model connection and proved cross-chain
signing and settlement with owner-authorized mainnet transfers. The automated
engine remains disarmed because a successful API response does not satisfy our
TEE workload policy. The model cannot override the deterministic spending
checks.”

Use the existing recorded receipts; this walkthrough needs no new signatures,
funding, paid inference, trades or minting. Keep API keys, recovery material and
private operator credentials off screen. Current policy and evidence scope are
in the [README](../README.md); the [idea draft](../HACKATHON.md#idea-field-pitch)
uses the same claims.
