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
  } else if (state.fundingRequired && !wallet && !busy)
    show(
      'Ready for owner review. Connect Meteor to create and fund the separate deployment wallet with 6.38 NEAR.',
    );
  if (!state.fullyDeployed) {
    deploy.textContent = state.fundingRequired
      ? 'Create deployment wallet in Meteor'
      : 'Complete funded deployment locally';
    if (!busy) deploy.disabled = state.fundingRequired && !wallet;
  }
  return state;
}
try {
  plan = await read('/plan');
  document.querySelector('#owner').textContent = plan.owner;
  document.querySelector('#namespace').textContent = plan.namespace;
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
      `Connected ${plan.owner}. Review the separate deployment wallet and its temporary local key before authorizing the fixed funding transaction.`,
    );
  } catch (error) {
    show(error.message);
    connect.disabled = false;
  } finally {
    busy = false;
  }
});

deploy.addEventListener('click', async () => {
  if (busy || !plan) return;
  busy = true;
  deploy.disabled = true;
  try {
    if (!document.querySelector('#reviewed').checked)
      throw Error('Review and authorize the separate funded deployment wallet first.');
    const state = await read('/preflight', { planDigest: plan.digest });
    if (state.fullyDeployed) {
      await refresh();
      return;
    }
    if (state.fundingRequired) {
      if (!wallet || (await wallet.getAccounts())[0]?.accountId !== plan.owner)
        throw Error('CONNECTED_OWNER_CHANGED');
      const tx = plan.factoryTransaction;
      if (
        tx.actions.length !== 1 ||
        tx.actions[0].type !== 'FunctionCall' ||
        tx.receiverId !== 'near' ||
        tx.actions[0].params.methodName !== 'create_account' ||
        tx.actions[0].params.deposit !== '6380000000000000000000000'
      )
        throw Error('FACTORY_TRANSACTION_CHANGED');
      show(
        'Meteor must approve one 6.38 NEAR account-creation payment. The temporary local key controls only the separate deployment wallet.',
      );
      const result = await wallet.signAndSendTransactions({
        transactions: [
          {
            signerId: tx.signerId,
            receiverId: tx.receiverId,
            actions: tx.actions.map(internalActionToNaj),
          },
        ],
      });
      const hashes = Array.isArray(result)
        ? result.map((row) => row?.transaction?.hash).filter(Boolean)
        : [];
      await read('/observe', { hashes });
    }
    show(
      'Deploying from the funded local wallet. The treasury remains paused. Excess funds will return to Meteor and the temporary key will be revoked.',
    );
    await read('/deploy-funded', { planDigest: plan.digest });
    await refresh();
  } catch (error) {
    show(
      `Deployment held: ${error.message}. Refresh the on-chain state before retrying; confirmed accounts will never be funded twice.`,
    );
  } finally {
    busy = false;
    try {
      const state = await refresh();
      deploy.disabled = state.fullyDeployed || (state.fundingRequired && !wallet);
    } catch (error) {
      show(error.message);
    }
  }
});
document.querySelector('#refresh').addEventListener('click', () => {
  if (!busy) void refresh().catch((error) => show(error.message));
});
