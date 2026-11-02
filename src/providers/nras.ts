import { z } from 'zod';
import { DomainError, sha256 } from '../domain.js';
import { setTimeout as sleep } from 'node:timers/promises';

const jwt = z.string().regex(/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
const gpuTokens = z.record(z.string().regex(/^GPU-\d+$/), jwt);
const reply = z.tuple([z.tuple([z.literal('JWT'), jwt]), gpuTokens]);
const claims = z
  .object({
    iss: z.literal('https://nras.attestation.nvidia.com'),
    eat_nonce: z.string().regex(/^[a-fA-F0-9]{64}$/),
    iat: z.number().int().nonnegative(),
    exp: z.number().int().positive(),
    nbf: z.number().int().nonnegative().optional(),
  })
  .passthrough();
const platform = claims.extend({
  sub: z.literal('NVIDIA-PLATFORM-ATTESTATION'),
  'x-nvidia-ver': z.literal('2.0'),
  'x-nvidia-overall-att-result': z.literal(true),
  submods: z.record(
    z.string(),
    z.tuple([
      z.literal('DIGEST'),
      z.tuple([z.literal('SHA-256'), z.string().regex(/^[a-fA-F0-9]{64}$/)]),
    ]),
  ),
});
const gpu = claims.extend({
  ueid: z.string().min(1),
  hwmodel: z.string().min(1),
  secboot: z.literal(true),
  dbgstat: z.literal('disabled'),
  measres: z.literal('success'),
  'x-nvidia-attestation-warning': z.null(),
});
const requiredChecks = [
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
];

/** Only accepts a reply fetched directly from the pinned HTTPS NRAS endpoint.
 * Authentication relies on that TLS connection; this is not an offline JWS verifier.
 */
export function verifyNrasVerdict(raw: unknown, nonce: string, expectedGpuCount: number): void {
  try {
    const [[, overallToken], tokens] = reply.parse(raw);
    const decode = (token: string) =>
      JSON.parse(Buffer.from(token.split('.')[1]!, 'base64url').toString('utf8'));
    const now = Math.floor(Date.now() / 1000);
    const checkFreshness = (value: z.infer<typeof claims>) => {
      if (value.eat_nonce.toLowerCase() !== nonce)
        throw new DomainError('TEE_GPU_NONCE', 'NRAS verdict nonce mismatch');
      if (value.exp <= now || value.iat > now || (value.nbf ?? 0) > now || value.exp <= value.iat)
        throw new DomainError('TEE_GPU_TIME', 'NRAS verdict is expired or not yet valid');
    };
    const overall = platform.parse(decode(overallToken));
    checkFreshness(overall);
    const ids = Object.keys(tokens);
    if (
      !Number.isSafeInteger(expectedGpuCount) ||
      expectedGpuCount < 1 ||
      ids.length !== expectedGpuCount ||
      Object.keys(overall.submods).length !== ids.length
    )
      throw new DomainError('TEE_GPU_BINDING', 'NRAS verdict does not cover every submitted GPU');
    for (const id of ids) {
      const token = tokens[id]!;
      if (overall.submods[id]?.[1][1].toLowerCase() !== sha256(token))
        throw new DomainError('TEE_GPU_BINDING', 'NRAS platform does not bind the GPU token');
      const value = gpu.parse(decode(token));
      checkFreshness(value);
      if (requiredChecks.some((flag) => value[`x-nvidia-gpu-${flag}`] !== true))
        throw new DomainError('TEE_GPU_VERDICT', 'GPU security checks did not all pass');
    }
  } catch (error) {
    if (error instanceof DomainError) throw error;
    throw new DomainError('TEE_GPU_VERDICT', 'Malformed or unacceptable NRAS GPU verdict');
  }
}

/** Wait briefly for a near-future authenticated verdict to become valid.
 * Strict time checks stay unchanged; expired and distant-future evidence fails.
 * No additional NRAS request or inference purchase is made.
 */
export async function verifyFreshNrasVerdict(
  raw: unknown,
  nonce: string,
  expectedGpuCount: number,
  wait: (ms: number) => Promise<unknown> = sleep,
): Promise<void> {
  try {
    verifyNrasVerdict(raw, nonce, expectedGpuCount);
    return;
  } catch (error) {
    if (!(error instanceof DomainError) || error.code !== 'TEE_GPU_TIME') throw error;
    const [[, overall], tokens] = reply.parse(raw);
    const times = [overall, ...Object.values(tokens)].map((token) =>
      claims.parse(JSON.parse(Buffer.from(token.split('.')[1]!, 'base64url').toString('utf8'))),
    );
    const validAt = Math.max(...times.map((c) => Math.max(c.iat, c.nbf ?? 0))) * 1000;
    const delay = validAt - Date.now() + 25;
    if (delay <= 0 || delay > 3000 || times.some((c) => c.exp * 1000 <= validAt)) throw error;
    await wait(delay);
    verifyNrasVerdict(raw, nonce, expectedGpuCount);
  }
}
