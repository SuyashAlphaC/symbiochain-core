// Canonical public PAPER viewer contract v1. Frontend copies are generated from this file.
import { z } from 'zod';

const atoms = z.string().regex(/^-?\d{1,78}$/);
const id = z.uuid();
const timestamp = z.iso.datetime();
export const ViewerCursor = z.string().regex(/^\d{1,78}$/);
export const ViewerRole = z.enum(['SCOUT', 'BRAIN', 'HAND']);
export const ViewerSnapshot = z
  .object({
    contractVersion: z.literal(1),
    mode: z.literal('PAPER'),
    capturedAt: timestamp,
    cursor: ViewerCursor,
    treasury: z
      .object({
        asset: z.string().min(1).max(200),
        decimals: z.number().int().min(0).max(24),
        balanceAtoms: atoms,
        availableAtoms: atoms,
        reservedAtoms: atoms,
        grossTradingPnlAtoms: atoms,
        minReserveAtoms: atoms,
      })
      .strict(),
    compute: z
      .object({ inferenceCostUsdMicros: atoms, purchaseImplemented: z.literal(false) })
      .strict(),
    survivalHours: z.null(),
    paused: z.boolean(),
    workers: z
      .array(
        z
          .object({ role: ViewerRole, paused: z.boolean(), heartbeat: timestamp.nullable() })
          .strict(),
      )
      .max(3),
    history: z.array(z.object({ timestamp, balanceAtoms: atoms }).strict()).max(169),
    decisions: z
      .array(
        z
          .object({
            id,
            cycleId: id,
            timestamp,
            agent: ViewerRole,
            action: z.string().max(100),
            details: z.string().max(300),
          })
          .strict(),
      )
      .max(30),
    transactions: z
      .array(
        z
          .object({
            id,
            cycleId: id,
            timestamp,
            txHash: z.string().max(200),
            chainId: z.string().max(80),
            amountAtoms: atoms,
            asset: z.string().max(200),
            decimals: z.number().int().min(0).max(24).nullable(),
            status: z.literal('SIMULATED'),
          })
          .strict(),
      )
      .max(30),
    receipts: z
      .array(
        z
          .object({
            id,
            cycleId: id,
            timestamp,
            mintedOnChain: z.literal(false),
            status: z.literal('SIMULATED'),
            shareBps: z.number().int().min(0).max(10000).nullable(),
            grossPnlAtoms: atoms.nullable(),
            approvedNetPnlAtoms: atoms.nullable(),
            approvalDigest: z
              .string()
              .regex(/^[a-f0-9]{64}$/)
              .nullable(),
          })
          .strict(),
      )
      .max(30),
    events: z
      .array(
        z
          .object({
            seq: ViewerCursor,
            timestamp,
            topic: z.string().min(1).max(100),
            cycleId: id.nullable(),
          })
          .strict(),
      )
      .max(30),
  })
  .strict();
export type ViewerSnapshot = z.infer<typeof ViewerSnapshot>;

export const ViewerProof = z
  .object({
    contractVersion: z.literal(1),
    mode: z.literal('PAPER'),
    scope: z.literal('RECORDED_VERIFICATION'),
    freshAttestationPerformed: z.literal(false),
    id,
    model: z.string().max(200).nullable(),
    signer: z.string().max(500).nullable(),
    measurement: z.string().max(500).nullable(),
    requestHash: z.string().max(128).nullable(),
    responseHash: z.string().max(128).nullable(),
    verifiedAt: timestamp.nullable(),
  })
  .strict();
export type ViewerProof = z.infer<typeof ViewerProof>;
