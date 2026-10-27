import {
  digest,
  type Proposal,
  type Quote,
  type BrainResult,
  type PreparedExecution,
  type Settlement,
} from '../domain.js';
import type { Providers } from './types.js';

/** A deterministic local counterparty. All economic results and proofs remain SIMULATED. */
export class PaperProviders implements Providers {
  async quote(cycleId: string, p: Proposal): Promise<Quote> {
    const input = BigInt(p.amountAtoms);
    const route = {
      mode: 'PAPER',
      cycleId,
      origin: p.originAsset,
      intermediate: p.intermediateAsset,
      returnAsset: p.originAsset,
      legs: 2,
    };
    return {
      id: `paper:${cycleId}`,
      inputAtoms: p.amountAtoms,
      expectedOutputAtoms: (input + input / 50n).toString(),
      minimumOutputAtoms: (input + input / 60n).toString(),
      costsAtoms: '1000',
      expiresAt: p.expiresAt,
      routeDigest: digest(route),
      route,
    };
  }
  async assess(cycleId: string, proposal: Proposal, quote: Quote): Promise<BrainResult> {
    const assessment = {
      execute: true,
      reason: 'Deterministic paper fixture; no model or hardware attestation was used',
      maxSlippageBps: 50,
      proposalDigest: digest({ proposal, quote }),
    };
    return {
      assessment,
      proof: {
        kind: 'PAPER',
        status: 'SIMULATED',
        model: 'paper-fixture',
        requestHash: digest({ proposal, quote }),
        responseHash: digest(assessment),
        signer: null,
        measurement: null,
        evidence: { simulation: true },
        publicDetails: { simulation: true, hardwareVerified: false },
      },
      usage: {
        requestId: `paper:${cycleId}`,
        model: 'paper-fixture',
        inputTokens: 0,
        outputTokens: 0,
        costUsdMicros: '100',
        billingSource: 'SIMULATED',
      },
    };
  }
  async prepare(cycleId: string, proposal: Proposal, quote: Quote): Promise<PreparedExecution> {
    return {
      id: cycleId,
      chainId: proposal.destinationChain,
      txHash: `paper:${digest({ cycleId, quote })}`,
      operation: 'round-trip',
      asset: proposal.originAsset,
      amountAtoms: proposal.amountAtoms,
      data: { mode: 'PAPER', routeDigest: quote.routeDigest },
    };
  }
  async broadcast(execution: PreparedExecution): Promise<void> {
    if (execution.data.mode !== 'PAPER' || !execution.txHash.startsWith('paper:'))
      throw new Error('Paper provider refuses non-paper execution');
  }
  async settle(
    _cycleId: string,
    p: Proposal,
    quote: Quote,
    execution: PreparedExecution,
  ): Promise<Settlement> {
    return {
      status: 'SUCCESS',
      receivedAtoms: quote.expectedOutputAtoms,
      feesAtoms: quote.costsAtoms,
      transactions: [
        {
          chainId: execution.chainId,
          txHash: execution.txHash,
          operation: 'round-trip',
          asset: p.originAsset,
          amountAtoms: quote.expectedOutputAtoms,
          status: 'SIMULATED',
        },
      ],
      evidence: { simulation: true, counterparty: 'local fixture', routeDigest: quote.routeDigest },
    };
  }
  async receipt(
    cycleId: string,
    evidence: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    return {
      id: `paper-receipt:${cycleId}`,
      evidenceHash: digest(evidence),
      mode: 'PAPER',
      mintedOnChain: false,
    };
  }
}
