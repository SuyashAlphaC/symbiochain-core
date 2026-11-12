# SymbioChain

[Live dashboard](https://symbiochain.vercel.app/dashboard) · [Mainnet evidence](https://symbiochain.vercel.app/evidence) · [Frontend source](https://github.com/AviraL0013/SymbioChain) · [Idea draft](HACKATHON.md#idea-field-pitch)

## 1. What it is and why it matters

AI agents need spending authority without unrestricted control of a treasury.
SymbioChain is a policy-controlled AI treasury on NEAR: Scout finds candidate
routes, Brain assesses committed terms, and Hand requests bounded execution.
Deterministic checks govern what an agent can authorize and sign.

The **Metabolic Rule** has two enforcement layers. The NEAR contract protects
native reserves and enforces roles, approved assets/chains, authorization limits
and one-use signing. The application checks compute budgets, trading economics
and TEE workload approval before admitting automated AI execution. A model's
recommendation cannot override these checks.

## 2. Live on Mainnet (Proven Mechanics)

**Owner-initiated cross-chain execution.** Human-authorized scripts used the
scoped Brain, Hand and Accountant keys to complete real Chain Signatures
transfers on [Base](https://basescan.org/tx/0x671a03fd1e327cd4a6cb57d5eb668016b3625364a14eb7a7beaafaebfd24135c)
and [Solana](https://solscan.io/tx/2WvDKWegMfxqaDDUJbsjXDgQ1CQK7aoHL7b51mNuscVG9swPC36i55pZYFNDANnEFp2E2c4hx1Hwd3vJQ3rdfxZv).
Both contract cycles closed; eight NEAR receipts cover authorization, MPC signing,
submission and finalization. **The AI engine did not initiate these transfers.**

**Real Intents settlement.** [1Click gas conversions](artifacts/mainnet-fresh-gas-funding.json)
funded the derived Base/Solana wallets, and two [internal agent payments](artifacts/mainnet-intents-settlement.json)
settled on Intents. The direct MPC transfer fixtures and their gas-funding swaps
are recorded separately on the [evidence page](https://symbiochain.vercel.app/evidence).

**Contract-enforced spending bounds.** The current owner-signed policy is:

| Control                | Current limit                                       |
| ---------------------- | --------------------------------------------------- |
| USDC authorization     | 0.25 USDC per action; 0.50 USDC per day             |
| Native SOL transfer    | 0.004 SOL per action; 0.008 SOL per day             |
| Protected NEAR reserve | 0.10 NEAR                                           |
| Automatic execution    | DISARMED; on-chain worker permissions remain active |

The [treasury](https://nearblocks.io/address/treasury.symbio-fcef733893.near),
dedicated agent accounts and restricted keys are deployed. The earlier
0.05/0.10-USDC policy remains a dated activation record; the current limits above
are shown by finalized state and the [later permission receipts](artifacts/mainnet-wallet-provisioning.json).

**Glossary:** _Receiver-scoped function-call keys_ can call only listed methods
on a designated receiver contract. _Chain Signatures/MPC_ lets the NEAR contract
request signatures for derived wallets on other chains. _1Click_ is NEAR Intents'
API for intent-based cross-chain swaps.

## 3. Verify in 5 Minutes

The public dashboard and evidence page require **no login, judge token or wallet
connection**. Operator actions use separate private credentials.

| Do this                                                                                                                                        | See this                                                                          |
| ---------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------- |
| Open the [dashboard](https://symbiochain.vercel.app/dashboard)                                                                                 | Finalized treasury balance, current owner policy and execution state              |
| Open [Evidence](https://symbiochain.vercel.app/evidence), expand **Mainnet MPC transfer fixtures**, then follow the Base/Solana explorer links | Two confirmed owner-initiated transfers and eight NEAR execution receipts         |
| Expand **Manual AI API probe**                                                                                                                 | `NEAR_AI_OK`, 31 input / 6 completion tokens, provider charge **$0.00000548**     |
| Read the [public probe record](artifacts/manual-ai-probe.json)                                                                                 | One manual request, zero automated requests, response hash and reconciled billing |
| Check the [release record](artifacts/mainnet-rpc-recovery.json) and [verification guide](docs/VERIFICATION.md)                                 | Exact application revisions, 290 automated tests and hosted browser checks        |

<a id="run-locally"></a>
<a id="verify-the-implementation"></a>

For a local three-agent replay, use **Node 24 and Docker** in a fresh checkout.
The first dependency installation can take longer than the hosted walkthrough.
A separate ignored environment file keeps this PAPER demo isolated:

```sh
npm ci
cp .env.example .env.paper
docker compose -p symbiochain up -d postgres --wait
DOTENV_CONFIG_PATH=.env.paper npm run db:generate
DOTENV_CONFIG_PATH=.env.paper npm run db:migrate
DOTENV_CONFIG_PATH=.env.paper npm run demo
```

Expected result: JSON with `state: "CLOSED"`, balanced accounting and an explicit
PAPER simulation label. It requires no wallet or paid model key. For the local
API, use `DOTENV_CONFIG_PATH=.env.paper npm run dev`; its `/dashboard` uses the
local tokens in `.env.paper`. Contract, isolated database and recovery checks are
in the [judge walkthrough](docs/JUDGING.md).

Source map: [workflow](src/engine.ts), [durable ledger/jobs](src/store.ts),
[provider adapters](src/providers), [NEAR contract](contracts/treasury/src/lib.rs),
[API/WebSocket contract](docs/API.md), [operations](docs/OPERATIONS.md),
[deployment](docs/DEPLOYMENT.md), [demo/X-post draft](docs/DEMO_POST.md).

## 4. Simulated vs. Real

| Mode / evidence      | State                                                                                    | What it proves                                                                       |
| -------------------- | ---------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| LIVE mainnet         | Owner-initiated transfers finalized; AI engine DISARMED                                  | MPC signing, destination settlement, Intents payments and contract spending controls |
| PAPER                | Simulated prices, inference and settlement; durable PostgreSQL workflow                  | Complete repeatable three-agent lifecycle, accounting and recovery                   |
| Local NEAR sandbox   | Real local contract calls with an invalid-signature MPC stub                             | Contract roles, bounds, payload construction and receipt/distribution mechanics      |
| Historical testnet   | Real testnet MPC plus separately confirmed Sepolia/devnet transfers; synthetic economics | Test-network signing and transfer mechanics                                          |
| Manual unverified AI | One actual Cloud API completion with reconciled billing                                  | Key authentication, model availability and per-request cost reporting                |

Detailed [testnet records](docs/TESTNET_REHEARSAL.md) retain their original dates.
The manual AI probe used the configured Cloud key; the response does not
independently establish its configured organization membership or a verified
response signature.

## 5. Not Yet Proven

- **TEE-approved autonomous execution.** Hardware/TLS subchecks passed, but the
  observed deployment did not satisfy the complete software provenance and
  measurement policy. The [recorded audit](artifacts/brave-cli-verification.json)
  leaves automated AI execution quarantined.
- **Profitable strategy trading.** Current signed round-trip previews fail the
  unchanged profit floor. Market economics require a viable route independently
  of TEE approval.
- **External service revenue and full business profitability.** Recorded funding
  is owner capital; complete operating-cost valuation and market demand remain
  to be established.
- **Automatic AI-credit purchases.** The published customer payment-to-credit
  interface needed for automation is unavailable; the [manual funding bridge](docs/SERVICE_LOOP.md#human-in-the-loop-metabolic-bridge)
  records operator tasks.
- **Profit-funded NFT distributions.** Conversion/allocation/recovery code is
  implemented and tested; business-profit-backed mainnet payouts remain unproven.

## 6. Tracks

- **Security:** contract-enforced spending limits, restricted function-call keys,
  one-use signing, durable recovery and fail-closed application TEE gating.
- **DeFi:** real mainnet cross-chain signing/transfer rails, Intents settlement and
  signed-quote admission checks.

Implementation: TypeScript/Fastify, PostgreSQL/Prisma, Rust/NEAR, Chain Signatures,
NEAR Intents and NEAR AI Cloud; pinned dependencies are in [package.json](package.json).
The [frontend repository](https://github.com/AviraL0013/SymbioChain) preserves the
teammate's interface and attribution. [MIT license](LICENSE).

Development history is retained: the initial backend was committed October 27;
[changes after the October 30 foundation](https://github.com/SuyashAlphaC/symbiochain-core/compare/c7ebccdb471c939f02fe954177a57e2635faeef8...main)
show the later NEAR integrations and evidence work. The application release is
identified separately from documentation revisions. Submission remains on hold.
