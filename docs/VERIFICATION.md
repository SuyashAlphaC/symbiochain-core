# Verification record

Local and hosted verification performed on 2026-10-27. Evidence categories are kept separate. The Render/Supabase PAPER backend is publicly hosted and verified. No funded mainnet transaction, authenticated real model completion or external financial self-sufficiency is asserted.

| Gate                   | Result                                                                                                                                                                                                                                                                                          |
| ---------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Prisma migrations      | Seven versioned migrations applied to local PostgreSQL, the isolated `_test` database and dedicated Supabase; all 18 backend tables have RLS and zero Data API grants                                                                                                                           |
| TypeScript             | Strict typecheck and production build pass                                                                                                                                                                                                                                                      |
| Unit tests             | 35 pass: units, commitments, policy economics, encryption, quote/response signatures, hardware policy, malformed DCAP input, EVM/SOL assembly, receipt freshness, archives, safe RPC values, optional JWT, plus five public-ITA cases for signature, nonce, time, issuer and platform rejection |
| PostgreSQL integration | 34 pass: workflow closure, concurrent processing, stale leases, held reserves, auth/replay, immutable journals, paid-inference and Intents nonce recovery, cost approval, plus 12 LIVE-orchestration cases covering both legs, dropped sends, refunds, retry limits and idle funding            |
| Rust unit tests        | 12 pass: roles/revocation, pause, budget and independent token caps, one-use signing, service conservation, receipt mechanics, failed payout credit and Solana payload structure                                                                                                                |
| NEAR sandbox           | 10 checks pass: real local contract calls, payload equality against viem/web3.js, duplicate/unauthorized rejection, NFT mint, distribution/claim, service settlement/storage and withdrawal protection                                                                                          |
| PAPER demo             | Reaches CLOSED with zero active reservation, balanced journals and explicit SIMULATED evidence                                                                                                                                                                                                  |
| Export/replay          | A private PAPER archive exports and replays with source mode preserved and checksum valid                                                                                                                                                                                                       |
| Docker                 | Non-root image builds; local container readiness returns 200, authenticated swarm read returns 200, unauthenticated read returns 401                                                                                                                                                            |
| Hosted deployment      | Render free service reaches `live`; public readiness 200, unauthorized read/write rejection 401, authenticated HTTPS/WSS and cursor replay pass. All three workers close a PAPER cycle with zero reserves and balanced journals.                                                                |
| npm audit              | Zero high/critical findings; transitive low/moderate findings remain documented in the operations guide                                                                                                                                                                                         |
| Public market probe    | Actual dry quotes verified using the approved 1Click manager key; captured conservative return is below input, so profit gate rejects it                                                                                                                                                        |
| Public gateway probe   | Real Intel Trust Authority gateway token: PS384 signature, pinned issuer/key source, fresh signed nonce, expiry, UpToDate TDX and debug-disabled claims verified; application measurement remains unapproved and model inference remains unverified                                             |

GitHub CI [run 40544585877](https://github.com/SuyashAlphaC/symbiochain-core/actions/runs/40544585877) passes both backend and contract jobs at `af16c74068a28b99f668b1b57528f484ae8261df`. This includes 35 unit tests, 34 PostgreSQL integration tests, the PAPER demo, audit gate, 12 Rust tests and 10 sandbox checks. cron-job.org recorded two scheduled HTTP 200 responses from the hosted readiness endpoint. See [hosting evidence](../artifacts/hosting-preflight.json).

## Commands

```bash
npm run check
npm run test:integration
npm run demo
npm run contract:test
npm run contract:build
bash scripts/build-mock.sh
bash scripts/install-sandbox.sh
npm run contract:integration
npm run probe:market
npm run probe:attestation
npm audit --audit-level=high
docker build -t symbiochain-core:local .
```

`artifacts/market-probe.json` is a real public quote snapshot with signatures and its capture time. It is not a settlement. Sandbox output uses an intentionally invalid-signature MPC stub and synthetic accountant-reported P&L. Hardware-policy tests inject verified-report fixtures; the separate malformed-quote test calls the actual DCAP library and rejects invalid bytes. Valid offline signing tests use locally generated keys, not MPC-generated signatures.

`test/integration/live.test.ts` exercises the production LIVE orchestration against PostgreSQL with injected RPC, treasury, inference and payment transports. Quotes and EVM/Solana transaction signatures are cryptographically verified using local test keys; network balances, hardware evidence and chain settlement are fixtures. These tests reproduce the PostgreSQL advisory-lock deserialization failure, recover lost broadcasts using identical signed bytes, retain reservations on exhausted retries, close first-leg refund authorizations, and verify the idle-funding confirmation boundary. They do not establish mainnet execution or genuine confidential inference. Production configuration exposes no fixture or attestation-bypass switch.

The optional-JWT regression first failed with `LIVE requires ONECLICK_JWT` and now passes without a partner token. The same test still rejects unarmed trading, missing approved model measurements and a missing inference key. This removes an unnecessary access dependency; it does not waive anonymous platform fees or establish funded settlement. `live:preflight` now lists the remaining 16 missing settings and reports the selected 1Click authentication mode separately.

The contract build emits the current `artifacts/symbiochain_treasury.wasm` SHA-256. Use the hash from your build/release; an artifact hash alone does not imply deployment.

`artifacts/public-attestation-probe.json` contains a real public gateway ITA token and Intel public keys acquired from a pinned HTTPS endpoint. The signature and signed caller nonce were checked at capture time. The token expires after a short interval; the artifact records historical verification, not permanent freshness. `deploymentMeasurementApproved` and `modelInferenceVerified` are false. This diagnostic neither exercises the production DCAP verifier nor purchases inference or moves funds. Its adversarial unit cases use locally generated RSA fixtures.

## Remaining live evidence

Infrastructure verification additionally checked the pinned SDK's types, preservation of Docker builds/API migration/readiness/worker startup, and a read-only Railway plan with three additions, zero changes and zero destructions. See [plan summary](../artifacts/infrastructure-plan.json). Provisioning attempts are rejected despite Hobby metadata; the selected empty environment has no services or pending deployment work. A queued template response was not counted as successful provisioning. The alternative Railway plan remains unapplied. Separate [hosted PAPER verification](../artifacts/hosted-paper-verification.json) establishes the selected Render/Supabase runtime checks.

Run `npm run live:preflight` to list missing configuration **names** without displaying secrets or issuing a transaction. Dedicated funded accounts/wallets, provider/session credentials, approved measurements and target-chain gas remain prerequisites. Supabase and Render were selected for the PAPER deployment. Real attested inference, actual MPC signing, funded two-leg settlement, live cost valuation and a demonstrated compute-funding cycle remain external validation work. Direct purchase of NEAR AI credits also needs a supported customer payment protocol; the inspected public interfaces do not supply one. See the [provider funding decision](PROVIDER_FUNDING.md). Do not replace those gates with paper/sandbox output.

## Operator and economics work on 2026-10-29

Local strict TypeScript/build and 35 unit tests pass. PostgreSQL integration now has 39 passing cases, including operator access control, disabled/LIVE crash rejection, one-shot crash consumption/cancellation, same-job lease recovery, cost approval wake-up, and negative-profit rejection after explicit settlement fees. Receipt profit calculation now deducts those separately recorded base-asset settlement fees in addition to approved operating costs.

The [local browser record](../artifacts/operator-local-verification.json) uses actual Chromium against the API/worker supervisor. It verifies disabled read-only controls, a real worker SIGKILL, supervisor exit 137/restart, Scout reclaim on attempt two, cost-gated reconciliation, immutable approval and closure with explicitly simulated 100-bps rights. Desktop and 390px mobile checks report no horizontal overflow or page errors. The local restart supervisor emulates host restart; hosted recovery evidence must be recorded separately after deployment.

This does not establish a compute-credit purchase, complete actual business costs, independently verified cost valuation, funded mainnet execution or an actual mainnet NFT mint.

Hosted operator verification passes on Render at revision `10964bb497bcdb283a2fe3fc30569f89b1c187dd`: actual targeted worker crash, same-job recovery on attempt two, WSS reconnection, administrative cost approval and closure with explicitly simulated rights. PostgreSQL checks confirm one settlement journal, one simulated inference usage record, one crash-trigger event and zero unbalanced journal/asset groups. The [hosted record](../artifacts/operator-hosted-verification.json) includes fresh Supabase TLS/RLS/grant checks. GitHub CI [run 40911885653](https://github.com/SuyashAlphaC/symbiochain-core/actions/runs/40911885653) passes both backend and contract jobs (35 unit, 39 integration, 12 Rust tests, 10 sandbox checks). The delayed-request browser regression also verifies that other controls stay disabled throughout pending actions.
