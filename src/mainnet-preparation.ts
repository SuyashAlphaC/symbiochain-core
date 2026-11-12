import { randomUUID } from 'node:crypto';
import type { Config } from './config.js';
import { Store, json } from './store.js';
import { MainnetReader } from './mainnet.js';
import { DomainError, Proposal } from './domain.js';
import { ChainWallets } from './providers/wallets.js';
import { OneClickClient } from './providers/oneclick.js';
import { RoundTripQuotes } from './providers/route-quotes.js';
import { quoteProfitCheck } from './policy.js';
import { MainnetPreparation, MainnetPreparationReport } from './mainnet-preparation-contract.js';
import type { Quote } from './domain.js';

const TOPIC = 'mainnet.preparation';
const GENESIS = '5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d';
export interface PreparationPorts {
  state(): Promise<{
    codeMatches: boolean;
    paused: boolean;
    workers: number;
    allowedChains: number[];
    allowedTokens: string[];
    maxTradeAtoms: string;
  }>;
  wallets(): Promise<{
    evmChain: number;
    solanaGenesis: string;
    wallets: MainnetPreparationReport['wallets'];
  }>;
  quote(proposal: Proposal): Promise<Quote>;
}

/** Every port is read-only. No Engine, NearTreasury, AI client or Intents signer is constructed. */
export async function inspectMainnetPreparation(c: Config, ports: PreparationPorts) {
  if (!c.MAINNET_PREPARATION_ENABLED || c.EXECUTION_MODE !== 'LIVE' || c.EXECUTION_ENABLED)
    throw new DomainError('PREPARATION_DISABLED', 'Read-only mainnet preparation is not enabled');
  const checks: MainnetPreparationReport['checks'] = [];
  const check = (id: string, passes: boolean, detail: string) =>
    checks.push({ id, status: passes ? 'PASS' : 'BLOCKED', detail });
  let wallets: MainnetPreparationReport['wallets'] = [];
  let networkValid = false;
  const input = BigInt(c.MAX_TRADE_ATOMS) < 50000n ? c.MAX_TRADE_ATOMS : '50000';
  const costs = (BigInt(c.GAS_COST_BASE_ATOMS) + BigInt(c.LIVE_COST_BUFFER_ATOMS)).toString();
  let quote: MainnetPreparationReport['quote'] = {
    status: 'UNAVAILABLE',
    inputAtoms: input,
    minimumOutputAtoms: null,
    costAllowanceAtoms: costs,
    requiredOutputAtoms: null,
    passesProfitFloor: false,
    quoteDigest: null,
    expiresAt: null,
  };
  try {
    const state = await ports.state();
    check(
      'TREASURY_IDENTITY',
      state.codeMatches,
      'Treasury executable must match the reviewed deployment.',
    );
    check(
      'OWNER_ACTIVATION',
      !state.paused && state.workers === 3,
      'The treasury must be unpaused with all three worker permissions enabled.',
    );
    check(
      'BASE_AUTHORIZATION',
      state.allowedChains.includes(c.EVM_CHAIN_ID) &&
        state.allowedTokens.some(
          (t) => t.toLowerCase() === '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913',
        ) &&
        BigInt(state.maxTradeAtoms) >= BigInt(input),
      'Base USDC must fit the owner-approved contract policy.',
    );
    check(
      'SOLANA_RETURN_AUTHORIZATION',
      state.allowedChains.includes(0) && state.allowedTokens.includes('sol:native'),
      'The SOL return leg needs an owner-signed chain-0 and sol:native policy with native-unit token caps. Current Base-only permissions do not authorize it.',
    );
  } catch {
    checks.push({
      id: 'TREASURY_STATE',
      status: 'UNAVAILABLE',
      detail: 'Finalized treasury policy could not be checked.',
    });
  }
  try {
    const observed = await ports.wallets();
    wallets = observed.wallets;
    networkValid = observed.evmChain === c.EVM_CHAIN_ID && observed.solanaGenesis === GENESIS;
    check(
      'MAINNET_ENDPOINTS',
      networkValid,
      'Base chain ID and Solana mainnet genesis are checked against the serving RPCs.',
    );
    const base = wallets.find((w) => w.chain === 'BASE'),
      solana = wallets.find((w) => w.chain === 'SOLANA');
    check(
      'BASE_CAPITAL',
      !!base && BigInt(base.tokenAtoms ?? '0') >= BigInt(input),
      `The derived Base wallet needs at least ${input} USDC atoms; native NEAR is not USDC trading capital.`,
    );
    check(
      'BASE_GAS',
      !!base &&
        BigInt(base.nativeAtoms) >= BigInt(c.EVM_MAX_GAS) * BigInt(c.EVM_MAX_FEE_PER_GAS_WEI),
      'The derived Base wallet must cover the configured maximum transfer-gas budget in ETH.',
    );
    check(
      'SOLANA_GAS',
      !!solana && BigInt(solana.nativeAtoms) >= BigInt(c.SOLANA_FEE_RESERVE_LAMPORTS),
      'The derived Solana wallet must retain the configured native SOL fee reserve.',
    );
  } catch {
    checks.push({
      id: 'WALLET_FUNDING',
      status: 'UNAVAILABLE',
      detail: 'Derived mainnet wallet balances could not be verified.',
    });
  }
  const base = wallets.find((w) => w.chain === 'BASE');
  if (networkValid && base && BigInt(input) > 0n) {
    try {
      const p = Proposal.parse({
        strategy: 'round-trip',
        originChain: `eip155:${c.EVM_CHAIN_ID}`,
        destinationChain: 'solana:mainnet',
        originAsset: c.BASE_ASSET,
        intermediateAsset: 'nep141:sol.omft.near',
        amountAtoms: input,
        recipient: base.address,
        refundTo: base.address,
        slippageBps: 0,
        expiresAt: new Date(Date.now() + 120000).toISOString(),
      });
      const q = await ports.quote(p);
      const profit = quoteProfitCheck(q, c.MIN_NET_PROFIT_ATOMS);
      quote = {
        status: 'VALIDATED',
        inputAtoms: input,
        minimumOutputAtoms: q.minimumOutputAtoms,
        costAllowanceAtoms: q.costsAtoms,
        requiredOutputAtoms: profit.requiredMinimumOutputAtoms,
        passesProfitFloor: profit.passesProfitFloor,
        quoteDigest: q.id,
        expiresAt: q.expiresAt,
      };
      check(
        'PROFITABLE_SIGNED_ROUTE',
        profit.passesProfitFloor,
        'Two real signed dry quotes must clear gas/operating buffers and the unchanged profit floor. A dry quote does not reserve capital or settle a trade.',
      );
    } catch {
      checks.push({
        id: 'PROFITABLE_SIGNED_ROUTE',
        status: 'UNAVAILABLE',
        detail:
          'The provider supplied no usable signed round trip at the approved size. No funded quote or trade was requested.',
      });
    }
  } else
    check(
      'PROFITABLE_SIGNED_ROUTE',
      false,
      'Verified mainnet endpoints and derived addresses are required before quoting.',
    );
  const ready = checks.every((c) => c.status === 'PASS');
  return MainnetPreparationReport.parse({
    id: randomUUID(),
    capturedAt: new Date().toISOString(),
    scope: 'REAL_MAINNET_READ_ONLY_PREPARATION',
    checks,
    wallets,
    quote,
    nonTeeReady: ready,
    nextGate: ready ? 'TEE_APPROVAL_REQUIRED' : 'NON_TEE_REQUIREMENTS',
    paidInferenceRequests: 0,
    transactionsSubmitted: 0,
    economicClaimsProven: false,
  });
}

export async function runMainnetPreparation(store: Store, ports?: PreparationPorts) {
  if (!ports) {
    const c = store.config,
      reader = new MainnetReader(c),
      wallets = new ChainWallets(c);
    const quotes = new RoundTripQuotes(c, new OneClickClient(c), wallets);
    ports = {
      state: async () => {
        const s = await reader.snapshot(),
          p = await reader.activationPolicy(s.block.hash);
        return {
          codeMatches: s.code.matches,
          paused: s.paused,
          workers: s.accounts.filter((a) => a.workerEnabled).length,
          allowedChains: p.allowed_chain_ids,
          allowedTokens: p.allowed_token_contracts,
          maxTradeAtoms: s.policy.maxTradeAtoms,
        };
      },
      wallets: async () => {
        const [evmChain, solanaGenesis, baseAddress, solAddress, block, slot] = await Promise.all([
          wallets.evm.getChainId(),
          wallets.solana.getGenesisHash(),
          wallets.address(`eip155:${c.EVM_CHAIN_ID}`),
          wallets.address('solana:mainnet'),
          wallets.evm.getBlockNumber(),
          wallets.solana.getSlot('finalized'),
        ]);
        const confirmed = block - BigInt(c.EVM_CONFIRMATIONS) + 1n;
        if (confirmed < 0n)
          throw new DomainError('CHAIN_NOT_READY', 'Insufficient confirmed history');
        const [native, token, sol] = await Promise.all([
          wallets.evm.getBalance({ address: baseAddress as `0x${string}`, blockNumber: confirmed }),
          wallets.balance(
            `eip155:${c.EVM_CHAIN_ID}`,
            '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
            confirmed,
          ),
          wallets.balance('solana:mainnet', 'sol:native'),
        ]);
        return {
          evmChain,
          solanaGenesis,
          wallets: [
            {
              chain: 'BASE',
              address: baseAddress,
              nativeAtoms: native.toString(),
              tokenAtoms: token.toString(),
              block: confirmed.toString(),
            },
            {
              chain: 'SOLANA',
              address: solAddress,
              nativeAtoms: sol.toString(),
              tokenAtoms: null,
              block: String(slot),
            },
          ],
        };
      },
      quote: (p) => quotes.quote(p),
    };
  }
  const report = await inspectMainnetPreparation(store.config, ports);
  await store.atomic((tx) => store.event(tx, TOPIC, report));
  return report;
}

export async function mainnetPreparation(store: Store) {
  if (store.mode !== 'LIVE' || store.config.NEAR_NETWORK !== 'mainnet')
    throw new DomainError('MAINNET_ONLY', 'Mainnet preparation is separate from PAPER data', 403);
  const row = await store.db.outboxEvent.findFirst({
    where: { mode: store.mode, topic: TOPIC },
    orderBy: { seq: 'desc' },
  });
  const report = row ? MainnetPreparationReport.parse(row.payload) : null;
  return MainnetPreparation.parse({
    contractVersion: 1,
    enabled: store.config.MAINNET_PREPARATION_ENABLED,
    report,
    stale:
      !report ||
      Date.now() < Date.parse(report.capturedAt) ||
      Date.now() - Date.parse(report.capturedAt) > 600000,
    executionEnabled: store.config.EXECUTION_ENABLED,
    tee: 'QUARANTINED',
  });
}
