import { describe, expect, it } from 'vitest';
import bs58 from 'bs58';
import { verifyIntentReceipt } from '../../src/providers/intent-receipts.js';
import type { Fetch } from '../../src/providers/http.js';
const h = (n: number) => bs58.encode(Buffer.alloc(32, n));
const terms = {
  payer: 'customer.near',
  receiver: 'business.near',
  asset: 'nep141:wrap.near',
  amountAtoms: '100',
  issuedAt: '2026-11-01T00:00:00.000Z',
};
function fixture() {
  const event = (standard: string, version: string, name: string, data: unknown[]) =>
    'EVENT_JSON:' + JSON.stringify({ standard, version, event: name, data });
  const logs = [
    event('dip4', '0.4.3', 'transfer', [
      {
        intent_hash: h(3),
        account_id: terms.payer,
        receiver_id: terms.receiver,
        tokens: { [terms.asset]: terms.amountAtoms },
      },
    ]),
    event('dip4', '0.4.3', 'intents_executed', [{ intent_hash: h(3), account_id: terms.payer }]),
    event('nep245', '1.0.0', 'mt_transfer', [
      {
        old_owner_id: terms.payer,
        new_owner_id: terms.receiver,
        token_ids: [terms.asset],
        amounts: [terms.amountAtoms],
      },
    ]),
  ];
  const receipt = {
    id: h(2),
    block_hash: h(4),
    outcome: { executor_id: 'intents.near', status: { SuccessValue: '' } as unknown, logs },
  };
  const tx = {
    final_execution_status: 'FINAL',
    transaction: { hash: h(1), receiver_id: 'intents.near' },
    status: { SuccessValue: '' },
    transaction_outcome: { outcome: { status: { SuccessReceiptId: h(2) } } },
    receipts_outcome: [receipt],
  };
  const data: Record<string, unknown> = {
    status: { chain_id: 'mainnet' },
    tx,
    block: {
      header: { hash: h(4), timestamp_nanosec: String(BigInt(Date.now() - 1000) * 1000000n) },
    },
  };
  const fetch: Fetch = async (_url, init) => {
    const method = JSON.parse(String(init?.body)).method as string;
    return new Response(JSON.stringify({ result: data[method] }));
  };
  return { fetch, receipt, tx, data };
}
const input = { txHash: h(1), senderId: 'relayer.near', terms };
describe('finalized external Intents receipts', () => {
  it('binds finality, executor, executed intent and actual asset movement', async () => {
    const proof = await verifyIntentReceipt(input, fixture().fetch);
    expect(proof.amountAtoms).toBe('100');
    expect(proof.sourceKey).toBe(`near:mainnet:${h(2)}:${h(3)}`);
    expect(proof.evidenceDigest).toMatch(/^[a-f0-9]{64}$/);
  });
  it.each(['payer', 'receiver', 'asset', 'amountAtoms'] as const)(
    'rejects a changed %s',
    async (key) => {
      await expect(
        verifyIntentReceipt(
          {
            ...input,
            terms: {
              ...terms,
              [key]:
                key === 'amountAtoms'
                  ? '101'
                  : key === 'asset'
                    ? 'nep141:other.near'
                    : 'other.near',
            },
          },
          fixture().fetch,
        ),
      ).rejects.toThrow('match the invoice');
    },
  );
  it('rejects forged logs from another contract and missing settlement events', async () => {
    const f = fixture();
    f.receipt.outcome.executor_id = 'fake.near';
    await expect(verifyIntentReceipt(input, f.fetch)).rejects.toThrow('match the invoice');
    f.receipt.outcome.executor_id = 'intents.near';
    f.receipt.outcome.logs.pop();
    await expect(verifyIntentReceipt(input, f.fetch)).rejects.toThrow('match the invoice');
  });
  it('rejects failed child receipts, nonfinal executions and the wrong network', async () => {
    const f = fixture();
    f.receipt.outcome.status = { Failure: 'reverted' };
    await expect(verifyIntentReceipt(input, f.fetch)).rejects.toThrow('succeeded');
    f.receipt.outcome.status = { SuccessValue: '' };
    f.tx.final_execution_status = 'EXECUTED';
    await expect(verifyIntentReceipt(input, f.fetch)).rejects.toThrow();
    f.tx.final_execution_status = 'FINAL';
    f.data.status = { chain_id: 'testnet' };
    await expect(verifyIntentReceipt(input, f.fetch)).rejects.toThrow();
  });
  it('rejects pre-invoice and ambiguous transfers', async () => {
    const f = fixture();
    f.receipt.outcome.logs.push(f.receipt.outcome.logs[0]!);
    await expect(verifyIntentReceipt(input, f.fetch)).rejects.toThrow('Exactly one');
    f.receipt.outcome.logs.pop();
    await expect(
      verifyIntentReceipt(
        { ...input, terms: { ...terms, issuedAt: new Date(Date.now() + 100000).toISOString() } },
        f.fetch,
      ),
    ).rejects.toThrow('postdate');
  });
});
