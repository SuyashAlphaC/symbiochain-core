import { readFile } from 'node:fs/promises';
import bs58 from 'bs58';
import { z } from 'zod';
import type { Config } from './config.js';
import { DomainError, atoms } from './domain.js';
import { httpJson, type Fetch } from './providers/http.js';
import { MainnetSnapshot, MainnetTransaction, MainnetWallet } from './mainnet-contract.js';

const Manifest = z.object({
  checkedAt: z.iso.datetime(),
  ownerAccount: z.string(),
  treasury: z.string(),
  recoveryPublicKey: z.string(),
  wasmSha256: z.string().regex(/^[a-f0-9]{64}$/),
  accounts: z.object({
    treasury: z.string(),
    brain: z.string(),
    hand: z.string(),
    accountant: z.string(),
    scout: z.string(),
  }),
  transactions: z
    .array(
      z.object({
        label: z.string(),
        hash: z.string(),
        signerId: z.string(),
        receiverId: z.string(),
        url: z.url(),
      }),
    )
    .max(30),
});
const Account = z.object({
  amount: atoms,
  storage_usage: z.number().int().nonnegative(),
  code_hash: z.string(),
});
const Keys = z.object({
  keys: z
    .array(
      z.object({
        public_key: z.string(),
        access_key: z.object({
          permission: z.union([z.literal('FullAccess'), z.object({ FunctionCall: z.unknown() })]),
        }),
      }),
    )
    .max(30),
});
const accountId = z
  .string()
  .min(2)
  .max(64)
  .regex(/^[a-z0-9]+(?:[._-][a-z0-9]+)*$/);

/** Public, bounded, read-only chain port. No signer or model client is constructed here. */
export class MainnetReader {
  private cached: { expires: number; snapshot: z.infer<typeof MainnetSnapshot> } | undefined;
  private inFlight: Promise<z.infer<typeof MainnetSnapshot>> | undefined;
  private manifest: Promise<z.infer<typeof Manifest>>;
  constructor(
    private c: Config,
    private transport: Fetch = fetch,
    manifest?: z.infer<typeof Manifest>,
  ) {
    this.manifest = manifest
      ? Promise.resolve(Manifest.parse(manifest))
      : readFile(
          new URL('../artifacts/mainnet-paused-deployment.json', import.meta.url),
          'utf8',
        ).then((raw) => Manifest.parse(JSON.parse(raw)));
    // Avoid an unhandled rejection before the first request if packaging is wrong.
    void this.manifest.catch(() => {});
  }
  private requireMainnet() {
    if (this.c.EXECUTION_MODE !== 'LIVE' || this.c.NEAR_NETWORK !== 'mainnet')
      throw new DomainError('MAINNET_NOT_ACTIVE', 'Mainnet observation is not active', 503);
  }
  private async rpc(
    method: 'query' | 'status' | 'block' | 'EXPERIMENTAL_protocol_config' | 'tx',
    params: unknown,
    endpoint = this.c.NEAR_RPC_URL,
  ) {
    const raw = z.object({ result: z.unknown().optional(), error: z.unknown().optional() }).parse(
      await httpJson(
        endpoint,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ jsonrpc: '2.0', id: 'symbio-mainnet-read', method, params }),
          signal: AbortSignal.timeout(12000),
        },
        this.transport,
      ),
    );
    if (raw.error || raw.result === undefined)
      throw new DomainError('MAINNET_RPC_UNAVAILABLE', 'Mainnet data could not be verified', 503);
    return raw.result;
  }
  private async block() {
    const [status, block] = await Promise.all([
      this.rpc('status', []),
      this.rpc('block', { finality: 'final' }),
    ]);
    if (z.object({ chain_id: z.string() }).parse(status).chain_id !== 'mainnet')
      throw new DomainError('CHAIN_ID_MISMATCH', 'RPC is not NEAR mainnet', 503);
    return z
      .object({
        header: z.object({
          hash: z.string(),
          height: z.number().int().nonnegative(),
          timestamp_nanosec: atoms,
        }),
      })
      .parse(block).header;
  }
  private async view(contract: string, method: string, block: string, args: object = {}) {
    const r = z.object({ result: z.array(z.number().int().min(0).max(255)).max(100000) }).parse(
      await this.rpc('query', {
        request_type: 'call_function',
        block_id: block,
        account_id: contract,
        method_name: method,
        args_base64: Buffer.from(JSON.stringify(args)).toString('base64'),
      }),
    );
    return JSON.parse(Buffer.from(r.result).toString());
  }
  async intentKeyRegistered(account: string, publicKey: string, block: string) {
    this.requireMainnet();
    return z.boolean().parse(
      await this.view(this.c.INTENTS_CONTRACT_ID, 'has_public_key', block, {
        account_id: accountId.parse(account),
        public_key: publicKey,
      }),
    );
  }
  async activationPolicy(block: string) {
    this.requireMainnet();
    return z
      .object({
        max_trade_atoms: atoms,
        max_daily_atoms: atoms,
        min_reserve_yocto: atoms,
        max_signing_cost_yocto: atoms,
        max_slippage_bps: z.number().int(),
        allowed_chain_ids: z.array(z.number().int()).max(8),
        allowed_token_contracts: z.array(z.string()).max(16),
        token_max_trade_atoms: z.array(atoms).max(16),
        token_max_daily_atoms: z.array(atoms).max(16),
      })
      .strict()
      .parse(await this.view(this.c.NEAR_CONTRACT_ID, 'get_policy', block));
  }
  async snapshot() {
    this.requireMainnet();
    if (this.cached && this.cached.expires > Date.now()) return this.cached.snapshot;
    if (this.inFlight) return this.inFlight;
    this.inFlight = this.capture()
      .then((snapshot) => {
        this.cached = { snapshot, expires: Date.now() + 15000 };
        return snapshot;
      })
      .finally(() => {
        this.inFlight = undefined;
      });
    return this.inFlight;
  }
  private async capture() {
    const m = await this.manifest;
    if (
      this.c.NEAR_CONTRACT_ID !== m.treasury ||
      this.c.NEAR_BRAIN_ACCOUNT_ID !== m.accounts.brain ||
      this.c.NEAR_WORKER_ACCOUNT_ID !== m.accounts.hand ||
      this.c.NEAR_ACCOUNTANT_ACCOUNT_ID !== m.accounts.accountant ||
      this.c.NEAR_SCOUT_ACCOUNT_ID !== m.accounts.scout
    )
      throw new DomainError(
        'MAINNET_IDENTITY_MISMATCH',
        'Configured deployment differs from the reviewed manifest',
        503,
      );
    const b = await this.block();
    const protocol = z
      .object({
        chain_id: z.literal('mainnet'),
        runtime_config: z.object({ storage_amount_per_byte: atoms }),
      })
      .parse(await this.rpc('EXPERIMENTAL_protocol_config', { block_id: b.hash }));
    const storagePrice = BigInt(protocol.runtime_config.storage_amount_per_byte);
    const accountIds = {
      OWNER: m.ownerAccount,
      TREASURY: m.treasury,
      SCOUT: m.accounts.scout,
      BRAIN: m.accounts.brain,
      HAND: m.accounts.hand,
      ACCOUNTANT: m.accounts.accountant,
    };
    const accounts = [];
    let observedHash = '';
    let temporaryKeyRevoked = false;
    for (const [role, id] of Object.entries(accountIds)) {
      const [state, keys] = await Promise.all([
        this.rpc('query', { request_type: 'view_account', block_id: b.hash, account_id: id }).then(
          (r) => Account.parse(r),
        ),
        this.rpc('query', {
          request_type: 'view_access_key_list',
          block_id: b.hash,
          account_id: id,
        }).then((r) => Keys.parse(r)),
      ]);
      if (role === 'TREASURY') observedHash = state.code_hash;
      const recovery = keys.keys.some(
        (k) => k.public_key === m.recoveryPublicKey && k.access_key.permission === 'FullAccess',
      );
      if (role === 'OWNER') temporaryKeyRevoked = recovery && keys.keys.length === 1;
      const storage = BigInt(state.storage_usage) * storagePrice;
      const available = BigInt(state.amount) - storage;
      let workerEnabled: boolean | null = null;
      if (['BRAIN', 'HAND', 'ACCOUNTANT'].includes(role)) {
        const idBytes = Buffer.from(id),
          length = Buffer.alloc(4);
        length.writeUInt32LE(idBytes.length);
        const key = Buffer.concat([Buffer.from([1]), length, idBytes]).toString('base64');
        const result = z
          .object({ values: z.array(z.object({ key: z.string(), value: z.string() })).max(5) })
          .parse(
            await this.rpc('query', {
              request_type: 'view_state',
              block_id: b.hash,
              account_id: m.treasury,
              prefix_base64: key,
            }),
          );
        const record = result.values.find((v) => v.key === key);
        if (!record || !['AA==', 'AQ=='].includes(record.value))
          throw new DomainError(
            'WORKER_STATE_UNVERIFIED',
            'Worker permissions could not be read',
            503,
          );
        workerEnabled = record.value === 'AQ==';
      }
      accounts.push({
        role,
        accountId: id,
        balanceYocto: state.amount,
        storageYocto: storage.toString(),
        availableYocto: (available > 0n ? available : 0n).toString(),
        storageBytes: state.storage_usage,
        fullAccessKeyCount: keys.keys.filter((k) => k.access_key.permission === 'FullAccess')
          .length,
        scopedKeyCount: keys.keys.filter((k) => k.access_key.permission !== 'FullAccess').length,
        recoveryKeyPresent: recovery,
        workerEnabled,
      });
    }
    const [distribution, policy, supply] = await Promise.all([
      this.view(m.treasury, 'distribution_policy', b.hash).then((v) =>
        z.object({ paused: z.boolean(), total_shares_bps: z.number().int() }).parse(v),
      ),
      this.view(m.treasury, 'get_policy', b.hash).then((v) =>
        z
          .object({ max_trade_atoms: atoms, max_daily_atoms: atoms, min_reserve_yocto: atoms })
          .parse(v),
      ),
      this.view(m.treasury, 'nft_total_supply', b.hash).then((v) => atoms.parse(v)),
    ]);
    const expectedHash = bs58.encode(Buffer.from(m.wasmSha256, 'hex'));
    const placeholderLimits = policy.max_trade_atoms === '1' || policy.max_daily_atoms === '1';
    const blockers = [
      ...(!this.c.EXECUTION_ENABLED
        ? ['Execution is disarmed; production serves mainnet observations only.']
        : []),
      ...(distribution.paused ? ['The treasury is paused on-chain.'] : []),
      ...(placeholderLimits ? ['Trading and gas spending caps are not configured.'] : []),
      'Inference blocked by application-level TEE workload measurement policy.',
      'Funded trading routes and a profitable settlement have not been demonstrated.',
      'Automatic AI credit purchasing has no supported provider payment integration.',
      ...(observedHash !== expectedHash
        ? ['Treasury code differs from the reviewed executable.']
        : []),
    ];
    return MainnetSnapshot.parse({
      contractVersion: 1,
      mode: 'LIVE',
      network: 'mainnet',
      capturedAt: new Date().toISOString(),
      block: {
        height: String(b.height),
        hash: b.hash,
        timestamp: new Date(Number(BigInt(b.timestamp_nanosec) / 1000000n)).toISOString(),
      },
      executionEnabled: this.c.EXECUTION_ENABLED,
      ownerAccount: m.ownerAccount,
      treasuryAccount: m.treasury,
      code: { expectedHash, observedHash, matches: observedHash === expectedHash },
      paused: distribution.paused,
      accounts,
      policy: {
        maxTradeAtoms: policy.max_trade_atoms,
        maxDailyAtoms: policy.max_daily_atoms,
        minReserveYocto: policy.min_reserve_yocto,
        placeholderLimits,
      },
      nfts: {
        totalSupply: supply,
        revenueShareBps: distribution.total_shares_bps,
        distributionLiabilityYocto: null,
      },
      compute: {
        model: this.c.NEAR_AI_MODEL,
        totalBudgetUsdMicros: this.c.AI_TOTAL_BUDGET_USD_MICROS,
        maxRequestUsdMicros: this.c.AI_MAX_REQUEST_USD_MICROS,
        deploymentApproval: 'QUARANTINED',
        automaticCreditPurchase: false,
      },
      deployment: { verifiedAt: m.checkedAt, temporaryKeyRevoked, transactions: m.transactions },
      blockers,
      survivalHours: null,
      externalRevenueProven: false,
    });
  }
  async wallet(input: string) {
    this.requireMainnet();
    const id = accountId.parse(input),
      b = await this.block();
    const [state, protocol] = await Promise.all([
      this.rpc('query', { request_type: 'view_account', block_id: b.hash, account_id: id }).then(
        (v) => Account.parse(v),
      ),
      this.rpc('EXPERIMENTAL_protocol_config', { block_id: b.hash }).then((v) =>
        z.object({ runtime_config: z.object({ storage_amount_per_byte: atoms }) }).parse(v),
      ),
    ]);
    const storage =
        BigInt(state.storage_usage) * BigInt(protocol.runtime_config.storage_amount_per_byte),
      available = BigInt(state.amount) - storage;
    return MainnetWallet.parse({
      network: 'mainnet',
      accountId: id,
      balanceYocto: state.amount,
      storageYocto: storage.toString(),
      availableYocto: (available > 0n ? available : 0n).toString(),
      blockHash: b.hash,
    });
  }
  async transaction(input: string) {
    this.requireMainnet();
    const hash = z
      .string()
      .regex(/^[1-9A-HJ-NP-Za-km-z]{43,44}$/)
      .parse(input);
    const m = await this.manifest,
      known = m.transactions.find((t) => t.hash === hash);
    if (!known)
      throw new DomainError(
        'TRANSACTION_NOT_RECORDED',
        'No recorded deployment transaction matches this hash',
        404,
      );
    await this.block();
    // Recorded deployment receipts can outlive the regular node's transaction cache.
    const archive = 'https://archival-rpc.mainnet.fastnear.com';
    const archiveIdentity = z
      .object({ chain_id: z.string() })
      .parse(await this.rpc('status', [], archive));
    if (archiveIdentity.chain_id !== 'mainnet')
      throw new DomainError('CHAIN_ID_MISMATCH', 'Archive RPC is not NEAR mainnet', 503);
    const outcomeStatus = z.union([
      z.object({ SuccessValue: z.string() }).strict(),
      z.object({ SuccessReceiptId: z.string() }).strict(),
      z.object({ Failure: z.unknown() }).strict(),
    ]);
    const tx = z
      .object({
        final_execution_status: z.string(),
        status: outcomeStatus,
        receipts_outcome: z
          .array(z.object({ outcome: z.object({ status: outcomeStatus }) }))
          .max(1000),
        transaction: z.object({ hash: z.string(), signer_id: z.string(), receiver_id: z.string() }),
        transaction_outcome: z.object({ block_hash: z.string() }),
      })
      .parse(
        await this.rpc(
          'tx',
          {
            tx_hash: hash,
            sender_account_id: known.signerId,
            wait_until: 'FINAL',
          },
          archive,
        ),
      );
    if (
      tx.transaction.hash !== hash ||
      tx.transaction.signer_id !== known.signerId ||
      tx.transaction.receiver_id !== known.receiverId
    )
      throw new DomainError(
        'TRANSACTION_IDENTITY_MISMATCH',
        'Transaction identity did not match',
        503,
      );
    return MainnetTransaction.parse({
      contractVersion: 1,
      network: 'mainnet',
      hash,
      signerId: known.signerId,
      receiverId: known.receiverId,
      succeeded:
        !('Failure' in tx.status) &&
        tx.receipts_outcome.every((r) => !('Failure' in r.outcome.status)),
      final: tx.final_execution_status === 'FINAL',
      blockHash: tx.transaction_outcome.block_hash,
      url: known.url,
      verifiedAt: new Date().toISOString(),
      classification: 'DEPLOYMENT_NOT_REVENUE',
    });
  }
}
