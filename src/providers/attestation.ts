import { createHash } from 'node:crypto';
import { getCollateralAndVerify, type VerifiedReport } from '@phala/dcap-qvl';
import { recoverMessageAddress, type Hex } from 'viem';
import { z } from 'zod';
import { sha256, DomainError } from '../domain.js';
import { httpJson, type Fetch } from './http.js';
import { verifyNrasVerdict } from './nras.js';

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
  tls_cert_fingerprint: z
    .string()
    .regex(/^[a-fA-F0-9]{64}$/)
    .optional(),
  compose_manager_attestation: z.unknown().optional(),
});
const ManagerReport = z.object({
  actions: z.array(z.record(z.string(), z.union([z.string(), z.array(z.string())]))).max(10000),
  actions_hash: z.string().regex(/^[a-fA-F0-9]{64}$/),
  nonce: z.string(),
  quote: hex,
  event_log: z.unknown(),
  report_data: hex.optional(),
});
export type DeploymentActions = z.infer<typeof ManagerReport>['actions'];
export type NearReport = z.infer<typeof Report>;
export interface VerifiedIdentity {
  signer: string;
  algorithm: 'ecdsa';
  composeHash: string;
  nonce: string;
  tcbStatus: string;
  gpuVerified: boolean;
  tlsSpkiSha256?: string;
  composeManagerActionsHash?: string;
}
export interface AttestationInspection {
  identity: VerifiedIdentity;
  appCompose: string;
  composeManagerActions?: DeploymentActions;
  deploymentApproved: false;
}
/** Compose Manager's UTF-8 lexical field order; retain unknown action fields. */
export function deploymentActionsHash(actions: DeploymentActions): string {
  return sha256(
    `[${actions
      .map(
        (action) =>
          `{${Object.entries(action)
            .sort(([a], [b]) => Buffer.compare(Buffer.from(a), Buffer.from(b)))
            .map(([key, value]) => `${JSON.stringify(key)}:${JSON.stringify(value)}`)
            .join(',')}}`,
      )
      .join(',')}]`,
  );
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
    peerSpkiSha256?: string,
    allowedActionsHashes: string[] = [],
  ): Promise<VerifiedIdentity> {
    const inspected = await this.inspect(raw, nonce, requireGpu, peerSpkiSha256);
    if (!allowedComposeHashes.includes(inspected.identity.composeHash))
      throw new DomainError('TEE_MEASUREMENT', 'Configuration is not independently approved');
    if (
      inspected.identity.composeManagerActionsHash &&
      !allowedActionsHashes.includes(inspected.identity.composeManagerActionsHash)
    )
      throw new DomainError(
        'TEE_DEPLOYMENT_ACTIONS',
        'Deployment action log is not independently approved',
      );
    return inspected.identity;
  }
  /** Hardware authentication only. This deliberately cannot approve deployment policy. */
  async inspect(
    raw: unknown,
    nonce: string,
    requireGpu: boolean,
    peerSpkiSha256?: string,
  ): Promise<AttestationInspection> {
    const report = Report.parse(raw);
    if (!/^[a-f0-9]{64}$/.test(nonce) || report.request_nonce.toLowerCase() !== nonce)
      throw new DomainError('TEE_NONCE', 'Attestation nonce mismatch');
    if (
      (report.tls_cert_fingerprint && !requireGpu && !peerSpkiSha256) ||
      (requireGpu && peerSpkiSha256)
    )
      throw new DomainError(
        'TEE_TLS_SCOPE',
        'Unexpected TLS binding; same-connection verification is required for that mode',
      );
    if (
      peerSpkiSha256 !== undefined &&
      (!/^[a-f0-9]{64}$/.test(peerSpkiSha256) ||
        report.tls_cert_fingerprint?.toLowerCase() !== peerSpkiSha256 ||
        !report.report_data)
    )
      throw new DomainError('TEE_TLS_BINDING', 'Attestation does not match the observed TLS peer');
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
    // Models may bind their upstream SPKI too. Check the quote commitment,
    // without claiming that SPKI was observed on the client connection.
    const reportedSpki = report.tls_cert_fingerprint?.toLowerCase();
    const boundSigner = reportedSpki
      ? bytes(sha256(Buffer.concat([bytes(report.signing_address), bytes(reportedSpki)])))
      : Buffer.concat([bytes(report.signing_address), Buffer.alloc(12)]);
    const expected = Buffer.concat([boundSigner, bytes(nonce)]);
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
    if (!replayRtmr3(report.event_log).equals(Buffer.from(td.rtMr3)))
      throw new DomainError('TEE_RTMR', 'Event log does not reproduce RTMR3');
    // This measured bootstrap can launch new workloads. A stripped action report
    // must not turn a dynamic deployment back into a static compose-only policy.
    if (
      info.app_compose.includes('nearaidev/compose-manager') &&
      !report.compose_manager_attestation
    )
      throw new DomainError(
        'TEE_DEPLOYMENT_MISSING',
        'Compose Manager deployment evidence is required',
      );
    let manager: z.infer<typeof ManagerReport> | undefined;
    if (report.compose_manager_attestation !== undefined) {
      manager = ManagerReport.parse(report.compose_manager_attestation);
      if (manager.nonce.toLowerCase() !== nonce)
        throw new DomainError('TEE_DEPLOYMENT_NONCE', 'Deployment log nonce mismatch');
      const verifiedManager = await this.verifyQuote(bytes(manager.quote));
      if (verifiedManager.status !== 'UpToDate' || verifiedManager.advisory_ids.length)
        throw new DomainError(
          'TEE_DEPLOYMENT_TCB',
          'Unaccepted deployment platform security status',
        );
      const managerTd =
        verifiedManager.report.asTd10() ??
        verifiedManager.report.asTd15()?.base ??
        verifiedManager.report.asTd15Ex()?.base.base;
      if (!managerTd || (managerTd.tdAttributes[0] ?? 1) & 1)
        throw new DomainError('TEE_DEPLOYMENT_DEBUG', 'Expected a non-debug deployment TDX report');
      const actionsHash = deploymentActionsHash(manager.actions);
      const managerExpected = Buffer.concat([bytes(actionsHash), bytes(nonce)]);
      if (
        actionsHash !== manager.actions_hash.toLowerCase() ||
        !Buffer.from(managerTd.reportData).equals(managerExpected) ||
        (manager.report_data !== undefined && !bytes(manager.report_data).equals(managerExpected))
      )
        throw new DomainError(
          'TEE_DEPLOYMENT_BINDING',
          'Quote does not bind the deployment actions and nonce',
        );
      if (!Buffer.from(managerTd.mrConfigId).equals(mrConfig))
        throw new DomainError(
          'TEE_DEPLOYMENT_COMPOSE',
          'Deployment log configuration does not match model configuration',
        );
      if (!replayRtmr3(manager.event_log).equals(Buffer.from(managerTd.rtMr3)))
        throw new DomainError(
          'TEE_DEPLOYMENT_RTMR',
          'Deployment event log does not reproduce RTMR3',
        );
    }
    let gpuVerified = false;
    if (requireGpu && !report.nvidia_payload)
      throw new DomainError('TEE_GPU_MISSING', 'Model GPU evidence is required');
    if (report.nvidia_payload) {
      const payload = z
        .object({
          nonce: z.string(),
          evidence_list: z.array(z.unknown()).min(1).max(32),
        })
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
      verifyNrasVerdict(result, nonce, payload.evidence_list.length);
      gpuVerified = true;
    }
    return {
      identity: {
        signer: report.signing_address.toLowerCase(),
        algorithm: 'ecdsa',
        composeHash,
        nonce,
        tcbStatus: verified.status,
        gpuVerified,
        ...(peerSpkiSha256 ? { tlsSpkiSha256: peerSpkiSha256 } : {}),
        ...(manager ? { composeManagerActionsHash: manager.actions_hash.toLowerCase() } : {}),
      },
      appCompose: info.app_compose,
      ...(manager ? { composeManagerActions: manager.actions } : {}),
      deploymentApproved: false,
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
