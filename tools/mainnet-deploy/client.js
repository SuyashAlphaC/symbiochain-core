import { setupWalletSelector, internalActionToNaj } from '@near-wallet-selector/core';
import { setupMeteorWallet } from '@near-wallet-selector/meteor-wallet';

// The legacy Meteor adapter logs its generated app key during login. This local
// signing page sends all progress to the DOM and suppresses SDK debug logging.
console.log = () => {};
const token = document.querySelector('meta[name="deployment-token"]').content;
const output = document.querySelector('#status');
const connect = document.querySelector('#connect');
const deploy = document.querySelector('#deploy');
let wallet,
  plan,
  busy = false;
const show = (message) => {
  output.textContent = message;
};
async function read(path, body) {
  const response = await fetch(path, {
    method: body ? 'POST' : 'GET',
    headers: {
      'x-deployment-token': token,
      ...(body ? { 'content-type': 'application/json' } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
    cache: 'no-store',
  });
  const value = await response.json();
  if (!response.ok) throw Error(value.code ?? 'DEPLOYMENT_CHECK_FAILED');
  return value;
}
async function refresh() {
  const state = await read('/state');
  document.querySelector('#progress').textContent =
    `${state.completed.length}/5 accounts verified. Remaining: ${state.remainingRoles.join(', ') || 'none'}.`;
  if (state.fullyDeployed) {
    deploy.disabled = true;
    show(
      'Mainnet deployment verified. Treasury is PAUSED; workers are disabled. Trading, inference and NFT minting remain off.',
    );
  } else if (!wallet && !busy)
    show(
      'Ready for owner review. Connect Meteor with solidvideo4090.near to sign the paused deployment.',
    );
  return state;
}
try {
  plan = await read('/plan');
  document.querySelector('#owner').textContent = plan.owner;
  document.querySelector('#accounts').textContent = Object.entries(plan.accounts)
    .map(([role, id]) => `${role}: ${id}`)
    .join('\n');
  document.querySelector('#hash').textContent = plan.wasmSha256;
  await refresh();
} catch (error) {
  show(error.message);
  connect.disabled = true;
}

connect.addEventListener('click', async () => {
  if (busy) return;
  busy = true;
  connect.disabled = true;
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
    if (accounts.length !== 1 || accounts[0].accountId !== plan.owner)
      throw Error('Select solidvideo4090.near in Meteor. No transaction was requested.');
    const state = await refresh();
    deploy.disabled = state.fullyDeployed;
    show(
      `Connected ${plan.owner}. Review the account funding and sign the fixed deployment batch in Meteor.`,
    );
  } catch (error) {
    show(error.message);
    connect.disabled = false;
  } finally {
    busy = false;
  }
});

deploy.addEventListener('click', async () => {
  if (busy || !wallet) return;
  busy = true;
  deploy.disabled = true;
  try {
    if (!document.querySelector('#reviewed').checked)
      throw Error('Review the 6.27 NEAR allocation and network-fee budget first.');
    if ((await wallet.getAccounts())[0]?.accountId !== plan.owner)
      throw Error('CONNECTED_OWNER_CHANGED');
    const state = await read('/preflight', { planDigest: plan.digest });
    if (!state.transactions.length) {
      await refresh();
      return;
    }
    const response = await fetch('/wasm', { cache: 'no-store' });
    if (!response.ok) throw Error('WASM_UNAVAILABLE');
    const wasm = new Uint8Array(await response.arrayBuffer());
    const digest = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', wasm)), (byte) =>
      byte.toString(16).padStart(2, '0'),
    ).join('');
    if (digest !== plan.wasmSha256) throw Error('WASM_DIGEST_MISMATCH');
    const transactions = state.transactions.map(({ signerId, receiverId, actions }) => ({
      signerId,
      receiverId,
      actions: actions.map((action) =>
        internalActionToNaj(
          action.type === 'DeployContract'
            ? { type: 'DeployContract', params: { code: wasm } }
            : action,
        ),
      ),
    }));
    show(
      'Meteor must sign the prepared transactions. Your owner private key stays in the wallet. Do not start a second batch.',
    );
    const result = await wallet.signAndSendTransactions({ transactions });
    const hashes = Array.isArray(result)
      ? result.map((row) => row?.transaction?.hash).filter(Boolean)
      : [];
    await read('/observe', { hashes });
    await refresh();
  } catch (error) {
    show(
      `Deployment held: ${error.message}. Refresh the on-chain state before retrying; confirmed accounts will never be funded twice.`,
    );
  } finally {
    busy = false;
    try {
      const state = await refresh();
      deploy.disabled = state.fullyDeployed || !wallet;
    } catch (error) {
      show(error.message);
    }
  }
});
document.querySelector('#refresh').addEventListener('click', () => {
  if (!busy) void refresh().catch((error) => show(error.message));
});
