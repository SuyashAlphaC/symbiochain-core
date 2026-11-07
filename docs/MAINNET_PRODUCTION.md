# Mainnet observation and execution gates

The permanent application uses the existing Render backend and Vercel frontend.
`LIVE` identifies the source of chain observations. `EXECUTION_ENABLED=false`
disarms the execution plane. It does not mean the swarm is trading, purchasing
inference or earning revenue. The [production verification record](../artifacts/mainnet-production-verification.json)
records the deployed revisions and checks; historical PAPER/testnet artifacts
retain their original scope.

The artifact is a frozen verification snapshot at its recorded timestamp.
Subsequent documentation-only merges can change the frontend's Git deployment
revision without changing application behavior. `/api/release` is the current
public frontend identity; Render's deployment record identifies the running
backend image. Documentation revisions are not inferred to be new execution
evidence.

## What is connected

The frontend reads `/api/runtime` and the bounded `/api/mainnet/*` projections
through fixed Next.js server routes. Read credentials remain server-side.
Mainnet observations include a finalized block, native account balances, storage
collateral, recovery custody, worker flags, treasury policy, executable hash and
NFT supply. Queries in each snapshot use the same finalized block hash. The
known deployment transaction lookup also checks receipt outcomes. Funding and
deployment receipts are labelled as infrastructure, not customer revenue.

The treasury is `treasury.symbio-fcef733893.near`, owned by
`symbio-fcef733893.near`. Its reviewed executable remains
`39f034e6ae16ddb9cf253ac977c4146989a0fee1fa7c33ba0944092bf41de3d5`.
The treasury is paused, three worker permissions are disabled and the temporary
deployment key remains revoked. No owner recovery key is loaded by Render.

Meteor and MyNearWallet connection requests use pinned wallet executors and
request account access without adding a key. Connection is not operator
authentication and requests no transaction. The browser fixture verifies those
parameters; an actual user must still complete their wallet's login UI.

## Disarmed runtime

`scripts/start-render.sh` applies additive migrations and database protection,
then starts only the API when execution is disabled. No worker loop is started.
Worker entry, cycle admission, engine execution and administrative mutations
independently reject disarmed execution. The public frontend offers no LIVE
arming endpoint. Legacy PAPER publication remains mode-bound and refuses LIVE.
Existing PAPER records remain in PostgreSQL under their original mode.

The hosted Cloud key and organization binding are retained. The durable
`AI_BUDGET_ID` is unchanged, so switching modes or restarting cannot reset the
allowance. Limits remain USD 1.00 total and USD 0.10 per request. Provider balance
is unknown without its separate authorization; a displayed application allowance
is not a provider balance. No paid completion is required to serve chain reads.

## Remaining activation requirements

- Independently approve the entire current TEE deployment and serving identity.
  Missing launcher signed provenance still closes this gate. Hardware subchecks
  alone do not authorize paid inference. See [the approval handoff](TEE_APPROVAL_HANDOFF.md).
- Obtain explicit numeric trading and gas caps. The deployed on-chain limits
  are defensive placeholders; runtime trading limits are zero. Fund only the
  reviewed routes, derived wallets and required native gas after authorization.
- Review owner-signed worker permissions and contract policy before unpausing.
  Load only receiver-scoped agent keys, never the owner's recovery key.
- Establish a genuinely profitable executable route before any trade. A losing
  10-USDC preview remains rejected; deployment does not create arbitrage.
- Validate real customer delivery, final Intents settlement and complete costs
  before claiming external net revenue or funding NFT distributions. Testnet
  transfers and simulated accounting are not that evidence.
- Automatic provider credit purchasing remains unavailable under the supported
  public-interface policy. A manual purchase report is provider-unverified and
  cannot increase credits or unlock inference.

These requirements are independent. Mainnet deployment and an organization-bound
Cloud key do not resolve missing provenance, create profit or supply a billing API.

## Release order and rollback

Deploy compatible backend code in PAPER first. Release the frontend through the
existing Vercel Git integration, then change the backend to LIVE/disarmed and
verify finalized data. Preserve database credentials, evidence encryption,
application tokens and the compute-budget identity. No reset or truncation is
part of this transition. The additive business migration was already rehearsed
on an isolated database.

For rollback, keep execution disarmed. Restore the saved PAPER environment and
the compatible backend image before promoting an older PAPER-only frontend.
Restore the original durable budget identity and evidence key, not newly
generated values. Do not roll old backend code into a LIVE environment: older
revisions do not understand the disarmed profile. A UI rollback never authorizes
an on-chain unpause, a recovery-key grant or a new inference purchase.

The private environment snapshots and release-operation records remain outside
Git. The public production artifact contains identifiers and sanitized outcomes
only. A hackathon submission receipt has not been observed; deployed revisions
are not automatically labelled submitted.
