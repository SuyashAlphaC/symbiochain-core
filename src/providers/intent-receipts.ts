import { z } from 'zod';
import { DomainError, digest, positiveAtoms } from '../domain.js';
import { httpJson, type Fetch } from './http.js';

export const nearHash = z.string().regex(/^[1-9A-HJ-NP-Za-km-z]{43,44}$/);
const account = z.string().min(2).max(64);
export const ReceiptTerms = z
  .object({
    payer: account,
    receiver: account,
    asset: z
      .string()
      .regex(/^nep141:[a-z0-9._-]+$/)
      .max(180),
    amountAtoms: positiveAtoms,
    issuedAt: z.iso.datetime(),
  })
  .strict();
export type ReceiptTerms = z.infer<typeof ReceiptTerms>;
export interface IntentReceipt {
  network: 'mainnet';
  txHash: string;
  receiptId: string;
  intentHash: string;
  sourceKey: string;
  blockHash: string;
  timestamp: string;
  payer: string;
  receiver: string;
  asset: string;
  amountAtoms: string;
  evidenceDigest: string;
}
const success = (s: unknown) =>
  !!s && typeof s === 'object' && ('SuccessValue' in s || 'SuccessReceiptId' in s);
const hash = nearHash;
const outcome = z.object({
  id: hash,
  block_hash: hash,
  outcome: z.object({ executor_id: account, status: z.unknown(), logs: z.array(z.string()) }),
});
const transaction = z.object({
  final_execution_status: z.literal('FINAL'),
  transaction: z.object({ hash, receiver_id: z.literal('intents.near') }),
  status: z.unknown(),
  transaction_outcome: z.object({ outcome: z.object({ status: z.unknown() }) }),
  receipts_outcome: z.array(outcome),
});
const event = z.object({
  standard: z.string(),
  version: z.string(),
  event: z.string(),
  data: z.array(z.unknown()),
});
const transfer = z.object({
  intent_hash: hash,
  account_id: account,
  receiver_id: account,
  tokens: z.record(z.string(), positiveAtoms),
});
const executed = z.object({ intent_hash: hash, account_id: account });
const mt = z.object({
  old_owner_id: account,
  new_owner_id: account,
  token_ids: z.array(z.string()),
  amounts: z.array(positiveAtoms),
});

/** Authenticated settlement evidence comes from finalized Intents receipts, never an explorer label.
 * The configured RPC remains a trust boundary; this is not a NEAR light-client proof.
 */
export async function verifyIntentReceipt(
  input: { txHash: string; senderId: string; terms: ReceiptTerms },
  transport: Fetch = fetch,
): Promise<IntentReceipt> {
  const terms = ReceiptTerms.parse(input.terms);
  nearHash.parse(input.txHash);
  account.parse(input.senderId);
  const rpc = async (method: string, params: unknown) => {
    const body = z.object({ result: z.unknown() }).parse(
      await httpJson(
        'https://rpc.mainnet.near.org',
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ jsonrpc: '2.0', id: 'business-receipt', method, params }),
        },
        transport,
      ),
    );
    return body.result;
  };
  const status = z.object({ chain_id: z.literal('mainnet') }).parse(await rpc('status', []));
  void status;
  const tx = transaction.parse(
    await rpc('tx', {
      tx_hash: input.txHash,
      sender_account_id: input.senderId,
      wait_until: 'FINAL',
    }),
  );
  if (
    tx.transaction.hash !== input.txHash ||
    !success(tx.status) ||
    !success(tx.transaction_outcome.outcome.status) ||
    tx.receipts_outcome.some((r) => !success(r.outcome.status))
  )
    throw new DomainError('RECEIPT_NOT_FINAL', 'Every receipt must have succeeded at finality');
  const matches: { receipt: z.infer<typeof outcome>; intentHash: string }[] = [];
  for (const receipt of tx.receipts_outcome) {
    if (receipt.outcome.executor_id !== 'intents.near') continue;
    const events = receipt.outcome.logs
      .filter((l) => l.startsWith('EVENT_JSON:'))
      .map((l) => event.parse(JSON.parse(l.slice('EVENT_JSON:'.length))));
    const dip = events.filter(
      (e) =>
        e.standard === 'dip4' &&
        ['0.3.0', '0.3.1', '0.4.0', '0.4.1', '0.4.2', '0.4.3'].includes(e.version),
    );
    const intents = dip
      .filter((e) => e.event === 'intents_executed')
      .flatMap((e) => e.data.map((d) => executed.parse(d)));
    const transfers = dip
      .filter((e) => e.event === 'transfer')
      .flatMap((e) => e.data.map((d) => transfer.parse(d)));
    const tokenEvents = events
      .filter((e) => e.standard === 'nep245' && e.version === '1.0.0' && e.event === 'mt_transfer')
      .flatMap((e) => e.data.map((d) => mt.parse(d)));
    for (const t of transfers) {
      if (
        t.account_id !== terms.payer ||
        t.receiver_id !== terms.receiver ||
        Object.keys(t.tokens).length !== 1 ||
        t.tokens[terms.asset] !== terms.amountAtoms ||
        !intents.some((i) => i.intent_hash === t.intent_hash && i.account_id === terms.payer)
      )
        continue;
      const movements = tokenEvents
        .filter(
          (m) =>
            m.old_owner_id === terms.payer &&
            m.new_owner_id === terms.receiver &&
            m.token_ids.length === m.amounts.length,
        )
        .flatMap((m) => m.token_ids.map((asset, i) => ({ asset, amount: m.amounts[i] })))
        .filter((m) => m.asset === terms.asset && m.amount === terms.amountAtoms);
      if (movements.length === 1) matches.push({ receipt, intentHash: t.intent_hash });
    }
  }
  if (matches.length !== 1)
    throw new DomainError(
      'RECEIPT_MISMATCH',
      'Exactly one executed transfer and token movement must match the invoice',
    );
  const match = matches[0]!;
  const block = z
    .object({ header: z.object({ hash, timestamp_nanosec: z.string().regex(/^\d+$/) }) })
    .parse(await rpc('block', { block_id: match.receipt.block_hash }));
  const ns = BigInt(block.header.timestamp_nanosec);
  if (
    block.header.hash !== match.receipt.block_hash ||
    ns < BigInt(Date.parse(terms.issuedAt)) * 1_000_000n ||
    ns > BigInt(Date.now() + 60000) * 1_000_000n
  )
    throw new DomainError(
      'RECEIPT_TIME',
      'Receipt must postdate issuance and match its final block',
    );
  const result = {
    network: 'mainnet' as const,
    txHash: input.txHash,
    receiptId: match.receipt.id,
    intentHash: match.intentHash,
    sourceKey: `near:mainnet:${match.receipt.id}:${match.intentHash}`,
    blockHash: block.header.hash,
    timestamp: new Date(Number(ns / 1_000_000n)).toISOString(),
    payer: terms.payer,
    receiver: terms.receiver,
    asset: terms.asset,
    amountAtoms: terms.amountAtoms,
  };
  return { ...result, evidenceDigest: digest(result) };
}
