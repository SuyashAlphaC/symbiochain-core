import { describe, it, expect } from 'vitest';
import { OneClickClient, type SwapTerms } from '../../src/providers/oneclick.js';
import { loadConfig } from '../../src/config.js';
import { generateKeyPairSync, sign } from 'node:crypto';
import bs58 from 'bs58';
import { quoteHash, type QuoteResponse } from '@defuse-protocol/one-click-sdk-typescript';
const keys = generateKeyPairSync('ed25519');
const c = loadConfig({
  ...process.env,
  DATABASE_URL: 'postgresql://unused',
  ADMIN_TOKEN: 'a'.repeat(32),
  READ_TOKEN: 'b'.repeat(32),
  EVIDENCE_ENCRYPTION_KEY: '11'.repeat(32),
  EXECUTION_MODE: 'PAPER',
  ONECLICK_MANAGER_PUBLIC_KEY: `ed25519:${bs58.encode(keys.publicKey.export({ type: 'spki', format: 'der' }).subarray(-32))}`,
});
const terms: SwapTerms = {
  originAsset: 'a',
  destinationAsset: 'b',
  amount: '1000000',
  recipient: 'derived.receiver',
  refundTo: 'derived.refund',
  deadline: new Date(Date.now() + 600000).toISOString(),
  slippageBps: 50,
};
function client(change: (v: Record<string, any>) => void = () => {}) {
  return new OneClickClient(c, async (_url, init) => {
    const request = JSON.parse(String(init?.body));
    const result = {
      correlationId: 'id',
      timestamp: new Date().toISOString(),
      signature: 'provider-signature',
      quoteRequest: { ...request, quoteWaitingTimeMs: 0 },
      quote: {
        amountIn: request.amount,
        amountOut: '1100000',
        minAmountOut: '1090000',
        depositAddress: 'quote.deposit',
        deadline: terms.deadline,
        timeEstimate: 30,
      },
    };
    change(result);
    result.signature = `ed25519:${bs58.encode(sign(null, Buffer.from(quoteHash(result as unknown as QuoteResponse)), keys.privateKey))}`;
    return new Response(JSON.stringify(result));
  });
}
describe('1Click boundary', () => {
  it('uses atomic units and BPS and permits harmless provider defaults', async () => {
    const q = await client().quote(terms, false);
    expect(q.quote.amountIn).toBe('1000000');
    expect(q.quoteRequest.slippageTolerance).toBe(50);
    expect(q.quoteRequest.depositType).toBe('ORIGIN_CHAIN');
  });
  it('rejects a provider-substituted recipient', async () => {
    await expect(
      client((r) => {
        r.quoteRequest.recipient = 'attacker';
      }).quote(terms, false),
    ).rejects.toThrow('requested terms');
  });
  it('rejects memo deposits and expired executable quotes', async () => {
    await expect(
      client((r) => {
        r.quote.depositMemo = '42';
      }).quote(terms, false),
    ).rejects.toThrow('simple deposit');
    await expect(
      client((r) => {
        r.quote.deadline = new Date(0).toISOString();
      }).quote(terms, false),
    ).rejects.toThrow('lifetime');
  });
  it('rejects an otherwise valid quote signed by an unapproved manager', async () => {
    const wrong = {
      ...c,
      ONECLICK_MANAGER_PUBLIC_KEY: 'ed25519:reYaWhvwu8Jzo3WUM3zhn6VrhuMEF4eADL17qtRVifc',
    };
    const transport: typeof fetch = async (_url, init) =>
      Response.json({
        correlationId: 'x',
        timestamp: new Date().toISOString(),
        signature: 'invalid',
        quoteRequest: JSON.parse(String(init?.body)),
        quote: { amountIn: terms.amount, amountOut: '2', minAmountOut: '1', timeEstimate: 30 },
      });
    await expect(new OneClickClient(wrong, transport).quote(terms, true)).rejects.toThrow(
      'signature is invalid',
    );
  });
});
