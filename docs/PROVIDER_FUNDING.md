# Compute-funding integration decision

Checked against NEAR AI's published documentation and official Cloud API source on 2026-10-27.

The original project requires a real sequence: earn money, spend part of that money on compute, receive provider credits, and consume them. Reading a balance, increasing a credit limit, syncing a grant or paying another swarm account does not prove that sequence.

## Available published interfaces

| Interface                                           | Supported purpose                      | Accounting meaning                                                  |
| --------------------------------------------------- | -------------------------------------- | ------------------------------------------------------------------- |
| `POST /v1/billing/costs`                            | Cost of identified inference requests  | Metered consumption, not a payment                                  |
| `GET /v1/organizations/{org_id}/usage/balance`      | Organization spending balance          | Provider-reported available credit                                  |
| `POST /v1/organizations/{org_id}/staking/farm/sync` | Refresh a linked staking-credit source | Credit accrual from that source, not purchase with trading proceeds |
| Administrative organization limits                  | Provider/billing service adjusts caps  | Privileged allocation, not proof that money moved                   |

The official [Cloud API architecture notes](https://github.com/nearai/cloud-api/blob/main/CLAUDE.md#external-billing-service) place purchases and credit recalculation in a separate billing UI/service. The [platform billing-summary documentation](https://docs.near.ai/api-reference/admin/get-the-platform-billing-summary-admin-only) distinguishes credit limits/consumption from cash payments. The public OpenAPI document inspected exposes request costs and staking sync, but no customer invoice creation/crypto-settlement/credit-purchase endpoint.

This supports a narrow conclusion: a supported direct purchase flow cannot be implemented from those published interfaces alone. It does not establish that NEAR AI has no other billing integration. The backend must not use a provider-admin limit mutation, a fabricated payment address, or a local escrow payout to simulate a purchase.

## Required provider contract

A direct purchase adapter needs a documented or provider-approved integration specifying:

1. How to create an organization-bound invoice with a stable idempotency key.
2. Accepted chain/token, exact atomic amount, authenticated payment destination, expiry and requested credit value.
3. How a transaction is bound to that invoice and how final payment/refund status is queried.
4. How purchased credits are attributed to the same organization, separately from grants, staking accrual and unrelated concurrent usage.
5. How to recover an accepted request whose response was lost without creating a second invoice/payment.

Once supplied, the existing guarded-transfer, durable signed-material and journal infrastructure can support that flow. Credentials alone do not supply the missing purchase protocol. Provider administrator credentials are not an acceptable replacement for a customer payment API.

## Current behavior

- The worker measures actual inference charges and provider credit balance.
- Low/unknown credit stops further paid inference.
- Optional staking sync supports a source already configured and linked through NEAR AI.
- No automatic purchase, principal staking, direct trading-profit funding, or already self-sustaining business is claimed.
- Live end-to-end validation also requires the dedicated funded accounts, keys and approved measurements listed by `npm run live:preflight`.

Relevant sources: [request costs](https://docs.near.ai/api-reference/billing/get-costs-by-request-ids), [organization balance](https://docs.near.ai/api-reference/usage/get-organization-balance), [staking sync](https://docs.near.ai/api-reference/staking-farm/sync-organization-staking-farm-credits), [staking overview](https://docs.near.ai/cloud/staking-for-inference/overview), [public OpenAPI](https://docs.near.ai/api-reference/openapi.json).

## Follow-up review on 2026-10-29

Rechecked the official [vendored OpenAPI](https://github.com/nearai/docs/blob/main/api-reference/openapi.json), [billing route implementation](https://github.com/nearai/cloud-api/blob/main/crates/api/src/routes/billing.rs), and [external billing architecture](https://github.com/nearai/cloud-api/blob/main/CLAUDE.md#external-billing-service). Published customer routes still describe request costs, organization balances and staking source/sync operations; this review did not find a customer invoice/checkout/payment-to-credit purchase protocol in those interfaces. The architecture places Stripe checkout and credit synchronization in a separate UI/billing service. That service's privileged limit-update operation is not a customer payment integration.

This establishes the remaining integration requirement, not the absence of all possible provider payment options. A provider-approved customer payment contract is still needed before implementing direct trading-profit purchases. `SYNC_STAKING_CREDITS` is optional and defaults to false; the backend does not count a sync or balance read as a purchase. No new payment adapter or fabricated checkout is claimed by the operator dashboard work.
