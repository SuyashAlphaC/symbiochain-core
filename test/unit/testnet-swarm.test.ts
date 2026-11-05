import { expect, it } from 'vitest';
import {
  digest,
  DomainError,
  type BrainResult,
  type Proposal,
  type Quote,
} from '../../src/domain.js';
import {
  newSwarmState,
  stepTestnetSwarm,
  publicSwarmReport,
  TestnetSwarmReport,
  TestnetExecutionReport,
  type TestnetSwarmPorts,
  type SwarmState,
} from '../../src/testnet-swarm.js';

function fixture() {
  const state = newSwarmState();
  const proposal: Proposal = {
    strategy: 'round-trip',
    originChain: 'near:testnet',
    destinationChain: 'solana:devnet',
    originAsset: 'TEST_USDC',
    intermediateAsset: 'TEST_SOL',
    amountAtoms: '1000000',
    recipient: 'treasury.fixture.testnet',
    refundTo: 'treasury.fixture.testnet',
    slippageBps: 50,
    expiresAt: new Date(Date.now() + 60000).toISOString(),
  };
  const quote: Quote = {
    id: 'synthetic-test-quote',
    inputAtoms: '1000000',
    expectedOutputAtoms: '1100000',
    minimumOutputAtoms: '1090000',
    costsAtoms: '10000',
    expiresAt: proposal.expiresAt,
    routeDigest: 'ab'.repeat(32),
    route: { settlement: 'SIMULATED' },
  };
  const result: BrainResult = {
    assessment: {
      execute: true,
      reason: 'Unit fixture only',
      maxSlippageBps: 50,
      proposalDigest: digest({ proposal, quote }),
    },
    proof: {
      kind: 'NEAR_AI',
      status: 'VERIFIED',
      model: 'z-ai/glm-5.3-flash',
      requestHash: 'aa'.repeat(32),
      responseHash: 'bb'.repeat(32),
      signer: 'unit-fixture',
      measurement: 'cc'.repeat(32),
      evidence: { privatePrompt: 'NEVER_PUBLISH_THIS' },
      publicDetails: {},
    },
    usage: {
      requestId: 'unit-only',
      model: 'z-ai/glm-5.3-flash',
      inputTokens: 1,
      outputTokens: 1,
      costUsdMicros: '1',
      billingSource: 'UNIT_FIXTURE',
    },
  };
  let paid = 0,
    broadcasts = 0,
    receipts = 0;
  const saved: SwarmState[] = [],
    effects = new Map<string, unknown>();
  const once = <T>(key: string, effect: () => T): T => {
    if (!effects.has(key)) effects.set(key, effect());
    return effects.get(key) as T;
  };
  const ports: TestnetSwarmPorts = {
    async scout() {
      return { proposal, quote };
    },
    async assess(id) {
      return once(`ai:${id}`, () => {
        paid++;
        return result;
      });
    },
    async execute(id) {
      return once(`tx:${id}`, () => {
        broadcasts++;
        return {
          chain: 'solana:devnet' as const,
          source: 'VERIFIED_AI' as const,
          sender: 'fixtureSender',
          status: 'CONFIRMED' as const,
          code: 'CONFIRMED',
          txHash: '1'.repeat(88),
          nativeFeeAtoms: '5000',
        };
      });
    },
    async reconcile(id) {
      return once(`nft:${id}`, () => {
        receipts++;
        return `cycle:${id}`;
      });
    },
    async inferenceCount() {
      return paid;
    },
    async save(s, r) {
      TestnetSwarmReport.parse(r);
      saved.push(structuredClone(s));
    },
  };
  return {
    state,
    ports,
    result,
    proposal,
    quote,
    saved,
    counters: () => ({ paid, broadcasts, receipts }),
  };
}
it('stops before signing or paying when deployment approval is unavailable', async () => {
  const f = fixture();
  f.ports.assess = async () => {
    throw new DomainError('TEE_DEPLOYMENT_UNAPPROVED', 'private diagnostic');
  };
  await stepTestnetSwarm(f.state, f.ports);
  await stepTestnetSwarm(f.state, f.ports);
  expect(f.state).toMatchObject({ stage: 'BRAIN', status: 'BLOCKED', paidInferenceRequests: 0 });
  expect(f.counters()).toEqual({ paid: 0, broadcasts: 0, receipts: 0 });
  expect(f.state.events.at(-1)?.code).toBe('TEE_DEPLOYMENT_UNAPPROVED');
});
it('completes the bounded workflow and publishes no private evidence', async () => {
  const f = fixture();
  for (let i = 0; i < 5; i++) await stepTestnetSwarm(f.state, f.ports);
  expect(f.state.status).toBe('CLOSED');
  expect(f.counters()).toEqual({ paid: 1, broadcasts: 1, receipts: 1 });
  expect(JSON.stringify(publicSwarmReport(f.state))).not.toContain('NEVER_PUBLISH_THIS');
  expect(publicSwarmReport(f.state)).toMatchObject({
    economics: 'SIMULATED',
    settlement: 'SIMULATED',
    paidInferenceRequests: 1,
  });
});
it('recovers after an effect and before checkpointing without a second purchase, transaction or mint', async () => {
  const f = fixture();
  await stepTestnetSwarm(f.state, f.ports);
  for (const stage of ['BRAIN', 'HAND', 'ACCOUNTANT']) {
    await stepTestnetSwarm(f.state, f.ports, async (s) => {
      if (s === stage) throw new DomainError('WORKER_CRASH', 'fixture');
    });
    expect(f.state.status).toBe('BLOCKED');
    const recovered = structuredClone(f.saved.at(-1)!);
    Object.assign(f.state, recovered);
    await stepTestnetSwarm(f.state, f.ports);
  }
  expect(f.state.status).toBe('CLOSED');
  expect(f.counters()).toEqual({ paid: 1, broadcasts: 1, receipts: 1 });
});
it('honors model rejection and rejects simulated, mismatched or expired decisions', async () => {
  for (const variant of ['reject', 'simulated', 'mismatched', 'expired']) {
    const f = fixture();
    if (variant === 'reject') f.result.assessment.execute = false;
    if (variant === 'simulated') f.result.proof.status = 'SIMULATED';
    if (variant === 'mismatched') f.result.assessment.proposalDigest = 'dd'.repeat(32);
    await stepTestnetSwarm(f.state, f.ports);
    await stepTestnetSwarm(f.state, f.ports);
    if (variant === 'expired') f.proposal.expiresAt = new Date(0).toISOString();
    await stepTestnetSwarm(f.state, f.ports);
    expect(f.state.status).toBe(variant === 'reject' ? 'REJECTED' : 'BLOCKED');
    expect(f.counters().broadcasts).toBe(0);
  }
});
it('refuses a closed status without matching verified execution and rejects expanded reports', () => {
  const report = publicSwarmReport(fixture().state);
  expect(
    TestnetSwarmReport.safeParse({ ...report, status: 'CLOSED', stage: 'CLOSED' }).success,
  ).toBe(false);
  expect(TestnetSwarmReport.safeParse({ ...report, apiKey: 'SECRET' }).success).toBe(false);
  expect(
    TestnetExecutionReport.safeParse({
      chain: 'solana:mainnet',
      source: 'VERIFIED_AI',
      sender: 'x',
      status: 'CONFIRMED',
      code: 'CONFIRMED',
      txHash: null,
      nativeFeeAtoms: null,
    }).success,
  ).toBe(false);
});
