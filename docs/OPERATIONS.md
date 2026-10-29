# Operations and live setup

## Dedicated accounts and custody

Use a new treasury contract account, Brain account, Hand account, Scout recipient, accountant account and offline owner. Never copy unrelated wallet keys into this project. The service must not possess the owner's key.

The Brain role authorizes committed routes. Hand requests constrained signing and records submissions. The accountant finalizes reported reconciliation and mints receipts. The owner sets policy, revokes workers, pauses the contract and withdraws uncommitted native funds. These are explicit trust boundaries. A response attestation is verified by the backend, not by the treasury contract.

Provision per-role function-call keys with limited gas allowances and only the required receiver/methods. Keep owner/full-access recovery keys offline. Intents account keys also authorize balances on the verifier; removing a NEAR account key does not unregister its Intents key. Revoke both registrations during key rotation. Start with small, separately funded service balances.

The supplied runtime composes the agents on one host. Separate processes/roles are supported; host-level credential isolation and attested execution of the orchestrator are not claimed. A NEAR function-call key has one allowed receiver, so LIVE Intents payments use separate `INTENTS_BRAIN_PRIVATE_KEY` and `INTENTS_HAND_PRIVATE_KEY` values scoped to `intents.near`, while treasury keys target the treasury contract. Register those dedicated Intents public keys on the verifier.

## Configure LIVE

Start from `.env.example`. Required live values include:

| Setting                                                       | Purpose                                                                       |
| ------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| `EXECUTION_MODE=LIVE`, `LIVE_TRADING_ENABLED=true`            | Explicit live arming                                                          |
| `NEAR_NETWORK=mainnet`, `NEAR_RPC_URL`                        | Actual mainnet; 1Click has no testnet                                         |
| `NEAR_CONTRACT_ID`                                            | Deployed guarded treasury                                                     |
| `NEAR_BRAIN_ACCOUNT_ID`, `NEAR_BRAIN_PRIVATE_KEY`             | Brain authorization signer                                                    |
| `NEAR_WORKER_ACCOUNT_ID`, `NEAR_WORKER_PRIVATE_KEY`           | Hand signer                                                                   |
| `NEAR_ACCOUNTANT_ACCOUNT_ID`, `NEAR_ACCOUNTANT_PRIVATE_KEY`   | Reconciliation signer                                                         |
| `NEAR_SCOUT_ACCOUNT_ID`                                       | Signal seller recipient                                                       |
| `CHAIN_SIGNATURES_CONTRACT`, `CHAIN_DERIVATION_PATH`          | MPC service and immutable derivation identity                                 |
| `NEAR_AI_API_KEY`, `NEAR_AI_MODEL`                            | Paid inference; use a canonical NEAR-served model                             |
| `NEAR_AI_ORG_ID`, `NEAR_AI_SESSION_TOKEN`                     | Provider credit balance; session access is distinct from an inference API key |
| `TEE_GATEWAY_COMPOSE_HASHES`, `TEE_MODEL_COMPOSE_HASHES`      | Independently reviewed deployment measurements                                |
| `ONECLICK_JWT`, `ONECLICK_MANAGER_PUBLIC_KEY`                 | Optional partner JWT; approved signed-quote manager remains required          |
| `EVM_RPC_URL`, `EVM_CHAIN_ID`, `SOLANA_RPC_URL`               | Correct mainnet endpoints                                                     |
| `BASE_ASSET`, `BASE_DECIMALS`, `ALLOWED_*`                    | Registry asset IDs, chain IDs and derived recipients                          |
| `NFT_RECEIVER_ID`, `NFT_SHARE_BPS=0`                          | Receipt holder; automatic rights require completed cost valuation             |
| Random `ADMIN_TOKEN`, `READ_TOKEN`, `EVIDENCE_ENCRYPTION_KEY` | Application access and evidence storage                                       |

`ONECLICK_JWT` is optional. Without it, the provider applies its unauthenticated fee schedule; the backend still verifies signed quotes and evaluates the actual quoted minimum return. It never assumes zero platform fees. The preflight reports `oneclickAuthentication` separately from required credentials. See the official [API key guide](https://docs.near-intents.org/integration/distribution-channels/1click-api/authentication) and [fee schedule](https://docs.near-intents.org/resources/fees).

The default Solana RPC in the example is devnet for local safety; change it to a mainnet endpoint for LIVE. The wallet adapter verifies the genesis hash. Supported EVM origin metadata maps Ethereum, Base, Arbitrum and Optimism, with one configured EVM chain per deployment. Solana signing is native SOL only; arbitrary SPL/program instructions are refused.

Pin compose measurements from an independently reviewed deployment/provenance process. Do not copy whatever measurement the provider returns into the allowlist at runtime. Debug platforms, unacceptable TCB states, replayed nonces, unsupported signature kinds and mismatched response bytes fail closed.

Model preflight is non-billable. The completion POST is paid. Hardware collateral and NVIDIA verification require outbound network access. The code requires an accepted model-serving signature rather than silently downgrading to gateway-only evidence.

## Build and initialize the treasury

`npm run contract:build` creates `artifacts/symbiochain_treasury.wasm` and its SHA-256. Deploy only this treasury WASM; **never deploy the MPC mock for live use**.

The contract initializer takes `owner`, `brain`, `hand`, `accountant`, `mpc`, `derivation_path`, and `policy`. Example policy shape:

```json
{
  "max_trade_atoms": "10000000",
  "max_daily_atoms": "50000000",
  "min_reserve_yocto": "500000000000000000000000",
  "max_signing_cost_yocto": "1",
  "max_slippage_bps": 50,
  "allowed_chain_ids": [8453, 0],
  "allowed_token_contracts": ["REPLACE_WITH_APPROVED_ERC20_ADDRESS", "sol:native"],
  "token_max_trade_atoms": ["10000000", "1000000000"],
  "token_max_daily_atoms": ["50000000", "5000000000"]
}
```

Chain `0` is the contract's native-Solana sentinel, not an EVM chain. Base-asset budgets and independent raw-token caps prevent incompatible denominations or a misleading budget from bypassing token limits. Both legs consume a base-denominated authorization budget, so size the daily limits accordingly. Contract authorizations expire within one hour, are immutable, and cannot request a second signature. Signing rechecks current policy and revocation.

Fund native operational/storage reserves. With the default Intents service rail, register the Brain/Hand Ed25519 public keys on `intents.near` and fund their `nep141:wrap.near` balances. Registration is an explicit wallet operation using the official [key-registration instructions](https://docs.near-intents.org/integration/verifier-contract/account-abstraction). The optional `NEAR_LEDGER` rail instead requires each payer to call `fund_services` on the treasury.

Read `get_signing_identity`; confirm its predecessor/path/MPC service match the backend configuration. Derive and fund the EVM and Solana wallets for that **contract account**, not the worker account. ERC-20 principal, EVM native gas and a SOL fee reserve are separate balances. Changing the treasury account or derivation path changes custody addresses.

The Scout maintenance loop reconciles an idle, confirmed ERC-20 balance into `UNATTRIBUTED_EXTERNAL_CAPITAL`, including deposits made after startup. Registry/RPC failures in this maintenance step do not prevent committed jobs from being reconciled. It never records a balance difference as revenue or reconciles an idle balance over active reservations. The block recorded in the event is the actual confirmation-adjusted balance block.

## Route discovery and policy

`SCOUT_ROUTES_FILE` points to a JSON array of at most ten Proposal objects **without** `expiresAt`. Scout supplies a deadline and searches periodically. Use actual registry assets, `eip155:<configured id>`, `solana:mainnet`, and the derived EVM treasury for both return recipient/refund. One live operation is admitted at a time to avoid competing unsigned nonces.

The DB policy is initialized once from environment defaults. Update it with the revision-checked admin API; an environment change does not overwrite persisted policy. The contract policy remains an independent owner-controlled ceiling. A backend policy change does not impersonate the owner or automatically change the contract.

Profitability uses a conservative return minimum, configured gas estimate and cost buffer. A second-leg quote may later fail that minimum, in which case assets remain held. Do not loosen policy merely to force a judge-facing success.

## Metabolism and funding

The backend stops purchasing inference when measured compute credit is below its floor or unknown. Credit observations expire after two minutes. `SYNC_STAKING_CREDITS=true` invokes the documented sync endpoint for a source already linked to the NEAR-authenticated organization. It does not create a stake, spend principal, or prove a trading-funded compute purchase. Session-token expiration also stops this path until credentials are renewed.

Actual request billing, grants/staking credits, service transfers and wallet capital are distinct evidence. Wallet balance divided by an assumed inference price is not a measured survival time. Hosting costs, native gas valuation and automatic conversion of trading profit into paid credits remain outside the demonstrated closed loop.

## Incident recovery

1. Pause the backend immediately with `/api/admin/pause`. An in-flight external request may still finish. Pause the NEAR contract using the offline owner when signing must stop independently of the backend.
2. Inspect cycle jobs, `lastError`, inference status, leg status, persisted transaction identities, RPC receipts, and provider status. Back up the database and encryption key together.
3. For `UNKNOWN`/settlement failures, reconcile the existing hash. Do not delete a reservation, change a nonce, or generate another transfer to make the dashboard advance.
4. A `STARTED` inference without response bytes may already be billed. Reconcile with the provider; automatic paid resubmission is deliberately disabled.
5. A stale Solana blockhash, reverted deposit, intermediate refund, or expired authorization requires explicit recovery. The automated worker holds its reservation rather than guessing that the money is free.
6. Rotate compromised worker keys and disable their contract role. Remove registered Intents keys separately. Rotate tokens independently from the evidence-encryption key; decrypt/re-encrypt existing evidence before replacing that key.

Unconfirmed sends may rebroadcast **identical persisted bytes**. `MAX_BROADCAST_ATTEMPTS` (default 3) and `REBROADCAST_INTERVAL_MS` (default 30,000) are enforced in PostgreSQL across restarts. Attempts, last send time and the sanitized error code are available in the cycle's leg summaries. Exhaustion, expiry or pause keeps funds held. No new signature or nonce is created. A confirmed first-leg refund finalizes its on-chain authorization; an intermediate-asset refund remains held for reviewed recovery.

The owner can withdraw uncommitted **native NEAR** only after pausing and when no unresolved signed/submitted cycles remain. This method is not an arbitrary cross-chain recovery signer. Recovering held external assets requires a separately reviewed, constrained recovery action; do not deploy a blind-signing bypass.

## NFTs and distributions

The contract offers NEP-171 core/metadata/enumeration, reported profitable-cycle receipts, fixed share bps, explicit NEAR distributions and pull claims. Rights sum to at most 10,000 bps. Distribution references cannot repeat. At most 128 nonzero rights tokens keep the distribution loop bounded. Unallocated distribution funds remain uncommitted treasury funds; no guaranteed payout is promised.

`NFT_SHARE_BPS=0` permits disclosed buffer-based receipts. A nonzero setting makes a reconciled cycle wait for `POST /api/admin/cycles/:id/cost-basis`. An authorized accounting service or operator supplies the complete valuation; the backend then automatically finalizes/mints from the approved net basis. No oracle or independent truth is implied by the administrator's approval.

The immutable approval body contains the exact `settlementDigest`, total `inferenceCostUsdMicros`, `computeBaseAtoms`, `nativeGasBaseAtoms`, `hostingBaseAtoms`, `otherBaseAtoms`, `receiptBudgetBaseAtoms`, and `approvedBy`. Amounts are nonnegative atomic strings; receipt-gas budget must be positive. `sourceEvidence` contains `nativeFeeEvidenceDigest`, a descriptive `valuationMethod`, nonempty `references`, and `includesNearGasAndHosting: true`. Calculate hashes using the canonical `digest` helper. Mismatched settlement/fee hashes, incomplete billed-inference totals and changes to an existing approval are rejected. Approval must arrive while the cycle is `RECONCILED`; do not change share configuration during an active cycle.

The source evidence and cost-basis digest appear in cycle/export/receipt evidence with an `ACCOUNTANT_APPROVED` trust label. Depositing money into a distribution function does not establish that the money was business revenue.

## Dependency review

The recorded npm audit has no high/critical findings and retains transitive low/moderate findings in the Chain Signatures/Solana toolchain. The known critical legacy DCAP binding was replaced with the advisory-recommended patched package; `tar` is pinned to a patched version. Do not apply a breaking dependency override just to suppress audit output. Re-run the adapter and sandbox gates when upgrading these dependencies.

## User-facing fault and cost demonstration

Open `/dashboard` and connect with the administrator token. On the colocated PAPER Render profile, `ENABLE_CHAOS_DEMO=true` enables the crash control and `NFT_SHARE_BPS=100` demonstrates the approval gate. Local `.env.example` keeps both features opt-in; its normal CLI demo uses zero rights.

1. Pause Scout using its agent card.
2. Create a PAPER cycle; its Scout job remains queued.
3. Arm the worker crash for that selected cycle and Scout.
4. Resume Scout. The worker claims the job, records the trigger and exits with SIGKILL.
5. Wait for the host to restart the service and for the job's lease to expire. The normal lease is 60 seconds; host startup adds time. The same Scout job should show attempt two.
6. The recovered cycle reaches `RECONCILED` and waits for cost approval.
7. Inspect the economics, fill explicitly simulated costs, review the acknowledgement and submit the bound approval. This synthetic valuation includes automatically deducted settlement fees and a separately labeled receipt budget.
8. The cycle closes with simulated rights. No on-chain mint, actual inference or real profit is claimed.

Cancel an armed crash before resuming if the target is wrong. Pause/resume controls remain available independently of crash injection. The spending pause governs new backend spending; the offline owner must pause the contract separately when on-chain signing needs to stop.

For LIVE, leave chaos controls disabled. Supply actual gas/hosting valuation and evidence references for cost approval. Receipt budgets are not final realized charges; a complete business expense observation window and funding costs are still needed for runway.
