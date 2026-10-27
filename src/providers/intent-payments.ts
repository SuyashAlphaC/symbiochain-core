import { Account, JsonRpcProvider, type KeyPairString } from 'near-api-js';
import { signMessage } from 'near-api-js/nep413';
import bs58 from 'bs58';
import { Store } from '../store.js';
import { DomainError, digest, sha256 } from '../domain.js';
import { seal, unseal } from '../crypto.js';
export interface SignedServiceIntent {
  standard: 'nep413';
  payload: { message: string; nonce: string; recipient: string };
  public_key: string;
  signature: string;
}
export interface PaymentTransport {
  salt(): Promise<string>;
  registered(accountId: string, publicKey: string): Promise<boolean>;
  used(accountId: string, nonce: string): Promise<boolean>;
  execute(account: Account, intent: SignedServiceIntent): Promise<string>;
}
export class IntentPayments {
  private readonly accounts: Record<'BRAIN' | 'HAND', Account>;
  private readonly transport: PaymentTransport;
  constructor(
    readonly store: Store,
    transport?: PaymentTransport,
  ) {
    const c = store.config,
      provider = new JsonRpcProvider({ url: c.NEAR_RPC_URL });
    this.accounts = {
      BRAIN: new Account(
        c.NEAR_BRAIN_ACCOUNT_ID,
        provider,
        (c.INTENTS_BRAIN_PRIVATE_KEY || c.NEAR_BRAIN_PRIVATE_KEY) as KeyPairString,
      ),
      HAND: new Account(
        c.NEAR_WORKER_ACCOUNT_ID,
        provider,
        (c.INTENTS_HAND_PRIVATE_KEY || c.NEAR_WORKER_PRIVATE_KEY) as KeyPairString,
      ),
    };
    const view = async <T>(method: string, args: Record<string, unknown>) =>
      (await provider.callFunction({
        contractId: c.INTENTS_CONTRACT_ID,
        method,
        args,
        blockQuery: { finality: 'final' },
      })) as T;
    this.transport = transport ?? {
      salt: () => view<string>('current_salt', {}),
      registered: (accountId, publicKey) =>
        view<boolean>('has_public_key', { account_id: accountId, public_key: publicKey }),
      used: (accountId, nonce) => view<boolean>('is_nonce_used', { account_id: accountId, nonce }),
      execute: async (account, intent) => {
        const result = await account.callFunctionRaw({
          contractId: c.INTENTS_CONTRACT_ID,
          methodName: 'execute_intents',
          args: { signed: [intent] },
          gas: 100_000_000_000_000n,
          deposit: 0n,
          waitUntil: 'FINAL',
        });
        if (result.status && typeof result.status === 'object' && 'Failure' in result.status)
          throw new DomainError('INTENT_EXECUTION_FAILED', 'Verifier rejected the service payment');
        return result.transaction.hash;
      },
    };
  }
  async settle(
    cycleId: string,
    id: string,
    role: 'BRAIN' | 'HAND',
    recipient: string,
    referenceHash: string,
  ): Promise<void> {
    const c = this.store.config,
      account = this.accounts[role],
      amount = c.SERVICE_PAYMENT_YOCTO;
    if (BigInt(amount) === 0n) return;
    const terms = {
      payer: account.accountId,
      recipient,
      amount,
      referenceHash,
      verifier: c.INTENTS_CONTRACT_ID,
      asset: 'nep141:wrap.near',
    };
    let row = await this.store.db.servicePayment.findUnique({ where: { id } }),
      intent: SignedServiceIntent;
    if (row) {
      if (row.termsDigest !== digest(terms))
        throw new DomainError('SERVICE_PAYMENT_CONFLICT', 'Payment terms have changed');
      if (row.status === 'SETTLED') return;
      intent = unseal(row.payloadCiphertext, c.EVIDENCE_ENCRYPTION_KEY, id) as SignedServiceIntent;
    } else {
      const salt = await this.transport.salt();
      if (!/^[a-fA-F0-9]{8}$/.test(salt))
        throw new DomainError('INTENTS_SALT', 'Invalid verifier nonce salt');
      const nonce = Buffer.concat([
        Buffer.from(salt, 'hex'),
        Buffer.from(sha256(`symbio-service:${id}`), 'hex').subarray(0, 28),
      ]);
      const cycle = await this.store.getCycle(cycleId);
      const message = JSON.stringify({
        signer_id: account.accountId,
        deadline: cycle.expiresAt.toISOString(),
        intents: [
          {
            intent: 'transfer',
            receiver_id: recipient,
            tokens: { 'nep141:wrap.near': amount },
            memo: `${id}:${referenceHash}`,
          },
        ],
      });
      const signed = await signMessage({
        signerAccount: account,
        payload: { message, nonce, recipient: c.INTENTS_CONTRACT_ID },
      });
      if (signed.publicKey.keyType !== 0)
        throw new DomainError(
          'INTENT_KEY_TYPE',
          'Service payments require dedicated Ed25519 signing keys',
        );
      if (!(await this.transport.registered(account.accountId, signed.publicKey.toString())))
        throw new DomainError(
          'INTENT_KEY_UNREGISTERED',
          'Register the dedicated agent public key on the verifier before enabling service payments',
        );
      intent = {
        standard: 'nep413',
        payload: { message, nonce: nonce.toString('base64'), recipient: c.INTENTS_CONTRACT_ID },
        public_key: signed.publicKey.toString(),
        signature: `ed25519:${bs58.encode(signed.signature)}`,
      };
      await this.store.db.servicePayment.create({
        data: {
          id,
          cycleId,
          mode: this.store.mode,
          termsDigest: digest(terms),
          status: 'PREPARED',
          payloadCiphertext: seal(intent, c.EVIDENCE_ENCRYPTION_KEY, id),
        },
      });
      row = await this.store.db.servicePayment.findUniqueOrThrow({ where: { id } });
    }
    if (!(await this.transport.used(account.accountId, intent.payload.nonce))) {
      if (row.attempts >= 3)
        throw new DomainError(
          'SERVICE_OUTCOME_UNKNOWN',
          'Payment retry budget exhausted; only nonce reconciliation remains',
        );
      if (Date.parse(JSON.parse(intent.payload.message).deadline) <= Date.now())
        throw new DomainError(
          'SERVICE_INTENT_EXPIRED',
          'Persisted intent expired; a replacement nonce is never generated automatically',
        );
      await this.store.db.servicePayment.update({
        where: { id },
        data: { attempts: { increment: 1 }, status: 'SUBMITTING' },
      });
      const txHash = await this.transport.execute(account, intent);
      await this.store.db.servicePayment.update({ where: { id }, data: { txHash } });
      if (!(await this.transport.used(account.accountId, intent.payload.nonce)))
        throw new DomainError('SERVICE_NOT_FINAL', 'Verifier has not confirmed the payment nonce');
    }
    await this.store.atomic(async (tx) => {
      const inserted = await this.store.journal(
        tx,
        `service:${id}`,
        'INTERNAL_AGENT_PAYMENT',
        [
          {
            account: `AGENT:${account.accountId}`,
            asset: terms.asset,
            amountAtoms: -BigInt(amount),
          },
          { account: `AGENT:${recipient}`, asset: terms.asset, amountAtoms: BigInt(amount) },
        ],
        cycleId,
      );
      await tx.servicePayment.update({ where: { id }, data: { status: 'SETTLED' } });
      if (inserted)
        await this.store.event(
          tx,
          'agent.payment',
          {
            id,
            payer: terms.payer,
            recipient,
            asset: terms.asset,
            amountAtoms: amount,
            referenceHash,
            rail: 'NEAR_INTENTS',
            classification: 'INTERNAL_TRANSFER_NOT_REVENUE',
            nonce: intent.payload.nonce,
          },
          cycleId,
        );
    });
  }
}
