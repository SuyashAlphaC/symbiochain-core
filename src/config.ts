import 'dotenv/config';
import { z } from 'zod';
import { Mode, atoms } from './domain.js';
const list = z.string().transform((v) =>
  v
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean),
);
const bool = z.enum(['true', 'false']).transform((v) => v === 'true');
const Schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  EXECUTION_MODE: Mode.default('PAPER'),
  DATABASE_URL: z.string().min(1),
  DATABASE_POOL_MAX: z.coerce.number().int().min(1).max(20).default(10),
  HOST: z.string().default('127.0.0.1'),
  PORT: z.coerce.number().int().min(1).max(65535).default(3001),
  LOG_LEVEL: z.enum(['silent', 'fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),
  ADMIN_TOKEN: z.string().min(32),
  READ_TOKEN: z.string().min(32),
  CORS_ORIGINS: list.prefault('http://localhost:3000'),
  EVIDENCE_ENCRYPTION_KEY: z.string().regex(/^[a-fA-F0-9]{64}$/),
  BASE_ASSET: z.string().default('USDC'),
  BASE_DECIMALS: z.coerce.number().int().min(0).max(24).default(6),
  MAX_TRADE_ATOMS: atoms.default('10000000'),
  MAX_DAILY_SPEND_ATOMS: atoms.default('50000000'),
  MIN_RESERVE_ATOMS: atoms.default('2000000'),
  MIN_NET_PROFIT_ATOMS: atoms.default('10000'),
  MAX_SLIPPAGE_BPS: z.coerce.number().int().min(0).max(1000).default(50),
  ALLOWED_ASSETS: list.prefault('USDC,WNEAR'),
  ALLOWED_CHAINS: list.prefault('near:paper,eip155:31337'),
  ALLOWED_RECIPIENTS: list.prefault('paper.treasury'),
  WORKER_POLL_MS: z.coerce.number().int().min(50).default(500),
  WORKER_LEASE_MS: z.coerce.number().int().min(1000).default(60000),
  SCOUT_INTERVAL_MS: z.coerce.number().int().min(1000).default(10000),
  LIVE_TRADING_ENABLED: bool.prefault('false'),
  ENABLE_CHAOS_DEMO: bool.prefault('false'),
  NEAR_NETWORK: z.enum(['mainnet', 'testnet', 'sandbox']).default('testnet'),
  NEAR_RPC_URL: z.url().default('https://rpc.testnet.near.org'),
  NEAR_CONTRACT_ID: z.string().default(''),
  NEAR_WORKER_ACCOUNT_ID: z.string().default(''),
  NEAR_WORKER_PRIVATE_KEY: z.string().default(''),
  NEAR_AI_API_KEY: z.string().default(''),
  NEAR_AI_MODEL: z.string().default(''),
  NEAR_AI_ORG_ID: z.string().default(''),
  NEAR_AI_SESSION_TOKEN: z.string().default(''),
  MIN_COMPUTE_CREDIT_USD_MICROS: atoms.default('100000'),
  SYNC_STAKING_CREDITS: bool.prefault('false'),
  NEAR_AI_BASE_URL: z.url().default('https://cloud-api.near.ai'),
  TEE_GATEWAY_COMPOSE_HASHES: list.prefault(''),
  TEE_MODEL_COMPOSE_HASHES: list.prefault(''),
  ONECLICK_API_BASE_URL: z.url().default('https://1click.chaindefuser.com'),
  ONECLICK_JWT: z.string().default(''),
  ONECLICK_MANAGER_PUBLIC_KEY: z
    .string()
    .default('ed25519:reYaWhvwu8Jzo3WUM3zhn6VrhuMEF4eADL17qtRVifc'),
  EVM_RPC_URL: z.string().default(''),
  EVM_CHAIN_ID: z.coerce.number().int().positive().default(8453),
  SOLANA_RPC_URL: z.url().default('https://api.devnet.solana.com'),
  NEAR_BRAIN_ACCOUNT_ID: z.string().default(''),
  NEAR_BRAIN_PRIVATE_KEY: z.string().default(''),
  NEAR_SCOUT_ACCOUNT_ID: z.string().default(''),
  NEAR_ACCOUNTANT_ACCOUNT_ID: z.string().default(''),
  NEAR_ACCOUNTANT_PRIVATE_KEY: z.string().default(''),
  CHAIN_SIGNATURES_CONTRACT: z.string().default('v1.signer'),
  CHAIN_DERIVATION_PATH: z.string().default('symbio-v1'),
  EVM_CONFIRMATIONS: z.coerce.number().int().min(1).default(5),
  MAX_BROADCAST_ATTEMPTS: z.coerce.number().int().min(1).max(10).default(3),
  REBROADCAST_INTERVAL_MS: z.coerce.number().int().min(1000).max(300000).default(30000),
  EVM_MAX_FEE_PER_GAS_WEI: atoms.default('2000000000'),
  EVM_MAX_GAS: atoms.default('150000'),
  SOLANA_FEE_RESERVE_LAMPORTS: atoms.default('10000000'),
  LIVE_COST_BUFFER_ATOMS: atoms.default('100000'),
  // One base atom denomination only; explicit gas conversion must be conservative.
  GAS_COST_BASE_ATOMS: atoms.default('100000'),
  NFT_RECEIVER_ID: z.string().default(''),
  NFT_SHARE_BPS: z.coerce.number().int().min(0).max(10000).default(0),
  SERVICE_PAYMENT_YOCTO: atoms.default('1000000000000000000000'),
  SERVICE_PAYMENT_RAIL: z.enum(['INTENTS', 'NEAR_LEDGER']).default('INTENTS'),
  INTENTS_CONTRACT_ID: z.string().default('intents.near'),
  INTENTS_BRAIN_PRIVATE_KEY: z.string().default(''),
  INTENTS_HAND_PRIVATE_KEY: z.string().default(''),
  SCOUT_ROUTES_FILE: z.string().default(''),
});
export type Config = z.infer<typeof Schema>;
export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const c = Schema.parse(env);
  if (c.EXECUTION_MODE === 'LIVE') {
    if (
      c.EVIDENCE_ENCRYPTION_KEY ===
      '9c2f2503f551fb28a6f481b520f2520b1ab0340f5a0117c566cdd674c68b76e8'
    )
      throw new Error('LIVE refuses the public example evidence-encryption key');
    if (!c.LIVE_TRADING_ENABLED) throw new Error('LIVE requires LIVE_TRADING_ENABLED=true');
    for (const key of [
      'NEAR_CONTRACT_ID',
      'NEAR_WORKER_ACCOUNT_ID',
      'NEAR_WORKER_PRIVATE_KEY',
      'NEAR_BRAIN_ACCOUNT_ID',
      'NEAR_BRAIN_PRIVATE_KEY',
      'NEAR_SCOUT_ACCOUNT_ID',
      'NEAR_ACCOUNTANT_ACCOUNT_ID',
      'NEAR_ACCOUNTANT_PRIVATE_KEY',
      'NEAR_AI_API_KEY',
      'NEAR_AI_MODEL',
      'NEAR_AI_ORG_ID',
      'NEAR_AI_SESSION_TOKEN',
      'EVM_RPC_URL',
      'NFT_RECEIVER_ID',
    ] as const) {
      if (!c[key]) throw new Error(`LIVE requires ${key}`);
    }
    if (c.ADMIN_TOKEN.startsWith('local-demo') || c.READ_TOKEN.startsWith('local-demo'))
      throw new Error('LIVE refuses demo authentication tokens');
    if (c.ENABLE_CHAOS_DEMO) throw new Error('Chaos controls cannot run in LIVE');
    if (!c.TEE_GATEWAY_COMPOSE_HASHES.length || !c.TEE_MODEL_COMPOSE_HASHES.length)
      throw new Error(
        'LIVE requires independently approved gateway and model compose measurements',
      );
    if (c.NEAR_NETWORK !== 'mainnet')
      throw new Error(
        '1Click has no testnet; LIVE requires NEAR mainnet and funded target-chain wallets',
      );
  }
  if (
    c.EXECUTION_MODE === 'LIVE' &&
    c.SERVICE_PAYMENT_RAIL === 'INTENTS' &&
    BigInt(c.SERVICE_PAYMENT_YOCTO) > 0n
  ) {
    if (!c.INTENTS_BRAIN_PRIVATE_KEY || !c.INTENTS_HAND_PRIVATE_KEY)
      throw new Error('Intents payments require separate receiver-scoped agent keys');
    if (
      c.INTENTS_BRAIN_PRIVATE_KEY === c.NEAR_BRAIN_PRIVATE_KEY ||
      c.INTENTS_HAND_PRIVATE_KEY === c.NEAR_WORKER_PRIVATE_KEY
    )
      throw new Error('Use separate keys for the treasury and Intents receivers');
  }
  if (c.ADMIN_TOKEN === c.READ_TOKEN) throw new Error('Admin and read tokens must differ');
  return c;
}
