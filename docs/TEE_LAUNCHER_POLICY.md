# Launcher provenance and the Brave verifier

Provenance and reproducibility are separate checks. NEAR's open
[compose-manager issue #64](https://github.com/nearai/compose-manager/issues/64)
explains why the launcher cannot currently be rebuilt byte for byte. It proposes
retaining the signing/provenance steps while fixing reproducibility. The issue
does not establish that an unsigned launcher is acceptable or that no provenance
record should exist for our exact digest.

## What Brave actually requires

This audit pins [brave/near-verifier at 72a1a994](https://github.com/brave/near-verifier/tree/72a1a994f3ab44c00ed4747398c68d38ac46bffa).
Its [image verifier](https://github.com/brave/near-verifier/blob/72a1a994f3ab44c00ed4747398c68d38ac46bffa/verifier/verifications/image.py#L566)
requires a verified SLSA statement and accepted source commit before applying the
launcher rebuild exemption. Missing provenance returns a failed result first.
The launcher source pin is `8e07c3583909c9ab9da94d883e87add1ae90832d`.

The [trust assumptions](https://github.com/brave/near-verifier/blob/72a1a994f3ab44c00ed4747398c68d38ac46bffa/README.md#trust-assumptions)
also distinguish verified NEAR-authored images from model runtimes and third-party
sidecars that receive different or no source verification. We cannot describe
all model/runtime images as fully provenance-verified and reproduced merely
because a tool runs successfully.

## Actual result for our image

See [the captured diagnostic](../artifacts/launcher-provenance-verification.json).
It invokes Brave's unmodified `verify_image_full` function for:

```text
nearaidev/compose-manager-launcher@sha256:079a14b41deb11e0e27f9b69648e8b3d89bd6fb9ccf6071643b8f447fa415085
```

| Check                                  | Result                            |
| -------------------------------------- | --------------------------------- |
| Image digest                           | Explicitly pinned                 |
| Launcher rebuild exemption             | Present in Brave's policy         |
| SLSA provenance found                  | False                             |
| SLSA provenance verified               | False                             |
| Reproducible rebuild                   | Not performed; launcher exemption |
| Complete service verification          | Not performed by this diagnostic  |
| API key supplied / inference purchased | Neither                           |

A separate cosign v3.0.6 invocation returned `no matching attestations`, exit 1.
The diagnostic exits 2 when provenance is unverified. Python returning normally
does not constitute a verification pass. This is a targeted prerequisite check,
not a complete Brave service attestation or a replacement for our gateway/model
hardware and exact-response-signature verification.

## Reproduce the diagnostic

The optional audit tools stay in ignored `.data`; they are not production
dependencies. Use Python 3.11+, Poetry, Git and Node 24. Clone the verifier at
the audited revision and install its locked main dependencies:

```sh
git clone https://github.com/brave/near-verifier.git .data/tee-gates/brave-near-verifier
git -C .data/tee-gates/brave-near-verifier checkout 72a1a994f3ab44c00ed4747398c68d38ac46bffa
cd .data/tee-gates/brave-near-verifier
POETRY_VIRTUALENVS_IN_PROJECT=true poetry install --only main --no-interaction
cd ../../..
```

From that directory, return to the repository root before running the probe.
Install the official [cosign v3.0.6 Linux AMD64 binary](https://github.com/sigstore/cosign/releases/tag/v3.0.6)
at `.data/tee-gates/bin/cosign`, make it executable, and verify its SHA-256:

```text
c956e5dfcac53d52bcf058360d579472f0c1d2d9b69f55209e256fe7783f4c74
```

```sh
npm run probe:launcher
```

The probe refuses changed tracked verifier source, another revision, or a
different cosign binary. Its child receives no API keys, AWS credentials or S3
bucket configuration. Pre-verification cache reuse is disabled. This specific
image's policy excludes rebuilding, so no vendor Docker build runs. A full Brave
service run has additional requirements, including its pinned Compose version
and potentially lengthy rebuilds; this command does not claim to perform one.

## Approval decision

NEAR's [image-provenance guidance](https://docs.near.ai/cloud/verification/cloud-api/image-provenance)
treats missing required provenance as unverified. We can publish successful
subchecks alongside that result, but overall deployment approval remains false.
A digest pin alone establishes an explicit trust choice; it does not supply the
missing signed build-to-source binding.

Keep the existing inference gate closed until the exact digest's provenance can
be verified and the deployment reviewed, or a reviewed replacement deployment is
available. Neither this diagnostic nor its exit code installs measurements or
authorizes a paid request. The provider request remains in
[TEE_APPROVAL_HANDOFF.md](TEE_APPROVAL_HANDOFF.md).
