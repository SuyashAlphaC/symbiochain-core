import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { MainnetReader } from '../dist/mainnet.js';
import { MainnetAcceptance } from '../dist/mainnet-acceptance-contract.js';
import { verifyFundingReceipt } from '../tools/mainnet-deploy/funding-plan.mjs';
import {
  verifyServiceReceipt,
  SERVICE_DEPOSIT,
} from '../tools/mainnet-deploy/service-roundtrip-plan.mjs';
import { ROOT, rpc, RPC } from '../tools/mainnet-deploy/plan.mjs';
const ARCHIVE = 'https://archival-rpc.mainnet.fastnear.com';
const m = JSON.parse(await readFile('artifacts/mainnet-paused-deployment.json', 'utf8'));
const c = {
  EXECUTION_MODE: 'LIVE',
  EXECUTION_ENABLED: false,
  NEAR_NETWORK: 'mainnet',
  NEAR_RPC_URL: RPC,
  NEAR_CONTRACT_ID: m.treasury,
  NEAR_WORKER_ACCOUNT_ID: m.accounts.hand,
  NEAR_BRAIN_ACCOUNT_ID: m.accounts.brain,
  NEAR_SCOUT_ACCOUNT_ID: m.accounts.scout,
  NEAR_ACCOUNTANT_ACCOUNT_ID: m.accounts.accountant,
  NEAR_AI_MODEL: 'z-ai/glm-5.3-flash',
  AI_TOTAL_BUDGET_USD_MICROS: '1000000',
  AI_MAX_REQUEST_USD_MICROS: '100000',
};
// All calls are read-only. Serialize them to respect public RPC rate limits.
let readQueue = Promise.resolve();
const pause = (ms) => new Promise((r) => setTimeout(r, ms));
const pacedRead = (url, init) => {
  const method = JSON.parse(String(init?.body)).method;
  if (!['query', 'status', 'block', 'tx', 'EXPERIMENTAL_protocol_config'].includes(method))
    throw Error('READ_ONLY_RUNNER_REFUSES_MUTATION');
  const result = readQueue.then(async () => {
    for (let attempt = 0; attempt < 3; attempt++) {
      await pause(1200 + attempt * 1500);
      const response = await fetch(url, { ...init, signal: AbortSignal.timeout(20000) });
      if (![429, 502, 503, 504].includes(response.status) || attempt === 2) return response;
      await response.body?.cancel();
    }
    throw Error('RPC_UNAVAILABLE');
  });
  readQueue = result.then(
    () => {},
    () => {},
  );
  return result;
};
const reader = new MainnetReader(c, pacedRead),
  snapshot = await reader.snapshot();
const checks = [],
  transactions = [];
const add = (id, label, status, scope, detail, links = []) =>
  checks.push({ id, label, status, scope, detail, links });
const state = (id, label, pass, detail) =>
  add(id, label, pass ? 'PASSED' : 'BLOCKED', 'ON_CHAIN_STATE', detail, [
    `https://nearblocks.io/address/${m.treasury}`,
  ]);
const block = (id, label, detail) => add(id, label, 'BLOCKED', 'NOT_EXECUTED', detail);
state(
  'network',
  'Mainnet network and finality',
  snapshot.network === 'mainnet',
  `Read finalized NEAR mainnet block ${snapshot.block.height}.`,
);
state(
  'deployment',
  'Deployed executable identity',
  snapshot.code.matches,
  `Observed treasury code ${snapshot.code.observedHash}; compared with the reviewed WASM digest.`,
);
state(
  'accounts',
  'Mainnet owner and agent accounts',
  snapshot.accounts.length === 6,
  'Owner, treasury, Scout, Brain, Hand and accountant accounts exist on mainnet.',
);
state(
  'custody',
  'Recovery custody and temporary-key revocation',
  snapshot.deployment.temporaryKeyRevoked &&
    snapshot.accounts.every((a) => a.recoveryKeyPresent && a.fullAccessKeyCount === 1),
  'Reviewed recovery key is present on all six accounts; no temporary deployment full-access key remains.',
);
state(
  'roles',
  'Deployed worker permission state',
  snapshot.accounts.filter((a) => a.workerEnabled !== null).every((a) => a.workerEnabled === false),
  'Three execution worker permissions are disabled. This observes deployed permissions; it is not a positive agent-authorization test.',
);
state(
  'pause',
  'On-chain paused state',
  snapshot.paused,
  'Treasury remains paused on mainnet. No unpause is requested by this acceptance runner.',
);
state(
  'policy_read',
  'Read deployed spending policy',
  true,
  `Read caps ${snapshot.policy.maxTradeAtoms}/${snapshot.policy.maxDailyAtoms} atomic units and reserve ${snapshot.policy.minReserveYocto} yoctoNEAR. Placeholder caps are not permission to trade.`,
);
const runtimeResponse = await fetch('https://symbiochain.vercel.app/api/swarm/runtime', {
  cache: 'no-store',
  signal: AbortSignal.timeout(30000),
});
const runtime = runtimeResponse.ok ? await runtimeResponse.json() : null;
state(
  'runtime',
  'Hosted execution gate',
  runtime?.mode === 'LIVE' && runtime.executionEnabled === false,
  'Hosted runtime is LIVE/mainnet with execution explicitly disarmed.',
);
for (const t of m.transactions) {
  const verified = await reader.transaction(t.hash);
  if (!verified.final || !verified.succeeded) throw Error('DEPLOYMENT_RECEIPT_UNVERIFIED');
  transactions.push({
    hash: t.hash,
    label: t.label,
    classification: 'DEPLOYMENT_NOT_REVENUE',
    url: t.url,
  });
}
add(
  'deployment_receipts',
  'Final deployment transaction receipts',
  'PASSED',
  'FINAL_MAINNET_TRANSACTION',
  `Independently rechecked ${m.transactions.length} known deployment transactions and all returned receipt outcomes.`,
  m.transactions.map((t) => t.url),
);
const funding = JSON.parse(await readFile('artifacts/mainnet-funding-demo.json', 'utf8'));
const fundingRaw = await rpc(
  'tx',
  { tx_hash: funding.transaction.hash, sender_account_id: ROOT, wait_until: 'FINAL' },
  ARCHIVE,
);
const fund = verifyFundingReceipt(fundingRaw, funding.transaction.hash);
transactions.push({
  hash: fund.hash,
  label: 'Paused treasury capital funding',
  classification: 'TEAM_FUNDED_TREASURY_CAPITAL_NOT_REVENUE',
  url: fund.url,
});
add(
  'funding',
  'Actual mainnet treasury funding',
  'PASSED',
  'FINAL_MAINNET_TRANSACTION',
  `Verified fund({}) deposit ${fund.depositYocto} yoctoNEAR and fee ${fund.actualFeeYocto} yoctoNEAR. This is team capital, not customer revenue.`,
  [fund.url],
);
let serviceRoundTrip = null;
try {
  const s = JSON.parse(await readFile('.data/mainnet-service-roundtrip/complete.json', 'utf8'));
  const credit = s.returnedYocto;
  for (const [step, t] of [
    ['deposit', s.depositTransaction],
    ['withdraw', s.transaction],
  ]) {
    verifyServiceReceipt(
      await rpc('tx', { tx_hash: t.hash, sender_account_id: ROOT, wait_until: 'FINAL' }, ARCHIVE),
      t.hash,
      step,
      credit,
    );
    transactions.push({
      hash: t.hash,
      label: step === 'deposit' ? 'Service-balance deposit' : 'Return of service credit',
      classification: 'SELF_FUNDED_SERVICE_BALANCE_TEST',
      url: t.url,
    });
  }
  if (s.after.serviceBalanceYocto !== '0') throw Error('SERVICE_BALANCE_NOT_CLEARED');
  serviceRoundTrip = {
    checkedAt: s.checkedAt,
    depositedYocto: SERVICE_DEPOSIT.toString(),
    returnedYocto: credit,
    storageCollateralYocto: s.storageCollateralYocto,
    totalFeeYocto: s.totalFeeYocto,
    totalOwnerCostYocto: s.totalOwnerCostYocto,
    walletBalanceReconciled: s.walletBalanceReconciled,
    depositHash: s.depositTransaction.hash,
    withdrawalHash: s.transaction.hash,
  };
  add(
    'service_balance',
    'Mainnet service-balance deposit and withdrawal',
    'PASSED',
    'FINAL_MAINNET_TRANSACTION',
    `Deposit credited after storage, payout callback succeeded and own service balance returned to zero. It is a self-funded escrow test, not agent-to-agent payment or an Intents settlement. Wallet cost reconciliation: ${s.walletBalanceReconciled}.`,
    [s.depositTransaction.url, s.transaction.url],
  );
} catch (e) {
  if (e.code !== 'ENOENT') throw e;
  add(
    'service_balance',
    'Mainnet service-balance deposit and withdrawal',
    'NOT_RUN',
    'NOT_EXECUTED',
    'The bounded 0.002 NEAR deposit/withdrawal portal is prepared; both owner signatures and final receipt reconciliation are required.',
  );
}
const fresh = (j) =>
  Date.now() - Date.parse(j.checkedAt) >= 0 &&
  Date.now() - Date.parse(j.checkedAt) < 6 * 60 * 60 * 1000;
try {
  const t = JSON.parse(await readFile('.data/tee-gates/latest-verification.json', 'utf8'));
  const hardware = fresh(t) && t.results.length >= 2 && t.results.every((r) => r.hardwareVerified);
  add(
    'tee_hardware',
    'Production provider hardware attestation',
    hardware ? 'PASSED' : 'BLOCKED',
    'PRODUCTION_ATTESTATION',
    `Authenticated free audit ${t.checkedAt}: gateway/model hardware ${hardware ? 'accepted' : 'not accepted or stale'}. Hardware subchecks do not approve the complete application deployment. No completion was purchased.`,
  );
} catch {
  block(
    'tee_hardware',
    'Production provider hardware attestation',
    'Fresh authenticated free audit is unavailable.',
  );
}
block(
  'tee_deployment',
  'Complete TEE deployment approval',
  'Independently approved software provenance/measurements and deployment actions are still missing. Mainnet funds do not open this gate.',
);
block(
  'inference',
  'Verified paid AI response',
  'No completion may be purchased before full deployment approval. Existing application limits remain USD 1 total and USD 0.10 per request.',
);
try {
  const q = JSON.parse(await readFile('.data/trading-gates/market-base-10000000-50.json', 'utf8'));
  if (!fresh(q) || q.signaturesVerified !== true) throw Error('STALE_QUOTE');
  add(
    'profit_guard',
    'Signed production quotes and profit admission',
    'PASSED',
    'SIGNED_MARKET_PREVIEW',
    `Signed dry quote at ${q.checkedAt}: input ${q.profitCheck.inputAtoms}, conservative output ${q.profitCheck.minimumOutputAtoms}, preview net ${q.profitCheck.minimumNetAfterAllowanceAtoms} USDC atoms; profit floor passed: ${q.profitCheck.passesProfitFloor}. These are indicative terms, not a funded swap or realized P&L.`,
  );
} catch {
  block(
    'profit_guard',
    'Signed production quotes and profit admission',
    'Fresh signed production dry quotes are unavailable.',
  );
}
block(
  'authorization',
  'Positive authorization and spending-limit enforcement',
  'Workers are revoked and the treasury is paused. A valid Brain-authorized AI cycle is required; a synthetic mainnet authorization will not substitute for it.',
);
block(
  'agent_payment',
  'Actual agent-to-agent service settlement',
  'A funded service-balance round trip does not exercise agent-to-agent payments. Actual settlement requires enabled roles and a valid approved cycle.',
);
block(
  'evm_signature',
  'Treasury-controlled mainnet EVM signature',
  'Treasury signature requests require authorized workers and a valid cycle. No unrelated-account signing fixture is substituted.',
);
block(
  'solana_signature',
  'Treasury-controlled mainnet Solana signature',
  'Treasury signing remains gated; mainnet derived-wallet funding and native gas require separate limits.',
);
block(
  'cross_chain',
  'Funded cross-chain execution and Intents settlement',
  'Trading/gas caps and target-chain funding are unset, TEE execution is unapproved and the current route fails its profit floor. No loss trade is executed to obtain a receipt.',
);
block(
  'nft',
  'Mainnet profit receipt NFT',
  'A genuinely reconciled profitable cycle and settlement-bound accounting approval are required. Mainnet synthetic positive P&L is not used to mint a receipt.',
);
block(
  'dividends',
  'Mainnet NFT distribution and holder claim',
  `Mainnet supply is ${snapshot.nfts.totalSupply} and revenue shares total ${snapshot.nfts.revenueShareBps} bps. No business-funded distribution or holder claim has occurred.`,
);
block(
  'business',
  'External revenue and complete operating profit',
  'Funding and self-funded escrow prove mechanics, not external demand or earned revenue. Complete realized operating costs remain unverified.',
);
block(
  'compute_purchase',
  'Automatic earned-proceeds AI credit purchase',
  'A publicly supported customer payment-to-credit API is still unavailable. Manual/operator reports cannot be presented as automatic purchased credits.',
);
add(
  'worker_recovery',
  'Recovery during actual mainnet agent execution',
  'NOT_RUN',
  'NOT_EXECUTED',
  'Production workers are intentionally stopped. A read-only server restart does not establish recovery of an active signing or settlement job.',
);
const summary = {
  passed: checks.filter((c) => c.status === 'PASSED').length,
  blocked: checks.filter((c) => c.status === 'BLOCKED').length,
  notRun: checks.filter((c) => c.status === 'NOT_RUN').length,
  complete: checks.every((c) => c.status === 'PASSED'),
};
const report = MainnetAcceptance.parse({
  contractVersion: 1,
  profile: 'MAINNET_ACCEPTANCE',
  network: 'mainnet',
  capturedAt: new Date().toISOString(),
  block: { height: snapshot.block.height, hash: snapshot.block.hash },
  summary,
  checks,
  transactions,
  serviceRoundTrip,
  runner: { paidInferenceRequests: 0, transactionsSubmitted: 0, readOnly: true },
});
await mkdir('.data/mainnet-acceptance', { recursive: true, mode: 0o700 });
await writeFile('.data/mainnet-acceptance/snapshot.json', JSON.stringify(snapshot, null, 2), {
  mode: 0o600,
});
await writeFile('artifacts/mainnet-acceptance.json', JSON.stringify(report, null, 2) + '\n');
console.log(
  JSON.stringify({
    profile: report.profile,
    network: report.network,
    summary: report.summary,
    verifiedMainnetTransactions: transactions.length,
    paidInferenceRequests: 0,
    runnerTransactionsSubmitted: 0,
  }),
);
