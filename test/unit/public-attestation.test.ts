import { constants, generateKeyPairSync, sign } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  INTEL_CERTS,
  INTEL_ISSUER,
  verifyPublicGatewayToken,
} from '../../scripts/probe-attestation.js';

const keys = generateKeyPairSync('rsa', { modulusLength: 2048 });
const jwks = {
  keys: [
    { ...keys.publicKey.export({ format: 'jwk' }), kid: 'LOCAL_TEST_KEY', alg: 'PS384' },
    { ...keys.publicKey.export({ format: 'jwk' }), kid: 'UNRELATED_RS256_KEY', alg: 'RS256' },
  ],
};
const nonce = 'aa'.repeat(32),
  now = 1793108500;
const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
function fixture(change: (claims: any) => void = () => {}) {
  const claims = {
    iss: INTEL_ISSUER,
    iat: now,
    nbf: now,
    exp: now + 300,
    tdx: {
      attester_type: 'TDX',
      attester_tcb_status: 'UpToDate',
      dbgstat: 'disabled',
      tdx_is_debuggable: false,
      tdx_td_attributes_debug: false,
      tdx_mrconfigid: `01${'bb'.repeat(32)}${'00'.repeat(15)}`,
      tdx_mrtd: 'cc'.repeat(48),
      attester_runtime_data: {
        caller_nonce: nonce,
        signing_algo: 'ecdsa',
        signing_address: `0x${'11'.repeat(20)}`,
      },
    },
  };
  change(claims);
  const bytes = `${encode({ alg: 'PS384', typ: 'JWT', kid: 'LOCAL_TEST_KEY', jku: INTEL_CERTS })}.${encode(claims)}`;
  const signature = sign('sha384', Buffer.from(bytes), {
    key: keys.privateKey,
    padding: constants.RSA_PKCS1_PSS_PADDING,
    saltLength: 48,
  });
  return {
    nonce,
    jwks_url: INTEL_CERTS,
    gateway: { token: `${bytes}.${signature.toString('base64url')}`, token_signing_alg: 'PS384' },
  };
}
describe('public gateway diagnostic evidence', () => {
  it('verifies a locally signed fixture while keeping deployment and model approval false', () => {
    expect(verifyPublicGatewayToken(fixture(), jwks, nonce, now)).toMatchObject({
      signatureVerified: true,
      freshNonceVerified: true,
      deploymentMeasurementApproved: false,
      modelInferenceVerified: false,
    });
  });
  it('rejects a replaced signature', () => {
    const envelope = fixture();
    envelope.gateway.token =
      envelope.gateway.token.split('.').slice(0, 2).join('.') +
      '.' +
      Buffer.alloc(256).toString('base64url');
    expect(() => verifyPublicGatewayToken(envelope, jwks, nonce, now)).toThrow('signature');
  });
  it('rejects a nonce echoed outside the signed claims', () => {
    expect(() =>
      verifyPublicGatewayToken(
        fixture((c) => (c.tdx.attester_runtime_data.caller_nonce = 'dd'.repeat(32))),
        jwks,
        nonce,
        now,
      ),
    ).toThrow();
  });
  it('rejects expired, future or stale signed tokens', () => {
    for (const mutate of [
      (c: any) => (c.exp = now),
      (c: any) => (c.nbf = now + 60),
      (c: any) => (c.iat = now - 301),
    ])
      expect(() => verifyPublicGatewayToken(fixture(mutate), jwks, nonce, now)).toThrow();
  });
  it('rejects untrusted issuers/key URLs and unsafe platform claims', () => {
    for (const mutate of [
      (c: any) => (c.iss = 'https://attacker.invalid'),
      (c: any) => (c.tdx.tdx_is_debuggable = true),
      (c: any) => (c.tdx.attester_tcb_status = 'OutOfDate'),
      (c: any) => (c.tdx.attester_advisory_ids = ['INTEL-SA-TEST']),
    ])
      expect(() => verifyPublicGatewayToken(fixture(mutate), jwks, nonce, now)).toThrow();
    expect(() =>
      verifyPublicGatewayToken(
        { ...fixture(), jwks_url: 'https://attacker.invalid/certs' },
        jwks,
        nonce,
        now,
      ),
    ).toThrow();
  });
});
