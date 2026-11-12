# Deployment, candidate and submission revisions

## Current production — internal Intents settlement and preparation

The [November 12 paired release](../artifacts/mainnet-preparation-release.json)
identifies backend `13c2c56475aec7fe83b6e00422c9955fb61441ee` on the existing
Render service and frontend `b21653e5a8c1b334141e684b5cf4c1be02f4b65a` on the
existing Vercel project. Production browser checks passed on desktop and mobile.
Two actual internal Intents payments are published with finalized receipt,
nonce and balance reconciliation. They are team-funded mechanics, not revenue.
The read-only preparation worker checks chain identities, funding, owner
permissions and signed previews every five minutes. Paid execution stays disarmed
and the TEE gate stays quarantined. Submission remains on hold.

## Earlier bounded mainnet activation

The [November 9 bounded release record](../artifacts/mainnet-bounded-release.json)
identifies the deployed backend/frontend revisions and their existing Render and
Vercel deployment IDs. Seven mainnet receipts establish owner activation; runtime
monitoring and paid inference remain explicitly separate. This record supersedes
the earlier paused-state release below without rewriting its dated observations.

## Earlier November 9 mainnet observer

The [production verification record](../artifacts/mainnet-acceptance-release.json)
supersedes the historical deployment tables below. It identifies the exact
frontend and backend revisions, existing hosting projects, sanitized checks and
the LIVE/disarmed runtime. The frontend's `/api/release` independently exposes its
public Vercel revision and deployment ID. Both repositories are public.
The artifact is frozen at its check time; later documentation-only deployments
can have a newer frontend Git revision. Consult `/api/release` for current identity.

The November 9 bounded activation supersedes the earlier paused foundation: the treasury is unpaused, three worker permissions are enabled and both scoped Intents keys are registered. The runtime remains disarmed with monitor-only heartbeats. [Seven finalized activation receipts](../artifacts/mainnet-bounded-activation.json) and the [activation guide](BOUNDED_MAINNET_ACTIVATION.md) record the exact scope. Mainnet native
balances and recorded deployment transactions are real; PAPER economics, testnet
accounting and local wallet fixtures retain their explicit scope. Paid inference,
funded trading, external revenue, automatic credit purchasing and business-funded
NFT distributions remain unproven. No hackathon form submission is confirmed.
See [activation requirements and rollback](MAINNET_PRODUCTION.md).

## November 9 mainnet acceptance

The [mainnet acceptance report](../artifacts/mainnet-acceptance.json) and [scope guide](MAINNET_ACCEPTANCE.md) add 12 rechecked mainnet transaction proofs and the completed self-funded service-balance deposit/withdrawal. This is mainnet mechanics evidence, not a profitable business cycle. The public evidence view excludes testnet results; the old route redirects. The release verification record identifies the exact paired revisions after publication.

## Historical release records

Statements below describe their dated checks, not the current runtime.

The [machine-readable revision manifest](../artifacts/funding-release-manifest.json)
records the verified deployed baseline separately from the business-accounting and NFT-funding source.
A hackathon form submission has **not** been confirmed; no revision is falsely
labelled submitted. Update the submission section only after recording the actual
submitted commits and application receipt.

| Scope                                           | Frontend                                                                                                                                | Backend                                                                                                                                        |
| ----------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| Verified deployed application                   | [`83d46d8eb5db2257989bf1c831694da20617635e`](https://github.com/AviraL0013/SymbioChain/commit/83d46d8eb5db2257989bf1c831694da20617635e) | [`e1633c7ff16cb2ce3ce484aa44b12d09cc0117a5`](https://github.com/SuyashAlphaC/symbiochain-core/commit/e1633c7ff16cb2ce3ce484aa44b12d09cc0117a5) |
| Business/funding source candidate; not deployed | [`e6bbcfe57d608297447b068d11c4910456c016d7`](https://github.com/AviraL0013/SymbioChain/commit/e6bbcfe57d608297447b068d11c4910456c016d7) | [`bc5df4e4c67fde7cd336a466436d1b53dacf7dac`](https://github.com/SuyashAlphaC/symbiochain-core/commit/bc5df4e4c67fde7cd336a466436d1b53dacf7dac) |

Both repositories are public. The existing Vercel project serves `/testnet` and
has configured operator access; the owner verified login, PAPER state and logout.
The backend's `artifacts/frontend-production-release.json` separates independent
read checks from owner-reported verification. Initial deployment/publication is
complete. No new Vercel project was created.

The new backend migration and `/business` frontend have been tested locally.
Deploy the additive backend migration/application before that frontend update.
Neither a new production deployment nor a hosted Supabase migration was performed
for this feature. Subsequent documentation commits do not change the application
revisions frozen in the table. Preserve this distinction when choosing submission
commits or refreshing deployment evidence.

## Execution and business scope

Real evidence covers testnet contract safeguards, agent ledger payments, MPC
signatures and separate confirmed Sepolia/Solana devnet transfers. Those transfers
are authorization fixtures, independent of the blocked AI workflow. The integrated
runner stops at TEE deployment approval with zero paid requests. Market quotes,
settlement economics and positive NFT accounting fixtures are simulated.

New business accounting is implementation-tested, including finalized-receipt
parsing with injected RPC responses. The earlier invoice probe timed out; a later independent wNEAR-credit parser
check passed against a public third-party receipt, not project revenue. No actual customer fee, profitable mainnet round
trip, AI-credit purchase or business-funded NFT payment was performed. The November 7 owner funding update below supersedes the earlier unfunded status. The later November 9 activation sets the bounded contract policy; separate funded trading validation remains incomplete. Provider purchase
integration remains blocked under the public-interface-only requirement. Earned-proceeds
NFT conversion, withdrawal, allocation and recovery are implemented and tested,
but disabled without funded validation; see [funding scope](BUSINESS_FUNDING.md).
The [November 6 testnet upgrade](../artifacts/testnet-funding-upgrade.json) preserved
state and left the treasury paused. Earlier artifacts retain their historical code hash.
No Supabase/Render/Vercel production update was performed for this extension.
The prior [November 5 manifest](../artifacts/business-release-manifest.json) is retained
as a dated historical record, superseded by the funding manifest above.

## Accounting merge and funding follow-up

The earlier backend PR #1 and frontend PR #4 were merged on November 5 at
`6a6a2ba6e6e1a4b3ad39a62b46d10500201453d6` and
`b855671653e4ac8a188f512b3a879c2a1a527227`, respectively. They contain accounting,
not the new NFT payment path. The [November 6 read-only preflight](../artifacts/funding-production-preflight.json)
confirmed Render still serves `e1633c7`, and both hosted business endpoints return 404. The frontend baseline above is the last verified exact deployment revision;
a later repository merge does not prove its deployment. Apply the existing
business migration and deploy the paired backend APIs before releasing this page.

The funding extension reviews have been merged into their source repositories; this does not establish a hosted release:
[backend #2](https://github.com/SuyashAlphaC/symbiochain-core/pull/2) and
[frontend #5](https://github.com/AviraL0013/SymbioChain/pull/5). Earlier merged PRs
retain their original scope. No production deployment was performed in this task.

## November 7 service and manual funding candidate

The application revisions for this extension are backend [`e59d172`](https://github.com/SuyashAlphaC/symbiochain-core/commit/e59d172c30caab19f8ccf1d7e3a114d54ee57ff0) and frontend [`b879d05`](https://github.com/AviraL0013/SymbioChain/commit/b879d0514d2551eb53504b757dde9cdfaed27974). Later documentation/evidence commits do not change those application revisions. The [candidate manifest](../artifacts/service-loop-release-manifest.json) records the exact scope.

New behavior includes prepaid quote-risk reports, separate customer advances and delivered external revenue, disabled-by-default LIVE arbitrage, durable manual top-up tasks and unverified operator confirmations. The frontend displays recorded TEE quarantine and HITL status through a fixed server proxy and exposes PAPER-only reporting under the existing operator session. The NEAR contract executable did not change; additional tests cover small splits, rounding liabilities and distribution replay.

[Isolated validation](../artifacts/service-loop-validation.json) passed 129 unit, 80 PostgreSQL integration and 16 Rust contract tests. Frontend validation passed 25 tests, formatting, lint, type checks, production build and the local browser flow. Local source fixtures are not external revenue, paid inference, provider credits or mainnet proof. The [read-only hosted preflight](../artifacts/service-loop-production-preflight.json) records API availability separately from source changes. No production database, hosting service, TEE allowlist or wallet was modified by this extension.

See [the service and bridge runbook](SERVICE_LOOP.md). Existing business migrations are required, with no new migration. Release the backend and then the paired frontend before creating service cycles; older detail clients accept only the round-trip strategy. Manual reports remain unverified and their reservations stay held. Customer checkout/refund operations, actual mainnet revenue and supported automatic provider credit purchasing remain unfinished.

The complete deployable backend revision is [`99a482c`](https://github.com/SuyashAlphaC/symbiochain-core/commit/99a482cc25e23b093b839c0f51f476bc5fe9e19b); it includes the runtime audit allowlist and CI packaging check. The paired frontend release revision is [`9ef944a`](https://github.com/AviraL0013/SymbioChain/commit/9ef944a7156c06b8e18e03a381712b9998cf928a). These extend the application implementation revisions above with packaging/documentation. The local Docker image built successfully and its Node runtime loaded exactly the public rehearsal and quarantine audit, retaining `deploymentApproved: false`. Paired reviews: [backend #4](https://github.com/SuyashAlphaC/symbiochain-core/pull/4), [frontend #6](https://github.com/AviraL0013/SymbioChain/pull/6).

## November 7 environment-only redeployment

Deployment `dep-dbnb6gp5efls73arhbmg` refreshed the existing Render service's owned-Cloud credentials and budget configuration using `deploy_only`. The deployed code remains `e1633c7ff16cb2ce3ce484aa44b12d09cc0117a5`; the newer service and HITL revisions above are still separate source candidates. The [verification record](../artifacts/owned-cloud-render-verification.json) captures readiness, mode, budget, worker freshness and the absence of completion/transaction requests. It does not establish TEE approval, actual provider balance or purchased credits attributable to business proceeds.

## November 7 owner-funded mainnet preparation

The owner funded `solidvideo4090.near` with approximately 6.735 NEAR and authorized a mainnet infrastructure deployment. Meteor blocked the original direct batch's full-access recovery-key actions, before any transaction. The [local signing tool](../tools/mainnet-deploy/README.md) now uses the official `near.create_account` factory to provision a separate deployment wallet with 6.38 NEAR and a 0.02 NEAR owner-side fee contingency. Its temporary local key deploys paused infrastructure, refunds excess funds and revokes itself. The dedicated account becomes the contract owner, retaining the original Meteor recovery public key. No original owner private key is exported and hosted LIVE mode stays off.

The [factory snapshot rehearsal](../artifacts/mainnet-factory-deployment-rehearsal.json) verifies deployment order, pause, funding, recovery custody, refunds and temporary-key revocation. The [unsigned browser check](../artifacts/mainnet-factory-browser-verification.json) verifies one factory call with zero root key grants. These are local evidence. **Final mainnet verification is recorded separately; preparation and local tests alone do not establish deployment.** TEE approval, real service revenue, supported compute purchases and business-funded NFT distributions remain independent unfinished validations.

## Verified mainnet foundation — November 7

The [final mainnet record](../artifacts/mainnet-paused-deployment.json) confirms treasury `treasury.symbio-fcef733893.near`, dedicated owner `symbio-fcef733893.near`, and Brain/Hand/accountant/Scout subaccounts. The executable SHA-256 is `39f034e6ae16ddb9cf253ac977c4146989a0fee1fa7c33ba0944092bf41de3d5`. All three workers are disabled, the treasury is paused and NFT revenue shares total zero. The original funding wallet’s recovery public key controls each account; the temporary deployment key is absent from the final owner account. Nine known transaction outcomes were verified successfully.

The original wallet’s final total balance is approximately 0.401437 NEAR. The five child accounts hold the allocated 6.27 NEAR; the dedicated parent retains approximately 0.012555 NEAR for storage and recovery. Recorded network token burns total approximately 0.051049 NEAR. Native account funding and storage collateral are not business expenses or revenue. The separate runtime profile is private and inactive; Render remains PAPER, with no production application or database change from this mainnet deployment.

TEE-approved inference, trading, real Intents settlements, customer revenue, compute purchases from proceeds and business-funded NFT payouts remain unproven.
