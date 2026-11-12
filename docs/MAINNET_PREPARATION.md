# Mainnet preparation and bounded internal payments

Owner activation and an execution engine are separate permissions. The TEE gate
remains closed, and the losing trading route is never forced through it.

## Autonomous preparation

`MAINNET_PREPARATION_ENABLED=true`, `MONITOR_ONLY_WORKERS=false` and
`EXECUTION_ENABLED=false` start an autonomous read-only worker. Every five minutes
it checks the deployed treasury code and policy, derives the real Base and Solana
wallets, checks network identities and confirmed balances, and requests two signed
1Click dry quotes at no more than the approved 0.05-USDC size. The exact quote
verification and routing code is shared with the real execution adapter.

The worker constructs no AI client, Intents signer, treasury signer, Engine or
funding runner. Three heartbeats continue while network checks run. Reports use
the existing private outbox table and are committed atomically. No migration,
public table access or fictional ledger funding is introduced. An interrupted
probe can run again because it has no financial side effects. The previous
committed report remains dated and becomes stale after ten minutes.

`GET /api/mainnet/preparation` is read-token protected. The frontend uses the
fixed server-only `/api/swarm/mainnet/preparation` proxy and strict shared schema.
The evidence page distinguishes preparation activity from authority to spend.
All nine non-TEE trading checks must pass before the next gate can be reported as
TEE approval. Missing capital, native gas or return-chain permissions are separate
failures. A valid signature on a dry quote is not a filled trade.

## Controlled mainnet Intents test

The user delegated selection of a small funding budget. The chosen **0.03 NEAR
planning ceiling** covers the complete internal-payment test, including the
failed first attempt. The original treasury allocation and its 0.10-NEAR reserve
are not used or topped up. At least 0.20 NEAR stays in the funding wallet.

The local portal `http://localhost:3421` requests one wallet signature from
`solidvideo4090.near`, with four calls to `wrap.near`:

1. Register the payer's FT storage with at most 0.00125 NEAR collateral; an
   existing registration refunds the deposit.
2. Wrap 0.002 NEAR, which remains recoverable capital.
3. Transfer 0.001 wNEAR into Brain's Intents balance.
4. Transfer 0.001 wNEAR into Hand's Intents balance.

Each transfer-call attaches one yoctoNEAR. The corrected calls each attach 70 TGas;
the owner's fee planning allowance is 0.017 NEAR. The subsequent Brain-to-Scout and
Hand-to-Brain transfers use 0.0001 wNEAR each and at most 0.0035 NEAR fees each.
Existing finite function-call keys permit only `execute_intents` on `intents.near`.
These are internal, team-funded transfer fixtures, not a paid model assessment,
external customer revenue, a swap, business profit or a revenue distribution.

The initial funding transaction
[`MFRCsnFFKRndiQTHhcNSTjJ7KsNcBuAUtEnmXWysx43`](https://nearblocks.io/txns/MFRCsnFFKRndiQTHhcNSTjJ7KsNcBuAUtEnmXWysx43)
failed at its first FT callback with `FunctionCallZeroAttachedGas`. The full
batch rolled back: both agent credits stayed zero, and the funding wallet's debit
was exactly the 0.0006324395304617-NEAR network fee. The failed attempt is preserved;
its fee counts toward the same test budget. The corrected path was rehearsed
against the observed mainnet wrapping code with an explicitly local mock receiver.
This rehearsal does not establish a successful mainnet Intents transfer.

```sh
bash scripts/build-mock.sh
bash scripts/install-sandbox.sh
node tools/mainnet-deploy/wrap-gas-rehearsal.mjs
```

The funding portal has no recovery key. Unknown outcomes hold another signature;
finality, every action, all outcomes and both actual credited balances are checked
before completion. After funding is confirmed, the controlled local runner uses
only the already registered agent keys:

```sh
node tools/mainnet-deploy/settle-intents-fixture.mjs --execute
```

Signed bytes, native transaction hash and the NEP-413 nonce are persisted before
broadcast. A restart reconciles that same identity; it never generates a replacement
payment after an unknown outcome. Successful debit/credit reconciliation and final
receipts produce `artifacts/mainnet-intents-settlement.json`. An unexecuted test
must not be called complete simply because its runner exists.

## Remaining independent conditions

The current Base-only contract policy does not authorize a native-SOL return leg.
That extension requires an owner signature and native-unit token caps. Derived
wallets need real USDC, ETH and SOL; native treasury collateral cannot substitute
for those balances. A route must clear the unchanged cost buffers and profit
floor. No market result or customer demand is created by deployment or by a
funding budget. Automatic provider credit purchasing still needs a supported
provider flow; internal transfers cannot establish purchased credits or revenue.

## Confirmed internal settlement — November 12

The corrected funding transaction is finalized:
[`EtMQTEso4nZsyzbhqY3f4sWmmBmaKpDLkCCJJxq7MMhx`](https://nearblocks.io/txns/EtMQTEso4nZsyzbhqY3f4sWmmBmaKpDLkCCJJxq7MMhx).
Both agents received exactly 0.001 wNEAR inside Intents.

The first attempted native payment was rejected before inclusion with
`NotEnoughAllowance`: the node required 0.030923502300241 NEAR allowance while
the key allowed 0.005 NEAR. It incurred no fee and used no Intents nonce. The user
atomically replaced each existing native function-call key with the same public
key, receiver and method scope, increasing its finite gas allowance to 0.04 NEAR.
The native key nonce reset invalidated the rejected transaction envelope.
Reconciliation retained the same off-chain payment nonce and exact economic terms.

Two actual transfers then succeeded and their exact debit/credit changes were
reconciled:

- [Brain paid Scout](https://nearblocks.io/txns/DVhS7bWWj5Rk3B7TRiTCw1SYXR1RpctCSw5xzWX5FnLB): 0.0001 wNEAR.
- [Hand paid Brain](https://nearblocks.io/txns/D2MwyAjVyKZFe8hYVeNX2YT6WR9dL1VRud3xaARJJneZ): 0.0001 wNEAR.

[Machine-readable evidence](../artifacts/mainnet-intents-settlement.json) records
0.0037364334643139 NEAR in total network fees, including the failed funding and
the two allowance repairs. A separate 0.00125 NEAR is FT storage collateral and
0.002 NEAR is recoverable capital. The observed sum is below the 0.03-NEAR ceiling.
These transfers do not establish external revenue, a market swap, model execution,
profit or purchased credits. The Intents key repair does not expand its receiver
or permitted native method and does not grant full access.
