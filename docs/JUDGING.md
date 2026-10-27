# Judge walkthrough

## Product claim

SymbioChain explores whether a three-agent treasury can cover its operating costs through cross-chain activity under enforceable limits. Its distinguishing mechanic is the connection between measurable resource pressure, paid agent cooperation, constrained signing and durable accounting. It does not force a trade to make an animation say ALIVE.

## Five-minute review

1. Run the README PAPER setup and `npm run demo`. Confirm `CLOSED`, zero active reservation, mode `PAPER`, and explicit synthetic evidence.
2. Inspect `src/engine.ts`, `src/store.ts` and the PostgreSQL recovery tests. Look for persisted signed material, immutable idempotency keys, serializable reservations, fenced leases, balanced journals and durable frontend events.
3. Run the NEAR sandbox suite. Compare EVM payloads with viem and Solana message bytes with web3.js. Confirm a second signing request and an unauthorized role are refused. Observe real local NFT distribution/claim behavior, with the mock/synthetic disclosure preserved.
4. Inspect `src/providers/near-ai.ts` and `attestation.ts`. Verification binds hardware evidence, approved measurements, nonce, signer and exact response bytes; a paid timeout does not purchase another completion. Run `npm run probe:attestation` for a separate public gateway ITA token check requiring no API key. It verifies Intel's signature and signed nonce/platform claims, with deployment approval and model inference explicitly false.
5. Run the public market probe. Both dry quotes are signed and checked. The checked-in probe was loss-making, so the profit floor rejects it. It is not a performed swap.

## Track mapping

| Area                | Implemented evidence                                                                   | Scope limit                                                                                |
| ------------------- | -------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| Autonomous business | Durable treasury workflow, reserve/compute-credit gates, metered inference             | Financial self-sufficiency and direct trade-profit credit purchases are not demonstrated   |
| Swarms              | Separate Scout/Brain/Hand lanes, paid signal/assessment flow                           | Components execute a defined protocol; not an emergent negotiation market                  |
| Agent economy       | Signed Intents service transfers, nonce-based timeout recovery                         | Internal payments are not external sales revenue                                           |
| Privacy             | NEAR AI hardware/response verification, encrypted evidence                             | Backend host is not attested; no TLS connection binding/E2EE transport                     |
| DeFi                | Signed 1Click previews, guarded EVM/SOL deposits, settlement reconciliation            | Asynchronous return pricing; no guaranteed arbitrage                                       |
| NFTs                | NEP-171 receipts, bounded fixed rights, explicit distributions, pull claims            | Accountant-reported reconciliation; automatic live rights wait for complete cost valuation |
| Security            | Roles/revocation, independent token caps, one-use signing, pause/reserves, fenced jobs | Local tests are not a production security audit                                            |

## Evidence labels

- **PAPER:** synthetic prices, model decisions, fills, fees and receipts. Useful for repeatable integration proof.
- **SANDBOX:** actual local NEAR execution; invalid-signature MPC stub and synthetic reported P&L. Proves contract behavior, not external trading.
- **DRY QUOTES:** real public 1Click responses and manager-signature checks, with no deposits or fills.
- **PUBLIC GATEWAY:** real Intel Trust Authority gateway token checked against pinned Intel keys, issuer, freshness, nonce and platform claims. No approved application measurement, model completion, production DCAP run or funded trade is established. A captured token expires; its verification result is historical.
- **LIVE:** reserved for actual provider/RPC evidence under explicitly armed configuration. No completed funded live run is included yet.
- **REPLAY:** historical archive with original mode retained. Checksum verification is not fresh hardware or chain verification.

Do not count seed capital, compute grants, service transfers or test escrow payouts as business revenue. The repository deliberately avoids the proposed “send 0.1 NEAR, receive 0.11 NEAR” fallback as a profitability claim.

## Submission checklist

Record the commit, build/contract hash, network, exact test commands, provider/model, approved measurements and actual transaction links for any live evidence. Keep model prompts and credentials private. Show unresolved/held states honestly. Link this README and the acceptance ledger rather than promising permanent operation or inventing judge endorsements.
