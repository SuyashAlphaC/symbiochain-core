# Historical controlled funding and testnet distribution

This dated walkthrough is superseded for the current demo by [mainnet acceptance](MAINNET_ACCEPTANCE.md), including the completed service-balance round trip. It records real mainnet deployment and funding, a closed
inference gate, and separately recorded testnet distribution mechanics. It does
not claim customer revenue, profitable trading, a mainnet NFT payout or purchased
AI credits.

## 1. Mainnet foundation and funding

Open [mission control](https://symbiochain.vercel.app/dashboard). It reads finalized
NEAR mainnet balances, code identity and permissions. The treasury is
`treasury.symbio-fcef733893.near`; the owner is `symbio-fcef733893.near`. The
[original foundation record](../artifacts/mainnet-paused-deployment.json) identifies
the nine verified deployment transactions and revoked temporary deployment key.

The wallet owner approved exactly one additional `fund({})` call from
`solidvideo4090.near`, with **0.001 NEAR** attached and 10 TGas prepaid:

[Confirmed mainnet funding transaction](https://nearblocks.io/txns/BUAMQU1darHsDvDesZVE8U8bnPm7pwMNvGyszczNxQej).

Independent final RPC verification checked the exact signer, treasury, method,
arguments, deposit, gas, every receipt outcome and the treasury's `funded` event.
The verified network fee was **0.0002268527160548 NEAR**; deposit plus fee was
**0.0012268527160548 NEAR**, below the 0.004 NEAR planning ceiling. The treasury
balance increased from 6.100 to **6.101 NEAR**. The deposit remains treasury
capital; it is not a fee earned from an external customer. The dashboard's
transaction verifier remains scoped to its original recorded deployment hashes;
use the explorer link for this separate funding receipt.

The [funding record](../artifacts/mainnet-funding-demo.json) preserves before/after
finalized observations. The treasury stayed **PAUSED**, all worker permissions
stayed disabled, execution stayed disarmed and no root key was exported or granted.
The local signing page now records completion and will not submit a second call.

## 2. Closed execution and compute gates

Show the dashboard's **DISARMED**, **PAUSED** and **QUARANTINED** states.
The funding call invokes no model, trading adapter, distribution or credit
purchase. No AI credits were spent. The application allowance remains USD 1.00
total and USD 0.10 per request; provider balance is a separate, unverified value.

The TEE provenance problem remains an upstream dependency. Funding is not an
approval mechanism. No manual top-up task or business profit is fabricated from
the treasury deposit.

## 3. Historical testnet distribution and claim

Open [the testnet evidence page](https://symbiochain.vercel.app/testnet). Its
recorded data is independent of the LIVE mainnet observer. The underlying
settlement and positive accountant reconciliation are explicitly **SIMULATED**.
The tokens used for this distribution came from the testnet faucet.

The previously executed distribution was rechecked through the archival testnet
RPC. Its `revenue_distributed` event records a **0.01 test-NEAR** deposit,
**0.001 test-NEAR** allocated to the receipt holder (**10%**, not 30%), and
0.009 test-NEAR left unallocated:

- [Testnet distribution](https://testnet.nearblocks.io/txns/2Asero1kxG7xfM633fuahR4Xuk3izeRvWnrTLevkLR4c).
- [Testnet holder claim](https://testnet.nearblocks.io/txns/98bpz1Bt5GnMBEa1bW2b1VHANqKda2sNWTnPNN6ihbZT).

Both transaction outcomes and all receipts were independently rechecked as final
and successful. [Verification record](../artifacts/controlled-demo-testnet-verification.json).
These are historical test-token operations; the mainnet NFT supply and revenue
rights remain zero. This walkthrough submits no new testnet transaction.

## 4. State after the demonstration

Return to mission control and refresh finalized mainnet state. The treasury is
still paused with no worker enabled. No pause/unpause transaction is necessary
for `fund()`. Confirm the 6.101 NEAR balance and use the explorer for the separate
funding receipt. Real market settlement, earned revenue, mainnet NFT payments and
the autonomous profit-to-compute purchase loop remain unproven.

## Local tool and recovery

The implementation is in `tools/mainnet-deploy/funding-*.mjs` and
`funding-client.js`. It reuses the existing pinned Meteor adapter. Run owner-tool
tests, build the funding client and start the loopback-only portal:

```sh
node --test tools/mainnet-deploy/*.test.mjs
npm run build:funding --prefix tools/mainnet-deploy
node tools/mainnet-deploy/funding-server.mjs
```

The portal is `http://localhost:3418`. It holds no wallet key or Cloud credential.
The unsigned browser test uses its own state directory, deliberately rejects
signing and must never be presented as the actual mainnet receipt. Actual funding
is recorded separately above. An attempt is persisted before requesting a wallet
signature. Unknown outcomes block another send; verify the existing hash instead.
Do not delete the completed operation state to repeat the demonstration.

Fee allowance is a planning check against current gas pricing and is checked
again against actual burnt tokens on reconciliation. NEAR transactions do not
contain a maximum gas-price field; the user reviews the wallet's fee estimate
before signing. The fixed action does not request an unpause, deployment,
access-key grant, trade, NFT mint or paid inference.
