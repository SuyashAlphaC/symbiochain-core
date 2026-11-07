import { it, expect } from 'vitest';
import bs58 from 'bs58';
import { incomingWrapCredit } from '../../src/providers/funding-credit.js';
const h = (n: number) => bs58.encode(Buffer.alloc(32, n));
const event = (name: string, data: unknown[]) =>
  'EVENT_JSON:' + JSON.stringify({ standard: 'nep245', version: '1.0.0', event: name, data });
function fixture() {
  const outcome = {
    executor_id: 'intents.near',
    status: { SuccessValue: '' } as Record<string, unknown>,
    logs: [
      event('mt_transfer', [
        {
          old_owner_id: 'solver.near',
          new_owner_id: 'business.near',
          token_ids: ['nep141:wrap.near'],
          amounts: ['600'],
        },
      ]),
      event('mt_burn', [
        { owner_id: 'business.near', token_ids: ['nep141:wrap.near'], amounts: ['100'] },
      ]),
    ],
  };
  return {
    final_execution_status: 'FINAL',
    status: { SuccessValue: '' },
    transaction: { hash: h(1) },
    transaction_outcome: { block_hash: h(2), outcome: { status: { SuccessReceiptId: h(3) } } },
    receipts_outcome: [{ outcome }],
  };
}
it('subtracts onward movements and burns from final credited Intents balances', () => {
  const f = fixture();
  expect(incomingWrapCredit(f, h(1), 'business.near').creditYocto).toBe('500');
  f.receipts_outcome[0]!.outcome.logs.push(
    event('mt_transfer', [
      {
        old_owner_id: 'business.near',
        new_owner_id: 'other.near',
        token_ids: ['nep141:wrap.near'],
        amounts: ['400'],
      },
    ]),
  );
  expect(incomingWrapCredit(f, h(1), 'business.near').creditYocto).toBe('100');
});
it('rejects failed, nonfinal and unrelated credits', () => {
  const f = fixture();
  f.receipts_outcome[0]!.outcome.executor_id = 'fake.near';
  expect(incomingWrapCredit(f, h(1), 'business.near').creditYocto).toBe('0');
  f.receipts_outcome[0]!.outcome.executor_id = 'intents.near';
  f.receipts_outcome[0]!.outcome.status = { Failure: 'reverted' };
  expect(() => incomingWrapCredit(f, h(1), 'business.near')).toThrow('successful final');
  f.final_execution_status = 'EXECUTED';
  expect(() => incomingWrapCredit(f, h(1), 'business.near')).toThrow();
});
