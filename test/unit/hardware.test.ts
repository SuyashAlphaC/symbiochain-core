import { describe, it, expect } from 'vitest';
import type { VerifiedReport } from '@phala/dcap-qvl';
import { HardwareVerifier } from '../../src/providers/attestation.js';
import { sha256 } from '../../src/domain.js';
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
  it('the actual DCAP verifier rejects malformed quote bytes', async () => {
    const f = fixture();
    await expect(
      new HardwareVerifier().verify(f.report, nonce, [measurement], false),
    ).rejects.toThrow();
  });
});
