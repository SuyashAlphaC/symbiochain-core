import { setupWalletSelector, internalActionToNaj } from '@near-wallet-selector/core';
import { setupMeteorWallet } from '@near-wallet-selector/meteor-wallet';
console.log = () => {};
const token = document.querySelector('meta[name="fixture-token"]').content,
  status = document.querySelector('#status'),
  sign = document.querySelector('#sign');
let plan,
  wallet,
  busy = false;
async function api(path, body) {
  const r = await fetch(path, {
    method: body ? 'POST' : 'GET',
    headers: { 'x-fixture-token': token, ...(body ? { 'content-type': 'application/json' } : {}) },
    ...(body ? { body: JSON.stringify({ planDigest: plan.digest, ...body }) } : {}),
    cache: 'no-store',
  });
  const b = await r.json();
  if (!r.ok) throw Error(b.code ?? 'PREPARATION_HELD');
  return b;
}
function check() {
  const t = plan.transaction;
  if (
    plan.network !== 'mainnet' ||
    plan.capitalYocto !== '0' ||
    plan.paidInferenceRequests !== 0 ||
    plan.automaticSpendingEnabled !== false
  )
    throw Error('EXECUTION_POLICY_CHANGED');
  if (plan.scope === 'SAME_KEY_MPC_GAS_ALLOWANCE_REPAIR') {
    const account = 'hand.symbio-fcef733893.near',
      key = 'ed25519:B5QXGjwnTzEKotw6pk2BRoTS3q6SbnW6mViWY3Kxg3cN';
    if (
      plan.signerId !== account ||
      plan.receiverId !== account ||
      t.actions.length !== 2 ||
      t.actions[0].type !== 'DeleteKey' ||
      t.actions[0].params.publicKey !== key ||
      t.actions[1].type !== 'AddKey' ||
      t.actions[1].params.publicKey !== key
    )
      throw Error('SAME_KEY_REPAIR_REQUIRED');
    const f = t.actions[1].params.accessKey.permission;
    if (
      f.receiverId !== 'treasury.symbio-fcef733893.near' ||
      JSON.stringify(f.methodNames) !==
        JSON.stringify([
          'request_evm_signature',
          'request_solana_signature',
          'record_submission',
        ]) ||
      f.allowance !== '300000000000000000000000' ||
      plan.feeAllowanceYocto !== '500000000000000000000'
    )
      throw Error('KEY_SCOPE_CHANGED');
  } else {
    if (
      plan.scope !== 'OWNER_REVIEWED_BASE_SOL_POLICY' ||
      plan.signerId !== 'symbio-fcef733893.near' ||
      plan.receiverId !== 'treasury.symbio-fcef733893.near' ||
      t.actions.length !== 1 ||
      t.actions[0].type !== 'FunctionCall'
    )
      throw Error('OWNER_POLICY_REQUIRED');
    const a = t.actions[0].params,
      expected = {
        max_trade_atoms: '250000',
        max_daily_atoms: '500000',
        min_reserve_yocto: '100000000000000000000000',
        max_signing_cost_yocto: '1',
        max_slippage_bps: 0,
        allowed_chain_ids: [8453, 0],
        allowed_token_contracts: ['0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', 'sol:native'],
        token_max_trade_atoms: ['250000', '4000000'],
        token_max_daily_atoms: ['500000', '8000000'],
      };
    if (
      a.methodName !== 'set_policy' ||
      a.deposit !== '0' ||
      a.gas !== '20000000000000' ||
      JSON.stringify(a.args) !== JSON.stringify({ policy: expected }) ||
      plan.feeAllowanceYocto !== '5000000000000000000000'
    )
      throw Error('BOUNDED_POLICY_CHANGED');
  }
  if (t.signerId !== plan.signerId || t.receiverId !== plan.receiverId)
    throw Error('TRANSACTION_BINDING_CHANGED');
}
async function refresh() {
  const s = await api('/state');
  sign.disabled = busy || !wallet || s.pending || !!s.receipt;
  if (s.receipt)
    status.textContent =
      'COMPLETE. Reviewed ' +
      (plan.scope === 'SAME_KEY_MPC_GAS_ALLOWANCE_REPAIR'
        ? 'same-key finite gas allowance'
        : 'bounded Base/SOL policy') +
      ' verified. Receipt: ' +
      s.receipt.transaction.url +
      '. AI remains quarantined; automated spending stays disabled.';
  else if (s.pending)
    status.textContent = 'Existing signature pending. Reconcile its hash; do not sign again.';
  return s;
}
try {
  plan = await api('/plan');
  check();
  await api('/preflight', {});
  const s = await refresh();
  if (!s.pending && !s.receipt)
    status.textContent = 'Ready. Select ' + plan.signerId + ' and review the exact transaction.';
} catch (e) {
  status.textContent = e.message;
}
document.querySelector('#connect').onclick = async () => {
  try {
    const selector = await setupWalletSelector({
      network: 'mainnet',
      fallbackRpcUrls: ['https://free.rpc.fastnear.com'],
      modules: [setupMeteorWallet()],
      debug: false,
    });
    wallet = await selector.wallet('meteor-wallet');
    if (!(await wallet.isSignedIn())) await wallet.signIn({});
    const accounts = await wallet.getAccounts();
    if (accounts.length !== 1 || accounts[0].accountId !== plan.signerId)
      throw Error('Select ' + plan.signerId + ' in Meteor');
    status.textContent = 'Connected. Review exact scope, finite limits and fee allowance.';
  } catch (e) {
    wallet = null;
    status.textContent = e.message;
  }
  await refresh();
};
sign.onclick = async () => {
  if (busy || !wallet) return;
  busy = true;
  sign.disabled = true;
  try {
    check();
    if (!document.querySelector('#reviewed').checked) throw Error('REVIEW_REQUIRED');
    if ((await wallet.getAccounts())[0]?.accountId !== plan.signerId)
      throw Error('SELECT_NAMED_SIGNER');
    await api('/begin', {});
    const r = await wallet.signAndSendTransactions({
      transactions: [
        {
          signerId: plan.signerId,
          receiverId: plan.receiverId,
          actions: plan.transaction.actions.map(internalActionToNaj),
        },
      ],
    });
    const hash = r?.[0]?.transaction?.hash;
    if (!hash) throw Error('OUTCOME_UNKNOWN_RECONCILE_EXISTING_HASH');
    document.querySelector('#hash').value = hash;
    await api('/observe', { hash });
    await refresh();
  } catch (e) {
    await refresh();
    status.textContent += '\nWallet: ' + e.message;
  } finally {
    busy = false;
    await refresh();
  }
};
document.querySelector('#verify').onclick = async () => {
  try {
    await api('/observe', { hash: document.querySelector('#hash').value.trim() });
    await refresh();
  } catch (e) {
    status.textContent = e.message;
  }
};
