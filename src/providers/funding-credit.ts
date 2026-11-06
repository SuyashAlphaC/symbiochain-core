import { z } from 'zod';
import { DomainError, atoms, digest } from '../domain.js';
import { nearHash } from './intent-receipts.js';
const status = z.record(z.string(), z.unknown());
const success = (s: Record<string, unknown>) =>
  Object.keys(s).length === 1 &&
  (typeof s.SuccessValue === 'string' || typeof s.SuccessReceiptId === 'string');
/** Net Intents credit in a finalized transaction, including burns and onward transfers.
 * RPC and 1Click's quote-to-transaction mapping are explicit trust boundaries.
 */
export function incomingWrapCredit(raw: unknown, hash: string, account: string) {
  const tx = z
    .object({
      final_execution_status: z.literal('FINAL'),
      status,
      transaction: z.object({ hash: nearHash }),
      transaction_outcome: z.object({ block_hash: nearHash, outcome: z.object({ status }) }),
      receipts_outcome: z.array(
        z.object({
          outcome: z.object({ executor_id: z.string(), status, logs: z.array(z.string()) }),
        }),
      ),
    })
    .parse(raw);
  if (
    tx.transaction.hash !== hash ||
    !success(tx.status) ||
    !success(tx.transaction_outcome.outcome.status) ||
    tx.receipts_outcome.some((r) => !success(r.outcome.status))
  )
    throw new DomainError(
      'FUNDING_CREDIT_PROOF',
      'Conversion credit needs exact successful final receipts',
    );
  let balance = 0n;
  for (const log of tx.receipts_outcome
    .filter((r) => r.outcome.executor_id === 'intents.near')
    .flatMap((r) => r.outcome.logs)) {
    if (!log.startsWith('EVENT_JSON:')) continue;
    const e = JSON.parse(log.slice(11));
    if (
      e.standard !== 'nep245' ||
      e.version !== '1.0.0' ||
      !['mt_transfer', 'mt_mint', 'mt_burn'].includes(e.event)
    )
      continue;
    for (const value of z
      .array(
        z.object({
          token_ids: z.array(z.string()),
          amounts: z.array(atoms),
          old_owner_id: z.string().optional(),
          new_owner_id: z.string().optional(),
          owner_id: z.string().optional(),
        }),
      )
      .parse(e.data)) {
      if (value.token_ids.length !== value.amounts.length)
        throw new DomainError('FUNDING_CREDIT_PROOF', 'Malformed token movement');
      const amount = value.token_ids.reduce(
        (n, asset, i) => n + (asset === 'nep141:wrap.near' ? BigInt(value.amounts[i]!) : 0n),
        0n,
      );
      if (e.event === 'mt_transfer') {
        if (value.new_owner_id === account) balance += amount;
        if (value.old_owner_id === account) balance -= amount;
      }
      if (value.owner_id === account) {
        if (e.event === 'mt_mint') balance += amount;
        if (e.event === 'mt_burn') balance -= amount;
      }
    }
  }
  return {
    creditYocto: balance.toString(),
    blockHash: tx.transaction_outcome.block_hash,
    evidenceDigest: digest(raw),
  };
}
