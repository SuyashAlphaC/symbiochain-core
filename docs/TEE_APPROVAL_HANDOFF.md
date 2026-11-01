# Remaining deployment approval

The [live evidence summary](../artifacts/tee-gates-verification.json) records authenticated gateway and GLM model hardware: Intel DCAP/TCB, nonce/signer binding, measured configuration, replayed RTMR3, gateway peer SPKI and NVIDIA GPU verdicts. Compose Manager's separate deployment-action quote also verifies. This establishes hardware evidence, not an approved application deployment or a signed inference response.

An offline discovery audit verified build-provenance signatures for nine NEAR-published image digests, including the gateway, VPC components, ingress, both referenced SGLang images, model proxy and Compose Manager. It used the official `@nearai/inference-sdk` verification implementation in an ignored tooling directory; no production dependency changed. Expected repository identity was restricted to the known NEAR publisher for each image. The retained results identify signed workflow, ref, source commit and immutable digest. Discovery of signed source claims does not automatically approve those sources, the whole action history or every third-party base image.

One measured bootstrap image still lacks a verifiable record at the checked public locations:

```text
nearaidev/compose-manager-launcher@sha256:079a14b41deb11e0e27f9b69648e8b3d89bd6fb9ccf6071643b8f447fa415085
```

GitHub's organization attestation endpoint returns HTTP 404 for that digest. The Docker registry's legacy digest attestation and signature tags also return 404. A missing record is unavailable evidence, not proof of a security incident. The launcher workflow currently publishes attestations, but that does not authenticate this particular previously deployed digest.

No organization session token, paid subscription or extra inference credit resolves a missing build record. Keep inference blocked until this image's provenance is verified or the provider supplies a reviewed replacement deployment. The currently observed model configurations vary across requests, so a fresh free probe must precede any approval. Do not install a returned hash automatically.

This is a ready-to-send technical request; it has not been sent to anyone:

> We are verifying `z-ai/glm-5.3-flash` through `https://cloud-api.near.ai/v1/attestation/report` with `provider=near`. Hardware and Compose Manager action authentication pass. We cannot locate build provenance for `nearaidev/compose-manager-launcher@sha256:079a14b41deb11e0e27f9b69648e8b3d89bd6fb9ccf6071643b8f447fa415085`: GitHub organization attestations and legacy OCI attestation/signature tags return 404. Could you provide a verifiable Sigstore/SLSA bundle and its expected source repository, workflow, ref and commit, or a replacement measured deployment whose required images have published provenance? This request concerns build evidence, not additional API access or credits. UTC probe timestamps and signing identities are in our sanitized verification summary; no API key or prompt is needed.

Once independently reviewed measurements and action hashes are approved, run one bounded completion through `NearAiClient`, verify its model-serving signature over exact request/response bytes and reconcile provider billing. Do not bypass the durable budget with a direct SDK chat call. Mainnet funding and trading remain separately disabled until the user supplies the account and spending limits.
