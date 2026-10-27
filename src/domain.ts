import { createHash } from 'node:crypto';
import { z } from 'zod';

export const Mode = z.enum(['PAPER', 'LIVE', 'REPLAY']);
export type Mode = z.infer<typeof Mode>;
export const atoms = z
  .string()
  .regex(/^(0|[1-9]\d{0,76})$/, 'Expected an unsigned integer in atomic units');
export const positiveAtoms = atoms.refine((v) => BigInt(v) > 0n, 'Amount must be positive');
export const eventCursor = atoms.refine(
  (v) => BigInt(v) <= 9223372036854775807n,
  'Cursor exceeds the event sequence range',
);
export const idSchema = z.string().uuid();
export const Proposal = z
  .object({
    strategy: z.literal('round-trip'),
    originChain: z.string().min(3).max(80),
    destinationChain: z.string().min(3).max(80),
    originAsset: z.string().min(1).max(200),
    intermediateAsset: z.string().min(1).max(200),
    amountAtoms: positiveAtoms,
    recipient: z.string().min(2).max(128),
    refundTo: z.string().min(2).max(128),
    slippageBps: z.number().int().min(0).max(1000),
    expiresAt: z.iso.datetime(),
  })
  .strict();
export type Proposal = z.infer<typeof Proposal>;

export const Quote = z
  .object({
    id: z.string(),
    inputAtoms: positiveAtoms,
    expectedOutputAtoms: positiveAtoms,
    minimumOutputAtoms: positiveAtoms,
    costsAtoms: atoms,
    expiresAt: z.iso.datetime(),
    routeDigest: z.string().regex(/^[a-f0-9]{64}$/),
    route: z.record(z.string(), z.unknown()),
  })
  .strict();
export type Quote = z.infer<typeof Quote>;

export const Assessment = z
  .object({
    execute: z.boolean(),
    reason: z.string().min(1).max(2000),
    maxSlippageBps: z.number().int().min(0).max(1000),
    proposalDigest: z.string().regex(/^[a-f0-9]{64}$/),
  })
  .strict();
export type Assessment = z.infer<typeof Assessment>;

export interface ProofResult {
  kind: 'PAPER' | 'NEAR_AI';
  status: 'SIMULATED' | 'VERIFIED';
  model: string;
  requestHash: string;
  responseHash: string;
  signer: string | null;
  measurement: string | null;
  evidence: unknown;
  publicDetails: Record<string, unknown>;
}
export interface Usage {
  requestId: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  costUsdMicros: string;
  billingSource: string;
}
export interface BrainResult {
  assessment: Assessment;
  proof: ProofResult;
  usage: Usage;
}
export interface PreparedExecution {
  id: string;
  chainId: string;
  txHash: string;
  operation: string;
  asset: string;
  amountAtoms: string;
  data: Record<string, unknown>;
}
export interface Settlement {
  status: 'PENDING' | 'SUCCESS' | 'REFUNDED' | 'UNKNOWN';
  receivedAtoms: string;
  feesAtoms: string;
  transactions: Array<{
    chainId: string;
    txHash: string;
    operation: string;
    asset: string;
    amountAtoms: string;
    status: string;
  }>;
  evidence: Record<string, unknown>;
}

export function canonical(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  return `{${Object.entries(value as Record<string, unknown>)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`)
    .join(',')}}`;
}
export function digest(value: unknown): string {
  return sha256(canonical(value));
}
export function sha256(value: string | Uint8Array): string {
  return createHash('sha256').update(value).digest('hex');
}
export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
export function netProfit(quote: Quote): bigint {
  return BigInt(quote.minimumOutputAtoms) - BigInt(quote.inputAtoms) - BigInt(quote.costsAtoms);
}
export class DomainError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly statusCode = 409,
  ) {
    super(message);
  }
}
export const terminalStates = new Set(['CLOSED', 'REJECTED', 'EXPIRED', 'REFUNDED', 'FAILED']);
export const transitions: Record<string, ReadonlySet<string>> = {
  DISCOVERED: new Set(['QUOTED', 'REJECTED', 'EXPIRED']),
  QUOTED: new Set(['ASSESSED', 'REJECTED', 'EXPIRED']),
  ASSESSED: new Set(['RESERVED', 'REJECTED', 'EXPIRED']),
  RESERVED: new Set(['SUBMITTED', 'REJECTED', 'EXPIRED', 'UNKNOWN']),
  SUBMITTED: new Set(['SETTLING', 'UNKNOWN']),
  SETTLING: new Set(['RECONCILED', 'REFUNDED', 'UNKNOWN']),
  UNKNOWN: new Set(['SETTLING', 'RECONCILED', 'REFUNDED']),
  RECONCILED: new Set(['CLOSED']),
};
export function assertTransition(from: string, to: string): void {
  if (!transitions[from]?.has(to))
    throw new DomainError('INVALID_TRANSITION', `${from} cannot transition to ${to}`);
}
