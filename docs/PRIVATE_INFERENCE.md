# Private inference verification

Use the NEAR AI Cloud gateway at `https://cloud-api.near.ai`. Model privacy is a separate choice: NEAR-operated Confidential TEE models support the NEAR model-evidence flow, while Incognito models run on upstream providers outside that model TEE. Third-party confidential providers have different evidence formats. See the current [model catalog documentation](https://docs.near.ai/cloud/models).

## Selected model

SymbioChain selects `z-ai/glm-5.3-flash` (GLM 5.3 Flash) for the Brain. Its canonical ID, NEAR-operated model evidence, structured-output support, and bounded output fit the existing risk-assessment client. The [official model page](https://near.ai/models/z-ai/glm-5.3-flash) publishes current pricing; inference consumes provider credits.

Set `NEAR_AI_MODEL=z-ai/glm-5.3-flash` in both the local backend environment and the existing Render service. This selects the model without enabling paid inference or LIVE trading. Hardware verification, independent deployment approval, balance access, and explicit LIVE arming remain separate checks. Keep `max_tokens: 600` and the operator's configured minimum-credit reserve.

## Implemented scope

| Check                       | Implementation and limit                                                                                                                                                                                                                                                            |
| --------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Gateway and model preflight | Requests a fresh nonce, a canonical model ID, `provider=near`, and `x-no-aliasing: true`; verifies the gateway and every returned model candidate before purchasing inference.                                                                                                      |
| Intel TDX                   | Verifies DCAP evidence, accepted platform status, non-debug mode, signer/nonce binding, exact compose-string hash, and replayed RTMR3. Deployment hashes must already be independently approved.                                                                                    |
| NVIDIA GPU verdict          | Sends the original GPU payload to the pinned HTTPS NRAS endpoint. Accepts its detached platform JWT plus GPU-token map; checks nonce, issuer, validity, all submitted GPUs, token digests, secure boot, disabled debugging, measurements, warnings, and required security verdicts. |
| Response integrity          | Retains exact request/response bytes and requires a model-serving signature matching exactly one previously verified model identity. Gateway-only signatures do not authorize trading.                                                                                              |
| Spending controls           | Checks organization credit before LIVE inference; limits completion output to 600 tokens and prevents automatic resubmission after an uncertain paid request. The minimum-credit reserve is not a hard cumulative spending cap.                                                     |
| Gateway TLS binding         | **Not implemented.** Proof metadata reports `tlsConnectionBinding: false`.                                                                                                                                                                                                          |
| Client-to-model E2EE        | **Not implemented.** Standard HTTPS protects traffic in transit.                                                                                                                                                                                                                    |

The NVIDIA verdict is authenticated through the direct HTTPS response from NRAS. The backend does not independently verify NRAS JWS signatures for offline use. This matches the documented [TLS-authenticated NRAS flow](https://docs.near.ai/cloud/verification/reference/quote-nonce-signer); archived JWT payloads alone are not independently verified evidence.

Backend orchestration and its function-call keys remain outside a TEE. A verified inference does not attest the Render worker, validate market profitability, or prove that an entire trade executed inside an enclave.

## Prepare without purchasing inference

1. Read `/v1/models` for current canonical IDs and pricing. This endpoint is public, so success does not validate an API key.
2. Use authenticated `GET /v1/attestation/report` with a fresh nonce, the candidate model, `provider=near`, and an explicit signing algorithm. Report retrieval is non-billable. A returned report still requires hardware and deployment-policy verification.
3. Review image provenance and approve gateway/model compose measurements through an independent source/build review. Never copy an observed hash directly into the allowlist as an approval shortcut.
4. Configure the separate `NEAR_AI_ORG_ID` and `NEAR_AI_SESSION_TOKEN` needed for balance reporting. Unknown balance stops LIVE inference. Keep local and hosted reserve settings aligned.
5. After those checks, run one bounded completion and reconcile its `inference-id` against provider billing. Do not start a continuous paid loop merely to validate credentials.

## Remaining transport work

The [gateway TLS flow](https://docs.near.ai/cloud/verification/cloud-api/tls) requires the peer certificate, SPKI hash, and attestation report to come from the same open TLS connection. To cover inference, the completion must use that connection too; a reconnect requires fresh verification. Ordinary `fetch`, a separately downloaded certificate, or `include_tls_fingerprint=true` alone does not establish this property. Certificate validation must remain enabled.

[Client-to-model E2EE](https://docs.near.ai/cloud/guides/e2ee-chat-completions) is an optional additional layer. It requires a verified model encryption key and a compatible serving path. It is a separate implementation from TLS binding and must not be claimed from an API-key check.

The [gateway verification guide](https://docs.near.ai/cloud/verification/cloud-api) defines the full request path. Prefer its current requirements over older example scripts or static model tables.
