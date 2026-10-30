import { expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import bs58 from 'bs58';
import { inspectMainnetRelease } from '../../src/live-inspection.js';
import type { Fetch } from '../../src/providers/http.js';

const wasm = Uint8Array.from([0, 97, 115, 109, 1, 0, 0, 0]);
const emptyHash = bs58.encode(new Uint8Array(32));
const treasuryHash = bs58.encode(createHash('sha256').update(wasm).digest());
const state = {
  amount: '999999999999999999999999999',
  locked: '0',
  storage_usage: 100,
  code_hash: treasuryHash,
};
function rpcFixture(
  change?: (request: { method: string; params: Record<string, unknown> }) => unknown,
) {
  const requests: { method: string; params: Record<string, unknown> }[] = [];
  const transport: Fetch = async (_url, init) => {
    const request = JSON.parse(String(init?.body));
    requests.push(request);
    let result: unknown =
      request.method === 'status'
        ? { chain_id: 'mainnet' }
        : request.method === 'block'
          ? { header: { height: 123, hash: 'final-block-hash' } }
          : request.method === 'EXPERIMENTAL_protocol_config'
            ? {
                chain_id: 'mainnet',
                protocol_version: 86,
                runtime_config: { storage_amount_per_byte: '10000000000000000000' },
              }
            : state;
    result = change?.(request) ?? { result };
    return Response.json(result);
  };
  return { requests, transport };
}

it('inspects storage and code identity using read-only queries without publishing RPC credentials', async () => {
  const fixture = rpcFixture();
  const report = await inspectMainnetRelease(
    {
      wasm,
      rpcUrl: 'https://rpc.example/?api_key=private-rpc-sentinel',
      accounts: { OWNER: 'owner.near', TREASURY: 'treasury.owner.near' },
    },
    fixture.transport,
  );
  expect(report.storage.codeOnlyLockLowerBoundYoctoNear).toBe('80000000000000000000');
  expect(report.accounts.find((x) => x.role === 'TREASURY')).toMatchObject({
    treasuryCodeMatches: true,
    amountYoctoNear: state.amount,
  });
  expect(report).toMatchObject({
    transactionsPerformed: false,
    fundingBudgetApproved: false,
    fundedRoundTripVerified: false,
    mpc: { signatureRequested: false, signatureCompatibilityVerified: false },
  });
  expect(JSON.stringify(report)).not.toContain('private-rpc-sentinel');
  expect(
    fixture.requests.every(
      (r) =>
        r.method === 'status' ||
        r.method === 'block' ||
        r.method === 'EXPERIMENTAL_protocol_config' ||
        (r.method === 'query' && r.params.request_type === 'view_account'),
    ),
  ).toBe(true);
  expect(
    fixture.requests
      .filter((r) => r.method === 'query' || r.method === 'EXPERIMENTAL_protocol_config')
      .every((r) => r.params.block_id === 'final-block-hash'),
  ).toBe(true);
});

it('rejects a wrong network before making any account queries', async () => {
  const fixture = rpcFixture((r) =>
    r.method === 'status' ? { result: { chain_id: 'testnet' } } : undefined,
  );
  await expect(
    inspectMainnetRelease({ wasm, rpcUrl: 'https://rpc.example', accounts: {} }, fixture.transport),
  ).rejects.toThrow();
  expect(fixture.requests.map((x) => x.method)).toEqual(['status']);
});

it('distinguishes missing accounts from unavailable queries and mismatching contract code', async () => {
  const fixture = rpcFixture((r) =>
    r.params.account_id === 'missing.near'
      ? { error: { cause: { name: 'UNKNOWN_ACCOUNT' } } }
      : r.params.account_id === 'different.near'
        ? { result: { ...state, code_hash: emptyHash } }
        : undefined,
  );
  const report = await inspectMainnetRelease(
    {
      wasm,
      rpcUrl: 'https://rpc.example',
      accounts: { OWNER: 'missing.near', TREASURY: 'different.near' },
    },
    fixture.transport,
  );
  expect(report.accounts[0]).toMatchObject({ status: 'NOT_CREATED' });
  expect(report.accounts[1]).toMatchObject({ treasuryCodeMatches: false });
  const unavailable = rpcFixture((r) =>
    r.method === 'query' ? { error: { cause: { name: 'UNAVAILABLE_SHARD' } } } : undefined,
  );
  await expect(
    inspectMainnetRelease(
      { wasm, rpcUrl: 'https://rpc.example', accounts: {} },
      unavailable.transport,
    ),
  ).rejects.toThrow('read-only mainnet query failed');
});

it('rejects zero storage prices, missing MPC code, testnet account names and non-WASM inputs', async () => {
  const noCode = rpcFixture((r) =>
    r.params.account_id === 'v1.signer'
      ? { result: { ...state, code_hash: emptyHash } }
      : undefined,
  );
  await expect(
    inspectMainnetRelease({ wasm, rpcUrl: 'https://rpc.example', accounts: {} }, noCode.transport),
  ).rejects.toThrow('no contract');
  const noPrice = rpcFixture((r) =>
    r.method === 'EXPERIMENTAL_protocol_config'
      ? {
          result: {
            chain_id: 'mainnet',
            block_height: 1,
            protocol_version: 86,
            runtime_config: { storage_amount_per_byte: '0' },
          },
        }
      : undefined,
  );
  await expect(
    inspectMainnetRelease({ wasm, rpcUrl: 'https://rpc.example', accounts: {} }, noPrice.transport),
  ).rejects.toThrow('invalid storage price');
  const fixture = rpcFixture();
  await expect(
    inspectMainnetRelease(
      { wasm, rpcUrl: 'https://rpc.example', accounts: { OWNER: 'owner.testnet' } },
      fixture.transport,
    ),
  ).rejects.toThrow();
  await expect(
    inspectMainnetRelease(
      { wasm: new Uint8Array(8), rpcUrl: 'https://rpc.example', accounts: {} },
      fixture.transport,
    ),
  ).rejects.toThrow('Build the treasury');
  expect(fixture.requests).toHaveLength(0);
});
