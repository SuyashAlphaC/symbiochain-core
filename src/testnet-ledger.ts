import { mkdir, open, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import {
  Account,
  actions,
  JsonRpcProvider,
  SignedTransaction,
  type KeyPairString,
} from 'near-api-js';
import { digest, DomainError, sha256 } from './domain.js';
import {
  TESTNET_RPC,
  TestnetSecrets,
  requireTestnetAccount,
  requireTestnetNetwork,
} from './testnet-profile.js';
import bs58 from 'bs58';

type Role = 'owner' | 'brain' | 'hand' | 'books' | 'treasury';
type Outcome = Awaited<ReturnType<Account['signAndSendTransaction']>>;
type Entry = { binding: string; signedBase64: string; outcome?: Outcome };
export async function privateJson(path: string, value: unknown): Promise<void> {
  await writeFile(`${path}.tmp`, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 });
  await rename(`${path}.tmp`, path);
}
export async function optionalJson(path: string): Promise<unknown | null> {
  try {
    return JSON.parse(await readFile(path, 'utf8'));
  } catch (e) {
    if (e && typeof e === 'object' && 'code' in e && e.code === 'ENOENT') return null;
    throw e;
  }
}

/** Uses only the faucet accounts created by testnet:rehearse. No mainnet keys are read. */
export class TestnetLedger {
  readonly provider = new JsonRpcProvider({ url: TESTNET_RPC });
  readonly accounts: Record<Role, Account>;
  private journal: Record<string, Entry> = {};
  private constructor(
    readonly directory: string,
    secrets: ReturnType<typeof TestnetSecrets.parse>,
  ) {
    this.accounts = Object.fromEntries(
      Object.entries(secrets.keys).map(([role, key]) => {
        const id = role === 'owner' ? secrets.root : `${role}.${secrets.root}`;
        requireTestnetAccount(id);
        return [role, new Account(id, this.provider, key as KeyPairString)];
      }),
    ) as Record<Role, Account>;
  }
  static async open(directory: string): Promise<TestnetLedger> {
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const secrets = TestnetSecrets.parse(
      await optionalJson('.data/testnet-rehearsal/credentials.json'),
    );
    const ledger = new TestnetLedger(directory, secrets);
    ledger.journal = ((await optionalJson(`${directory}/near-journal.json`)) ?? {}) as Record<
      string,
      Entry
    >;
    await ledger.network();
    const wasm = await readFile('artifacts/symbiochain_treasury.wasm');
    const account = await ledger.provider.viewAccount({
      accountId: ledger.accounts.treasury.accountId,
    });
    if (account.code_hash !== bs58.encode(Buffer.from(sha256(wasm), 'hex')))
      throw new DomainError(
        'TESTNET_CODE',
        'Rehearsal contract must match the locally built treasury',
      );
    return ledger;
  }
  async network() {
    await requireTestnetNetwork(() => this.provider.viewNodeStatus());
  }
  async view<T>(method: string, args: Record<string, unknown> = {}): Promise<T> {
    await this.network();
    return (await this.provider.callFunction({
      contractId: this.accounts.treasury.accountId,
      method,
      args,
    })) as T;
  }
  async call(
    operation: string,
    role: Role,
    method: string,
    args: Record<string, unknown> = {},
    deposit = 0n,
    gas = 80_000_000_000_000n,
  ): Promise<Outcome> {
    await this.network();
    const signer = this.accounts[role],
      receiver = this.accounts.treasury.accountId;
    const binding = digest({
      role,
      receiver,
      method,
      args,
      deposit: String(deposit),
      gas: String(gas),
    });
    const prior = this.journal[operation];
    if (prior && prior.binding !== binding)
      throw new DomainError('TESTNET_CONFLICT', 'Operation conflicts with durable terms');
    if (prior?.outcome) return this.success(prior.outcome);
    const signed = prior
      ? SignedTransaction.decode(Buffer.from(prior.signedBase64, 'base64'))
      : await signer.createSignedTransaction({
          receiverId: receiver,
          actions: [actions.functionCall(method, args, gas, deposit)],
        });
    this.journal[operation] = {
      binding,
      signedBase64: Buffer.from(signed.encode()).toString('base64'),
    };
    // A failed transport may only retry these identical bytes. Never regenerate a nonce.
    await privateJson(`${this.directory}/near-journal.json`, this.journal);
    const outcome = await this.provider.sendTransactionUntil(signed, 'FINAL');
    this.journal[operation]!.outcome = outcome;
    await privateJson(`${this.directory}/near-journal.json`, this.journal);
    return this.success(outcome);
  }
  private success(outcome: Outcome): Outcome {
    if (JSON.stringify(outcome.status).includes('Failure'))
      throw new DomainError(
        'TESTNET_CONTRACT_REJECTED',
        'Testnet contract rejected the recorded operation',
      );
    return outcome;
  }
  transactions() {
    return Object.entries(this.journal).flatMap(([operation, entry]) =>
      entry.outcome
        ? [
            {
              operation,
              hash: entry.outcome.transaction.hash,
              receiver: this.accounts.treasury.accountId,
              success: !JSON.stringify(entry.outcome.status).includes('Failure'),
            },
          ]
        : [],
    );
  }
  async paused(paused: boolean): Promise<void> {
    const current = await this.view<{ status: string }>('check_metabolism');
    if ((current.status === 'PAUSED') === paused) return;
    const pending = Object.entries(this.journal).find(
      ([key, value]) => key.startsWith(paused ? 'pause-' : 'resume-') && !value.outcome,
    );
    await this.call(
      pending?.[0] ?? `${paused ? 'pause' : 'resume'}-${Object.keys(this.journal).length}`,
      'owner',
      'set_paused',
      { paused },
    );
  }
}

/** Shared with the rehearsal so two commands never sign from the same role concurrently. */
export async function testnetLock(
  directory = '.data/testnet-rehearsal',
): Promise<() => Promise<void>> {
  const path = `${directory}/runner.lock`;
  const lock = await open(path, 'wx', 0o600).catch((error) => {
    if (error.code === 'EEXIST')
      throw new DomainError(
        'TESTNET_RUNNER_LOCKED',
        'Another runner or an unreconciled stale lock exists',
      );
    throw error;
  });
  await lock.writeFile(JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }));
  return async () => {
    await lock.close();
    await unlink(path);
  };
}

/** Explicit recovery only; never remove a live or unidentifiable runner's lock. */
export async function recoverTestnetLock(directory = '.data/testnet-rehearsal'): Promise<void> {
  const path = `${directory}/runner.lock`;
  const value = (await optionalJson(path)) as { pid?: number; startedAt?: string } | null;
  if (!value) return;
  if (!Number.isSafeInteger(value.pid) || value.pid! <= 1 || typeof value.startedAt !== 'string')
    throw new DomainError('TESTNET_LOCK_MANUAL_REVIEW', 'Lock owner cannot be identified');
  try {
    process.kill(value.pid!, 0);
  } catch (error) {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'ESRCH') {
      await privateJson(`${directory}/last-lock-recovery.json`, {
        pid: value.pid,
        recoveredAt: new Date().toISOString(),
        note: 'Removed a dead runner lock only. Signed transactions and inference reservations remain unchanged.',
      });
      await unlink(path);
      return;
    }
    throw new DomainError(
      'TESTNET_LOCK_MANUAL_REVIEW',
      'Cannot establish whether the lock owner is alive',
    );
  }
  throw new DomainError('TESTNET_RUNNER_ACTIVE', 'Refuse recovery while the lock owner exists');
}
