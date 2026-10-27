import assert from 'node:assert/strict';
import { constants, createPublicKey, randomBytes, verify } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { z } from 'zod';
import { httpJson } from '../src/providers/http.js';

export const INTEL_ISSUER = 'https://portal.trustauthority.intel.com';
export const INTEL_CERTS = `${INTEL_ISSUER}/certs`;
const hexadecimal = (length: number) => z.string().regex(new RegExp(`^[a-fA-F0-9]{${length}}$`));

/** Diagnostic evidence only. This never authorizes inference or changes measurement allowlists. */
export function verifyPublicGatewayToken(
  input: unknown,
  keys: unknown,
  nonce: string,
  now = Math.floor(Date.now() / 1000),
) {
  hexadecimal(64).parse(nonce);
  const envelope = z
    .object({
      nonce: z.string(),
      jwks_url: z.literal(INTEL_CERTS),
      gateway: z.object({ token: z.string(), token_signing_alg: z.literal('PS384') }),
    })
    .parse(input);
  assert.equal(envelope.nonce, nonce, 'Envelope nonce mismatch');
  const parts = envelope.gateway.token.split('.');
  assert.equal(parts.length, 3, 'Malformed JWT');
  const decode = (part: string) => JSON.parse(Buffer.from(part, 'base64url').toString('utf8'));
  const header = z
    .object({
      alg: z.literal('PS384'),
      typ: z.literal('JWT'),
      kid: z.string().min(1),
      jku: z.literal(INTEL_CERTS).optional(),
    })
    .parse(decode(parts[0]!));
  const jwks = z.object({ keys: z.array(z.record(z.string(), z.unknown())).min(1) }).parse(keys);
  const matches = jwks.keys.filter((key) => key.kid === header.kid);
  assert.equal(matches.length, 1, 'Signing key is missing or ambiguous');
  const key = z
    .object({
      kty: z.literal('RSA'),
      alg: z.literal('PS384').optional(),
      n: z.string().min(1),
      e: z.string().min(1),
    })
    .parse(matches[0]);
  const publicKey = createPublicKey({ key: { ...key, alg: 'PS384' }, format: 'jwk' });
  assert.ok((publicKey.asymmetricKeyDetails?.modulusLength ?? 0) >= 2048, 'Weak signing key');
  assert.ok(
    verify(
      'sha384',
      Buffer.from(`${parts[0]}.${parts[1]}`),
      {
        key: publicKey,
        padding: constants.RSA_PKCS1_PSS_PADDING,
        saltLength: 48,
      },
      Buffer.from(parts[2]!, 'base64url'),
    ),
    'Invalid Intel signature',
  );
  const claims = z
    .object({
      iss: z.literal(INTEL_ISSUER),
      iat: z.number().int(),
      nbf: z.number().int(),
      exp: z.number().int(),
      tdx: z.object({
        attester_type: z.literal('TDX'),
        attester_tcb_status: z.literal('UpToDate'),
        attester_advisory_ids: z.array(z.string()).max(0).optional(),
        dbgstat: z.literal('disabled'),
        tdx_is_debuggable: z.literal(false),
        tdx_td_attributes_debug: z.literal(false),
        tdx_mrconfigid: hexadecimal(96),
        tdx_mrtd: hexadecimal(96),
        attester_runtime_data: z.object({
          caller_nonce: z.literal(nonce),
          signing_algo: z.literal('ecdsa'),
          signing_address: z.string().regex(/^0x[a-fA-F0-9]{40}$/),
        }),
      }),
    })
    .parse(decode(parts[1]!));
  assert.ok(claims.exp > now && claims.nbf <= now + 30, 'Token is expired or not yet valid');
  assert.ok(claims.iat <= now + 30 && claims.iat >= now - 300, 'Token is not fresh');
  assert.ok(
    claims.iat <= claims.exp && claims.nbf <= claims.exp && claims.exp - claims.iat <= 600,
    'Invalid token lifetime',
  );
  assert.match(
    claims.tdx.tdx_mrconfigid,
    /^01[a-fA-F0-9]{64}0{30}$/,
    'Unexpected compose measurement format',
  );
  return {
    method: 'INTEL_TRUST_AUTHORITY_GATEWAY_ONLY',
    verifiedAt: new Date(now * 1000).toISOString(),
    issuedAt: new Date(claims.iat * 1000).toISOString(),
    expiresAt: new Date(claims.exp * 1000).toISOString(),
    signatureVerified: true,
    freshNonceVerified: true,
    tcbStatus: claims.tdx.attester_tcb_status,
    debugEnabled: false,
    signer: claims.tdx.attester_runtime_data.signing_address,
    observedComposeHash: claims.tdx.tdx_mrconfigid.slice(2, 66).toLowerCase(),
    deploymentMeasurementApproved: false,
    modelInferenceVerified: false,
  };
}

async function main() {
  const nonce = randomBytes(32).toString('hex');
  const source = new URL('https://cloud-api.near.ai/v1/attestation/ita-token');
  source.searchParams.set('nonce', nonce);
  source.searchParams.set('signing_algo', 'ecdsa');
  source.searchParams.set('include_tls_fingerprint', 'false');
  const envelope = await httpJson(source, { redirect: 'error' });
  // Pin the trust anchor. Never fetch a key URL selected by the response or JWT header.
  const keys = await httpJson(INTEL_CERTS, { redirect: 'error' });
  const verification = verifyPublicGatewayToken(envelope, keys, nonce);
  const artifact = {
    version: 1,
    source: source.toString(),
    capturedAt: new Date().toISOString(),
    evidence: { envelope, keys },
    verification,
    disclosure:
      'Public gateway ITA token verified at capture time. No model call, inference attestation, approved deployment measurement, wallet operation or payment. This does not exercise the production DCAP verifier or authorize LIVE.',
  };
  await writeFile(
    'artifacts/public-attestation-probe.json',
    JSON.stringify(artifact, null, 2) + '\n',
  );
  console.log(
    JSON.stringify(
      { ...verification, artifact: 'artifacts/public-attestation-probe.json' },
      null,
      2,
    ),
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href)
  await main();
