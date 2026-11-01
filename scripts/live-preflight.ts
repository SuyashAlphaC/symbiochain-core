import { loadConfig } from '../src/config.js';
const c = loadConfig({ ...process.env, EXECUTION_MODE: 'PAPER' });
const required = [
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
  'EVM_RPC_URL',
  'NFT_RECEIVER_ID',
] as const;
const missing: string[] = required.filter((key) => !c[key]);
if (c.COMPUTE_CREDIT_POLICY === 'PROVIDER_BALANCE')
  for (const key of ['NEAR_AI_ORG_ID', 'NEAR_AI_SESSION_TOKEN'] as const)
    if (!c[key]) missing.push(key);
if (c.SERVICE_PAYMENT_RAIL === 'INTENTS' && BigInt(c.SERVICE_PAYMENT_YOCTO) > 0n)
  for (const key of ['INTENTS_BRAIN_PRIVATE_KEY', 'INTENTS_HAND_PRIVATE_KEY'] as const)
    if (!c[key]) missing.push(key);
const concerns = [];
if (c.NEAR_NETWORK !== 'mainnet') concerns.push('NEAR mainnet is not selected');
if (!c.TEE_GATEWAY_COMPOSE_HASHES.length || !c.TEE_MODEL_COMPOSE_HASHES.length)
  concerns.push('Independently approved TEE measurements are missing');
if (c.ADMIN_TOKEN.startsWith('local-demo') || c.READ_TOKEN.startsWith('local-demo'))
  concerns.push('Public example authentication tokens remain configured');
if (
  c.EVIDENCE_ENCRYPTION_KEY === '9c2f2503f551fb28a6f481b520f2520b1ab0340f5a0117c566cdd674c68b76e8'
)
  concerns.push('Public example encryption key remains configured');
if (c.SOLANA_RPC_URL.includes('devnet')) concerns.push('Solana RPC still targets devnet');
if (
  c.COMPUTE_CREDIT_POLICY === 'LOCAL_BUDGET' &&
  (c.NEAR_AI_MODEL !== 'z-ai/glm-5.3-flash' ||
    new URL(c.NEAR_AI_BASE_URL).origin !== 'https://cloud-api.near.ai')
)
  concerns.push('Local budget requires the reviewed canonical NEAR GLM model');
console.log(
  JSON.stringify(
    {
      activeMode: process.env.EXECUTION_MODE ?? 'PAPER',
      liveTradingEnabled: c.LIVE_TRADING_ENABLED,
      oneclickAuthentication: c.ONECLICK_JWT ? 'AUTHENTICATED' : 'ANONYMOUS',
      computeCreditPolicy: c.COMPUTE_CREDIT_POLICY,
      providerCreditBalanceRequired: c.COMPUTE_CREDIT_POLICY === 'PROVIDER_BALANCE',
      configurationReady: missing.length === 0 && concerns.length === 0,
      missingDedicatedSettings: missing,
      concerns,
      networkChecksPerformed: false,
      transactionsPerformed: false,
      notice:
        'Configuration presence only. Funding, access-key scope, contract identity, measurements and provider capabilities need separate live validation.',
    },
    null,
    2,
  ),
);
if (missing.length || concerns.length) process.exitCode = 2;
