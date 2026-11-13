# Private inference verification

[Overview](../README.md) · [Recorded checks](VERIFICATION.md) · [Operations](OPERATIONS.md)

Use the NEAR AI Cloud gateway at `https://cloud-api.near.ai`. Model privacy is a separate choice: NEAR-operated Confidential TEE models support the NEAR model-evidence flow, while Incognito models run on upstream providers outside that model TEE. Third-party confidential providers have different evidence formats. See the current [model catalog documentation](https://docs.near.ai/cloud/models).

## Selected model

SymbioChain selects `z-ai/glm-5.3-flash` (GLM 5.3 Flash) for the Brain. Its canonical ID, NEAR-operated model evidence, structured-output support, and bounded output fit the existing risk-assessment client. The [official model page](https://near.ai/models/z-ai/glm-5.3-flash) publishes current pricing; inference consumes provider credits.

Set `NEAR_AI_MODEL=z-ai/glm-5.3-flash` in both the local backend environment and the existing Render service. This selects the model without enabling paid inference or LIVE trading. Hardware verification, independent deployment approval, the selected spending guard, and explicit LIVE arming remain separate checks. Requests use `max_tokens: 600`, `thinking_token_budget: 64`, minimal reasoning, and JSON output.

## Implemented scope

| Check                       | Implementation and limit                                                                                                                                                                                                                                                            |
| --------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Gateway and model preflight | Requests a fresh nonce, a canonical model ID, `provider=near`, and `x-no-aliasing: true`; verifies the gateway and every returned model candidate before purchasing inference.                                                                                                      |
| Intel TDX                   | Verifies DCAP evidence, accepted platform status, non-debug mode, signer/nonce binding, exact compose-string hash, and replayed RTMR3. Deployment hashes must already be independently approved.                                                                                    |
| Dynamic deployment          | Authenticates Compose Manager actions with a separate DCAP quote, nonce, action hash, matching compose measurement and replayed RTMR3. Requires a separately reviewed `TEE_MODEL_ACTIONS_HASHES` entry; a bootstrap hash alone cannot approve a changed workload.                   |
| NVIDIA GPU verdict          | Sends the original GPU payload to the pinned HTTPS NRAS endpoint. Accepts its detached platform JWT plus GPU-token map; checks nonce, issuer, validity, all submitted GPUs, token digests, secure boot, disabled debugging, measurements, warnings, and required security verdicts. |
| Response integrity          | Retains exact request/response bytes and requires a model-serving signature matching exactly one previously verified model identity. Gateway-only signatures do not authorize trading.                                                                                              |
| Spending controls           | Selects either provider-balance checks or a durable application budget. Limits response/reasoning tokens and prevents automatic resubmission after an uncertain paid request. Organization access is not required for the explicit local-budget policy.                             |
| Gateway TLS binding         | Captures the authenticated TLS peer SPKI, verifies its quote binding, and uses the identical open socket for attestation and completion. A replacement connection stops the request before its body is sent.                                                                        |
| Client-to-model E2EE        | **Not implemented.** Standard HTTPS protects traffic in transit.                                                                                                                                                                                                                    |

The NVIDIA verdict is authenticated through the direct HTTPS response from NRAS. The backend does not independently verify NRAS JWS signatures for offline use. This matches the documented [TLS-authenticated NRAS flow](https://docs.near.ai/cloud/verification/reference/quote-nonce-signer); archived JWT payloads alone are not independently verified evidence.

Backend orchestration and its function-call keys remain outside a TEE. A verified inference does not attest the Render worker, validate market profitability, or prove that an entire trade executed inside an enclave.

## Prepare without purchasing inference

1. Read `/v1/models` for current canonical IDs and pricing. This endpoint is public, so success does not validate an API key.
2. Use authenticated `GET /v1/attestation/report` with a fresh nonce, the candidate model, `provider=near`, and an explicit signing algorithm. Report retrieval is non-billable. A returned report still requires hardware and deployment-policy verification.
3. Review image provenance and approve gateway/model compose measurements through an independent source/build review. Never copy an observed hash directly into the allowlist as an approval shortcut.
4. Select the spending policy below. Organization balance reporting requires `NEAR_AI_ORG_ID` and `NEAR_AI_SESSION_TOKEN` for the organization actually owning the key. A Builders-issued grant key can instead use a durable local budget without those credentials.
5. After those checks, run one bounded completion and reconcile its `inference-id` against provider billing. Do not start a continuous paid loop merely to validate credentials.

## Free hardware audit and deployment policy

Run `npm run probe:tee` to retrieve and verify fresh gateway/model hardware evidence without purchasing a completion. It records raw evidence under ignored `.data/tee-gates/` and prints a safe summary. `hardwareVerified` authenticates the evidence; `deploymentApproved` separately checks configured measurements and deployment actions. A nonzero exit means the inference gates are not all satisfied. The probe never approves a hash or enables LIVE.

For Compose Manager deployments, review the authenticated actions and immutable image provenance before configuring `TEE_MODEL_ACTIONS_HASHES`. The canonical action hash retains unknown fields and uses UTF-8 lexical key order. Missing deployment evidence, changed actions, stale nonces, mismatched configuration, unaccepted TCB status and altered runtime measurements stop verification. Action logs prove deployment requests, not successful execution or the current state of every container. They bind a measured configuration, not a unique model instance.

The current audit authenticates both gateway and model hardware, including GPU evidence, but leaves deployment approval false. Selected image build provenance has been verified separately; this does not approve all images or a complete deployment. No paid inference has been purchased by this audit. A signed completion remains a separate required check.

Previously completed inference caches also recheck deployment policy. Removing an approved measurement or action hash stops reuse. Legacy GLM evidence without authenticated deployment actions or gateway connection binding cannot authorize LIVE. Such evidence is not silently upgraded.

## Builders keys and application budgets

The current service uses the newer user-owned Cloud key configured with its
organization ID. The earlier Builders-key workaround remains supported. Neither
an org ID in configuration nor a successful completion independently verifies
organization membership. The single [manual probe](../artifacts/manual-ai-probe.json)
used the newer key and reconciled to $0.00000548 without opening any TEE gate.

`COMPUTE_CREDIT_POLICY=PROVIDER_BALANCE` preserves the original organization-balance guard. Unknown, expired, or insufficient balance stops LIVE inference. Staking-credit sync is available only with that policy.

For a Builders grant whose organization is inaccessible, use the provided inference key and select:

```dotenv
COMPUTE_CREDIT_POLICY=LOCAL_BUDGET
AI_BUDGET_ID=symbio-builders-v1
AI_TOTAL_BUDGET_USD_MICROS=1000000
AI_MAX_REQUEST_USD_MICROS=100000
SYNC_STAKING_CREDITS=false
```

This authorizes up to $1 of cumulative application spending, with a $0.10 per-request admission ceiling. Before each paid request the backend checks canonical model metadata and reviewed rate ceilings, then reserves the maximum input-context charge plus bounded output/reasoning. At the reviewed catalog values this holds 84,219 USD micros; it is a conservative reservation, not a charged fee. The reservation and inference attempt are committed atomically to the existing PostgreSQL journal. Concurrent workers cannot reserve the same remaining allowance.

Actual charges come from `POST /v1/billing/costs` using the inference key and the response's `inference-id`; no organization session is needed for that endpoint. Successful reconciliation releases unused allowance. Timeouts or unavailable billing retain the reservation. A charge above the reservation is recorded and halts further paid requests. See the official [usage-reporting guide](https://docs.near.ai/cloud/guides/usage-reporting) and [GLM reasoning controls](https://docs.near.ai/cloud/reasoning-models).

Keep the budget ID and database stable across restarts, redeploys and key rotation. The budget does not reset daily. Returning to the provider-balance policy preserves the journal for a later return to the same budget. No schema migration is needed.

The operator API reports this as `computeControl.source: LOCAL_BUDGET`, with committed and available application allowance. Actual provider credit remains unknown (`computeCreditNanoUsd: null`); the backend does not invent a remaining grant balance or claim a protected $9 balance. Other applications using the same key are outside this budget's accounting. Full-business runway remains unknown.

## Transport verification

The [gateway TLS flow](https://docs.near.ai/cloud/verification/cloud-api/tls) requires the peer certificate, SPKI hash, and attestation report to come from the same open TLS connection. To cover inference, the completion must use that connection too; a reconnect requires fresh verification. `TlsGatewaySession` implements this connection requirement with normal certificate and hostname validation enabled. Ordinary `fetch`, a separately downloaded certificate, or `include_tls_fingerprint=true` alone does not establish it. New verified receipts record `tlsConnectionBinding: true`; older evidence without this binding cannot resume into LIVE authorization.

[Client-to-model E2EE](https://docs.near.ai/cloud/guides/e2ee-chat-completions) is an optional additional layer. It requires a verified model encryption key and a compatible serving path. It is a separate implementation from TLS binding and must not be claimed from an API-key check.

The [gateway verification guide](https://docs.near.ai/cloud/verification/cloud-api) defines the full request path. Prefer its current requirements over older example scripts or static model tables.

## Launcher provenance and the Brave verifier

The recorded November 7 audit pins
[brave/near-verifier at 72a1a994](https://github.com/brave/near-verifier/tree/72a1a994f3ab44c00ed4747398c68d38ac46bffa).
Its image verifier requires signed SLSA provenance and an accepted source commit
**before** applying the launcher's rebuild exemption. A source pin does not
replace missing build-to-source evidence. The
[compose-manager reproducibility issue](https://github.com/nearai/compose-manager/issues/64)
does not approve an unsigned image.

The unmodified CLI's `--skip-reproducibility` audit exited **1**. It did not
rebuild images. Intel TDX, GPU and TLS subchecks passed, but the exact launcher's
SLSA record was unavailable; OS/source pins also differed and two expected
gateway services were absent. These are separate failures. Successful subchecks
cannot establish complete deployment approval.

Preserved evidence: [launcher diagnostic](../artifacts/launcher-provenance-verification.json),
[CLI invocation and flags](../artifacts/brave-cli-verification.json),
[raw CLI report](../artifacts/brave-cli-provenance-only-report.json).
The affected image is:

```text
nearaidev/compose-manager-launcher@sha256:079a14b41deb11e0e27f9b69648e8b3d89bd6fb9ccf6071643b8f447fa415085
```

`npm run probe:launcher` runs the targeted diagnostic using the pinned verifier
checkout and prerequisites identified in its recorded artifact. It purchases no
inference and installs no approved measurement. For an independent CLI rerun,
use that exact source revision and recorded flags; supply `NEAR_API_KEY` privately
through the process environment, not command history or committed files.

For the targeted diagnostic, use Python 3.11+, Poetry and Git. Clone the verifier
into `.data/tee-gates/brave-near-verifier`, check out the exact revision above
and run `POETRY_VIRTUALENVS_IN_PROJECT=true poetry install --only main --no-interaction`
there. Install the official Linux AMD64
[cosign v3.0.6](https://github.com/sigstore/cosign/releases/tag/v3.0.6) at
`.data/tee-gates/bin/cosign` with executable permission and SHA-256
`c956e5dfcac53d52bcf058360d579472f0c1d2d9b69f55209e256fe7783f4c74`.
Return to the backend root before running the probe. It refuses changed verifier
source or a different binary. These optional tools are not production dependencies.

Keep automated inference quarantined until required provenance and the complete
observed deployment are independently reviewed, or a reviewed replacement is
available. Neither a manual paid completion nor this rebuild exemption can waive
the application policy. Backend workers themselves remain outside a TEE.

## Provider credit purchases

The recorded public-interface review found request-cost reporting, organization
balances and staking-credit sync, but no supported customer automation contract
binding invoice, payment, idempotent recovery and final credit attribution. See
the reviewed [public OpenAPI](https://github.com/nearai/docs/blob/main/api-reference/openapi.json)
and [billing architecture](https://github.com/nearai/cloud-api/blob/main/CLAUDE.md#external-billing-service).
Staking sync, grants and privileged balance updates are not proceeds-funded
credit purchases.

The [sanitized PingPay checkout inspection](../artifacts/pingpay-checkout-review.json)
proves only that an unpaid organization-targeted checkout existed. Its private
URL and customer identifiers remain outside Git. NEAR AI's merchant credentials
are not available to this project; a separate SymbioChain merchant account would
not purchase Cloud credits. No undocumented browser RPC or invented payment
endpoint is used. A new API key or mainnet deployment alone cannot implement
this missing protocol.

The implemented [manual bridge](ARCHITECTURE.md#human-in-the-loop-metabolic-bridge)
records tasks and unverified operator reports. It cannot mark provider credits
purchased, increase allowance, settle a proceeds reservation or approve a TEE.
