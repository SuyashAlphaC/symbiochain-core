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

- The worker measures actual inference charges. The default policy also reads a matching organization's provider credit balance.
- Low/unknown credit stops inference under `PROVIDER_BALANCE`. An explicit `LOCAL_BUDGET` policy supports Builders keys through durable reservations and per-request billing, while leaving the provider balance unknown.
- Optional staking sync supports a source already configured and linked through NEAR AI.
- No automatic purchase, principal staking, direct trading-profit funding, or already self-sustaining business is claimed.
- Live end-to-end validation also requires the dedicated funded accounts, keys and approved measurements listed by `npm run live:preflight`.

Relevant sources: [request costs](https://docs.near.ai/api-reference/billing/get-costs-by-request-ids), [organization balance](https://docs.near.ai/api-reference/usage/get-organization-balance), [staking sync](https://docs.near.ai/api-reference/staking-farm/sync-organization-staking-farm-credits), [staking overview](https://docs.near.ai/cloud/staking-for-inference/overview), [public OpenAPI](https://docs.near.ai/api-reference/openapi.json).

## Follow-up review on 2026-10-29

Rechecked the official [vendored OpenAPI](https://github.com/nearai/docs/blob/main/api-reference/openapi.json), [billing route implementation](https://github.com/nearai/cloud-api/blob/main/crates/api/src/routes/billing.rs), and [external billing architecture](https://github.com/nearai/cloud-api/blob/main/CLAUDE.md#external-billing-service). Published customer routes still describe request costs, organization balances and staking source/sync operations; this review did not find a customer invoice/checkout/payment-to-credit purchase protocol in those interfaces. The architecture places Stripe checkout and credit synchronization in a separate UI/billing service. That service's privileged limit-update operation is not a customer payment integration.

This establishes the remaining integration requirement, not the absence of all possible provider payment options. A provider-approved customer payment contract is still needed before implementing direct trading-profit purchases. `SYNC_STAKING_CREDITS` is optional and defaults to false; the backend does not count a sync or balance read as a purchase. No new payment adapter or fabricated checkout is claimed by the operator dashboard work.

## Follow-up review on 2026-11-05

Rechecked the published [OpenAPI source](https://github.com/nearai/docs/blob/main/api-reference/openapi.json) and [external billing architecture](https://github.com/nearai/cloud-api/blob/main/CLAUDE.md#external-billing-service). The published paths still include `/v1/billing/costs`, organization usage balance and staking farm/sync, with no customer purchase/invoice/payment endpoint in that specification. The architecture places Stripe checkout in the separate `nearai-cloud-ui` billing service; its GitHub repository was not publicly accessible during this review. This does not rule out provider-supported private billing integrations, but none has been supplied for this project.

The new [business ledger](BUSINESS_ACCOUNTING.md) can reserve reported earned proceeds for compute, but cannot mark them paid or purchased. A grant, a different organization's checkout, staking sync or admin credit allocation still cannot close the profit-to-compute loop. The owner confirmed that mainnet funds/account/caps remain unavailable. No payment or inference was attempted.

## Public-interface-only decision on 2026-11-06

The owner explicitly requires publicly supported NEAR AI interfaces only. The
reviewed [OpenAPI](https://github.com/nearai/docs/blob/main/api-reference/openapi.json)
and [external billing architecture](https://github.com/nearai/cloud-api/blob/main/CLAUDE.md#external-billing-service)
still do not supply a verified customer payment-to-credit purchase protocol. The
public [credit-transfer source](https://github.com/nearai/cloud-api/blob/main/crates/api/src/routes/credit_transfers.rs)
describes movement of existing organization credits, not purchase using earned
crypto proceeds; source availability alone is not a deployment/API support check.
No undocumented billing endpoint, privileged limit mutation, reseller or invented
payment destination is used. No paid inference or credit purchase was attempted.

`POST /api/business/compute-purchases` requires admin authorization and returns
`409 PROVIDER_PURCHASE_PROTOCOL_REQUIRED` with no payment/journal side effects.
The funding status reports `computePurchaseImplemented: false` and
`NO_PUBLIC_NEAR_AI_PURCHASE_PROTOCOL`; the frontend keeps the purchase count zero.
This is a completed refusal boundary, **not** an implemented purchase adapter.
The separate [NFT funding implementation](BUSINESS_FUNDING.md) does not resolve
this provider dependency. Grants, existing balances, transfers and staking sync
remain distinct from purchases in the ledger and submission claims.
