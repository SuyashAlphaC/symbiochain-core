import assert from 'node:assert/strict';
import { Worker } from 'near-workspaces';
import { readFile } from 'node:fs/promises';
import { encodeFunctionData, erc20Abi, serializeTransaction, keccak256 } from 'viem';
import { PublicKey, SystemProgram, Transaction } from '@solana/web3.js';
import bs58 from 'bs58';
import { resolve } from 'node:path';
// near-workspaces 5 ships a protocol-77 sandbox. Use our pinned protocol-86 binary.
process.env.NEAR_SANDBOX_BIN_PATH = '1';
process.env.NEAR_SANDBOX_BINARY_PATH = resolve('.data/bin/Linux-x86_64');
const worker = await Worker.init();
try {
  const root = worker.rootAccount;
  const owner = await root.createSubAccount('owner');
  const brain = await root.createSubAccount('brain');
  const hand = await root.createSubAccount('hand');
  const books = await root.createSubAccount('books');
  const holder = await root.createSubAccount('holder');
  const mpc = await root.createSubAccount('mpc');
  const treasury = await root.createSubAccount('treasury');
  await treasury.deploy(await readFile('artifacts/symbiochain_treasury.wasm'));
  await mpc.deploy(
    await readFile(
      'contracts/treasury/target/wasm32-unknown-unknown/release/symbiochain_mpc_mock.wasm',
    ),
  );
  const token = `0x${'11'.repeat(20)}` as const,
    deposit = `0x${'22'.repeat(20)}` as const;
  await treasury.call(treasury, 'new', {
    owner: owner.accountId,
    brain: brain.accountId,
    hand: hand.accountId,
    accountant: books.accountId,
    mpc: mpc.accountId,
    derivation_path: 'symbio-v1',
    policy: {
      max_trade_atoms: '10000000',
      max_daily_atoms: '50000000',
      min_reserve_yocto: '50000000000000000000000',
      max_signing_cost_yocto: '1',
      max_slippage_bps: 50,
      allowed_chain_ids: [8453, 0],
      allowed_token_contracts: [token, 'sol:native'],
      token_max_trade_atoms: ['10000000', '1000000000'],
      token_max_daily_atoms: ['50000000', '5000000000'],
    },
  });
  const block = await worker.provider.block({ finality: 'final' });
  const authorization = {
    cycle_id: 'sandbox-cycle:1',
    proposal_hash: 'aa'.repeat(32),
    route_hash: 'bb'.repeat(32),
    evidence_hash: 'cc'.repeat(32),
    amount_atoms: '5000000',
    budget_atoms: '5000000',
    expires_at_ns: (BigInt(block.header.timestamp_nanosec) + 600_000_000_000n).toString(),
    chain_id: 8453,
    token_contract: token,
    deposit_address: deposit,
    max_fee_per_gas: '1000000000',
    gas_limit: '100000',
    slippage_bps: 50,
  };
  await assert.rejects(hand.call(treasury, 'authorize_cycle', { authorization }), /Unauthorized/);
  await brain.call(treasury, 'authorize_cycle', { authorization });
  await brain.call(treasury, 'authorize_cycle', { authorization });
  await hand.call(
    treasury,
    'request_evm_signature',
    {
      cycle_id: authorization.cycle_id,
      transaction: {
        nonce: '7',
        max_priority_fee_per_gas: '100',
        max_fee_per_gas: '100000',
        gas_limit: '60000',
      },
    },
    { gas: 300_000_000_000_000n },
  );
  const signed = await treasury.view<{ status: string; payload_hex: string }>('get_cycle', {
    cycle_id: authorization.cycle_id,
  });
  assert.equal(signed.status, 'SIGNED');
  const unsigned = serializeTransaction({
    type: 'eip1559',
    chainId: 8453,
    nonce: 7,
    maxPriorityFeePerGas: 100n,
    maxFeePerGas: 100000n,
    gas: 60000n,
    to: token,
    value: 0n,
    data: encodeFunctionData({
      abi: erc20Abi,
      functionName: 'transfer',
      args: [deposit, 5000000n],
    }),
  });
  assert.equal(signed.payload_hex, keccak256(unsigned).slice(2));
  await assert.rejects(
    hand.call(
      treasury,
      'request_evm_signature',
      {
        cycle_id: authorization.cycle_id,
        transaction: {
          nonce: '8',
          max_priority_fee_per_gas: '0',
          max_fee_per_gas: '1',
          gas_limit: '60000',
        },
      },
      { gas: 300_000_000_000_000n },
    ),
    /Signing already/,
  );
  await hand.call(treasury, 'record_submission', {
    cycle_id: authorization.cycle_id,
    tx_hash: 'sandbox:NOT_A_REAL_CHAIN_TRANSACTION',
  });
  await books.call(treasury, 'finalize_cycle', {
    cycle_id: authorization.cycle_id,
    reconciliation_hash: 'dd'.repeat(32),
    realized_pnl_atoms: '100',
  });
  await books.call(treasury, 'mint_proof_nft', {
    cycle_id: authorization.cycle_id,
    receiver_id: holder.accountId,
    share_bps: 1000,
  });
  await books.call(
    treasury,
    'distribute_revenue',
    { distribution_reference: 'sandbox-synthetic-funding' },
    { attachedDeposit: 10n ** 24n },
  );
  assert.equal(
    await treasury.view('dividend_balance', { token_id: 'cycle:sandbox-cycle:1' }),
    '100000000000000000000000',
  );
  await holder.call(
    treasury,
    'claim_dividends',
    { token_id: 'cycle:sandbox-cycle:1' },
    { gas: 100_000_000_000_000n },
  );
  assert.equal(await treasury.view('dividend_balance', { token_id: 'cycle:sandbox-cycle:1' }), '0');
  await hand.call(treasury, 'fund_services', {}, { attachedDeposit: 10n ** 23n });
  await assert.rejects(
    holder.call(treasury, 'fund_services', {}, { attachedDeposit: 1n }),
    /cover its storage/,
  );
  const payment = {
    payment_id: 'sandbox:signal',
    recipient: brain.accountId,
    amount: '1000000000000000000000',
    reference_hash: 'ee'.repeat(32),
  };
  await hand.call(treasury, 'settle_service', payment);
  await hand.call(treasury, 'settle_service', payment);
  assert.equal(
    await treasury.view('service_balance', { account: brain.accountId }),
    '1000000000000000000000',
  );
  const sender = new PublicKey(new Uint8Array(32).fill(1)),
    recipient = new PublicKey(new Uint8Array(32).fill(2)),
    blockhash = bs58.encode(new Uint8Array(32).fill(3));
  await brain.call(treasury, 'authorize_cycle', {
    authorization: {
      ...authorization,
      cycle_id: 'sandbox-cycle:2',
      chain_id: 0,
      token_contract: 'sol:native',
      deposit_address: recipient.toBuffer().toString('hex'),
      amount_atoms: '42',
    },
  });
  await hand.call(
    treasury,
    'request_solana_signature',
    {
      cycle_id: 'sandbox-cycle:2',
      sender_hex: sender.toBuffer().toString('hex'),
      recent_blockhash_hex: Buffer.from(bs58.decode(blockhash)).toString('hex'),
    },
    { gas: 300_000_000_000_000n },
  );
  const sol = await treasury.view<{ payload_hex: string }>('get_cycle', {
    cycle_id: 'sandbox-cycle:2',
  });
  const solTx = new Transaction({ feePayer: sender, recentBlockhash: blockhash }).add(
    SystemProgram.transfer({ fromPubkey: sender, toPubkey: recipient, lamports: 42n }),
  );
  assert.equal(sol.payload_hex, solTx.serializeMessage().toString('hex'));
  await owner.call(treasury, 'set_paused', { paused: true });
  await assert.rejects(
    owner.call(treasury, 'withdraw_funds', { amount: '1' }),
    /Outstanding signatures/,
  );
  console.log(
    JSON.stringify(
      {
        suite: 'NEAR sandbox',
        passed: true,
        checks: [
          'role isolation',
          'idempotent authorization',
          'EVM payload equality against viem',
          'one signature per authorization',
          'receipt mint',
          'bounded revenue claim',
          'conserved service payment',
          'Solana payload equality against web3.js',
          'service funding pays its storage',
          'unresolved signatures block owner withdrawal',
        ],
        disclosure:
          'Local sandbox with an invalid-signature MPC stub and synthetic reported profit; no external trade or attestation claimed',
      },
      null,
      2,
    ),
  );
} finally {
  await worker.tearDown();
}
