# Earned-proceeds NFT funding

## Status — November 6, 2026

The conversion, native withdrawal, treasury distribution and durable recovery code
are implemented. They use public 1Click, Intents and NEAR RPC interfaces. The
feature defaults to disabled, with zero spending caps. There has been **no funded
SymbioChain mainnet conversion or business-funded dividend**. The owner has no
mainnet funds and has not selected an account or spending limits.

Automatic NEAR AI credit purchasing is still **provider-blocked and unimplemented**.
The owner requires publicly supported interfaces only. The reviewed public API
does not supply a verified customer payment-to-credit protocol. The compute
purchase endpoint returns `409 PROVIDER_PURCHASE_PROTOCOL_REQUIRED`, creates no
payment and changes no credits. A grant, staking sync, credit transfer or provider
admin allocation is not recorded as a purchase. See [the provider review](PROVIDER_FUNDING.md).

## Money and proof

1. The [business ledger](BUSINESS_ACCOUNTING.md) must recognize a final external
   mainnet fee receipt and close a complete accountant-reported operating-cost window.
2. Reserve available positive net for `NFT_DISTRIBUTION`. Recorded business losses
   and unresolved inference charges prevent new spending. Neither an invoice nor
   investor capital qualifies as collected fee revenue.
3. Queue that reservation with an explicit minimum native NEAR output. Freeze its
   identities, input amount, gas allowance, reserve, code hash and refund deadline.
4. If the revenue asset is not wNEAR, obtain a signed 1Click quote with origin,
   destination and refund type `INTENTS`. Validate the generated single-action
   NEP-413 payload before signing its exact bytes. Support the provider's current
   deposit-account `transfer` and the documented bounded `token_diff` form.
5. Reconcile the same quote and nonce: provider SUCCESS, used Intents nonce,
   signed quote identity, reported output and final successful destination
   receipts must agree. Count net wNEAR credits emitted by `intents.near` after
   the quote. An authorized transfer alone is not settlement proof. This trusts
   the configured RPC and 1Click's mapping from quote to destination hashes; it
   is not a light client or independent proof of commercial substance.
6. Withdraw the guaranteed minimum as native NEAR to the accountant using
   `native_withdraw`. Any verified excess output stays as wNEAR. If the reserved
   asset is already wNEAR, skip the swap and withdraw the reservation amount.
7. Submit `distribute_revenue` with that exact native deposit and the unique
   reservation-bound reference. Require final success for every receipt and the
   treasury's exact `revenue_distributed` event, including allocated and retained
   amounts. The pinned contract protects holder liabilities; holders use its
   existing pull-claim methods. The backend does not impersonate NFT holders.

The ledger records input conversion, actual credited output, native withdrawal,
dividend liability, treasury retention and observed gas once. Gas initially comes
from the accountant's separately funded native reserve, not a claimed automatic
gas-funding loop. Later cost windows must include and positively value recorded
native gas before reporting new distributable profit. Units remain separate:
revenue-token atoms, yoctoNEAR and USD micros are not interchangeable.

## Recovery and limits

The encrypted append-only `BusinessEntry` journal persists the quote, signed
intent and exact signed NEAR transaction **before** submission. Only one funding
operation is active at a time; a dedicated payout access key isolates transaction
nonces from trading-cycle finalization. Concurrent workers converge on the
persisted winner. Reconciliation precedes any send; retries reuse its exact bytes
and stop after three submission attempts per stage. No replacement nonce is
generated for an unknown or expired payment. Accepted-but-unconfirmed outcomes
remain held. Use an RPC with sufficient transaction history for restart recovery.

The request refund deadline and the signed quote's deposit-address inactivity
deadline are different. New swap submissions stop at the requested refund
deadline. The signed message may retain the provider's longer inactivity deadline,
bounded to 72 hours beyond that request. Recovery can reconcile an already accepted
identity after either deadline; it never edits a signed payload to extend it.

Cancellation releases a reservation only before any submission marker and before
any real conversion was recognized. Cancellation and submission markers serialize
against each other. A reported refund remains `REFUNDED_HELD` until reviewed chain
reconciliation; it is not automatically made spendable. A configuration change,
policy pause, contract pause/hash change, missing rights, insufficient reserve,
unresolved charge or eroded reported proceeds prevents new outbound actions.

Input caps apply per operation and over a rolling 24-hour admission window;
cancelled approvals remain in that window conservatively. Minimum output is
operator-approved. The contract also caps each native distribution at `10^30`
yoctoNEAR. Transactions attach at most 200 Tgas to withdrawal and 100 Tgas to
distribution. Before sending, the backend checks the native allowance against
the current gas price with a 2x margin and protects storage plus the configured
reserve. **NEAR has no transaction-level maximum gas price:** the yoctoNEAR
allowance is an admission estimate, not a cryptographic hard price cap. Actual
gas is recorded; an observed breach pauses the policy without hiding a completed
payment. A changed future gas price can leave proceeds held for review.

## Configuration and operator interface

Nothing below is populated or armed by the PAPER frontend. Keep secrets server-only.
Do not use recovery keys, shared trading keys or customer wallet keys.

| Setting                                                                                                     | Meaning                                                                                                                                                                     |
| ----------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `EXECUTION_MODE=LIVE`, `NEAR_NETWORK=mainnet`, `LIVE_TRADING_ENABLED=true`, `BUSINESS_PAYOUTS_ENABLED=true` | All required for outbound funding; defaults remain PAPER/disabled                                                                                                           |
| `BUSINESS_RECEIVER_ID`, `BUSINESS_INTENTS_ASSET`                                                            | Exact receiver/book denomination from the verified fee receipts                                                                                                             |
| `BUSINESS_INTENTS_PRIVATE_KEY`                                                                              | Dedicated Ed25519 Intents key registered for that receiver; signs intents only                                                                                              |
| `NEAR_ACCOUNTANT_ACCOUNT_ID`, `BUSINESS_PAYOUT_PRIVATE_KEY`                                                 | Accountant and dedicated NEAR transaction key, distinct from the Intents and cycle-finalization keys; withdrawal attaches zero and distribution needs a deposit-capable key |
| `NEAR_CONTRACT_ID`, `BUSINESS_TREASURY_CODE_HASH`                                                           | Existing treasury with the distribution methods, pinned reviewed code and nonzero rights; accountant role must match                                                        |
| `BUSINESS_MAX_PAYOUT_ATOMS`, `BUSINESS_DAILY_PAYOUT_ATOMS`                                                  | Positive per-operation/rolling-day limits, in revenue-token atoms                                                                                                           |
| `BUSINESS_MAX_GAS_YOCTO`, `BUSINESS_MIN_NATIVE_RESERVE_YOCTO`                                               | Positive native gas allowance and protected reserve                                                                                                                         |
| `NEAR_RPC_URL`, 1Click settings                                                                             | HTTPS mainnet RPC and the official 1Click endpoint; existing quote-key/JWT validation applies                                                                               |

Read/admin tokens authorize `GET /api/business/funding`. Admin authorization is
required for `POST /api/business/payouts` with
`{ "reservationReference": "existing-reservation", "minimumNearYocto": "approved-positive-integer" }`
and `POST /api/business/payouts/:reference/cancel`. The reference returned by queue
is `nft:<reservation UUID>`. The HAND worker resumes it every ten seconds when
explicitly enabled. No new financial-write proxy is exposed in the frontend.

From a configured developer checkout, the same operations are available as:

```bash
npm run business:funding -- status
npm run business:funding -- queue --reservation EXISTING_REFERENCE --minimum-near-yocto APPROVED_INTEGER
npm run business:funding -- step nft:RESERVATION_UUID
npm run business:funding -- cancel nft:RESERVATION_UUID
```

These are operator instructions, **not authorization to arm or fund this project**.
The current account/caps are unset. The production container runs the compiled
worker; this TypeScript CLI is for a local checkout. Never put credentials into
command arguments or source references.

## Validation and release

Tests cover signed authorization boundaries, altered payloads, final receipt/event
matching, lost accepted responses, identical-byte restart recovery, competing
workers, pauses, cancellations, refunds, caps and balanced journals. These are
implementation tests with injected transports, not earned-revenue evidence.

The [unsigned protocol review](../artifacts/funding-protocol-review.json) checked
a real provider-generated payload without signing or submitting it. The
[public receipt parser check](../artifacts/funding-credit-proof-review.json) uses
a **third party's** historical transaction, not a SymbioChain sale or swap.

The [testnet code upgrade](../artifacts/testnet-funding-upgrade.json) deployed the
new getters/pause protection to the existing treasury, preserved its stored state
and left it paused. It did not convert earnings or pay a business dividend.
Earlier rehearsal artifacts retain their original code hash and historical scope.

No new schema is required beyond `20261105120000_business_evidence`. Apply that
additive migration and database hardening before the paired backend/frontend
release. It remains locally tested, not applied to hosted Supabase for this feature.
Disable payouts and reconcile outstanding identities before rolling application
code back; keep the journal and its encryption key. Do not erase financial records
or sign replacements as a rollback. Production deployments, source candidates and
actual submission status are distinguished in [release revisions](RELEASE_REVISIONS.md).

Public protocol references: [1Click signed execution](https://docs.near-intents.org/integration/distribution-channels/1click-api/quickstart/signed-intent-execution),
[quote fields](https://docs.near-intents.org/api-reference/oneclick/request-a-swap-quote),
[Intents withdrawals](https://docs.near-intents.org/integration/verifier-contract/deposits-and-withdrawals/withdrawals),
[NEAR transaction finality](https://docs.near.org/api/rpc/transactions).
