import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import bs58 from 'bs58';
import { loadConfig } from '../../src/config.js';
import { MainnetReader } from '../../src/mainnet.js';
import type { Fetch } from '../../src/providers/http.js';
import { Engine } from '../../src/engine.js';
import type { Store } from '../../src/store.js';
import type { Providers } from '../../src/providers/types.js';

const record = JSON.parse(await readFile('artifacts/mainnet-paused-deployment.json', 'utf8'));
const env = {
  DATABASE_URL: 'postgresql://unused:unused@localhost/unused',
  ADMIN_TOKEN: 'a'.repeat(40),
  READ_TOKEN: 'r'.repeat(40),
  EVIDENCE_ENCRYPTION_KEY: 'b'.repeat(64),
  EXECUTION_MODE: 'LIVE',
  EXECUTION_ENABLED: 'false',
  NEAR_NETWORK: 'mainnet',
  NEAR_CONTRACT_ID: record.treasury,
  NEAR_BRAIN_ACCOUNT_ID: record.accounts.brain,
  NEAR_WORKER_ACCOUNT_ID: record.accounts.hand,
  NEAR_SCOUT_ACCOUNT_ID: record.accounts.scout,
  NEAR_ACCOUNTANT_ACCOUNT_ID: record.accounts.accountant,
  NEAR_RPC_URL: 'https://rpc.example/?api_key=RPC_SECRET_SENTINEL',
};
const config = loadConfig(env);
const manifest = { ...record };
function fixture(chain = 'mainnet', failedReceipt = false) {
  const requests: { method: string; params: Record<string, unknown> }[] = [];
  const endpoints: string[] = [];
  const fetch: Fetch = async (url, init) => {
    const r = JSON.parse(String(init?.body));
    requests.push(r);
    endpoints.push(String(url));
    let result: unknown;
    if (r.method === 'status') result = { chain_id: chain };
    else if (r.method === 'block')
      result = {
        header: { hash: 'FINAL_BLOCK', height: 100, timestamp_nanosec: '1700000000000000000' },
      };
    else if (r.method === 'EXPERIMENTAL_protocol_config')
      result = {
        chain_id: 'mainnet',
        runtime_config: { storage_amount_per_byte: '10000000000000000000' },
      };
    else if (r.method === 'tx')
      result = {
        final_execution_status: 'FINAL',
        status: { SuccessValue: '' },
        transaction: {
          hash: record.transactions[0].hash,
          signer_id: record.transactions[0].signerId,
          receiver_id: record.transactions[0].receiverId,
        },
        transaction_outcome: { block_hash: 'FINAL_BLOCK' },
        receipts_outcome: [
          {
            outcome: {
              status: failedReceipt ? { Failure: { ActionError: 'failed' } } : { SuccessValue: '' },
            },
          },
        ],
      };
    else if (r.params.request_type === 'view_account')
      result = {
        amount: '6100000000000000000000000',
        storage_usage: 100,
        code_hash:
          r.params.account_id === record.treasury
            ? bs58.encode(Buffer.from(record.wasmSha256, 'hex'))
            : '11111111111111111111111111111111',
      };
    else if (r.params.request_type === 'view_access_key_list')
      result = {
        keys: [{ public_key: record.recoveryPublicKey, access_key: { permission: 'FullAccess' } }],
      };
    else if (r.params.request_type === 'view_state')
      result = { values: [{ key: r.params.prefix_base64, value: 'AA==' }] };
    else if (r.params.method_name === 'distribution_policy')
      result = { result: [...Buffer.from(JSON.stringify({ paused: true, total_shares_bps: 0 }))] };
    else if (r.params.method_name === 'get_policy')
      result = {
        result: [
          ...Buffer.from(
            JSON.stringify({
              max_trade_atoms: '1',
              max_daily_atoms: '1',
              min_reserve_yocto: '100000000000000000000000',
            }),
          ),
        ],
      };
    else if (r.params.method_name === 'nft_total_supply')
      result = { result: [...Buffer.from('"0"')] };
    else throw Error('UNEXPECTED_RPC_WRITE_OR_METHOD');
    return Response.json({ result });
  };
  return { fetch, requests, endpoints };
}
describe('disarmed production', () => {
  it('serves LIVE observation without signing keys, but refuses every enabled spending switch', () => {
    expect(config).toMatchObject({
      EXECUTION_MODE: 'LIVE',
      EXECUTION_ENABLED: false,
      LIVE_TRADING_ENABLED: false,
      NEAR_WORKER_PRIVATE_KEY: '',
    });
    for (const key of [
      'LIVE_TRADING_ENABLED',
      'LIVE_ARBITRAGE_ENABLED',
      'BUSINESS_PAYOUTS_ENABLED',
    ])
      expect(() => loadConfig({ ...env, [key]: 'true' })).toThrow('Disarmed LIVE');
    expect(() => loadConfig({ ...env, EXECUTION_ENABLED: 'true' })).toThrow('LIVE requires');
    expect(() => loadConfig({ ...env, NEAR_NETWORK: 'testnet' })).toThrow('mainnet');
  });
  it('refuses job claims before touching the database or any provider', async () => {
    const engine = new Engine({ config } as Store, {} as Providers);
    await expect(engine.tick()).rejects.toMatchObject({ code: 'EXECUTION_DISABLED' });
  });
});
describe('public mainnet observation', () => {
  it.each([429, 503])(
    'recovers HTTP %s through verified read-only failover without hammering the primary',
    async (status) => {
      const f = fixture();
      let primaryCalls = 0;
      const read: Fetch = async (url, init) => {
        if (String(url) === config.NEAR_RPC_URL) {
          primaryCalls++;
          return new Response('temporarily unavailable', { status });
        }
        expect(String(url)).toBe('https://near.drpc.org');
        expect(String(url)).not.toContain('RPC_SECRET_SENTINEL');
        return f.fetch(url, init);
      };
      const reader = new MainnetReader(config, read, manifest);
      const [a, b] = await Promise.all([reader.snapshot(), reader.snapshot()]);
      expect(a).toEqual(b);
      expect(a.code.matches).toBe(true);
      expect(a.executionEnabled).toBe(false);
      expect(f.requests.filter((r) => r.method === 'status')).toHaveLength(1);
      expect(
        f.requests
          .filter((r) => r.method === 'query')
          .every((r) => r.params.block_id === 'FINAL_BLOCK'),
      ).toBe(true);
      const calls = primaryCalls;
      expect(calls).toBeGreaterThan(0);
      expect(calls).toBeLessThanOrEqual(2);
      await reader.wallet(manifest.ownerAccount);
      expect(primaryCalls).toBe(calls);
      expect(JSON.stringify(a)).not.toContain('RPC_SECRET_SENTINEL');
    },
  );
  it('rejects a fallback on the wrong network before reading account data', async () => {
    const f = fixture('testnet');
    const read: Fetch = async (url, init) =>
      String(url) === config.NEAR_RPC_URL ? new Response('', { status: 429 }) : f.fetch(url, init);
    await expect(new MainnetReader(config, read, manifest).snapshot()).rejects.toMatchObject({
      code: 'CHAIN_ID_MISMATCH',
    });
    expect(f.requests.some((r) => r.method === 'query')).toBe(false);
  });
  it('preserves the original finalized block when rate limiting begins midway through a snapshot', async () => {
    const f = fixture();
    const read: Fetch = async (url, init) => {
      const request = JSON.parse(String(init?.body));
      if (
        String(url) === config.NEAR_RPC_URL &&
        request.params?.request_type === 'view_access_key_list' &&
        request.params?.account_id === manifest.treasury
      )
        return new Response('', { status: 429 });
      if (String(url) === 'https://near.drpc.org' && request.method === 'block')
        throw Error('FINALITY_REBASE_NOT_ALLOWED');
      return f.fetch(url, init);
    };
    const snapshot = await new MainnetReader(config, read, manifest).snapshot();
    expect(snapshot.block.hash).toBe('FINAL_BLOCK');
    expect(f.requests.filter((r) => r.method === 'block')).toHaveLength(1);
    expect(
      f.requests
        .filter((r) => r.method === 'query')
        .every((r) => r.params.block_id === 'FINAL_BLOCK'),
    ).toBe(true);
    expect(f.endpoints).toContain('https://near.drpc.org');
  });
  it.each([400, 401, 403])(
    'does not hide non-transient HTTP %s behind another provider',
    async (status) => {
      const endpoints: string[] = [];
      const read: Fetch = async (url) => {
        endpoints.push(String(url));
        return new Response('', { status });
      };
      await expect(new MainnetReader(config, read, manifest).snapshot()).rejects.toMatchObject({
        code: 'UPSTREAM_HTTP',
      });
      expect(endpoints.every((url) => url === config.NEAR_RPC_URL)).toBe(true);
    },
  );
  it('fails closed with bounded requests when both read providers are unavailable', async () => {
    const endpoints: string[] = [];
    const read: Fetch = async (url) => {
      endpoints.push(String(url));
      return new Response('', { status: 429 });
    };
    await expect(new MainnetReader(config, read, manifest).snapshot()).rejects.toMatchObject({
      code: 'UPSTREAM_HTTP',
    });
    expect(endpoints).toContain('https://near.drpc.org');
    expect(endpoints.length).toBeLessThanOrEqual(4);
  });
  it('checks receipt failures before calling a recorded transaction successful', async () => {
    const good = await new MainnetReader(config, fixture().fetch, manifest).transaction(
      record.transactions[0].hash,
    );
    const failed = await new MainnetReader(
      config,
      fixture('mainnet', true).fetch,
      manifest,
    ).transaction(record.transactions[0].hash);
    expect(good).toMatchObject({
      succeeded: true,
      final: true,
      classification: 'DEPLOYMENT_NOT_REVENUE',
    });
    expect(failed.succeeded).toBe(false);
  });
  it('uses one final block, preserves native units and keeps RPC credentials private', async () => {
    const f = fixture(),
      reader = new MainnetReader(config, f.fetch, manifest);
    const [a, b] = await Promise.all([reader.snapshot(), reader.snapshot()]);
    expect(a).toEqual(b);
    expect(a).toMatchObject({
      mode: 'LIVE',
      executionEnabled: false,
      paused: true,
      code: { matches: true },
      nfts: { totalSupply: '0', distributionLiabilityYocto: null },
      externalRevenueProven: false,
      survivalHours: null,
    });
    expect(a.accounts).toHaveLength(6);
    expect(a.accounts[0]?.balanceYocto).toBe('6100000000000000000000000');
    expect(JSON.stringify(a)).not.toContain('RPC_SECRET_SENTINEL');
    expect(f.requests.filter((r) => r.method === 'block')).toHaveLength(1);
    expect(
      f.requests
        .filter((r) => r.method === 'query')
        .every((r) => r.params.block_id === 'FINAL_BLOCK'),
    ).toBe(true);
    const count = f.requests.length;
    await reader.snapshot();
    expect(f.requests).toHaveLength(count);
  });
  it('rejects a wrong network and an unreviewed deployment identity', async () => {
    await expect(
      new MainnetReader(config, fixture('testnet').fetch, manifest).snapshot(),
    ).rejects.toMatchObject({ code: 'CHAIN_ID_MISMATCH' });
    await expect(
      new MainnetReader(
        { ...config, NEAR_CONTRACT_ID: 'other.near' },
        fixture().fetch,
        manifest,
      ).snapshot(),
    ).rejects.toMatchObject({ code: 'MAINNET_IDENTITY_MISMATCH' });
  });
  it('does not turn arbitrary hashes into an unrestricted transaction proxy', async () => {
    const f = fixture();
    await expect(
      new MainnetReader(config, f.fetch, manifest).transaction('1'.repeat(43)),
    ).rejects.toMatchObject({ code: 'TRANSACTION_NOT_RECORDED' });
    expect(f.requests).toHaveLength(0);
  });
  it('reads recorded historical receipts from the mainnet archive without widening the hash allowlist', async () => {
    const f = fixture();
    const result = await new MainnetReader(config, f.fetch, manifest).transaction(
      record.transactions[0].hash,
    );
    expect(result).toMatchObject({
      final: true,
      succeeded: true,
      classification: 'DEPLOYMENT_NOT_REVENUE',
    });
    const transaction = f.requests.findIndex((r) => r.method === 'tx');
    expect(f.endpoints[transaction]).toBe('https://archival-rpc.mainnet.fastnear.com');
    expect(f.requests[transaction]?.params.sender_account_id).toBe(record.transactions[0].signerId);
    expect(
      f.requests.some(
        (r, i) =>
          r.method === 'status' && f.endpoints[i] === 'https://archival-rpc.mainnet.fastnear.com',
      ),
    ).toBe(true);
  });
});
