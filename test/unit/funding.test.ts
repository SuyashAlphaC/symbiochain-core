import { describe, it, expect } from 'vitest';
import { generateKeyPairSync, sign } from 'node:crypto';
import { KeyPair, createTransaction, actions, SignedTransaction, Signature } from 'near-api-js';
import { sha256 } from '../../src/domain.js';
import bs58 from 'bs58';
import { quoteHash, type QuoteResponse } from '@defuse-protocol/one-click-sdk-typescript';
import { NearFundingPorts, swapCredit, verifyFundingOutcome } from '../../src/providers/funding.js';
import type { FundingTerms, PreparedFundingCall } from '../../src/funding-types.js';
import { loadConfig } from '../../src/config.js';
const h = (n: number) => bs58.encode(Buffer.alloc(32, n));
const t: FundingTerms = {
  reservationId: '611f1894-55a7-4b21-a6dd-3bb1a203e902',
  reservationReference: 'budget',
  reference: 'nft:budget',
  payer: 'business.near',
  accountant: 'books.near',
  treasury: 'treasury.near',
  treasuryCodeHash: h(9),
  asset: 'nep141:usdc.near',
  amountAtoms: '100',
  minimumNearYocto: '490',
  maxGasYocto: '1000',
  minReserveYocto: '1000',
  slippageBps: 50,
  deadline: new Date(Date.now() + 600000).toISOString(),
};
function fixture() {
  const quote = {
    correlationId: 'fixture',
    timestamp: new Date().toISOString(),
    signature: 'fixture',
    quoteRequest: {
      dry: false,
      swapType: 'EXACT_INPUT',
      depositMode: 'SIMPLE',
      originAsset: t.asset,
      destinationAsset: 'nep141:wrap.near',
      depositType: 'INTENTS',
      recipientType: 'INTENTS',
      refundType: 'INTENTS',
      amount: t.amountAtoms,
      recipient: t.payer,
      refundTo: t.payer,
      slippageTolerance: 50,
      deadline: t.deadline,
    },
    quote: {
      amountIn: '100',
      amountOut: '600',
      minAmountOut: '500',
      depositAddress: 'deposit',
      deadline: t.deadline,
      timeEstimate: 1,
    },
  };
  const message = {
    signer_id: t.payer,
    deadline: t.deadline,
    intents: [{ intent: 'token_diff', diff: { [t.asset]: '-100', 'nep141:wrap.near': '500' } }],
  };
  const payload = {
    message: JSON.stringify(message),
    nonce: Buffer.concat([Buffer.from('01020304', 'hex'), Buffer.alloc(28, 1)]).toString('base64'),
    recipient: 'intents.near' as const,
  };
  return { quote, message, payload };
}
describe('business conversion authorization', () => {
  it('permits only an exact Intents-to-Intents two-asset exchange above the approved floor', () => {
    const f = fixture();
    expect(swapCredit(t, f.quote, { payload: f.payload })).toBe('500');
  });
  it('rejects provider-substituted destinations, amounts and extra actions before signing', () => {
    for (const alter of [
      (m: ReturnType<typeof fixture>['message']) => {
        m.signer_id = 'attacker.near';
      },
      (m: ReturnType<typeof fixture>['message']) => {
        m.intents[0]!.diff[t.asset] = '-101';
      },
      (m: ReturnType<typeof fixture>['message']) => {
        m.intents[0]!.diff['nep141:wrap.near'] = '499';
      },
      (m: ReturnType<typeof fixture>['message']) => {
        m.intents.push(m.intents[0]!);
      },
    ]) {
      const f = fixture();
      alter(f.message);
      f.payload.message = JSON.stringify(f.message);
      expect(() => swapCredit(t, f.quote, { payload: f.payload })).toThrow();
    }
    const f = fixture();
    f.quote.quoteRequest.recipient = 'attacker.near';
    expect(() => swapCredit(t, f.quote, { payload: f.payload })).toThrow('committed terms');
  });
  it('retains expiry for submission but permits reconciliation of the same expired identity', () => {
    const f = fixture();
    expect(() => swapCredit(t, f.quote, { payload: f.payload }, Date.now() + 10000000)).toThrow();
    expect(swapCredit(t, f.quote, { payload: f.payload }, 0)).toBe('500');
  });
  it('signs the exact validated NEP413 payload with the registered dedicated key', async () => {
    const f = fixture(),
      manager = generateKeyPairSync('ed25519'),
      business = KeyPair.fromRandom('ed25519');
    const pub = `ed25519:${bs58.encode(manager.publicKey.export({ type: 'spki', format: 'der' }).subarray(-32))}`;
    f.quote.signature = `ed25519:${bs58.encode(sign(null, Buffer.from(quoteHash(f.quote as unknown as QuoteResponse)), manager.privateKey))}`;
    const c = loadConfig({
      ...process.env,
      DATABASE_URL: 'postgresql://unused',
      EXECUTION_MODE: 'PAPER',
      BUSINESS_RECEIVER_ID: t.payer,
      BUSINESS_INTENTS_PRIVATE_KEY: business.toString(),
      BUSINESS_PAYOUT_PRIVATE_KEY: KeyPair.fromRandom('ed25519').toString(),
      NEAR_ACCOUNTANT_ACCOUNT_ID: t.accountant,
      ONECLICK_MANAGER_PUBLIC_KEY: pub,
    });
    let registerChecks = 0;
    const transport: typeof fetch = async (url, init) => {
      if (String(url).endsWith('/v0/generate-intent'))
        return Response.json({ intent: { standard: 'nep413', payload: f.payload } });
      const body = JSON.parse(String(init?.body)),
        method = body.params.method_name;
      const result =
        method === 'mt_balance_of' ? '1000' : method === 'current_salt' ? '01020304' : true;
      if (method === 'has_public_key') registerChecks++;
      return Response.json({ result: { result: [...Buffer.from(JSON.stringify(result))] } });
    };
    const signed = await new NearFundingPorts(c, transport).signSwap(t, f.quote);
    expect(signed.payload).toEqual(f.payload);
    expect(signed.public_key).toBe(business.getPublicKey().toString());
    expect(bs58.decode(signed.signature.slice(8))).toHaveLength(64);
    expect(registerChecks).toBe(1);
    f.payload.message = JSON.stringify({ ...f.message, signer_id: 'attacker.near' });
    await expect(new NearFundingPorts(c, transport).signSwap(t, f.quote)).rejects.toThrow(
      'approved exchange',
    );
    expect(registerChecks).toBe(1);
  });
});
function finalFixture() {
  const call: PreparedFundingCall = {
    kind: 'DISTRIBUTE',
    txHash: h(1),
    signedBase64: 'fixture',
    amountNearYocto: '500',
  };
  const event = {
    standard: 'symbiochain',
    version: '1.0.0',
    event: 'revenue_distributed',
    data: [{ reference: t.reference, deposited: '500', allocated: '50', unallocated: '450' }],
  };
  const receipt = {
    id: h(2),
    outcome: {
      executor_id: t.treasury,
      status: { SuccessValue: '' } as Record<string, unknown>,
      tokens_burnt: '3',
      logs: ['EVENT_JSON:' + JSON.stringify(event)],
    },
  };
  const raw = {
    final_execution_status: 'FINAL',
    status: { SuccessValue: '' },
    transaction: { hash: h(1), signer_id: t.accountant, receiver_id: t.treasury },
    transaction_outcome: {
      id: h(1),
      outcome: {
        executor_id: t.accountant,
        status: { SuccessReceiptId: h(2) },
        tokens_burnt: '2',
        logs: [],
      },
    },
    receipts_outcome: [receipt],
  };
  return { call, event, receipt, raw };
}
it('binds final allocation, amount, treasury emitter and actual gas to the exact transaction', () => {
  const f = finalFixture();
  expect(verifyFundingOutcome(t, f.call, f.raw)).toMatchObject({
    txHash: h(1),
    gasYocto: '5',
    amountNearYocto: '500',
    allocatedYocto: '50',
  });
  f.receipt.outcome.executor_id = 'fake.near';
  expect(() => verifyFundingOutcome(t, f.call, f.raw)).toThrow('allocation');
});
it('rejects failed children and allocations from another distribution', () => {
  const f = finalFixture();
  f.receipt.outcome.status = { Failure: 'failed' };
  expect(() => verifyFundingOutcome(t, f.call, f.raw)).toThrow('child receipts');
  f.receipt.outcome.status = { SuccessValue: '' };
  f.event.data[0]!.reference = 'other';
  f.receipt.outcome.logs = ['EVENT_JSON:' + JSON.stringify(f.event)];
  expect(() => verifyFundingOutcome(t, f.call, f.raw)).toThrow('allocation');
});
it('binds the live provider transfer payload to its signed deposit account and exact amount', () => {
  const f = fixture();
  f.payload.message = JSON.stringify({
    ...f.message,
    intents: [
      {
        intent: 'transfer',
        receiver_id: f.quote.quote.depositAddress,
        tokens: { [t.asset]: '100' },
      },
    ],
  });
  expect(swapCredit(t, f.quote, { payload: f.payload })).toBe('500');
  f.payload.message = JSON.stringify({
    ...f.message,
    intents: [{ intent: 'transfer', receiver_id: 'attacker.near', tokens: { [t.asset]: '100' } }],
  });
  expect(() => swapCredit(t, f.quote, { payload: f.payload })).toThrow('signed quote deposit');
});

it('queries an unknown signed identity with NONE before its first broadcast', async () => {
  const key = KeyPair.fromRandom('ed25519');
  const transaction = createTransaction(
    t.accountant,
    key.getPublicKey(),
    t.treasury,
    1n,
    [
      actions.functionCall(
        'distribute_revenue',
        { distribution_reference: t.reference },
        100000000000000n,
        500n,
      ),
    ],
    Buffer.alloc(32, 1),
  );
  const hashBytes = Buffer.from(sha256(transaction.encode()), 'hex');
  const signed = new SignedTransaction({
    transaction,
    signature: new Signature({ keyType: 0, data: key.sign(hashBytes).signature }),
  });
  const call: PreparedFundingCall = {
    kind: 'DISTRIBUTE',
    txHash: bs58.encode(hashBytes),
    signedBase64: Buffer.from(signed.encode()).toString('base64'),
    amountNearYocto: '500',
  };
  const c = loadConfig({
    ...process.env,
    DATABASE_URL: 'postgresql://unused',
    EXECUTION_MODE: 'PAPER',
    BUSINESS_RECEIVER_ID: t.payer,
    BUSINESS_INTENTS_PRIVATE_KEY: KeyPair.fromRandom('ed25519').toString(),
    BUSINESS_PAYOUT_PRIVATE_KEY: key.toString(),
    NEAR_ACCOUNTANT_ACCOUNT_ID: t.accountant,
  });
  const queries: Record<string, unknown>[] = [];
  const transport: typeof fetch = async (_url, init) => {
    const body = JSON.parse(String(init?.body));
    queries.push(body);
    return Response.json({
      error: { name: 'HANDLER_ERROR', cause: { name: 'UNKNOWN_TRANSACTION' } },
    });
  };
  expect(await new NearFundingPorts(c, transport).reconcileCall(t, call)).toBeNull();
  expect(queries).toHaveLength(1);
  expect(queries[0]).toMatchObject({
    method: 'tx',
    params: { signed_tx_base64: call.signedBase64, wait_until: 'NONE' },
  });
});

it('distinguishes the requested refund deadline from the signed deposit inactivity deadline', () => {
  const f = fixture();
  f.quote.quote.deadline = new Date(Date.parse(t.deadline) + 72 * 3600000).toISOString();
  f.payload.message = JSON.stringify({
    ...f.message,
    deadline: f.quote.quote.deadline,
    intents: [
      {
        intent: 'transfer',
        receiver_id: f.quote.quote.depositAddress,
        tokens: { [t.asset]: '100' },
      },
    ],
  });
  expect(swapCredit(t, f.quote, { payload: f.payload })).toBe('500');
  f.quote.quote.deadline = new Date(Date.parse(t.deadline) + 73 * 3600000).toISOString();
  expect(() => swapCredit(t, f.quote, { payload: f.payload })).toThrow('approved exchange');
});
