import { z } from 'zod';
import { Store } from './store.js';
import { digest, sha256, DomainError } from './domain.js';
import { unseal } from './crypto.js';
export async function exportEvidence(store: Store, id: string) {
  const cycle = await store.getCycle(id);
  const [decisions, proofs, transactions, journals, costBasis] = await Promise.all([
    store.db.decision.findMany({ where: { cycleId: id }, orderBy: { createdAt: 'asc' } }),
    store.db.proof.findMany({ where: { cycleId: id }, orderBy: { createdAt: 'asc' } }),
    store.db.chainTransaction.findMany({ where: { cycleId: id } }),
    store.db.journal.findMany({ where: { cycleId: id }, include: { postings: true } }),
    store.db.costBasis.findUnique({ where: { cycleId: id } }),
  ]);
  const { submission: _signedMaterial, ...safeCycle } = cycle;
  const bundle = JSON.parse(
    JSON.stringify({
      sourceMode: cycle.mode,
      exportedAt: new Date().toISOString(),
      cycle: safeCycle,
      decisions,
      transactions,
      journals,
      costBasis,
      proofs: proofs.map(({ evidenceCiphertext, ...p }) => ({
        ...p,
        evidence: evidenceCiphertext
          ? unseal(evidenceCiphertext, store.config.EVIDENCE_ENCRYPTION_KEY, id)
          : null,
      })),
      trustNotice:
        'An archive checksum detects changes to this file. It does not independently attest hardware, chain inclusion, profitability, or the exporter.',
    }),
  );
  return { format: 'symbiochain-evidence-v1' as const, bundleHash: digest(bundle), bundle };
}
export function verifyArchive(input: unknown) {
  const archive = z
    .object({
      format: z.literal('symbiochain-evidence-v1'),
      bundleHash: z.string().regex(/^[a-f0-9]{64}$/),
      bundle: z
        .object({
          sourceMode: z.enum(['PAPER', 'LIVE', 'REPLAY']),
          cycle: z.object({ id: z.string(), state: z.string() }).passthrough(),
          proofs: z.array(
            z
              .object({
                kind: z.string(),
                requestHash: z.string().nullable(),
                responseHash: z.string().nullable(),
                evidence: z.unknown(),
              })
              .passthrough(),
          ),
          decisions: z.array(z.unknown()),
        })
        .passthrough(),
    })
    .parse(input);
  if (digest(archive.bundle) !== archive.bundleHash)
    throw new DomainError('ARCHIVE_TAMPERED', 'Archive checksum mismatch');
  for (const proof of archive.bundle.proofs)
    if (proof.kind === 'NEAR_AI') {
      const e = z
        .object({ requestBase64: z.string(), responseBase64: z.string() })
        .parse(proof.evidence);
      if (
        sha256(Buffer.from(e.requestBase64, 'base64')) !== proof.requestHash ||
        sha256(Buffer.from(e.responseBase64, 'base64')) !== proof.responseHash
      )
        throw new DomainError(
          'ARCHIVE_RESPONSE_BINDING',
          'Archived inference bytes do not match their recorded hashes',
        );
    }
  return archive;
}
