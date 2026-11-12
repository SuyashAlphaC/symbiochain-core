/** Local transport/gas proof using the reviewed treasury WASM. No real signature or funds. */
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { Worker } from 'near-workspaces';
import { WASM_SHA256 } from './plan.mjs';
process.env.NEAR_SANDBOX_BIN_PATH = '1';
process.env.NEAR_SANDBOX_BINARY_PATH = resolve('.data/bin/Linux-x86_64');
const wasm = await readFile('artifacts/symbiochain_treasury.wasm');
assert.equal(createHash('sha256').update(wasm).digest('hex'), WASM_SHA256);
const w = await Worker.init();
try {
  const root = w.rootAccount,
    accounts = {};
  for (const role of ['owner', 'brain', 'hand', 'books', 'mpc', 'treasury'])
    accounts[role] = await root.createSubAccount(role);
  const { owner, brain, hand, books, mpc, treasury } = accounts;
  await treasury.deploy(wasm);
  await mpc.deploy(
    await readFile(
      'contracts/treasury/target/wasm32-unknown-unknown/release/symbiochain_mpc_mock.wasm',
    ),
  );
  const token = '0x' + '11'.repeat(20),
    recipient = '0x' + '22'.repeat(20);
  await treasury.call(treasury, 'new', {
    owner: owner.accountId,
    brain: brain.accountId,
    hand: hand.accountId,
    accountant: books.accountId,
    mpc: mpc.accountId,
    derivation_path: 'symbio-mainnet-v1',
    policy: {
      max_trade_atoms: '250000',
      max_daily_atoms: '500000',
      min_reserve_yocto: '100000000000000000000000',
      max_signing_cost_yocto: '1',
      max_slippage_bps: 0,
      allowed_chain_ids: [8453, 0],
      allowed_token_contracts: [token, 'sol:native'],
      token_max_trade_atoms: ['250000', '4000000'],
      token_max_daily_atoms: ['500000', '8000000'],
    },
  });
  const b = await w.provider.block({ finality: 'final' });
  const a = {
    cycle_id: 'sandbox-gas-rehearsal-not-mainnet',
    proposal_hash: 'aa'.repeat(32),
    route_hash: 'bb'.repeat(32),
    evidence_hash: 'cc'.repeat(32),
    amount_atoms: '1',
    budget_atoms: '1',
    expires_at_ns: (BigInt(b.header.timestamp_nanosec) + 600000000000n).toString(),
    chain_id: 8453,
    token_contract: token,
    deposit_address: recipient,
    max_fee_per_gas: '500000000',
    gas_limit: '100000',
    slippage_bps: 0,
  };
  const out = [];
  for (const [signer, method, args, gas] of [
    [brain, 'authorize_cycle', { authorization: a }, 20000000000000n],
    [
      hand,
      'request_evm_signature',
      {
        cycle_id: a.cycle_id,
        transaction: {
          nonce: '0',
          max_priority_fee_per_gas: '1',
          max_fee_per_gas: '100',
          gas_limit: '60000',
        },
      },
      250000000000000n,
    ],
    [
      hand,
      'record_submission',
      { cycle_id: a.cycle_id, tx_hash: 'SANDBOX_ONLY_INVALID_MPC_SIGNATURE_NOT_BROADCAST' },
      20000000000000n,
    ],
    [
      books,
      'finalize_cycle',
      { cycle_id: a.cycle_id, reconciliation_hash: 'dd'.repeat(32), realized_pnl_atoms: '0' },
      20000000000000n,
    ],
  ]) {
    const r = await signer.callRaw(treasury, method, args, { gas });
    assert.ok(r.succeeded, method + ' gas failed');
    out.push({
      method,
      attachedGas: gas.toString(),
      succeeded: r.succeeded,
      gasBurnt: r.gas_burnt,
    });
  }
  const closed = await treasury.view('get_cycle', { cycle_id: a.cycle_id });
  assert.equal(closed.status, 'CLOSED');
  assert.equal(closed.realized_pnl_atoms, '0');
  // Separate synthetic profit is used solely to measure NFT mint gas locally.
  const synthetic = { ...a, cycle_id: 'sandbox-mint-gas-only' };
  await brain.call(
    treasury,
    'authorize_cycle',
    { authorization: synthetic },
    { gas: 20000000000000n },
  );
  await hand.call(
    treasury,
    'request_evm_signature',
    {
      cycle_id: synthetic.cycle_id,
      transaction: {
        nonce: '1',
        max_priority_fee_per_gas: '1',
        max_fee_per_gas: '100',
        gas_limit: '60000',
      },
    },
    { gas: 250000000000000n },
  );
  await hand.call(
    treasury,
    'record_submission',
    { cycle_id: synthetic.cycle_id, tx_hash: 'SANDBOX_ONLY_NOT_BROADCAST' },
    { gas: 20000000000000n },
  );
  await books.call(
    treasury,
    'finalize_cycle',
    { cycle_id: synthetic.cycle_id, reconciliation_hash: 'ee'.repeat(32), realized_pnl_atoms: '1' },
    { gas: 20000000000000n },
  );
  const mint = await books.callRaw(
    treasury,
    'mint_proof_nft',
    { cycle_id: synthetic.cycle_id, receiver_id: owner.accountId, share_bps: 0 },
    { gas: 20000000000000n },
  );
  assert.ok(mint.succeeded);
  out.push({
    method: 'mint_proof_nft',
    attachedGas: '20000000000000',
    succeeded: mint.succeeded,
    gasBurnt: mint.gas_burnt,
    fixture: 'LOCAL_SYNTHETIC_PROFIT_ONLY',
  });
  const report = {
    checkedAt: new Date().toISOString(),
    scope: 'LOCAL_SANDBOX_GAS_WITH_REVIEWED_MAINNET_WASM',
    treasuryWasmSha256: WASM_SHA256,
    signer: 'SANDBOX_INVALID_SIGNATURE_TRANSPORT_STUB',
    methods: out,
    mainnetTransactionsSubmitted: 0,
    paidInferenceRequests: 0,
    profitClaimed: false,
  };
  await writeFile(
    'artifacts/mainnet-treasury-gas-rehearsal.json',
    JSON.stringify(report, null, 2) + '\n',
  );
  console.log(JSON.stringify(report));
} finally {
  await w.tearDown();
}
