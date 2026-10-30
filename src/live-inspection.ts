import { createHash } from 'node:crypto';
import bs58 from 'bs58';
import { z } from 'zod';
import { DomainError } from './domain.js';
import { httpJson, type Fetch } from './providers/http.js';

const integer = z.string().regex(/^\d{1,78}$/);
const accountId = z
  .string()
  .min(2)
  .max(64)
  .regex(/^[a-z0-9]+(?:[-_.][a-z0-9]+)*$/)
  .refine((v) => !v.endsWith('.testnet'));
const account = z.object({
  amount: integer,
  locked: integer,
  storage_usage: z.number().int().nonnegative().safe(),
  code_hash: z.string().min(1),
});

/** Read-only release inspection. It has no signer, key store, database or broadcast transport. */
export async function inspectMainnetRelease(
  input: {
    wasm: Uint8Array;
    rpcUrl: string;
    accounts: Partial<
      Record<'OWNER' | 'TREASURY' | 'BRAIN' | 'HAND' | 'SCOUT' | 'ACCOUNTANT', string>
    >;
  },
  transport: Fetch = fetch,
) {
  if (
    input.wasm.length < 8 ||
    !Buffer.from(input.wasm.subarray(0, 8)).equals(Buffer.from([0, 97, 115, 109, 1, 0, 0, 0]))
  )
    throw new DomainError('WASM_INVALID', 'Build the treasury WASM before inspecting its release');
  for (const value of Object.values(input.accounts)) if (value) accountId.parse(value);
  const url = new URL(input.rpcUrl);
  if (url.protocol !== 'https:' || url.username || url.password)
    throw new DomainError('RPC_URL', 'Mainnet inspection requires an HTTPS RPC');
  async function rpc(
    method: 'status' | 'block' | 'EXPERIMENTAL_protocol_config' | 'query',
    params: unknown,
  ) {
    const raw = z
      .object({
        result: z.unknown().optional(),
        error: z
          .object({ cause: z.object({ name: z.string() }).optional() })
          .passthrough()
          .optional(),
      })
      .parse(
        await httpJson(
          url,
          {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
              jsonrpc: '2.0',
              id: 'symbio-release-inspection',
              method,
              params,
            }),
          },
          transport,
        ),
      );
    if (raw.error) {
      if (raw.error.cause?.name === 'UNKNOWN_ACCOUNT') return null;
      throw new DomainError('RPC_UNAVAILABLE', 'A read-only mainnet query failed');
    }
    if (raw.result === undefined)
      throw new DomainError('RPC_RESPONSE', 'Mainnet RPC omitted its result');
    return raw.result;
  }
  const status = z.object({ chain_id: z.literal('mainnet') }).parse(await rpc('status', []));
  const block = z
    .object({ header: z.object({ height: z.number().int().safe(), hash: z.string().min(1) }) })
    .parse(await rpc('block', { finality: 'final' }));
  const protocol = z
    .object({
      chain_id: z.literal('mainnet'),
      protocol_version: z.number().int(),
      runtime_config: z.object({ storage_amount_per_byte: integer }),
    })
    .parse(await rpc('EXPERIMENTAL_protocol_config', { block_id: block.header.hash }));
  if (BigInt(protocol.runtime_config.storage_amount_per_byte) <= 0n)
    throw new DomainError('STORAGE_PRICE', 'Mainnet RPC reported an invalid storage price');
  const hash = createHash('sha256').update(input.wasm).digest();
  const codeHash = bs58.encode(hash);
  const observations = [];
  for (const role of ['OWNER', 'TREASURY', 'BRAIN', 'HAND', 'SCOUT', 'ACCOUNTANT'] as const) {
    const id = input.accounts[role];
    if (!id) {
      observations.push({ role, accountId: null, status: 'NOT_SELECTED' as const });
      continue;
    }
    const raw = await rpc('query', {
      request_type: 'view_account',
      block_id: block.header.hash,
      account_id: id,
    });
    if (raw === null) {
      observations.push({ role, accountId: id, status: 'NOT_CREATED' as const });
      continue;
    }
    const state = account.parse(raw);
    observations.push({
      role,
      accountId: id,
      status: 'EXISTS' as const,
      amountYoctoNear: state.amount,
      lockedYoctoNear: state.locked,
      storageBytes: state.storage_usage,
      codeHash: state.code_hash,
      treasuryCodeMatches: role === 'TREASURY' ? state.code_hash === codeHash : null,
    });
  }
  const signer = account.parse(
    await rpc('query', {
      request_type: 'view_account',
      block_id: block.header.hash,
      account_id: 'v1.signer',
    }),
  );
  if (signer.code_hash === bs58.encode(new Uint8Array(32)))
    throw new DomainError('MPC_CODE_MISSING', 'Mainnet signer account has no contract');
  return {
    version: 1,
    capturedAt: new Date().toISOString(),
    inspection: 'READ_ONLY_MAINNET',
    transactionsPerformed: false,
    network: {
      chainId: status.chain_id,
      protocolVersion: protocol.protocol_version,
      observedAtBlock: block.header.height,
      observedAtBlockHash: block.header.hash,
    },
    artifact: { bytes: input.wasm.length, sha256: hash.toString('hex'), nearCodeHash: codeHash },
    storage: {
      pricePerByteYoctoNear: protocol.runtime_config.storage_amount_per_byte,
      codeOnlyLockLowerBoundYoctoNear: (
        BigInt(input.wasm.length) * BigInt(protocol.runtime_config.storage_amount_per_byte)
      ).toString(),
      excludes: [
        'account and key storage',
        'initialized and future contract state',
        'native reserves',
        'transaction gas',
        'Intents service funds',
        'external-chain gas and principal',
      ],
      classification: 'LOCKED_CAPITAL_NOT_TRANSACTION_FEE',
    },
    accounts: observations,
    mpc: {
      accountId: 'v1.signer',
      codeHash: signer.code_hash,
      signatureRequested: false,
      signatureCompatibilityVerified: false,
    },
    releaseStatus: 'OWNER_REVIEW_REQUIRED',
    fundingBudgetApproved: false,
    fundedRoundTripVerified: false,
    remaining: [
      'Select owner and role accounts and approve an explicit funding budget',
      'Review initializer, key scopes, asset metadata and both contract/backend policies',
      'Deploy and verify contract identity before funding derived wallets',
      'Register dedicated Intents keys and fund wNEAR service balances',
      'Verify derived EVM/Solana custody, mainnet RPCs, native gas and principal',
      'Complete approved TEE and compute-balance setup before enabling LIVE',
      'Execute only a route that passes the existing profitability and spending checks',
    ],
  };
}
