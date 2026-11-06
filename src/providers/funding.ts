import {
  Account,
  JsonRpcProvider,
  SignedTransaction,
  actions,
  type KeyPairString,
} from 'near-api-js';
import { signMessage } from 'near-api-js/nep413';
import bs58 from 'bs58';
import { z } from 'zod';
import {
  verifyQuoteSignature,
  quoteHash,
  type QuoteResponse,
} from '@defuse-protocol/one-click-sdk-typescript';
import type { Config } from '../config.js';
import { DomainError, digest, sha256, atoms, positiveAtoms } from '../domain.js';
import { OneClickClient, quoteSchema } from './oneclick.js';
import { incomingWrapCredit } from './funding-credit.js';
import { nearHash } from './intent-receipts.js';
import { httpJson, type Fetch } from './http.js';
import {
  SignedFundingIntent,
  PreparedFundingCall,
  type FundingTerms,
  type FundingPorts,
  type FinalFundingCall,
} from '../funding-types.js';

const WRAP = 'nep141:wrap.near';
const GAS = { WITHDRAW: 200_000_000_000_000n, DISTRIBUTE: 100_000_000_000_000n };
const nonceBytes = (value: string) => {
  const bytes = Buffer.from(value, 'base64');
  if (bytes.length !== 32 || bytes.toString('base64') !== value)
    throw new DomainError('FUNDING_NONCE', 'Expected a canonical 32-byte nonce');
  return bytes;
};
/** Only this exact two-asset exchange may be signed. No provider-generated arbitrary actions. */
export function swapCredit(
  terms: FundingTerms,
  quote: unknown,
  signed: { payload: { message: string; nonce: string; recipient: string } },
  now = Date.now(),
) {
  const q = quoteSchema.parse(quote);
  const expected = {
    dry: false,
    swapType: 'EXACT_INPUT',
    depositMode: 'SIMPLE',
    originAsset: terms.asset,
    destinationAsset: WRAP,
    depositType: 'INTENTS',
    recipientType: 'INTENTS',
    refundType: 'INTENTS',
    amount: terms.amountAtoms,
    recipient: terms.payer,
    refundTo: terms.payer,
    slippageTolerance: terms.slippageBps,
    deadline: terms.deadline,
  };
  for (const [key, value] of Object.entries(expected))
    if (digest(q.quoteRequest[key]) !== digest(value))
      throw new DomainError('FUNDING_QUOTE_TERMS', 'Conversion quote changed committed terms');
  if (
    q.quote.amountIn !== terms.amountAtoms ||
    BigInt(q.quote.minAmountOut) < BigInt(terms.minimumNearYocto) ||
    BigInt(q.quote.minAmountOut) <= 0n ||
    BigInt(q.quote.minAmountOut) > BigInt(q.quote.amountOut)
  )
    throw new DomainError(
      'FUNDING_QUOTE_FLOOR',
      'Conversion does not meet the approved NEAR minimum',
    );
  const action = z.discriminatedUnion('intent', [
    z
      .object({
        intent: z.literal('token_diff'),
        diff: z.record(z.string(), z.string().regex(/^-?[1-9]\d*$/)),
      })
      .strict(),
    z
      .object({
        intent: z.literal('transfer'),
        receiver_id: z.string(),
        tokens: z.record(z.string(), positiveAtoms),
      })
      .strict(),
  ]);
  const message = z
    .object({ signer_id: z.string(), deadline: z.iso.datetime(), intents: z.tuple([action]) })
    .strict()
    .parse(JSON.parse(signed.payload.message));
  if (
    Date.parse(q.quote.deadline ?? '') > Date.parse(terms.deadline) + 72 * 3600000 ||
    signed.payload.recipient !== 'intents.near' ||
    message.signer_id !== terms.payer ||
    Date.parse(message.deadline) > Date.parse(q.quote.deadline ?? terms.deadline) ||
    Date.parse(message.deadline) <= now
  )
    throw new DomainError('FUNDING_INTENT_TERMS', 'Unsigned intent exceeds the approved exchange');
  const intent = message.intents[0];
  let credit = q.quote.minAmountOut;
  if (intent.intent === 'transfer') {
    if (
      !q.quote.depositAddress ||
      intent.receiver_id !== q.quote.depositAddress ||
      Object.keys(intent.tokens).length !== 1 ||
      intent.tokens[terms.asset] !== terms.amountAtoms
    )
      throw new DomainError(
        'FUNDING_INTENT_TERMS',
        'Transfer is not the signed quote deposit and exact reserved amount',
      );
  } else {
    const diff = intent.diff;
    credit = diff[WRAP] ?? '0';
    if (
      Object.keys(diff).length !== 2 ||
      diff[terms.asset] !== `-${terms.amountAtoms}` ||
      !/^\d+$/.test(credit) ||
      BigInt(credit) < BigInt(q.quote.minAmountOut) ||
      BigInt(credit) > BigInt(q.quote.amountOut)
    )
      throw new DomainError(
        'FUNDING_INTENT_TERMS',
        'Unsigned intent exceeds the approved exchange',
      );
  }
  nonceBytes(signed.payload.nonce);
  return credit;
}

export class NearFundingPorts implements FundingPorts {
  private readonly provider: JsonRpcProvider;
  private readonly accountant: Account;
  private readonly business: Account;
  private readonly oneclick: OneClickClient;
  constructor(
    readonly config: Config,
    private readonly transport: Fetch = fetch,
  ) {
    this.provider = new JsonRpcProvider({ url: config.NEAR_RPC_URL });
    this.accountant = new Account(
      config.NEAR_ACCOUNTANT_ACCOUNT_ID,
      this.provider,
      config.BUSINESS_PAYOUT_PRIVATE_KEY as KeyPairString,
    );
    // This key signs Intents only; it is never used for a NEAR transaction.
    this.business = new Account(
      config.BUSINESS_RECEIVER_ID,
      this.provider,
      config.BUSINESS_INTENTS_PRIVATE_KEY as KeyPairString,
    );
    this.oneclick = new OneClickClient(config, transport);
  }
  private async rpc(method: string, params: unknown): Promise<unknown> {
    const r = z.object({ result: z.unknown().optional(), error: z.unknown().optional() }).parse(
      await httpJson(
        this.config.NEAR_RPC_URL,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ jsonrpc: '2.0', id: 'business-funding', method, params }),
        },
        this.transport,
      ),
    );
    if (r.error) {
      if (method === 'tx' && JSON.stringify(r.error).includes('UNKNOWN_TRANSACTION')) return null;
      throw new DomainError(
        'FUNDING_RPC_UNAVAILABLE',
        'Financial outcome could not be established',
        502,
      );
    }
    return r.result;
  }
  private async view<T>(accountId: string, method: string, args: unknown): Promise<T> {
    const result = z.object({ result: z.array(z.number().int().min(0).max(255)) }).parse(
      await this.rpc('query', {
        request_type: 'call_function',
        account_id: accountId,
        method_name: method,
        args_base64: Buffer.from(JSON.stringify(args)).toString('base64'),
        finality: 'final',
      }),
    );
    return JSON.parse(Buffer.from(result.result).toString('utf8')) as T;
  }
  private async used(nonce: string) {
    return z.boolean().parse(
      await this.view('intents.near', 'is_nonce_used', {
        account_id: this.config.BUSINESS_RECEIVER_ID,
        nonce,
      }),
    );
  }
  async check(t: FundingTerms, deposit = '0', gasSpent = '0') {
    if (
      this.config.NEAR_NETWORK !== 'mainnet' ||
      this.config.EXECUTION_MODE !== 'LIVE' ||
      !this.config.LIVE_TRADING_ENABLED ||
      !this.config.BUSINESS_PAYOUTS_ENABLED ||
      new URL(this.config.ONECLICK_API_BASE_URL).origin !== 'https://1click.chaindefuser.com' ||
      new URL(this.config.NEAR_RPC_URL).protocol !== 'https:' ||
      this.config.INTENTS_CONTRACT_ID !== 'intents.near'
    )
      throw new DomainError('FUNDING_DISABLED', 'Mainnet business payouts are not armed');
    z.object({ chain_id: z.literal('mainnet') }).parse(await this.rpc('status', []));
    const [contract, balance, gas, policy] = await Promise.all([
      this.rpc('query', {
        request_type: 'view_account',
        account_id: t.treasury,
        finality: 'final',
      }),
      this.rpc('query', {
        request_type: 'view_account',
        account_id: t.accountant,
        finality: 'final',
      }),
      this.rpc('gas_price', [null]),
      this.view(t.treasury, 'distribution_policy', {}),
    ]);
    if (z.object({ code_hash: z.string() }).parse(contract).code_hash !== t.treasuryCodeHash)
      throw new DomainError('FUNDING_CONTRACT', 'Treasury code does not match the approved hash');
    const p = z
      .object({
        accountant: z.string(),
        total_shares_bps: z.number().int().min(1).max(10000),
        paused: z.literal(false),
      })
      .parse(policy);
    if (p.accountant !== t.accountant)
      throw new DomainError('FUNDING_ACCOUNTANT', 'Treasury accountant changed');
    const b = z
      .object({ amount: atoms, storage_usage: z.number().int().nonnegative() })
      .parse(balance);
    const gasPrice = BigInt(z.object({ gas_price: positiveAtoms }).parse(gas).gas_price);
    // Three hundred Tgas plus a 2x price margin; no signed transaction may exceed the fixed gas units.
    const spent = BigInt(gasSpent);
    const remaining = BigInt(t.maxGasYocto) - spent;
    const budget =
      gasPrice * (deposit === '0' ? GAS.WITHDRAW + GAS.DISTRIBUTE : GAS.DISTRIBUTE) * 2n;
    if (
      remaining <= 0n ||
      budget > remaining ||
      BigInt(b.amount) - BigInt(b.storage_usage) * 10n ** 19n - BigInt(deposit) <
        BigInt(t.minReserveYocto) + remaining
    )
      throw new DomainError(
        'FUNDING_GAS_RESERVE',
        'Dedicated native gas/reserve budget is insufficient',
      );
  }
  async quote(t: FundingTerms) {
    return this.oneclick.quote(
      {
        originAsset: t.asset,
        destinationAsset: WRAP,
        amount: t.amountAtoms,
        recipient: t.payer,
        refundTo: t.payer,
        deadline: t.deadline,
        slippageBps: t.slippageBps,
      },
      false,
      'INTENTS',
    );
  }
  async signSwap(t: FundingTerms, quote: unknown) {
    if (Date.parse(t.deadline) <= Date.now())
      throw new DomainError(
        'FUNDING_EXPIRED',
        'Swap refund deadline has passed; do not create another authorization',
      );
    const balance = z
      .string()
      .regex(/^\d+$/)
      .parse(
        await this.view('intents.near', 'mt_balance_of', {
          account_id: t.payer,
          token_id: t.asset,
        }),
      );
    if (BigInt(balance) < BigInt(t.amountAtoms))
      throw new DomainError('FUNDING_BALANCE', 'Earned asset balance is below the reservation');
    const q = quoteSchema.parse(quote);
    if (
      !verifyQuoteSignature(q as unknown as QuoteResponse, this.config.ONECLICK_MANAGER_PUBLIC_KEY)
    )
      throw new DomainError('QUOTE_SIGNATURE', 'Conversion quote signature is invalid');
    const raw = z
      .object({
        intent: z
          .object({ standard: z.literal('nep413'), payload: SignedFundingIntent.shape.payload })
          .strict(),
      })
      .parse(await this.oneclick.generateIntent(q.quote.depositAddress!, t.payer));
    swapCredit(t, q, raw.intent);
    return this.sign(raw.intent.payload);
  }
  private async sign(payload: SignedFundingIntent['payload']) {
    const bytes = nonceBytes(payload.nonce);
    const salt = z
      .string()
      .regex(/^[a-f0-9]{8}$/i)
      .parse(await this.view('intents.near', 'current_salt', {}));
    if (bytes.subarray(0, 4).toString('hex') !== salt.toLowerCase())
      throw new DomainError('FUNDING_NONCE', 'Intent nonce salt is stale');
    const signed = await signMessage({
      signerAccount: this.business,
      payload: { message: payload.message, nonce: bytes, recipient: payload.recipient },
    });
    if (
      signed.publicKey.keyType !== 0 ||
      !z.boolean().parse(
        await this.view('intents.near', 'has_public_key', {
          account_id: this.config.BUSINESS_RECEIVER_ID,
          public_key: signed.publicKey.toString(),
        }),
      )
    )
      throw new DomainError('FUNDING_KEY', 'Register a dedicated business Intents Ed25519 key');
    return SignedFundingIntent.parse({
      standard: 'nep413',
      payload,
      public_key: signed.publicKey.toString(),
      signature: `ed25519:${bs58.encode(signed.signature)}`,
    });
  }
  async swapStatus(t: FundingTerms, quote: unknown, signed: SignedFundingIntent) {
    const creditYocto = swapCredit(t, quote, signed, 0); // Expiry blocks submission, never reconciliation.
    const q = quoteSchema.parse(quote),
      status = await this.oneclick.status(q.quote.depositAddress!);
    if (quoteHash(status.quoteResponse) !== quoteHash(q as unknown as QuoteResponse))
      throw new DomainError('FUNDING_SWAP_BINDING', 'Status belongs to different conversion terms');
    const spent = await this.used(signed.payload.nonce);
    if (status.status === 'REFUNDED')
      return { status: 'REFUNDED' as const, creditYocto: '0', evidenceDigest: digest(status) };
    if (status.status === 'SUCCESS') {
      if (
        !spent ||
        !status.swapDetails.amountOut ||
        BigInt(status.swapDetails.amountOut) < BigInt(creditYocto)
      )
        throw new DomainError(
          'FUNDING_SWAP_UNCONFIRMED',
          'Conversion nonce and guaranteed credit are not confirmed',
        );
      const reported = status.swapDetails.amountOut;
      const hashes = [...new Set(status.swapDetails.destinationChainTxHashes.map((t) => t.hash))];
      if (!hashes.length || hashes.length > 5 || hashes.some((h) => !nearHash.safeParse(h).success))
        throw new DomainError(
          'FUNDING_CREDIT_PROOF',
          '1Click must identify finalized NEAR credit transactions',
        );
      let observed = 0n;
      const evidence = [];
      for (const hash of hashes) {
        let raw = await this.rpc('tx', {
          tx_hash: hash,
          sender_account_id: 'intents.near',
          wait_until: 'NONE',
        });
        if (!raw)
          raw = await this.rpc('tx', {
            tx_hash: hash,
            sender_account_id: t.payer,
            wait_until: 'NONE',
          });
        if (!raw)
          throw new DomainError(
            'FUNDING_CREDIT_PROOF',
            'A credited transaction is unavailable from the configured RPC',
          );
        const proof = incomingWrapCredit(raw, hash, t.payer);
        const block = z
          .object({ header: z.object({ hash: nearHash, timestamp_nanosec: atoms }) })
          .parse(await this.rpc('block', { block_id: proof.blockHash }));
        if (
          block.header.hash !== proof.blockHash ||
          BigInt(block.header.timestamp_nanosec) < BigInt(Date.parse(q.timestamp)) * 1000000n
        )
          throw new DomainError(
            'FUNDING_CREDIT_PROOF',
            'Credited transaction predates the signed conversion quote',
          );
        observed += BigInt(proof.creditYocto);
        evidence.push(proof.evidenceDigest);
      }
      if (observed < BigInt(reported))
        throw new DomainError(
          'FUNDING_CREDIT_PROOF',
          'Net on-chain credit is below the reported conversion output',
        );
      return {
        status: 'SUCCESS' as const,
        creditYocto,
        receivedYocto: reported,
        evidenceDigest: digest({ status, creditEvidence: evidence }),
      };
    }
    if (status.status === 'FAILED' || (spent && status.status === 'PENDING_DEPOSIT'))
      throw new DomainError(
        'FUNDING_SWAP_UNKNOWN',
        'Conversion outcome needs reconciliation; funds remain held',
      );
    return { status: 'PENDING' as const, creditYocto, evidenceDigest: digest(status) };
  }
  async submitSwap(signed: SignedFundingIntent) {
    if (this.config.EXECUTION_MODE !== 'LIVE' || !this.config.BUSINESS_PAYOUTS_ENABLED)
      throw new DomainError('FUNDING_DISABLED', 'Financial submission is not armed');
    const deadline = JSON.parse(signed.payload.message).deadline;
    if (Date.parse(deadline) <= Date.now())
      throw new DomainError(
        'FUNDING_EXPIRED',
        'Persisted intent expired; no replacement nonce will be generated',
      );
    if (!(await this.used(signed.payload.nonce))) await this.oneclick.submitIntent(signed);
  }
  async prepareCall(t: FundingTerms, kind: 'WITHDRAW' | 'DISTRIBUTE', amount: string) {
    let receiver = t.treasury,
      method = 'distribute_revenue',
      args: Record<string, unknown> = { distribution_reference: t.reference },
      deposit = BigInt(amount),
      intentNonce: string | undefined,
      intentExpiresAt: string | undefined;
    if (kind === 'WITHDRAW') {
      const available = z
        .string()
        .regex(/^\d+$/)
        .parse(
          await this.view('intents.near', 'mt_balance_of', { account_id: t.payer, token_id: WRAP }),
        );
      if (BigInt(available) < BigInt(amount))
        throw new DomainError(
          'FUNDING_BALANCE',
          'Confirmed wNEAR is below the proposed withdrawal',
        );
      const salt = z
        .string()
        .regex(/^[a-f0-9]{8}$/i)
        .parse(await this.view('intents.near', 'current_salt', {}));
      const nonce = Buffer.concat([
        Buffer.from(salt, 'hex'),
        Buffer.from(sha256(`withdraw:${t.reference}`), 'hex').subarray(0, 28),
      ]).toString('base64');
      const payload = {
        recipient: 'intents.near' as const,
        nonce,
        message: JSON.stringify({
          signer_id: t.payer,
          deadline: new Date(Date.now() + 1200000).toISOString(),
          intents: [{ intent: 'native_withdraw', receiver_id: t.accountant, amount }],
        }),
      };
      const signed = await this.sign(payload);
      receiver = 'intents.near';
      method = 'execute_intents';
      args = { signed: [signed] };
      deposit = 0n;
      intentNonce = nonce;
      intentExpiresAt = JSON.parse(payload.message).deadline;
    }
    const signed = await this.accountant.createSignedTransaction({
      receiverId: receiver,
      actions: [actions.functionCall(method, args, GAS[kind], deposit)],
    });
    return PreparedFundingCall.parse({
      kind,
      amountNearYocto: amount,
      signedBase64: Buffer.from(signed.encode()).toString('base64'),
      txHash: bs58.encode(Buffer.from(sha256(signed.transaction.encode()), 'hex')),
      ...(intentNonce ? { intentNonce, intentExpiresAt } : {}),
    });
  }
  async reconcileCall(
    t: FundingTerms,
    call: PreparedFundingCall,
  ): Promise<FinalFundingCall | null> {
    const signed = SignedTransaction.decode(Buffer.from(call.signedBase64, 'base64'));
    if (bs58.encode(Buffer.from(sha256(signed.transaction.encode()), 'hex')) !== call.txHash)
      throw new DomainError('FUNDING_SIGNED_BYTES', 'Persisted transaction identity changed');
    // NONE distinguishes an unsubmitted identity from an already accepted but nonfinal payment.
    let raw = await this.rpc('tx', { signed_tx_base64: call.signedBase64, wait_until: 'NONE' });
    if (!raw) return null;
    if ((raw as { final_execution_status?: string }).final_execution_status !== 'FINAL')
      raw = await this.rpc('tx', { signed_tx_base64: call.signedBase64, wait_until: 'FINAL' });
    if (!raw)
      throw new DomainError(
        'FUNDING_CONFIRMATION_PENDING',
        'Known payment still requires finality',
      );
    return verifyFundingOutcome(t, call, raw);
  }
  async sendCall(call: PreparedFundingCall) {
    if (this.config.EXECUTION_MODE !== 'LIVE' || !this.config.BUSINESS_PAYOUTS_ENABLED)
      throw new DomainError('FUNDING_DISABLED', 'Financial submission is not armed');
    if (
      call.kind === 'WITHDRAW' &&
      (!call.intentExpiresAt || Date.parse(call.intentExpiresAt) <= Date.now())
    )
      throw new DomainError(
        'FUNDING_EXPIRED',
        'Unknown withdrawal intent expired; only reconciliation is allowed',
      );
    const signed = SignedTransaction.decode(Buffer.from(call.signedBase64, 'base64'));
    if (bs58.encode(Buffer.from(sha256(signed.transaction.encode()), 'hex')) !== call.txHash)
      throw new DomainError('FUNDING_SIGNED_BYTES', 'Persisted transaction identity changed');
    await this.provider.sendTransactionUntil(signed, 'FINAL');
  }
}

export function verifyFundingOutcome(
  t: FundingTerms,
  call: PreparedFundingCall,
  raw: unknown,
): FinalFundingCall {
  const outcome = z.object({
    id: z.string(),
    outcome: z.object({
      executor_id: z.string(),
      status: z.record(z.string(), z.unknown()),
      logs: z.array(z.string()),
      tokens_burnt: atoms,
    }),
  });
  const tx = z
    .object({
      final_execution_status: z.literal('FINAL'),
      status: z.record(z.string(), z.unknown()),
      transaction: z.object({ hash: z.string(), signer_id: z.string(), receiver_id: z.string() }),
      transaction_outcome: outcome,
      receipts_outcome: z.array(outcome),
    })
    .parse(raw);
  const success = (s: Record<string, unknown>) =>
    Object.keys(s).length === 1 &&
    (typeof s.SuccessValue === 'string' || typeof s.SuccessReceiptId === 'string');
  if (
    tx.transaction.hash !== call.txHash ||
    tx.transaction.signer_id !== t.accountant ||
    tx.transaction.receiver_id !== (call.kind === 'WITHDRAW' ? 'intents.near' : t.treasury) ||
    !success(tx.status) ||
    !success(tx.transaction_outcome.outcome.status) ||
    tx.receipts_outcome.some((r) => !success(r.outcome.status))
  )
    throw new DomainError(
      'FUNDING_CHAIN_FAILURE',
      'Exact finalized transaction and all child receipts must succeed',
    );
  let allocated: string | null = null;
  if (call.kind === 'DISTRIBUTE') {
    const events = tx.receipts_outcome
      .filter((r) => r.outcome.executor_id === t.treasury)
      .flatMap((r) => r.outcome.logs)
      .filter((l) => l.startsWith('EVENT_JSON:'))
      .map((l) => JSON.parse(l.slice(11)))
      .filter(
        (e) =>
          e.standard === 'symbiochain' &&
          e.version === '1.0.0' &&
          e.event === 'revenue_distributed',
      )
      .flatMap((e) =>
        z
          .array(
            z.object({
              reference: z.string(),
              deposited: positiveAtoms,
              allocated: positiveAtoms,
              unallocated: atoms,
            }),
          )
          .parse(e.data),
      )
      .filter((e) => e.reference === t.reference && e.deposited === call.amountNearYocto);
    if (
      events.length !== 1 ||
      BigInt(events[0]!.allocated) + BigInt(events[0]!.unallocated) !== BigInt(call.amountNearYocto)
    )
      throw new DomainError(
        'FUNDING_DISTRIBUTION_PROOF',
        'Missing exact on-chain dividend allocation',
      );
    allocated = events[0]!.allocated;
  }
  return {
    txHash: call.txHash,
    gasYocto: [tx.transaction_outcome, ...tx.receipts_outcome]
      .reduce((n, r) => n + BigInt(r.outcome.tokens_burnt), 0n)
      .toString(),
    amountNearYocto: call.amountNearYocto,
    allocatedYocto: allocated,
    evidenceDigest: digest(raw),
  };
}
