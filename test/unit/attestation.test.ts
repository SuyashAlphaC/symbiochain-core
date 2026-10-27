import { describe, it, expect } from 'vitest';
import { privateKeyToAccount } from 'viem/accounts';
import {
  replayRtmr3,
  verifyResponseSignature,
  type VerifiedIdentity,
} from '../../src/providers/attestation.js';
import { sha256 } from '../../src/domain.js';
const key = privateKeyToAccount(`0x${'11'.repeat(32)}`);
const identity: VerifiedIdentity = {
  signer: key.address.toLowerCase(),
  algorithm: 'ecdsa',
  composeHash: 'aa'.repeat(32),
  nonce: 'bb'.repeat(32),
  tcbStatus: 'UpToDate',
  gpuVerified: true,
};
describe('exact-byte attested response binding', () => {
  it('accepts a model signature and rejects response-byte or model substitution', async () => {
    const request = Buffer.from('{"model":"canonical/model"}'),
      response = Buffer.from('{"id":"completion"}');
    const text = `canonical/model:${sha256(request)}:${sha256(response)}`;
    const signature = {
      signature_kind: 'provider_tee',
      signing_algo: 'ecdsa',
      signing_address: key.address,
      text,
      signature: await key.signMessage({ message: text }),
    };
    expect(
      (
        await verifyResponseSignature(signature, request, response, 'canonical/model', identity, [
          identity,
        ])
      ).kind,
    ).toBe('provider_tee');
    await expect(
      verifyResponseSignature(
        signature,
        request,
        Buffer.concat([response, Buffer.from(' ')]),
        'canonical/model',
        identity,
        [identity],
      ),
    ).rejects.toThrow('exact request');
    await expect(
      verifyResponseSignature(signature, request, response, 'different/model', identity, [
        identity,
      ]),
    ).rejects.toThrow('exact request');
  });
  it('rejects unknown signers and ambiguous duplicate identities', async () => {
    const request = Buffer.from('a'),
      response = Buffer.from('b'),
      text = `m:${sha256(request)}:${sha256(response)}`;
    const signature = {
      signature_kind: 'provider_tee',
      signing_algo: 'ecdsa',
      signing_address: key.address,
      text,
      signature: await key.signMessage({ message: text }),
    };
    await expect(
      verifyResponseSignature(signature, request, response, 'm', identity, []),
    ).rejects.toThrow('exactly one');
    await expect(
      verifyResponseSignature(signature, request, response, 'm', identity, [identity, identity]),
    ).rejects.toThrow('exactly one');
  });
  it('does not trust a supplied event digest over the event payload', () => {
    expect(replayRtmr3([])).toEqual(Buffer.alloc(48));
    expect(() =>
      replayRtmr3([
        { imr: 3, event_type: 1, event: 'app', event_payload: 'abcd', digest: '00'.repeat(48) },
      ]),
    ).toThrow('digest mismatch');
    expect(
      replayRtmr3([{ imr: 3, event_type: 1, event: 'app', event_payload: 'abcd' }]),
    ).not.toEqual(replayRtmr3([{ imr: 3, event_type: 1, event: 'app', event_payload: 'abce' }]));
  });
});
