import { describe, it, expect, vi } from 'vitest';
import type { VerifiedReport } from '@phala/dcap-qvl';
import { HardwareVerifier } from '../../src/providers/attestation.js';
import { sha256 } from '../../src/domain.js';
import type { Fetch } from '../../src/providers/http.js';
const nonce = 'bb'.repeat(32),
  signer = `0x${'11'.repeat(20)}`,
  compose = '{"services":{"model":"reviewed-image"}}',
  measurement = sha256(compose);
function fixture() {
  const td = {
    tdAttributes: Buffer.alloc(8),
    reportData: Buffer.concat([
      Buffer.from(signer.slice(2), 'hex'),
      Buffer.alloc(12),
      Buffer.from(nonce, 'hex'),
    ]),
    mrConfigId: Buffer.concat([
      Buffer.from([1]),
      Buffer.from(measurement, 'hex'),
      Buffer.alloc(15),
    ]),
    rtMr3: Buffer.alloc(48),
  };
  const verified = {
    status: 'UpToDate',
    advisory_ids: [],
    report: { asTd10: () => td, asTd15: () => undefined, asTd15Ex: () => undefined },
  };
  const report = {
    intel_quote: '010203',
    signing_address: signer,
    signing_algo: 'ecdsa',
    request_nonce: nonce,
    event_log: [],
    info: { tcb_info: { app_compose: compose } },
  };
  const verifier = new HardwareVerifier(async () => verified as unknown as VerifiedReport);
  return { td, verified, report, verifier };
}

// NRAS replies over authenticated HTTPS with a detached EAT: a platform JWT
// followed by a map of GPU JWTs. These unsigned tokens are transport fixtures.
function gpuFixture() {
  const f = fixture();
  const now = Math.floor(Date.now() / 1000);
  const common = {
    iss: 'https://nras.attestation.nvidia.com',
    eat_nonce: nonce,
    iat: now - 1,
    nbf: now - 1,
    exp: now + 3600,
  };
  const gpuClaims: Record<string, unknown> = {
    ...common,
    ueid: 'fixture-gpu',
    hwmodel: 'GH100',
    secboot: true,
    dbgstat: 'disabled',
    measres: 'success',
    'x-nvidia-attestation-warning': null,
  };
  for (const flag of [
    'driver-rim-schema-validated',
    'driver-rim-signature-verified',
    'driver-rim-cert-validated',
    'driver-rim-fetched',
    'driver-rim-measurements-available',
    'vbios-rim-schema-validated',
    'vbios-rim-signature-verified',
    'vbios-rim-cert-validated',
    'vbios-rim-fetched',
    'vbios-rim-measurements-available',
    'vbios-index-no-conflict',
    'attestation-report-parsed',
    'attestation-report-nonce-match',
    'attestation-report-cert-chain-validated',
    'attestation-report-signature-verified',
    'arch-check',
  ])
    gpuClaims[`x-nvidia-gpu-${flag}`] = true;
  const token = (claims: unknown) =>
    `${Buffer.from('{"alg":"ES384"}').toString('base64url')}.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.fixture`;
  const platform: Record<string, unknown> = {
    ...common,
    sub: 'NVIDIA-PLATFORM-ATTESTATION',
    'x-nvidia-ver': '2.0',
    'x-nvidia-overall-att-result': true,
  };
  const payload = {
    nonce,
    arch: 'HOPPER',
    evidence_list: [{ evidence: 'fixture-0' }, { evidence: 'fixture-1' }],
  };
  const report = { ...f.report, nvidia_payload: JSON.stringify(payload) };
  const gpuOverrides: Record<string, Record<string, unknown>> = {};
  const response = (): [['JWT', string], Record<string, string>] => {
    const gpus = {
      'GPU-0': token({ ...gpuClaims, ueid: 'fixture-0', ...gpuOverrides['GPU-0'] }),
      'GPU-1': token({ ...gpuClaims, ueid: 'fixture-1', ...gpuOverrides['GPU-1'] }),
    };
    return [
      [
        'JWT',
        token({
          ...platform,
          submods: Object.fromEntries(
            Object.entries(gpus).map(([id, jwt]) => [id, ['DIGEST', ['SHA-256', sha256(jwt)]]]),
          ),
        }),
      ],
      gpus,
    ];
  };
  const transport = vi.fn<Fetch>(async () => Response.json(response()));
  const verifier = new HardwareVerifier(
    async () => f.verified as unknown as VerifiedReport,
    transport,
  );
  return {
    ...f,
    report,
    payload,
    platform,
    gpuClaims,
    gpuOverrides,
    response,
    transport,
    verifier,
    token,
  };
}
describe('hardware policy over verified quote fields', () => {
  it('binds approved configuration, signer, nonce and replayed event log', async () => {
    const f = fixture();
    const identity = await f.verifier.verify(f.report, nonce, [measurement], false);
    expect(identity.composeHash).toBe(measurement);
    expect(identity.gpuVerified).toBe(false);
  });
  it('rejects nonce replay and an unapproved configuration', async () => {
    const f = fixture();
    await expect(
      f.verifier.verify(f.report, 'cc'.repeat(32), [measurement], false),
    ).rejects.toThrow('nonce mismatch');
    await expect(f.verifier.verify(f.report, nonce, [], false)).rejects.toThrow(
      'independently approved',
    );
  });
  it('rejects debug mode, non-current TCB, changed signer data and altered event measurements', async () => {
    let f = fixture();
    f.td.tdAttributes[0] = 1;
    await expect(f.verifier.verify(f.report, nonce, [measurement], false)).rejects.toThrow('Debug');
    f = fixture();
    f.verified.status = 'OutOfDate';
    await expect(f.verifier.verify(f.report, nonce, [measurement], false)).rejects.toThrow(
      'security status',
    );
    f = fixture();
    f.td.reportData[0] = 0;
    await expect(f.verifier.verify(f.report, nonce, [measurement], false)).rejects.toThrow(
      'signer and nonce',
    );
    f = fixture();
    f.td.rtMr3[0] = 1;
    await expect(f.verifier.verify(f.report, nonce, [measurement], false)).rejects.toThrow('RTMR3');
  });
  it('requires GPU evidence for a model-serving identity', async () => {
    const f = fixture();
    await expect(f.verifier.verify(f.report, nonce, [measurement], true)).rejects.toThrow(
      'GPU evidence is required',
    );
  });
  it('accepts the documented NRAS platform tuple and per-GPU token map', async () => {
    const f = gpuFixture();
    const identity = await f.verifier.verify(f.report, nonce, [measurement], true);
    expect(identity.gpuVerified).toBe(true);
    expect(f.transport).toHaveBeenCalledOnce();
    const [url, init] = f.transport.mock.calls[0]!;
    expect(url).toBe('https://nras.attestation.nvidia.com/v3/attest/gpu');
    expect(JSON.parse(String(init!.body))).toEqual(f.payload);
  });
  it.each([
    ['overall nonce', 'platform', { eat_nonce: 'cc'.repeat(32) }],
    ['GPU nonce', 'gpu', { eat_nonce: 'cc'.repeat(32) }],
    ['overall expiry', 'platform', { exp: 1 }],
    ['GPU expiry', 'gpu', { exp: 1 }],
    ['future issuance', 'platform', { iat: 9999999999 }],
    ['future GPU validity', 'gpu', { nbf: 9999999999 }],
    ['overall issuer', 'platform', { iss: 'https://untrusted.example' }],
    ['GPU issuer', 'gpu', { iss: 'https://untrusted.example' }],
    ['overall verdict', 'platform', { 'x-nvidia-overall-att-result': false }],
    ['secure boot', 'gpu', { secboot: false }],
    ['debug mode', 'gpu', { dbgstat: 'enabled' }],
    ['measurements', 'gpu', { measres: 'failure' }],
    ['warning', 'gpu', { 'x-nvidia-attestation-warning': 'unaccepted warning' }],
    ['report signature', 'gpu', { 'x-nvidia-gpu-attestation-report-signature-verified': false }],
    ['missing RIM check', 'gpu', { 'x-nvidia-gpu-driver-rim-cert-validated': undefined }],
    ['equipment identity', 'gpu', { ueid: '' }],
  ] as const)(
    'rejects an invalid %s, including on the second GPU',
    async (_name, target, patch) => {
      const f = gpuFixture();
      if (target === 'platform') Object.assign(f.platform, patch);
      else f.gpuOverrides['GPU-1'] = patch;
      await expect(f.verifier.verify(f.report, nonce, [measurement], true)).rejects.toThrow();
    },
  );
  it('rejects a GPU payload nonce mismatch before contacting NVIDIA', async () => {
    const f = gpuFixture();
    f.report.nvidia_payload = JSON.stringify({ ...f.payload, nonce: 'cc'.repeat(32) });
    await expect(f.verifier.verify(f.report, nonce, [measurement], true)).rejects.toThrow(
      'GPU nonce',
    );
    expect(f.transport).not.toHaveBeenCalled();
  });
  it('requires coverage of every submitted GPU and its platform-bound token', async () => {
    const missing = gpuFixture();
    missing.report.nvidia_payload = JSON.stringify({
      ...missing.payload,
      evidence_list: [missing.payload.evidence_list[0]],
    });
    await expect(
      missing.verifier.verify(missing.report, nonce, [measurement], true),
    ).rejects.toThrow('every submitted GPU');
    const changed = gpuFixture();
    changed.transport.mockImplementation(async () => {
      const reply = changed.response();
      reply[1]['GPU-1'] = changed.token({ ...changed.gpuClaims, ueid: 'substituted' });
      return Response.json(reply);
    });
    await expect(
      changed.verifier.verify(changed.report, nonce, [measurement], true),
    ).rejects.toThrow('does not bind');
  });
  it.each(['overall only', 'missing GPU token', 'malformed JWT'])(
    'rejects incomplete or malformed NRAS evidence: %s',
    async (variant) => {
      const f = gpuFixture();
      f.transport.mockImplementation(async () => {
        const reply = f.response();
        if (variant === 'overall only') return Response.json([reply[0]]);
        if (variant === 'missing GPU token') delete reply[1]['GPU-1'];
        else reply[0][1] = 'malformed';
        return Response.json(reply);
      });
      await expect(f.verifier.verify(f.report, nonce, [measurement], true)).rejects.toThrow();
    },
  );
  it('the actual DCAP verifier rejects malformed quote bytes', async () => {
    const f = fixture();
    await expect(
      new HardwareVerifier().verify(f.report, nonce, [measurement], false),
    ).rejects.toThrow();
  });
});
