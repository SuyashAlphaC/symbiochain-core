import { z } from 'zod';
import { atoms, positiveAtoms } from './domain.js';
import { nearHash } from './providers/intent-receipts.js';
export const FundingRequest = z
  .object({
    reservationReference: z.string().regex(/^[a-zA-Z0-9:_-]{1,100}$/),
    minimumNearYocto: positiveAtoms,
  })
  .strict();
export const FundingTerms = z
  .object({
    reservationId: z.uuid(),
    reservationReference: z.string(),
    reference: z.string().max(100),
    payer: z.string(),
    accountant: z.string(),
    treasury: z.string(),
    treasuryCodeHash: nearHash,
    asset: z.string().regex(/^nep141:[a-z0-9._-]+$/),
    amountAtoms: positiveAtoms,
    minimumNearYocto: positiveAtoms,
    maxGasYocto: positiveAtoms,
    minReserveYocto: positiveAtoms,
    slippageBps: z.number().int().min(0).max(1000),
    deadline: z.iso.datetime(),
  })
  .strict();
export type FundingTerms = z.infer<typeof FundingTerms>;
export const SignedFundingIntent = z
  .object({
    standard: z.literal('nep413'),
    payload: z
      .object({
        message: z.string().max(16384),
        nonce: z.string(),
        recipient: z.literal('intents.near'),
      })
      .strict(),
    public_key: z.string(),
    signature: z.string(),
  })
  .strict();
export type SignedFundingIntent = z.infer<typeof SignedFundingIntent>;
export const PreparedFundingCall = z
  .object({
    kind: z.enum(['WITHDRAW', 'DISTRIBUTE']),
    txHash: nearHash,
    signedBase64: z.string(),
    amountNearYocto: positiveAtoms,
    intentNonce: z.string().optional(),
    intentExpiresAt: z.iso.datetime().optional(),
  })
  .strict();
export type PreparedFundingCall = z.infer<typeof PreparedFundingCall>;
export interface FinalFundingCall {
  txHash: string;
  gasYocto: string;
  amountNearYocto: string;
  allocatedYocto: string | null;
  evidenceDigest: string;
}
export interface FundingPorts {
  check(terms: FundingTerms, deposit?: string, gasSpent?: string): Promise<void>;
  quote(terms: FundingTerms): Promise<unknown>;
  signSwap(terms: FundingTerms, quote: unknown): Promise<SignedFundingIntent>;
  swapStatus(
    terms: FundingTerms,
    quote: unknown,
    signed: SignedFundingIntent,
  ): Promise<{
    status: 'PENDING' | 'SUCCESS' | 'REFUNDED';
    creditYocto: string;
    receivedYocto?: string;
    evidenceDigest: string;
  }>;
  submitSwap(signed: SignedFundingIntent): Promise<void>;
  prepareCall(
    terms: FundingTerms,
    kind: 'WITHDRAW' | 'DISTRIBUTE',
    amount: string,
  ): Promise<PreparedFundingCall>;
  reconcileCall(terms: FundingTerms, call: PreparedFundingCall): Promise<FinalFundingCall | null>;
  sendCall(call: PreparedFundingCall): Promise<void>;
}
export const FundingSummary = z
  .object({
    contractVersion: z.literal(1),
    mode: z.enum(['PAPER', 'LIVE', 'REPLAY']),
    nftFundingImplemented: z.literal(true),
    nftFundingEnabled: z.boolean(),
    computePurchaseImplemented: z.literal(false),
    computePurchaseBlocker: z.literal('NO_PUBLIC_NEAR_AI_PURCHASE_PROTOCOL'),
    completedDistributions: z.number().int().nonnegative(),
    spentInputAtoms: atoms,
    distributedNearYocto: atoms,
    allocatedNearYocto: atoms,
    operations: z.array(
      z
        .object({
          reference: z.string(),
          reservationReference: z.string(),
          state: z.string(),
          updatedAt: z.iso.datetime(),
          error: z.string().nullable(),
          withdrawalTxHash: nearHash.nullable(),
          distributionTxHash: nearHash.nullable(),
        })
        .strict(),
    ),
  })
  .strict();
