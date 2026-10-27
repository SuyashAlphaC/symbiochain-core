import { beforeEach, afterAll, afterEach, it, expect, vi } from 'vitest';
import { randomUUID, generateKeyPairSync, sign, createPrivateKey } from 'node:crypto';
import { privateKeyToAccount } from 'viem/accounts';
import {
  parseSignature,
  keccak256,
  encodeEventTopics,
  encodeAbiParameters,
  erc20Abi,
  type Hex,
} from 'viem';
import { Keypair, PublicKey, SystemProgram, Transaction } from '@solana/web3.js';
import bs58 from 'bs58';
import { quoteHash, type QuoteResponse } from '@defuse-protocol/one-click-sdk-typescript';
import { loadConfig } from '../../src/config.js';
import { createDatabase } from '../../src/db.js';
import { Store } from '../../src/store.js';
import { Engine } from '../../src/engine.js';
import { Proposal, digest, type BrainResult } from '../../src/domain.js';
import { LiveProviders, type LivePorts } from '../../src/providers/live.js';
import { ChainWallets, type UnsignedTransfer } from '../../src/providers/wallets.js';
import { OneClickClient } from '../../src/providers/oneclick.js';
import type { ContractCycle, ContractRole } from '../../src/providers/near-contract.js';

// This suite exercises the LIVE orchestration branch using explicitly injected local transports.
// Its market, hardware, RPC, MPC and balances are fixtures, never mainnet/TEE evidence.
const url =
  process.env.TEST_DATABASE_URL ??
  'postgresql://symbio:symbio_local@localhost:55439/symbiochain_test';
if (!new URL(url).pathname.endsWith('_test')) throw new Error('Dedicated test DB required');
const db = createDatabase(url);
const manager = generateKeyPairSync('ed25519');
const evmSigner = privateKeyToAccount(`0x${'11'.repeat(32)}`),
  solSigner = Keypair.generate();
const token = `0x${'22'.repeat(20)}` as const,
  evmDeposit = `0x${'33'.repeat(20)}` as const;
const solDeposit = Keypair.generate().publicKey.toBase58(),
  pool = Keypair.generate();
const base = 'nep141:fixture-usdc.omft.near',
  middle = 'nep141:sol.omft.near';
const nativeReceipt = bs58.encode(new Uint8Array(64).fill(7)),
  tokenReceipt = `0x${'77'.repeat(32)}` as const;
const fixtureConfig = loadConfig({
  ...process.env,
  DATABASE_URL: url,
  EXECUTION_MODE: 'PAPER',
  EVM_RPC_URL: 'http://127.0.0.1:1',
  BASE_ASSET: base,
  ALLOWED_ASSETS: `${base},${middle}`,
  ALLOWED_CHAINS: 'eip155:8453,solana:mainnet',
  ALLOWED_RECIPIENTS: evmSigner.address,
  GAS_COST_BASE_ATOMS: '10000',
  LIVE_COST_BUFFER_ATOMS: '10000',
  MIN_NET_PROFIT_ATOMS: '1000',
  NFT_RECEIVER_ID: 'holder.test.near',
  NEAR_SCOUT_ACCOUNT_ID: 'scout.test.near',
  NEAR_BRAIN_ACCOUNT_ID: 'brain.test.near',
  NEAR_WORKER_ACCOUNT_ID: 'hand.test.near',
  ONECLICK_MANAGER_PUBLIC_KEY: `ed25519:${bs58.encode(manager.publicKey.export({ type: 'spki', format: 'der' }).subarray(-32))}`,
});
// Configuration arming is tested separately. Only this local test constructs a LIVE-valued config.
const store = new Store(db, { ...fixtureConfig, EXECUTION_MODE: 'LIVE' });
beforeEach(async () => {
  await db.$executeRawUnsafe(
    'TRUNCATE "Cycle", "Policy", "ServicePayment", "ComputeAccount", "Journal", "WorkerControl", "OutboxEvent" RESTART IDENTITY CASCADE',
  );
  await store.initialize();
});
afterEach(() => vi.restoreAllMocks());
afterAll(async () => db.$disconnect());

function fixture(
  options: {
    lostBroadcast?: 'EVM' | 'SOLANA';
    droppedBroadcast?: 'EVM' | 'SOLANA';
    neverAccept?: 'EVM' | 'SOLANA';
    wrongRecipient?: boolean;
    firstLegRefund?: boolean;
  } = {},
) {
  let evmHead = 1000n,
    solHead = 2000,
    phase = 0,
    lost = false,
    prepares = 0;
  const signedCalls: string[] = [],
    broadcasts: string[] = [],
    payments: string[] = [],
    broadcastInputs: string[] = [],
    quotes = new Map<string, QuoteResponse>();
  const records = new Map<string, ContractCycle>(),
    unsigned = new Map<string, UnsignedTransfer>();
  const wallets = new ChainWallets(fixtureConfig);
  vi.spyOn(wallets, 'address').mockImplementation(async (chain) =>
    chain.startsWith('eip155:') ? evmSigner.address : solSigner.publicKey.toBase58(),
  );
  vi.spyOn(wallets.evm, 'getChainId').mockResolvedValue(8453);
  vi.spyOn(wallets.evm, 'getBlockNumber').mockImplementation(async () => evmHead);
  vi.spyOn(wallets.evm, 'getBalance').mockResolvedValue(10n ** 18n);
  vi.spyOn(wallets.evm, 'readContract').mockResolvedValue(20_000_000n);
  vi.spyOn(wallets.evm, 'estimateFeesPerGas').mockResolvedValue({
    maxFeePerGas: 10000n,
    maxPriorityFeePerGas: 100n,
  });
  vi.spyOn(wallets.evm, 'estimateGas').mockResolvedValue(50000n);
  vi.spyOn(wallets.evm, 'getTransactionCount').mockResolvedValue(0);
  vi.spyOn(wallets.solana, 'getGenesisHash').mockResolvedValue('5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp');
  vi.spyOn(wallets.solana, 'getSlot').mockImplementation(async () => solHead);
  vi.spyOn(wallets.solana, 'getBalance').mockResolvedValue(10_000_000_000);
  vi.spyOn(wallets.solana, 'getLatestBlockhash').mockResolvedValue({
    blockhash: bs58.encode(new Uint8Array(32).fill(3)),
    lastValidBlockHeight: 3000,
  });
  vi.spyOn(wallets.evm, 'sendRawTransaction').mockImplementation(
    async ({ serializedTransaction }) => {
      broadcastInputs.push(serializedTransaction);
      if (options.neverAccept === 'EVM') throw new Error('Fixture EVM endpoint unavailable');
      if (options.droppedBroadcast === 'EVM' && !lost) {
        lost = true;
        throw new Error('Fixture disconnected before EVM submission');
      }
      const hash = keccak256(serializedTransaction);
      broadcasts.push(hash);
      phase = 1;
      evmHead = 1010n;
      solHead = 2015;
      if (options.lostBroadcast === 'EVM' && !lost) {
        lost = true;
        throw new Error('Fixture accepted EVM deposit, reply lost');
      }
      return hash;
    },
  );
  vi.spyOn(wallets.solana, 'sendRawTransaction').mockImplementation(async (raw) => {
    broadcastInputs.push(Buffer.from(raw).toString('base64'));
    if (options.neverAccept === 'SOLANA') throw new Error('Fixture Solana endpoint unavailable');
    if (options.droppedBroadcast === 'SOLANA' && !lost) {
      lost = true;
      throw new Error('Fixture disconnected before SOL submission');
    }
    const tx = Transaction.from(Buffer.from(raw));
    const hash = bs58.encode(tx.signature!);
    broadcasts.push(hash);
    phase = 2;
    evmHead = 1030n;
    solHead = 2030;
    if (options.lostBroadcast === 'SOLANA' && !lost) {
      lost = true;
      throw new Error('Fixture accepted SOL deposit, reply lost');
    }
    return hash;
  });
  vi.spyOn(wallets.evm, 'getTransactionReceipt').mockImplementation(async ({ hash }) => {
    if (hash === tokenReceipt && phase === 1 && options.firstLegRefund)
      return {
        status: 'success',
        blockNumber: 1005n,
        gasUsed: 1n,
        effectiveGasPrice: 1n,
        logs: [
          {
            address: token,
            data: encodeAbiParameters([{ type: 'uint256' }], [4_998_000n]),
            topics: encodeEventTopics({
              abi: erc20Abi,
              eventName: 'Transfer',
              args: { from: evmDeposit, to: evmSigner.address },
            }),
          },
        ],
      } as never;
    if (hash === tokenReceipt && phase === 2)
      return {
        status: 'success',
        blockNumber: 1020n,
        gasUsed: 1n,
        effectiveGasPrice: 1n,
        logs: [
          {
            address: token,
            data: encodeAbiParameters([{ type: 'uint256' }], [5_200_000n]),
            topics: encodeEventTopics({
              abi: erc20Abi,
              eventName: 'Transfer',
              args: {
                from: evmDeposit,
                to: options.wrongRecipient ? evmDeposit : evmSigner.address,
              },
            }),
          },
        ],
      } as never;
    if (broadcasts.includes(hash))
      return {
        status: 'success',
        blockNumber: 1001n,
        gasUsed: 50000n,
        effectiveGasPrice: 100n,
        logs: [],
      } as never;
    throw new Error('Fixture transaction not found');
  });
  vi.spyOn(wallets.solana, 'getSignatureStatuses').mockImplementation(
    async (signatures) =>
      ({
        context: { slot: solHead },
        value: signatures.map((hash) =>
          broadcasts.includes(hash)
            ? { slot: 2020, confirmations: null, err: null, confirmationStatus: 'finalized' }
            : null,
        ),
      }) as never,
  );
  vi.spyOn(wallets.solana, 'getTransaction').mockImplementation(async (hash) => {
    if (hash === nativeReceipt && phase >= 1) {
      const receiver = solSigner.publicKey;
      const transfer = new Transaction({
        feePayer: pool.publicKey,
        recentBlockhash: bs58.encode(new Uint8Array(32).fill(3)),
      }).add(
        SystemProgram.transfer({
          fromPubkey: pool.publicKey,
          toPubkey: receiver,
          lamports: 31_000_000n,
        }),
      );
      return {
        slot: 2010,
        meta: {
          err: null,
          fee: 5000,
          preBalances: [1_000_000_000, 0, 0],
          postBalances: [968_995_000, 31_000_000, 0],
        },
        transaction: { message: transfer.compileMessage() },
      } as never;
    }
    if (broadcasts.includes(hash)) return { slot: 2020, meta: { err: null, fee: 5000 } } as never;
    return null;
  });
  const actualPrepare = wallets.prepare.bind(wallets);
  vi.spyOn(wallets, 'prepare').mockImplementation(async (...args) => {
    prepares++;
    return actualPrepare(...args);
  });
  const actualAuthorization = wallets.authorization.bind(wallets);
  vi.spyOn(wallets, 'authorization').mockImplementation((transfer, terms) => {
    unsigned.set(terms.cycle_id, transfer);
    return actualAuthorization(transfer, terms);
  });
  const oneclick = new OneClickClient(store.config, async (input, init) => {
    const endpoint = new URL(input instanceof Request ? input.url : input);
    if (endpoint.pathname === '/v0/tokens')
      return Response.json([
        {
          assetId: base,
          decimals: 6,
          blockchain: 'base',
          symbol: 'USDC',
          price: 1,
          priceUpdatedAt: new Date().toISOString(),
          contractAddress: token,
        },
        {
          assetId: middle,
          decimals: 9,
          blockchain: 'sol',
          symbol: 'SOL',
          price: 100,
          priceUpdatedAt: new Date().toISOString(),
        },
      ]);
    if (endpoint.pathname === '/v0/quote') {
      const request = JSON.parse(String(init?.body)),
        first = request.originAsset === base;
      const quote = {
        amountIn: request.amount,
        minAmountIn: request.amount,
        amountInFormatted: 'fixture',
        amountInUsd: 'fixture',
        amountOut: first ? '31000000' : '5200000',
        minAmountOut: first ? '30000000' : '5150000',
        amountOutFormatted: 'fixture',
        amountOutUsd: 'fixture',
        timeEstimate: 1,
        ...(!request.dry
          ? { depositAddress: first ? evmDeposit : solDeposit, deadline: request.deadline }
          : {}),
      };
      const result = {
        correlationId: randomUUID(),
        timestamp: new Date().toISOString(),
        signature: '',
        quoteRequest: request,
        quote,
      } as QuoteResponse;
      result.signature = `ed25519:${bs58.encode(sign(null, Buffer.from(quoteHash(result)), manager.privateKey))}`;
      if (quote.depositAddress) quotes.set(quote.depositAddress, result);
      return Response.json(result);
    }
    if (endpoint.pathname === '/v0/status') {
      const q = quotes.get(endpoint.searchParams.get('depositAddress')!)!;
      const first = q.quoteRequest.originAsset === base;
      if (first && options.firstLegRefund)
        return Response.json({
          correlationId: randomUUID(),
          updatedAt: new Date().toISOString(),
          quoteResponse: q,
          status: 'REFUNDED',
          swapDetails: {
            amountIn: q.quote.amountIn,
            refundedAmount: '4998000',
            originChainTxHashes: [
              { hash: broadcasts[0], explorerUrl: 'https://fixture.invalid/deposit' },
              { hash: tokenReceipt, explorerUrl: 'https://fixture.invalid/refund' },
            ],
            destinationChainTxHashes: [],
            nearTxHashes: [],
            intentHashes: [],
          },
        });
      return Response.json({
        correlationId: randomUUID(),
        updatedAt: new Date().toISOString(),
        quoteResponse: q,
        status: 'SUCCESS',
        swapDetails: {
          amountIn: q.quote.amountIn,
          amountOut: q.quote.amountOut,
          originChainTxHashes: [
            { hash: broadcasts[first ? 0 : 1], explorerUrl: 'https://fixture.invalid/deposit' },
          ],
          destinationChainTxHashes: [
            {
              hash: first ? nativeReceipt : tokenReceipt,
              explorerUrl: 'https://fixture.invalid/receipt',
            },
          ],
          nearTxHashes: [],
          intentHashes: [],
        },
      });
    }
    if (endpoint.pathname === '/v0/deposit/submit') return Response.json({ status: 'OK' });
    throw new Error(`Unexpected local fixture endpoint ${endpoint.pathname}`);
  });
  const treasury: LivePorts['treasury'] = {
    authorize: async (authorization) => {
      const old = records.get(authorization.cycle_id);
      if (old) {
        expect(digest(old.authorization)).toBe(digest(authorization));
        return;
      }
      records.set(authorization.cycle_id, {
        authorization,
        status: 'AUTHORIZED',
        payload_hex: null,
        signature: null,
        tx_hash: null,
        realized_pnl_atoms: null,
        reconciliation_hash: null,
      });
    },
    cycle: async (id) => structuredClone(records.get(id) ?? null),
    service: async () => {
      throw new Error('Fixture requires Intents service port');
    },
    call: async <T>(_role: ContractRole, method: string, args: Record<string, unknown>) => {
      const id = String(args.cycle_id),
        r = records.get(id)!;
      if (method === 'request_evm_signature' || method === 'request_solana_signature') {
        expect(r.status).toBe('AUTHORIZED');
        const transfer = unsigned.get(id)!;
        signedCalls.push(id);
        let signature: unknown;
        if (method === 'request_evm_signature') {
          const s = parseSignature(await evmSigner.sign({ hash: `0x${transfer.payloadHex}` }));
          signature = {
            big_r: { affine_point: `02${s.r.slice(2)}` },
            s: { scalar: s.s.slice(2) },
            recovery_id: s.yParity,
          };
        } else {
          const key = createPrivateKey({
            key: Buffer.concat([
              Buffer.from('302e020100300506032b657004220420', 'hex'),
              solSigner.secretKey.subarray(0, 32),
            ]),
            format: 'der',
            type: 'pkcs8',
          });
          signature = {
            scheme: 'Ed25519',
            signature: [...sign(null, Buffer.from(transfer.payloadHex, 'hex'), key)],
          };
        }
        r.payload_hex = transfer.payloadHex;
        r.signature = JSON.stringify(signature);
        r.status = 'SIGNED';
        return signature as T;
      }
      if (method === 'record_submission') {
        r.tx_hash = String(args.tx_hash);
        r.status = 'SUBMITTED';
        return undefined as T;
      }
      if (method === 'finalize_cycle') {
        r.status = 'CLOSED';
        r.realized_pnl_atoms = String(args.realized_pnl_atoms);
        r.reconciliation_hash = String(args.reconciliation_hash);
        return r as T;
      }
      if (method === 'mint_proof_nft')
        return { token_id: `fixture:${id}`, owner_id: store.config.NFT_RECEIVER_ID } as T;
      throw new Error(`Unexpected fixture contract method ${method}`);
    },
  };
  const ports: LivePorts = {
    oneclick,
    treasury,
    wallets,
    payments: {
      settle: async (_cycle, id) => {
        payments.push(id);
      },
    },
    ai: {
      assess: async (id, p, q): Promise<BrainResult> => ({
        assessment: {
          execute: true,
          reason: 'Explicit local orchestration fixture; no hardware attestation',
          maxSlippageBps: 50,
          proposalDigest: digest({ proposal: p, quote: q }),
        },
        proof: {
          kind: 'NEAR_AI',
          status: 'VERIFIED',
          model: 'TEST_TRANSPORT_ONLY',
          requestHash: digest(p),
          responseHash: digest(q),
          signer: null,
          measurement: null,
          evidence: { fixture: true },
          publicDetails: { fixture: true, hardwareVerified: false },
        },
        usage: {
          requestId: `fixture:${id}`,
          model: 'TEST_TRANSPORT_ONLY',
          inputTokens: 1,
          outputTokens: 1,
          costUsdMicros: '100',
          billingSource: 'TEST_TRANSPORT_ONLY',
        },
      }),
    },
  };
  const providers = new LiveProviders(store, ports);
  return {
    providers,
    ports,
    broadcasts,
    broadcastInputs,
    signedCalls,
    payments,
    prepares: () => prepares,
    records,
  };
}
async function start(f: ReturnType<typeof fixture>) {
  await f.providers.reconcileIdleBalance();
  const p = Proposal.parse({
    strategy: 'round-trip',
    originChain: 'eip155:8453',
    destinationChain: 'solana:mainnet',
    originAsset: base,
    intermediateAsset: middle,
    amountAtoms: '5000000',
    recipient: evmSigner.address,
    refundTo: evmSigner.address,
    slippageBps: 50,
    expiresAt: new Date(Date.now() + 600000).toISOString(),
  });
  return (await store.createCycle(p, randomUUID())).cycle;
}
async function run(f: ReturnType<typeof fixture>, count = 18) {
  const engine = new Engine(store, new LiveProviders(store, f.ports));
  for (let n = 0; n < count; n++) {
    await db.job.updateMany({ where: { doneAt: null }, data: { availableAt: new Date(0) } });
    await db.liveLeg.updateMany({
      where: { lastBroadcastAt: { not: null } },
      data: { lastBroadcastAt: new Date(0) },
    });
    await engine.tick();
  }
}
it('runs both live-provider legs with real local signatures, signed quote verification and native fee accounting', async () => {
  const f = fixture(),
    cycle = await start(f);
  await run(f);
  const result = await store.getCycle(cycle.id);
  expect(result.state).toBe('CLOSED');
  expect(f.prepares()).toBe(2);
  expect(f.broadcasts).toHaveLength(2);
  expect(f.signedCalls).toHaveLength(2);
  expect(new Set(f.payments).size).toBe(2);
  expect(await db.reservation.count({ where: { status: 'ACTIVE' } })).toBe(0);
  expect(
    await db.chainTransaction.count({ where: { cycleId: cycle.id, operation: 'INTENTS_RECEIPT' } }),
  ).toBe(2);
  expect(await db.journal.count({ where: { cycleId: cycle.id, kind: 'NATIVE_CHAIN_COST' } })).toBe(
    2,
  );
  expect(await store.balance()).toBe(20_200_000n);
});
it.each(['EVM', 'SOLANA'] as const)(
  'recovers a lost %s broadcast reply without another signature or deposit',
  async (chain) => {
    const f = fixture({ lostBroadcast: chain }),
      cycle = await start(f);
    await run(f);
    expect((await store.getCycle(cycle.id)).state).toBe('CLOSED');
    expect(f.prepares()).toBe(2);
    expect(f.signedCalls).toHaveLength(2);
    expect(f.broadcasts).toHaveLength(2);
  },
);
it('refuses to recognize a return payment to another recipient and holds the capital reservation', async () => {
  const f = fixture({ wrongRecipient: true }),
    cycle = await start(f);
  await run(f);
  expect((await store.getCycle(cycle.id)).state).toBe('SETTLING');
  expect(await db.reservation.count({ where: { cycleId: cycle.id, status: 'ACTIVE' } })).toBe(1);
  expect(await db.journal.count({ where: { cycleId: cycle.id, kind: 'TRADING_RESULT' } })).toBe(0);
});
it.each(['EVM', 'SOLANA'] as const)(
  'recovers a %s send that never reached the chain using identical signed bytes',
  async (chain) => {
    const f = fixture({ droppedBroadcast: chain }),
      cycle = await start(f);
    await run(f, 24);
    expect((await store.getCycle(cycle.id)).state).toBe('CLOSED');
    expect(f.prepares()).toBe(2);
    expect(f.signedCalls).toHaveLength(2);
    expect(f.broadcasts).toHaveLength(2);
    expect(f.broadcastInputs).toHaveLength(3);
    expect(new Set(f.broadcastInputs).size).toBe(2);
  },
);
it('closes the on-chain authorization after a confirmed first-leg refund and does not mint profit rights', async () => {
  const f = fixture({ firstLegRefund: true }),
    cycle = await start(f);
  await run(f);
  expect((await store.getCycle(cycle.id)).state).toBe('REFUNDED');
  expect(f.prepares()).toBe(1);
  expect(f.broadcasts).toHaveLength(1);
  expect(f.records.get(`${cycle.id}:1`)?.status).toBe('CLOSED');
  expect(await store.balance()).toBe(19_998_000n);
  expect(await db.reservation.count({ where: { cycleId: cycle.id, status: 'ACTIVE' } })).toBe(0);
  expect(await db.proof.count({ where: { cycleId: cycle.id, kind: 'EXECUTION_RECEIPT' } })).toBe(0);
});
it.each(['EVM', 'SOLANA'] as const)(
  'bounds %s send retries and retains reserves after the retry budget is exhausted',
  async (chain) => {
    const f = fixture({ neverAccept: chain }),
      cycle = await start(f);
    await run(f, 24);
    const leg = await db.liveLeg.findUniqueOrThrow({
      where: { id: `${cycle.id}:${chain === 'EVM' ? 1 : 2}` },
    });
    expect(leg.broadcastAttempts).toBe(store.config.MAX_BROADCAST_ATTEMPTS);
    expect(leg.lastBroadcastError).toBe('BROADCAST_OUTCOME_UNKNOWN');
    expect(f.broadcastInputs.length).toBe(
      store.config.MAX_BROADCAST_ATTEMPTS + (chain === 'EVM' ? 0 : 1),
    );
    expect(f.signedCalls.length).toBe(chain === 'EVM' ? 1 : 2);
    expect(await db.reservation.count({ where: { cycleId: cycle.id, status: 'ACTIVE' } })).toBe(1);
    expect(await db.journal.count({ where: { cycleId: cycle.id, kind: 'TRADING_RESULT' } })).toBe(
      0,
    );
  },
);
it('honors the persisted cooldown after an unknown send outcome', async () => {
  const f = fixture({ droppedBroadcast: 'EVM' }),
    cycle = await start(f),
    engine = new Engine(store, f.providers);
  for (let n = 0; n < 6; n++) await engine.tick();
  expect((await store.getCycle(cycle.id)).state).toBe('UNKNOWN');
  expect(f.broadcastInputs).toHaveLength(1);
});
it('does not let an unavailable idle-balance API block reconciliation of committed capital', async () => {
  const f = fixture(),
    cycle = await start(f),
    engine = new Engine(store, f.providers);
  for (let n = 0; n < 3; n++) await engine.tick();
  expect((await store.getCycle(cycle.id)).state).toBe('RESERVED');
  const tokens = vi
    .spyOn(f.ports.oneclick, 'tokens')
    .mockRejectedValue(new Error('Fixture registry unavailable'));
  await expect(f.providers.reconcileIdleBalance()).resolves.toBeUndefined();
  expect(tokens).not.toHaveBeenCalled();
});
it('uses the same confirmation boundary for idle balances and incoming-transfer evidence', async () => {
  const f = fixture(),
    balance = vi.spyOn(f.ports.wallets, 'balance');
  await f.providers.reconcileIdleBalance();
  expect(balance).toHaveBeenCalledWith('eip155:8453', token, 996n);
  const observed = await db.outboxEvent.findFirstOrThrow({
    where: { mode: 'LIVE', topic: 'treasury.reconciled' },
  });
  expect((observed.payload as { block: string }).block).toBe('996');
});
