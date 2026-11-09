# Bounded owner activation with AI quarantined

The current activation panel is on [Execution evidence](https://symbiochain.vercel.app/evidence). It distinguishes observed owner activation, configured credentials, Intents registration, monitor heartbeats and the closed AI gate. A prepared plan is not an executed transaction; the panel publishes only confirmed receipts.

## Account and unit binding

Treasury: `treasury.symbio-fcef733893.near`. Contract owner: `symbio-fcef733893.near`. The recovery public key already present on the funding Meteor wallet controls these accounts and the agent accounts. No recovery key or revoked temporary deployment key is loaded by the backend.

The owner plan sets **0.05 USDC per authorization** and **0.10 USDC per day**, in six-decimal USDC units, with matching per-token limits. Only Base chain ID 8453 and its native USDC contract `0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913` are allowed. The native treasury reserve stays 0.10 NEAR; the permitted MPC signing deposit is 1 yoctoNEAR. The current trading strategy cannot execute a 10-USDC proposal under these deliberately smaller limits.

These are authorization limits, not a universal NEAR outflow cap. They do not constrain every owner action, Intents balance or network fee. Each account's full-access recovery authority remains able to administer its own funds. Gas estimates are planning checks; NEAR transactions have no maximum gas-price field. Do not claim mathematical immunity to all fund loss.

## Runtime configuration

The existing Render service retains its database, application tokens, evidence key, Cloud key/organization binding and durable AI budget identity. The application uses these actual names:

| Variable                                                                                          | Purpose                                                                          |
| ------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------- |
| `NEAR_BRAIN_PRIVATE_KEY`                                                                          | Existing key scoped to Brain's treasury methods                                  |
| `NEAR_WORKER_PRIVATE_KEY`                                                                         | Existing Hand key scoped to treasury execution methods                           |
| `NEAR_ACCOUNTANT_PRIVATE_KEY`                                                                     | Existing accountant key scoped to reconciliation/receipt methods                 |
| `INTENTS_BRAIN_PRIVATE_KEY`, `INTENTS_HAND_PRIVATE_KEY`                                           | Separate keys scoped to `execute_intents` on `intents.near`                      |
| `EVM_RPC_URL`, `EVM_CHAIN_ID`                                                                     | Verified Base mainnet RPC and chain ID 8453                                      |
| `NFT_RECEIVER_ID`                                                                                 | `solidvideo4090.near`; configuration does not mint an NFT                        |
| `MAX_TRADE_ATOMS`, `MAX_DAILY_SPEND_ATOMS`                                                        | 50000 and 100000 USDC atoms                                                      |
| `MONITOR_ONLY_WORKERS`                                                                            | `true`: publish heartbeats without constructing providers or an execution engine |
| `EXECUTION_ENABLED`, `LIVE_TRADING_ENABLED`, `LIVE_ARBITRAGE_ENABLED`, `BUSINESS_PAYOUTS_ENABLED` | `false` while AI execution remains quarantined                                   |
| `SERVICE_PAYMENT_YOCTO`                                                                           | Zero during quarantine; no automatic service debit                               |

Original treasury key scopes are independently checked before provisioning. Counts on the public panel represent configuration presence; Intents registration is separately queried on-chain. An Intents key's function-call gas allowance limits its NEAR transaction fees, but its registered signing authority covers that agent's Intents balances. Registration is not a funded settlement.

The worker process can now run a monitor-only branch. It updates the three existing heartbeat records and never constructs an Engine, wallet signer, inference provider or funding runner. Monitor configuration refuses every enabled spending switch. The existing execution and TEE guards remain unchanged. Heartbeats do not prove an autonomous AI cycle, job recovery or market activity.

## Owner review and signatures

The keyless local portal is **http://localhost:3420**. It is loopback-only, checks Host and Origin and requires its per-process session token on control routes. The reviewed public plan is [mainnet-bounded-plan.json](../artifacts/mainnet-bounded-plan.json).

Seven sequential signatures were confirmed on November 9, 2026:

1. Brain adds a function-call key restricted to `intents.near.execute_intents`, with a 0.005 NEAR gas allowance.
2. Brain registers that public key with Intents, attaching 1 yoctoNEAR.
3. Hand adds its separate key with the same scope and allowance.
4. Hand registers its public key, attaching 1 yoctoNEAR.
5. While paused, the owner withdraws 0.02 NEAR from existing treasury funds to the same owner account for gas. The 0.10 NEAR native reserve remains protected.
6. The contract owner atomically sets the reviewed policy, enables Brain/Hand/accountant and unpauses the treasury. Five synchronous calls use 5 TGas each (25 TGas total).
7. The owner calls `fund({})` with **zero deposit** as a control probe. This adds no treasury capital and proves no revenue or trade.

There was **no treasury top-up**. The combined planning ceiling was 0.03 NEAR: 0.02 NEAR reallocated internally for owner gas and 0.01 NEAR allowed for network fees and new key storage. Per-transaction network fee allowance was 0.01 NEAR. The original higher-gas owner batch was rejected by Meteor before submission; the reduced-gas batch and reserve allocation were rehearsed locally before the owner reviewed the revised plan. No rejected transaction was silently repeated. Preflight rechecks finalized code/custody, permissions, gas price and signer reserves. Actual fees and storage changes are reconciled after confirmation.

Meteor must select the named signer, rather than `solidvideo4090.near`. If those accounts are missing, use Meteor's own account discovery/recovery UI with the original recovery custody. [Meteor's official guide](https://help.meteorwallet.app/en/articles/4-how-to-import-an-existing-wallet-into-meteor-wallet). Enter recovery material only inside the wallet's own UI; never in this portal, backend environment or chat.

An unknown signing result blocks another signature. Reconcile its existing hash. The server checks exact signer/receiver, every action and argument, finality, all outcomes, fees, receipt age and expected after-state. Verified receipts are idempotent. It cannot create an owner signature or sign with a recovery key.

## Evidence and limits

[Bounded activation proof](../artifacts/mainnet-bounded-activation.json) records COMPLETE coverage for all seven finalized receipts, independently rechecked against archival mainnet RPC. It reconciles fees and added storage separately from the 0.02 NEAR owner gas allocation. The owner policy is active and all three on-chain worker permissions are enabled. Runtime monitoring remains separate from execution. The schema also supports PENDING and PARTIAL coverage for future runs. Pending artifacts contain no invented transaction. The live panel may observe a changed policy before all receipts have been published; it keeps observed state separate from recorded coverage.

Inference remains blocked by application-level TEE workload measurement policy. Hardware evidence and software acceptance remain different checks. No returned hash is automatically trusted. External revenue, profitable market settlement, mainnet revenue-share distributions and automatic provider credit purchasing remain unproven. The activation is not a proof of an earning business.
