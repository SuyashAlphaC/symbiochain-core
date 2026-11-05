import 'dotenv/config';
import { mkdir } from 'node:fs/promises';
import { setTimeout as sleep } from 'node:timers/promises';
import { loadConfig } from '../src/config.js';
import { createDatabase, type Database } from '../src/db.js';
import { json } from '../src/store.js';
import { digest, DomainError, type Proposal, type Quote } from '../src/domain.js';
import { NearAiClient } from '../src/providers/near-ai.js';
import {
  TestnetLedger,
  optionalJson,
  privateJson,
  testnetLock,
  recoverTestnetLock,
} from '../src/testnet-ledger.js';
import {
  TestnetExecutor,
  TESTNET_SOL_RECIPIENT,
  requireTestnetTransfer,
} from '../src/testnet-execution.js';
import {
  newSwarmState,
  stepTestnetSwarm,
  type SwarmState,
  type TestnetSwarmPorts,
} from '../src/testnet-swarm.js';
import { publishTestnetReport } from '../src/testnet-report.js';

const directory = '.data/testnet-swarm';
await mkdir(directory, { recursive: true, mode: 0o700 });
if (process.argv.includes('--recover-stale-lock')) await recoverTestnetLock();
const unlock = await testnetLock();
let db: Database | undefined, ledger: TestnetLedger | undefined;
const state = ((await optionalJson(`${directory}/state.json`)) ?? newSwarmState()) as SwarmState;
try {
  ledger = await TestnetLedger.open(directory);
  const executor = new TestnetExecutor(ledger);
  const treasury = ledger.accounts.treasury.accountId;
  const aiConfig = loadConfig({
    ...process.env,
    EXECUTION_MODE: 'PAPER',
    LIVE_TRADING_ENABLED: 'false',
    DATABASE_URL: process.env.TESTNET_DATABASE_URL ?? 'postgresql://unused',
    COMPUTE_CREDIT_POLICY: 'LOCAL_BUDGET',
    AI_BUDGET_ID: 'symbio-testnet-swarm-v1',
    AI_TOTAL_BUDGET_USD_MICROS: '100000',
    AI_MAX_REQUEST_USD_MICROS: '100000',
    SYNC_STAKING_CREDITS: 'false',
  });
  const database = () => {
    if (
      !process.env.TESTNET_DATABASE_URL ||
      !new URL(process.env.TESTNET_DATABASE_URL).pathname.endsWith('_testnet')
    )
      throw new DomainError(
        'TESTNET_DATABASE_REQUIRED',
        'Dedicated durable database ending in _testnet required',
      );
    return (db ??= createDatabase(process.env.TESTNET_DATABASE_URL, 2));
  };
  const ports: TestnetSwarmPorts = {
    async scout(runId) {
      const saved = await optionalJson(`${directory}/opportunity.json`);
      if (saved) return saved as { proposal: Proposal; quote: Quote };
      const expiry = new Date(Date.now() + 50 * 60_000).toISOString();
      const proposal: Proposal = {
        strategy: 'round-trip',
        originChain: 'near:testnet',
        destinationChain: 'solana:devnet',
        originAsset: 'TEST_USDC',
        intermediateAsset: 'TEST_SOL',
        amountAtoms: '1000000',
        recipient: treasury,
        refundTo: treasury,
        slippageBps: 50,
        expiresAt: expiry,
      };
      const route = {
        settlement: 'SIMULATED',
        economics: 'SIMULATED',
        destinationExecution: 'solana:devnet',
        destinationTransfer: {
          chain: 'solana:devnet',
          sender: await executor.address('solana:devnet'),
          recipient: TESTNET_SOL_RECIPIENT,
          token: 'sol:native',
          amountAtoms: '1000000',
        },
        purpose:
          'Faucet-funded bounded transfer demonstration; not an executable arbitrage opportunity. Reject if insufficient evidence.',
      };
      const quote: Quote = {
        id: `testnet-fixture:${runId}`,
        inputAtoms: '1000000',
        expectedOutputAtoms: '1100000',
        minimumOutputAtoms: '1090000',
        costsAtoms: '10000',
        expiresAt: expiry,
        routeDigest: digest(route),
        route,
      };
      const opportunity = { proposal, quote };
      await privateJson(`${directory}/opportunity.json`, opportunity);
      return opportunity;
    },
    async assess(runId, proposal, quote) {
      // Missing approval is checked before database access and before any paid request.
      if (
        !aiConfig.TEE_GATEWAY_COMPOSE_HASHES.length ||
        !aiConfig.TEE_MODEL_COMPOSE_HASHES.length ||
        !aiConfig.TEE_MODEL_ACTIONS_HASHES.length
      )
        throw new DomainError(
          'TEE_DEPLOYMENT_UNAPPROVED',
          'Independently reviewed deployment policy is required',
        );
      if (Date.parse(proposal.expiresAt) <= Date.now())
        throw new DomainError(
          'TESTNET_OPPORTUNITY_EXPIRED',
          'Original terms expired; no automatic replacement',
        );
      requireTestnetTransfer(quote, await executor.address('solana:devnet'));
      const databaseClient = database();
      await databaseClient.cycle.upsert({
        where: { id: runId },
        update: {},
        create: {
          id: runId,
          mode: 'PAPER',
          idempotencyKey: `testnet-swarm:${runId}`,
          strategy: 'round-trip',
          proposal: json(proposal),
          quote: json(quote),
          expiresAt: new Date(proposal.expiresAt),
        },
      });
      const result = await new NearAiClient(aiConfig, databaseClient).assess(
        runId,
        proposal,
        quote,
      );
      if (
        !result.proof.publicDetails.tlsConnectionBinding ||
        !result.proof.publicDetails.gpuVerified ||
        !result.proof.publicDetails.composeManagerActionsHash
      )
        throw new DomainError(
          'TESTNET_TEE_BINDING',
          'Verified gateway, model GPU and deployment action binding required',
        );
      return result;
    },
    async execute(runId, proposal, quote, brain) {
      requireTestnetTransfer(quote, await executor.address('solana:devnet'));
      const execution = await executor.execute(
        runId,
        'solana:devnet',
        'VERIFIED_AI',
        digest({ request: brain.proof.requestHash, response: brain.proof.responseHash }),
        digest({ proposal, quote }),
        quote.routeDigest,
      );
      await ledger!.paused(false);
      await ledger!.call(`${runId}:service-funding`, 'hand', 'fund_services', {}, 10n ** 22n);
      await ledger!.call(`${runId}:brain-payment`, 'hand', 'settle_service', {
        payment_id: `testnet-swarm:${runId}:brain`,
        recipient: ledger!.accounts.brain.accountId,
        amount: (10n ** 21n).toString(),
        reference_hash: brain.proof.responseHash,
      });
      return execution;
    },
    async reconcile(runId, execution) {
      const cycle_id = `testnet-swarm:${runId}:solana`;
      // Positive P&L is an explicitly synthetic fixture, solely to exercise the existing NFT gate.
      await ledger!.call(`${runId}:fixture-accounting`, 'books', 'finalize_cycle', {
        cycle_id,
        reconciliation_hash: digest({ execution, settlement: 'SIMULATED', economics: 'SIMULATED' }),
        realized_pnl_atoms: '100',
      });
      await ledger!.call(`${runId}:fixture-receipt`, 'books', 'mint_proof_nft', {
        cycle_id,
        receiver_id: ledger!.accounts.owner.accountId,
        share_bps: 0,
      });
      return `cycle:${cycle_id}`;
    },
    async inferenceCount(runId) {
      if (!db) return state.paidInferenceRequests;
      try {
        return await db.inferenceAttempt.count({ where: { cycleId: runId } });
      } catch {
        return 1;
      } // Conservatively account for a possibly accepted paid request.
    },
    async save(value, report) {
      await privateJson(`${directory}/state.json`, value);
      await privateJson(`${directory}/public.json`, report);
      await publishTestnetReport();
    },
  };
  do {
    await stepTestnetSwarm(state, ports, undefined, async (stage) => {
      if (process.argv.includes(`--crash-after-claim=${stage}`)) process.exit(70);
    });
    console.log(
      JSON.stringify({
        runId: state.runId,
        stage: state.stage,
        status: state.status,
        paidInferenceRequests: state.paidInferenceRequests,
        code: state.events.at(-1)?.code,
      }),
    );
    if (
      !process.argv.includes('--watch') ||
      ['BLOCKED', 'CLOSED', 'REJECTED'].includes(state.status)
    )
      break;
    await sleep(1000);
  } while (true);
  if (state.status === 'BLOCKED') process.exitCode = 2;
} catch (error) {
  console.error(
    JSON.stringify({
      code: error instanceof DomainError ? error.code : 'TESTNET_RUNTIME_UNAVAILABLE',
    }),
  );
  process.exitCode = 2;
} finally {
  try {
    if (ledger) await ledger.paused(true);
  } finally {
    await db?.$disconnect();
    await unlock();
  }
}
