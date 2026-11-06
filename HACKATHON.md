# SymbioChain — Policy-controlled agents on NEAR

## Submission status

Testnet prototype with a [verified hosted PAPER demonstration](artifacts/hosted-paper-verification.json), a real NEAR testnet treasury, MPC-authorized Sepolia and Solana devnet transfers, contract safeguards and testnet NFT mechanics. The integrated runner currently stops at the private-inference deployment gate. See the [testnet judge walkthrough](docs/TESTNET_SUBMISSION.md) for reproducible steps, transaction links and exact boundaries. Funded mainnet trading, verified model inference and automatic compute purchases remain incomplete; financial self-sufficiency is not claimed.

## Idea-field pitch

SymbioChain coordinates Scout, Brain and Hand behind treasury spending limits and durable execution records on NEAR. Its testnet prototype demonstrates contract safeguards, agent service payments, real MPC-authorized Sepolia and Solana devnet transfers, and NFT distribution mechanics. A resumable workflow links scouting, verified private inference, constrained execution and receipts; its real run currently stops at the documented deployment-provenance gate. Market settlement and positive testnet P&L are explicit simulations. The project demonstrates safeguards and recovery, not a proven self-funding trading business.

## Entry point and startup

Follow the [local setup](README.md#run-locally), then run `npm run demo`. It funds the PAPER treasury with 20 simulated USDC, creates a 5-USDC proposal, processes all three roles and requires the cycle to reach `CLOSED`. Every financial result in that run is labeled simulated.

For continuous operation, start `npm run dev` and `npm run worker` in separate terminals. The worker runs Scout, Brain and Hand lanes; PostgreSQL stores their jobs, reservations, evidence and events. PM2 can run the lanes as separate processes. A persistent host is still required when the developer closes their laptop.

LIVE requires a deployed treasury, dedicated agent accounts, approved measurements, provider access, and separately funded derived EVM/Solana wallets, native gas and compute credits. The backend currently supports operator provisioning through the [operations guide](docs/OPERATIONS.md); a single NEAR USDC deposit that automatically provisions all those resources is not implemented.

## Execution loop

1. **Observe:** Scout reads approved routes and obtains signed 1Click previews. Conservative return amounts must meet the configured profit floor after cost buffers.
2. **Assess:** Brain pays for the signal. LIVE checks available compute credit, hardware evidence, approved measurements, nonce and signing identity before purchasing inference. The model's decision cannot override deterministic limits.
3. **Reserve:** Hand purchases the assessment and reserves capital in a serializable PostgreSQL transaction. Current policy and the independent NEAR contract ceilings both apply.
4. **Sign and settle:** The treasury constructs a permitted ERC-20 or native-SOL transfer payload. Signed bytes are persisted encrypted before broadcast. The return leg is repriced after actual receipt. Failed profit checks or unknown outcomes keep the position held for reconciliation.
5. **Account:** Incoming transfers, finality, native fees and metered inference are recorded separately. Journals distinguish capital, internal payments, trading results and operating costs.
6. **Record:** The accountant finalizes the reconciliation. Nonzero NFT rights require a complete approved cost basis. The frontend receives durable events and can replay them after reconnecting.

The metabolic rule is a spending constraint: low or unknown compute credit stops further paid inference; low wallet reserves stop new spending. It cannot force a profitable trade into existence. Automatic conversion of trading proceeds into purchased NEAR AI credits needs a supported provider payment flow, as recorded in the [funding decision](docs/PROVIDER_FUNDING.md).

## What judges can verify

| Evidence                   | Run or inspect                                                                                     | What it establishes                                                                                                                                          |
| -------------------------- | -------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Agent cycle                | `npm run demo`                                                                                     | A complete simulated three-role workflow, explicit mode and closed reservation                                                                               |
| Backend checks             | `npm run check`                                                                                    | Strict TypeScript, unit tests and production compilation                                                                                                     |
| Recovery and APIs          | `npm run test:integration` after the [isolated test DB setup](README.md#verify-the-implementation) | Leases, concurrency, accounting, authentication, replay, paid-call recovery and two-leg orchestration with injected transports                               |
| NEAR execution             | [Contract build and sandbox commands](README.md#verify-the-implementation)                         | Real local contract calls, independent payload comparisons, role isolation, one-use signing, NFTs, service balances and distributions                        |
| Signed market quotes       | `npm run probe:market`; [captured response](artifacts/market-probe.json)                           | Real dry-quote signatures; the captured route fails the profit floor                                                                                         |
| Public hardware diagnostic | `npm run probe:attestation`; [captured evidence](artifacts/public-attestation-probe.json)          | Intel signature, issuer, nonce, freshness and TDX platform claims at capture time; application measurements remain unapproved and model inference unverified |
| Frontend data              | [REST and raw WebSocket contract](docs/API.md)                                                     | Authenticated money/decision/event interfaces with durable cursors and explicit evidence scope                                                               |

Current counts and command outcomes are in the [verification record](docs/VERIFICATION.md). Public attestation tokens expire; captured verification is historical. The sandbox MPC stub returns an intentionally invalid signature and its P&L is synthetic. Locally signed fixtures and hardware-policy fixtures are not mainnet MPC responses or actual model runs.

## Frontend demo

Use `GET /api/health` for reserves, gross trading P&L, measured compute consumption, worker status and credit observations. `survivalHours: null` means the full operating runway is unknown. Subscribe to `/ws` with the read token in the first frame and persist the last sequence for reconnects.

To demonstrate loss of Scout activity, use the authenticated `POST /api/admin/agents/SCOUT/pause` control and later `/resume`. This pauses the lane durably; it does not kill an operating-system process. Committed transactions retain their recorded identities and reservations. A stored TEE proof hash is historical verification, not a fresh verification request.

## Proposed track alignment

| Track    | Backend evidence                                                               | Boundary                                                             |
| -------- | ------------------------------------------------------------------------------ | -------------------------------------------------------------------- |
| business | Treasury policy, reserve/credit gates, cost accounting                         | No demonstrated self-funding business                                |
| swarms   | Three durable roles and paid cooperation                                       | Defined protocol, not an emergent bidding market                     |
| agents   | Intents service-payment adapter and nonce recovery                             | Internal payments do not establish external revenue                  |
| privacy  | Confidential-inference verification adapter and public gateway diagnostic      | Orchestrator host is not attested; no live authenticated model proof |
| defi     | Signed previews, constrained EVM/SOL payloads, settlement reconciliation       | Asynchronous price risk; no guaranteed arbitrage                     |
| nfts     | NEP-171 receipts, fixed bounded rights, explicit distributions and pull claims | Reconciliation and cost valuation trust the authorized accountant    |
| security | Role revocation, independent token caps, one-use signing and held reserves     | Local verification is not a production audit                         |

Track names are the proposed submission mapping; confirm eligibility against the event's applicable rules.

## Released evidence and unfinished business claims

The frontend repository is public. PR #3 is merged, `/testnet` is live in the existing Vercel project, and operator configuration/login/logout checks are complete. The PAPER backend and readiness monitor are deployed. See [release revisions](docs/RELEASE_REVISIONS.md) for exact verified application commits; later feature commits are not silently called deployed or submitted. No hackathon form receipt has been recorded.

The NEAR testnet treasury, real MPC signatures and Sepolia/Solana devnet transfers are complete as authorization fixtures. The integrated runner remains blocked at TEE deployment approval. Its market data, quotes, settlement economics and positive NFT accounting fixture remain simulated. Testnet NFT deposits prove distribution mechanics, not business revenue.

The new [business accounting source](docs/BUSINESS_ACCOUNTING.md) separates invoices from finalized external receipts, records accountant-reported operating costs and reserves proceeds only after recorded loss recovery. Fixture tests validate those rules. No customer revenue or realized business profitability is proven.

Mainnet deployment and funded 1Click/Intents settlement still need a dedicated funded account, signing configuration, hard spending limits and a viable route. The owner currently has no mainnet funds. The existing losing preview remains rejected. The contract is already deployed on testnet; this is not a pending testnet deployment.

Automatic NEAR AI purchases remain unimplemented pending a provider-approved payment-to-credit protocol. Proceeds-funded NFT conversion, distribution and exact-identity recovery are [implemented and locally tested](docs/BUSINESS_FUNDING.md), but disabled without funded mainnet proof. No reservation, balance sync, faucet token or internal payment is presented as either completed cash flow.

See the [acceptance ledger](docs/IMPLEMENTATION.md), [deployment record](docs/DEPLOYMENT.md) and [judge walkthrough](docs/JUDGING.md). Submit evidence with its actual revision, network, contract hash, approved model measurements and transaction links; keep real execution, simulations, implementation tests and unfinished work distinct.
