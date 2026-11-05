# Testnet submission and judge walkthrough

SymbioChain is a policy-controlled agent treasury prototype. The deployed dashboard
runs PAPER. Separate public testnet evidence records real contract and MPC
operations. It does not demonstrate a self-funding business.

## Evidence boundaries

| Capability                           | Recorded result                                                                 | Boundary                                                              |
| ------------------------------------ | ------------------------------------------------------------------------------- | --------------------------------------------------------------------- |
| Treasury, permissions, limits, pause | Production WASM deployed to NEAR testnet; real acceptance/rejection checks      | Faucet capital, not mainnet                                           |
| Agent payment                        | Funded NEAR ledger settlement with duplicate protection                         | Not an Intents payment                                                |
| Sepolia execution                    | Real MPC ECDSA signature and confirmed test-USDC transfer                       | Authorization fixture, not AI-approved arbitrage                      |
| Solana devnet execution              | Real MPC Ed25519 signature and finalized native transfer                        | Authorization fixture, not AI-approved arbitrage                      |
| NFT, distribution, claim             | Real contract operations in the testnet rehearsal                               | Positive reported P&L is synthetic; distribution is faucet capital    |
| Integrated agent runner              | Durable Scout/Brain/Hand workflow implemented; real run stops at Brain approval | No completed authenticated AI cycle claimed                           |
| TEE hardware                         | Gateway and model hardware audit passed November 5                              | Historical evidence is not a current attestation                      |
| TEE deployment and response          | Blocked pending independently reviewed provenance/allowlists                    | No paid completion or signed model response verified                  |
| Market settlement and economics      | Explicit simulation; real losing quotes remain rejected                         | No real profit, business runway or automatic compute purchase claimed |

## Actual transactions

- [NEAR testnet treasury](https://testnet.nearblocks.io/address/treasury.sc-rehearsal-1bb69cb2.testnet)
- [Sepolia test-USDC transfer](https://sepolia.etherscan.io/tx/0xd47cc9a925ca1bd0f0232181736894a744ed9ba41284e920cd14cb5029ca81e3)
- [Solana devnet transfer](https://explorer.solana.com/tx/2hMmyjDc1bYdyoi4QdfhpRLUb4bFYAWeDcJnjGQgGkTGPRmFuuMKeHdrYmrqaBmbV3QjSet2ZXeXzUYnbfBVvRkb?cluster=devnet)

The bounded report is `artifacts/testnet-rehearsal.json`. Its original rehearsal
transactions and capture time are separate from the newer `swarm` and
`executions` records. An authorization fixture cannot satisfy the integrated
runner's `VERIFIED_AI` execution requirement.

## Reproduce without provider keys

Use Node 24 and Docker for the backend. From a fresh clone:

```sh
npm ci
cp .env.example .env
docker compose up -d postgres
npm run db:generate
npm run db:migrate
npm run check
npm run demo
```

Expected: passing checks and a `CLOSED` PAPER cycle, explicitly simulated. Never
point regression tests or these instructions at a production/LIVE database.

```sh
npm run contract:build
npm run testnet:rehearse
npm run testnet:swarm -- --watch
```

Expected: fresh faucet accounts, actual treasury deployment and contract/MPC/NFT
checks. The bounded swarm advances from Scout to Brain, then exits 2 with
`TEE_DEPLOYMENT_UNAPPROVED` until deployment approval exists. It does not purchase
inference or sign around that gate. Faucet outages are explicit blocked results.

The profile checks NEAR network identity before every mutation and the WASM hash
before reusing a treasury. It never reads production wallet keys. Preserve the
ignored `.data/testnet-*` directories: they contain recovery keys, exact signed
bytes and idempotency journals. Never publish them.

## Destination execution

```sh
npm run testnet:execute
```

Expected: two labelled `AUTHORIZATION_FIXTURE` results. Fund the printed derived
addresses with faucet tokens only, then resume the same command. Sepolia uses
chain 11155111 and Circle's published test USDC
`0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238`. The adapter checks deployed bytecode,
token balance, gas coverage and the committed ERC-20 Transfer log. It transfers
one test USDC. Solana verifies the full devnet genesis hash and transfers 0.001
faucet SOL, allowing the fixture recipient's rent reserve.

References: [Circle addresses](https://developers.circle.com/stablecoins/usdc-contract-addresses),
[Circle faucet](https://faucet.circle.com/), [Solana faucet](https://faucet.solana.com/).

Terms and signatures are durable before broadcast. Unknown outcomes retain the
same identity; retries check confirmation and may retransmit only identical
bytes. An expired Solana blockhash requires reconciliation, never silent
resigning. Resuming a confirmed run cannot purchase another MPC signature or
create another token transfer.

## Stop and recover an actual worker

Run testnet commands sequentially: all share a runner lock.

```sh
npm run testnet:swarm -- --crash-after-claim=BRAIN
npm run testnet:swarm -- --recover-stale-lock --watch
```

The first command intentionally exits 70 after checkpointing the claim. Explicit
recovery removes only an identified dead process's lock and resumes the same run;
it refuses a live PID. Journals and inference reservations remain intact. The
recorded recovery returned to the same TEE gate with zero paid requests. Unit
tests additionally exercise crashes after model, transaction and mint effects
through fake ports; these tests are not real TEE execution evidence.

## Remaining private-inference approval

[TEE_APPROVAL_HANDOFF.md](TEE_APPROVAL_HANDOFF.md) names the missing digest and
provides a technical request. Obtain verifiable build evidence or a reviewed
replacement. Review immutable sources and fresh measurements before configuring
allowlists. Never install observed hashes solely to make the probe pass.

The runner requires `TESTNET_DATABASE_URL` for a dedicated durable PostgreSQL
database ending in `_testnet`. Apply the existing migrations to it and retain its
volume. Regression tests use a different database ending in `_test`.

```sh
DATABASE_URL="$TESTNET_DATABASE_URL" npm run db:migrate
npm run testnet:tee
npm run testnet:swarm -- --watch
```

Only after approval may `NearAiClient` purchase one completion for the immutable
run. The testnet budget has a **$0.10 total allowance** and a $0.10 conservative
per-request cap. Unknown outcomes retain their reservation and cannot trigger a
second purchase. Provider billing and the exact-byte model signature are checked.
The allowance is not the provider's remaining balance. A model rejection ends as
`REJECTED`; Hand never executes it.

If approved, the same run can advance through guarded devnet execution, payment
for the assessment, explicit synthetic reconciliation and a zero-share testnet
receipt. Synthetic positive accountant input only exercises the existing NFT gate;
it is not business revenue or profit from the destination transfer.

## Frontend and publication

Clone [AviraL0013/SymbioChain](https://github.com/AviraL0013/SymbioChain) beside this
repository. Use Node 22 there, `npm ci`, and its server-only environment example.
Start this backend with `npm run dev`, then follow the frontend README.
`/testnet` reads the authenticated report through same-origin server routes and
polls stored evidence without requesting inference or signing. The overview and
protected operator remain PAPER.

The existing Vercel project now serves [the testnet page](https://symbiochain.vercel.app/testnet).
PR #3 merged at `83d46d8eb5db2257989bf1c831694da20617635e`, and the frontend
repository is public. Operator access is configured; owner login/logout checks
passed and anonymous operator-state access is rejected. The
[production release record](../artifacts/frontend-production-release.json)
separates independent read-only checks from owner-reported browser verification.
The teammate release prompt remains a historical runbook; these release steps
are complete. Both repositories include MIT application-code licences, while
third-party assets retain their notices. The TEE approval gate remains open;
release does not establish a completed authenticated AI cycle or real profit.

## Start another bounded run

```sh
npm run testnet:swarm -- --new-run --watch
```

Use the original `TESTNET_DATABASE_URL`. This explicit action checks the original
inference record and NEAR journal, then archives the old runtime directory under
`.data/testnet-swarm-history/<runId>`. It retains the faucet account credentials,
derived wallets, database billing records and cumulative $0.10 allowance.
A completed/rejected run, or a run with no inference/chain effects yet, can be
retired. A STARTED/RECEIVED paid request, unfinished chain operation or inconsistent
database identity prevents retirement and requires reconciliation. Do not delete
journals or change database URLs to bypass this check. This command is how to
issue fresh terms after an opportunity expires; refreshes never silently replace
an immutable proposal.
