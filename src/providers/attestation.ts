import { createHash } from 'node:crypto';
import { getCollateralAndVerify, type VerifiedReport } from '@phala/dcap-qvl';
import { recoverMessageAddress, type Hex } from 'viem';
import { z } from 'zod';
import { sha256, DomainError } from '../domain.js';
import { httpJson, type Fetch } from './http.js';

const hex = z
  .string()
  .regex(/^(0x)?[a-fA-F0-9]*$/)
  .refine((s) => s.replace(/^0x/, '').length % 2 === 0);
const Report = z.object({
  intel_quote: hex,
  signing_address: z.string().regex(/^0x[a-fA-F0-9]{40}$/),
  signing_algo: z.literal('ecdsa'),
  request_nonce: hex,
  report_data: hex.optional(),
  event_log: z.unknown(),
  info: z.object({ tcb_info: z.unknown() }),
  nvidia_payload: z.string().optional(),
  tls_cert_fingerprint: z.string().optional(),
});
export type NearReport = z.infer<typeof Report>;
export interface VerifiedIdentity {
  signer: string;
  algorithm: 'ecdsa';
  composeHash: string;
  nonce: string;
  tcbStatus: string;
  gpuVerified: boolean;
}
const bytes = (s: string) => Buffer.from(s.replace(/^0x/, ''), 'hex');
const h384 = (...parts: Uint8Array[]) => {
  const h = createHash('sha384');
  for (const p of parts) h.update(p);
  return h.digest();
};

export function replayRtmr3(input: unknown): Buffer {
  const events = z
    .array(
      z.object({
        imr: z.number().int(),
        event_type: z.number().int().min(0).max(0xffffffff),
        event: z.string(),
        event_payload: hex.nullish(),
        digest: hex.nullish(),
      }),
    )
    .max(10000)
    .parse(typeof input === 'string' ? JSON.parse(input) : input);
  let register = Buffer.alloc(48);
  for (const e of events) {
    if (e.imr !== 3) continue;
    const type = Buffer.alloc(4);
    type.writeUInt32LE(e.event_type);
    const digest = h384(
      type,
      Buffer.from(':'),
      Buffer.from(e.event),
      Buffer.from(':'),
      bytes(e.event_payload ?? ''),
    );
    if (e.digest && !bytes(e.digest).equals(digest))
      throw new DomainError('TEE_EVENT_DIGEST', 'Event log digest mismatch');
    register = h384(register, digest);
  }
  return register;
}

export class HardwareVerifier {
  constructor(
    private readonly verifyQuote: (quote: Buffer) => Promise<VerifiedReport> = (quote) =>
      getCollateralAndVerify(quote),
    private readonly transport: Fetch = fetch,
  ) {}
  async verify(
    raw: unknown,
    nonce: string,
    allowedComposeHashes: string[],
    requireGpu: boolean,
  ): Promise<VerifiedIdentity> {
    const report = Report.parse(raw);
    if (!/^[a-f0-9]{64}$/.test(nonce) || report.request_nonce.toLowerCase() !== nonce)
      throw new DomainError('TEE_NONCE', 'Attestation nonce mismatch');
    if (report.tls_cert_fingerprint)
      throw new DomainError(
        'TEE_TLS_SCOPE',
        'Unexpected TLS binding; same-connection verification is required for that mode',
      );
    const verified = await this.verifyQuote(bytes(report.intel_quote));
    if (verified.status !== 'UpToDate' || verified.advisory_ids.length !== 0)
      throw new DomainError('TEE_TCB', 'Unaccepted platform security status');
    const td =
      verified.report.asTd10() ??
      verified.report.asTd15()?.base ??
      verified.report.asTd15Ex()?.base.base;
    if (!td) throw new DomainError('TEE_TYPE', 'Expected Intel TDX report');
    if ((td.tdAttributes[0] ?? 1) & 1)
      throw new DomainError('TEE_DEBUG', 'Debug enclaves are forbidden');
    const expected = Buffer.concat([bytes(report.signing_address), Buffer.alloc(12), bytes(nonce)]);
    if (!Buffer.from(td.reportData).equals(expected))
      throw new DomainError('TEE_BINDING', 'Quote does not bind signer and nonce');
    if (report.report_data && !bytes(report.report_data).equals(expected))
      throw new DomainError('TEE_ECHO', 'Echoed report data mismatch');
    const info = z
      .object({ app_compose: z.string() })
      .parse(
        typeof report.info.tcb_info === 'string'
          ? JSON.parse(report.info.tcb_info)
          : report.info.tcb_info,
      );
    const composeHash = sha256(info.app_compose);
    const mrConfig = Buffer.concat([Buffer.from([1]), bytes(composeHash), Buffer.alloc(15)]);
    if (!Buffer.from(td.mrConfigId).equals(mrConfig))
      throw new DomainError('TEE_COMPOSE', 'Configuration does not match the verified quote');
    if (!allowedComposeHashes.includes(composeHash))
      throw new DomainError('TEE_MEASUREMENT', 'Configuration is not independently approved');
    if (!replayRtmr3(report.event_log).equals(Buffer.from(td.rtMr3)))
      throw new DomainError('TEE_RTMR', 'Event log does not reproduce RTMR3');
    let gpuVerified = false;
    if (requireGpu && !report.nvidia_payload)
      throw new DomainError('TEE_GPU_MISSING', 'Model GPU evidence is required');
    if (report.nvidia_payload) {
      const payload = z
        .object({ nonce: z.string() })
        .passthrough()
        .parse(JSON.parse(report.nvidia_payload));
      if (payload.nonce.toLowerCase() !== nonce)
        throw new DomainError('TEE_GPU_NONCE', 'GPU nonce mismatch');
      const result = await httpJson(
        'https://nras.attestation.nvidia.com/v3/attest/gpu',
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(payload),
        },
        this.transport,
      );
      const entries = z.array(z.tuple([z.string(), z.string()])).parse(result);
      const jwt = entries.find((e) => e[0] === 'JWT')?.[1];
      if (!jwt)
        throw new DomainError('TEE_GPU_VERDICT', 'NRAS did not return an attestation verdict');
      const claims = JSON.parse(
        Buffer.from(jwt.split('.')[1] ?? '', 'base64url').toString('utf8'),
      ) as Record<string, unknown>;
      if (claims['x-nvidia-overall-att-result'] !== true)
        throw new DomainError('TEE_GPU_VERDICT', 'GPU attestation failed');
      gpuVerified = true;
    }
    return {
      signer: report.signing_address.toLowerCase(),
      algorithm: 'ecdsa',
      composeHash,
      nonce,
      tcbStatus: verified.status,
      gpuVerified,
    };
  }
}

const Signature = z.object({
  signature_kind: z.enum(['provider_tee', 'gateway']),
  signing_algo: z.literal('ecdsa'),
  signing_address: z.string().regex(/^0x[a-fA-F0-9]{40}$/),
  text: z.string(),
  signature: z.string().regex(/^0x[a-fA-F0-9]{130}$/),
});
export async function verifyResponseSignature(
  raw: unknown,
  request: Buffer,
  response: Buffer,
  model: string,
  gateway: VerifiedIdentity,
  models: VerifiedIdentity[],
): Promise<{ signer: string; kind: string; identity: VerifiedIdentity }> {
  const s = Signature.parse(raw);
  const candidates = s.signature_kind === 'provider_tee' ? models : [gateway];
  const matches = candidates.filter(
    (i) => i.signer === s.signing_address.toLowerCase() && i.algorithm === s.signing_algo,
  );
  if (matches.length !== 1)
    throw new DomainError(
      'TEE_SIGNATURE_IDENTITY',
      'Signature must match exactly one preflight identity',
    );
  const expected = `${s.signature_kind === 'provider_tee' ? model + ':' : ''}${sha256(request)}:${sha256(response)}`;
  if (s.text !== expected)
    throw new DomainError(
      'TEE_RESPONSE_BINDING',
      'Signed hashes do not match exact request and response bytes',
    );
  const signer = await recoverMessageAddress({ message: s.text, signature: s.signature as Hex });
  if (signer.toLowerCase() !== s.signing_address.toLowerCase())
    throw new DomainError('TEE_SIGNATURE', 'Invalid response signature');
  return { signer: signer.toLowerCase(), kind: s.signature_kind, identity: matches[0]! };
}
