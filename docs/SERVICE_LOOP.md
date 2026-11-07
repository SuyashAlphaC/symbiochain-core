# Prepaid risk reports and manual compute funding

## Evidence and availability

This source candidate adds a limited risk-report service and a human-in-the-loop (HITL) credit bridge. It has no paid-customer, demand, purchased-credit or funded-mainnet evidence. The hosted release is unchanged. Recorded TEE deployment approval is **QUARANTINED**. PAPER uses deterministic local fixtures, not an enclave emulator; local signatures would not establish hardware attestation.

Do not request real customer payments while an approved report cannot be delivered. Ownership and deployment of `symbiochain.near` have not been established. No public announcement or customer solicitation was sent by this work.

## Service workflow

1. An administrator creates a `risk-assessment` order with immutable terms, payer, exact payment-asset price and relationship `TEAM_DEMO` or `EXTERNAL_ATTESTED`. The order and its durable Scout job are created atomically. Price is independent of trading P&L.
2. Scout obtains quotes for the allowlisted subject. Losing opportunities can be assessed: the profit shortfall becomes a report flag. Trading admission retains its original checks.
3. Brain waits for prepayment. LIVE requires the existing final mainnet Intents receipt verifier. Synthetic payments are PAPER only. Prepayments are customer advances, never earned revenue.
4. Brain uses the existing budget, attestation, approved-measurement and exact response-signature checks. Quarantine or an uncertain inference outcome holds delivery. Local inference cannot replace LIVE evidence.
5. Hand stores a report with `executionAuthorized: false` after a mode-appropriate bound proof. The engine and preparation adapters prevent service orders from trading. No execution NFT is minted for a report.
6. Only delivered LIVE services classified as external become revenue entries. Known related accounts cannot be external payers. PAPER and TEAM_DEMO never enter external revenue or the proceeds funding pool. Undisclosed common ownership and commercial demand cannot be inferred from a receipt.

This is an operator-mediated demonstration: administrators create orders, reconcile payment and retrieve private reports for customers. Customer wallet authentication, public checkout, automatic refunds and a delivery portal are not implemented. Expired, refused or quarantined prepayments remain advances requiring manual reconciliation/refund. Keep real customer sales disabled until those operations are reviewed.

The service assesses a quoted proposal; it is not a wallet or smart-contract security audit. A 1 USDC price minus hypothetical $0.01 inference is an illustrative gross contribution calculation. Actual net requires compute, gas, hosting, fees, refunds and all other operating costs in a closed accounting window. No profitability guarantee is made.

### Private APIs

All writes and report reads require backend administrator access. References are immutable and idempotent. The browser never receives the administrator credential.

| Endpoint                                                  | Behavior                                                                                                                                               |
| --------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `POST /api/business/services`                             | Create an order with `reference`, `payer`, `customerRelationship`, `agreedTermsDigest`, `priceAtoms` and a Proposal using `strategy: risk-assessment`. |
| `POST /api/business/invoices/:reference/receipt`          | Reconcile final LIVE Intents prepayment using `txHash` and `senderId`; submits no payment.                                                             |
| `POST /api/business/services/:reference/simulate-payment` | Explicit synthetic prepayment, PAPER only.                                                                                                             |
| `GET /api/business/services/:reference/report`            | Private delivered report, or 404 while pending.                                                                                                        |

On an isolated PAPER database with `BUSINESS_RECEIVER_ID`, `BUSINESS_INTENTS_ASSET` and the sample PAPER route allowlists configured, `npm run demo:service` runs a team-demo order, synthetic payment and local report. It spends no model credits and produces no actual revenue. Its sample price is `1000000` payment-asset atoms; this represents one USDC only for a six-decimal USDC asset.

## Human-in-the-loop metabolic bridge

The bridge reads finalized-receipt accounting and closed, accountant-reported cost windows. A balance or deposit alone is not profit. Reservations enforce recorded business-loss recovery and unknown-inference holds. Before presenting a purchase request, the bridge rechecks policy, unknown costs and aggregate reported net.

```text
Final service payment + approved report delivery
  → closed operating-cost window
  → earned-proceeds COMPUTE_PURCHASE reservation
  → WAITING_OPERATOR + durable dashboard event
  → human purchases credits in the matching Cloud organization
  → OPERATOR_REPORTED_UNVERIFIED
  → reservation remains held for reconciliation
```

Run once with an explicit maximum payment-asset budget and requested USD credits:

```bash
npm run business:bridge -- --once --max-atoms 1000000 --credit-usd-micros 1000000
```

Remove `--once` for ten-second monitoring. Production can use `node dist/metabolic-bridge-main.js` with the same arguments. Payment-asset atoms and USD-credit micros are separate units. The human must inspect the checkout, organization, funding source, fees and exchange rate; the bridge does not infer a payment quote or FX conversion.

LIVE tasks freeze `NEAR_AI_ORG_ID`; a missing organization fails before reservation. Equality on confirmation is a consistency check, not independent proof that the key/payment belongs to it. PAPER uses `PAPER_ORGANIZATION`. The Builders grant must not be relabelled as this organization's balance.

The bridge emits `business.topup_required` through the durable outbox, and pending tasks appear in the private operator dashboard. Optionally configure a dedicated `OPERATOR_TOPUP_WEBHOOK_URL` with an HTTPS Discord webhook. The standalone process sends a generic operator alert with mentions disabled. An uncertain send is not automatically repeated; the dashboard task remains available. No webhook was sent during validation. Keep webhook URLs out of Git and logs.

### Reports and trust boundary

The existing frontend operator session records **PAPER reports only**. LIVE reports require the private administrator API. Confirmation records a receipt digest, organization, reported credits and funding source (`OPERATOR_FUNDED` or `EARNED_PROCEEDS_REPORTED`). It cannot verify credit attribution, move funds, change a compute allowance, release a reservation or open the TEE gate. Actual purchased-credit counters remain zero. An operator-funded purchase does not demonstrate earned revenue paying for compute.

| Endpoint                                   | Behavior                                                                                                                                 |
| ------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /api/operations/status`               | Curated recorded quarantine, HITL counts and revenue status; omits private tasks, organizations and receipts.                            |
| `GET /api/business/compute-topups`         | Administrator-only bounded task list.                                                                                                    |
| `POST /api/business/compute-topups`        | Create a task from `reservationReference` and `requestedCreditUsdMicros`.                                                                |
| `POST /api/business/compute-topups/report` | Record `reference`, matching `organizationId`, `receiptDigest`, `reportedCreditUsdMicros` and `fundingSource`; immutable and unverified. |

There is no provider purchase adapter, automatic payment or mock credit API. A future adapter would require a published customer authorization/payment binding, idempotency, recovery and verifiable credit attribution. It cannot be enabled by merely changing a URL. Reported reservations remain encumbered until separately reviewed reconciliation establishes the actual result; automatic settlement/release of manual reports is not implemented.

## Profit split and release

The existing contract enforces fixed NFT basis-point entitlements on explicit native NEAR distributions, protects liabilities, retains rounding remainder and rejects reused references. It does not calculate USDC profit or prove revenue provenance. Accountant-approved proceeds and the verified conversion adapter form the accounting-to-contract trust boundary. No new WASM, deployment, rights mint or distribution was performed here.

The application reuses `BusinessEntry`; there is no new schema migration. The existing business migration must already be applied. Deploy the paired backend before the frontend. Older backends produce unavailable/stale states, not manufactured success. Preserve financial records on rollback; stopping the bridge does not release reservations. Keep `LIVE_ARBITRAGE_ENABLED=false`. Previously submitted transactions can still be reconciled.

Create new `risk-assessment` cycles only after the paired frontend is released. Older cycle-detail clients accept only `round-trip`; they may reject service records. A rollback retains those records and may require the matching viewer schema. The original v1 snapshot structure is unchanged.
