import { randomUUID } from 'node:crypto';
import { digest, DomainError, type BrainResult, type Proposal, type Quote } from './domain.js';

import {
  TestnetExecutionReport,
  TestnetSwarmReport,
  type SwarmStage,
} from './testnet-swarm-contract.js';
export { TestnetExecutionReport, TestnetSwarmReport } from './testnet-swarm-contract.js';

export interface SwarmState {
  runId: string;
  stage: SwarmStage;
  status: TestnetSwarmReport['status'];
  events: TestnetSwarmReport['events'];
  paidInferenceRequests: number;
  proposal?: Proposal;
  quote?: Quote;
  brain?: BrainResult;
  execution?: TestnetExecutionReport;
  receiptTokenId?: string;
}
export interface TestnetSwarmPorts {
  scout(runId: string): Promise<{ proposal: Proposal; quote: Quote }>;
  assess(runId: string, proposal: Proposal, quote: Quote): Promise<BrainResult>;
  execute(
    runId: string,
    proposal: Proposal,
    quote: Quote,
    brain: BrainResult,
  ): Promise<TestnetExecutionReport>;
  reconcile(runId: string, execution: TestnetExecutionReport): Promise<string>;
  inferenceCount(runId: string): Promise<number>;
  save(state: SwarmState, report: TestnetSwarmReport): Promise<void>;
}
export function newSwarmState(): SwarmState {
  return {
    runId: randomUUID(),
    stage: 'SCOUT',
    status: 'PENDING',
    events: [],
    paidInferenceRequests: 0,
  };
}

/** Explicit retirement never abandons a possibly paid request or signed operation. */
export function requireSafeNewSwarm(
  state: SwarmState,
  inferenceStatus: string | null,
  journal: Record<string, { outcome?: unknown }>,
): void {
  const entries = Object.values(journal);
  const complete =
    (state.status === 'CLOSED' && state.stage === 'CLOSED') ||
    (state.status === 'REJECTED' && state.stage === 'REJECTED');
  if (complete) publicSwarmReport(state);
  const beforeInference =
    ['SCOUT', 'BRAIN'].includes(state.stage) &&
    state.paidInferenceRequests === 0 &&
    inferenceStatus === null &&
    entries.length === 0;
  if (
    entries.some((entry) => !entry.outcome) ||
    (inferenceStatus !== null && inferenceStatus !== 'COMPLETE') ||
    (!complete && !beforeInference)
  )
    throw new DomainError(
      'TESTNET_RECONCILIATION_REQUIRED',
      'Finish or reconcile the existing run before starting another',
    );
}
export function publicSwarmReport(state: SwarmState): TestnetSwarmReport {
  const p = state.brain?.proof;
  return TestnetSwarmReport.parse({
    profile: 'TESTNET_SWARM',
    runId: state.runId,
    updatedAt: new Date().toISOString(),
    stage: state.stage,
    status: state.status,
    settlement: 'SIMULATED',
    economics: 'SIMULATED',
    paidInferenceRequests: state.paidInferenceRequests,
    billedUsdMicros: state.brain?.usage.costUsdMicros ?? null,
    inference: p
      ? {
          model: p.model,
          status: p.status,
          requestHash: p.requestHash,
          responseHash: p.responseHash,
          measurement: p.measurement,
          execute: state.brain!.assessment.execute,
        }
      : null,
    execution: state.execution ?? null,
    receiptTokenId: state.receiptTokenId ?? null,
    events: state.events,
  });
}

/** A single bounded workflow. External ports own exact-byte/idempotent effects. */
export async function stepTestnetSwarm(
  state: SwarmState,
  ports: TestnetSwarmPorts,
  afterEffect?: (stage: SwarmStage) => Promise<void>,
  afterClaim?: (stage: SwarmStage) => Promise<void>,
): Promise<void> {
  if (state.status === 'CLOSED' || state.status === 'REJECTED') return;
  const event = (code: string, stage: SwarmStage = state.stage) => {
    state.events.push({ stage, at: new Date().toISOString(), code });
    state.events = state.events.slice(-64);
  };
  const save = () => ports.save(state, publicSwarmReport(state));
  state.status = 'RUNNING';
  event('CLAIMED');
  await save();
  await afterClaim?.(state.stage);
  try {
    const stage = state.stage;
    if (stage === 'SCOUT') {
      const opportunity = await ports.scout(state.runId);
      await afterEffect?.(stage);
      Object.assign(state, opportunity);
      state.stage = 'BRAIN';
    } else if (stage === 'BRAIN') {
      const result = await ports.assess(state.runId, state.proposal!, state.quote!);
      if (
        result.proof.status !== 'VERIFIED' ||
        result.proof.kind !== 'NEAR_AI' ||
        result.assessment.proposalDigest !==
          digest({ proposal: state.proposal, quote: state.quote }) ||
        result.assessment.maxSlippageBps > state.proposal!.slippageBps
      )
        throw new DomainError(
          'TESTNET_UNVERIFIED_AI',
          'A matching verified model decision is required',
        );
      await afterEffect?.(stage);
      state.brain = result;
      state.stage = result.assessment.execute ? 'HAND' : 'REJECTED';
    } else if (stage === 'HAND') {
      if (!state.brain?.assessment.execute)
        throw new DomainError('TESTNET_AI_REJECTED', 'Model did not approve execution');
      if (
        Date.parse(state.proposal!.expiresAt) <= Date.now() ||
        Date.parse(state.quote!.expiresAt) <= Date.now()
      )
        throw new DomainError('TESTNET_OPPORTUNITY_EXPIRED', 'Committed opportunity expired');
      if (
        state.brain.proof.kind !== 'NEAR_AI' ||
        state.brain.proof.status !== 'VERIFIED' ||
        state.brain.assessment.proposalDigest !==
          digest({ proposal: state.proposal, quote: state.quote })
      )
        throw new DomainError(
          'TESTNET_UNVERIFIED_AI',
          'Decision no longer matches committed terms',
        );
      const execution = TestnetExecutionReport.parse(
        await ports.execute(state.runId, state.proposal!, state.quote!, state.brain),
      );
      if (execution.status !== 'CONFIRMED' || execution.source !== 'VERIFIED_AI')
        throw new DomainError('TESTNET_UNCONFIRMED', 'Destination confirmation is required');
      await afterEffect?.(stage);
      state.execution = execution;
      state.stage = 'ACCOUNTANT';
    } else if (stage === 'ACCOUNTANT') {
      const tokenId = await ports.reconcile(state.runId, state.execution!);
      await afterEffect?.(stage);
      state.receiptTokenId = tokenId;
      state.stage = 'CLOSED';
    }
    state.status =
      state.stage === 'CLOSED' ? 'CLOSED' : state.stage === 'REJECTED' ? 'REJECTED' : 'PENDING';
    event('COMPLETED', stage);
  } catch (error) {
    state.status = 'BLOCKED';
    event(
      error instanceof DomainError && /^[A-Z0-9_]{1,80}$/.test(error.code)
        ? error.code
        : 'TESTNET_PROVIDER_UNAVAILABLE',
    );
  } finally {
    state.paidInferenceRequests = await ports.inferenceCount(state.runId);
    await save();
  }
}
