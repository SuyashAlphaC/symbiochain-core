import { randomBytes } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { loadConfig } from '../src/config.js';
import { DomainError } from '../src/domain.js';
import { HardwareVerifier } from '../src/providers/attestation.js';
import { httpJson } from '../src/providers/http.js';
import { TlsGatewaySession } from '../src/providers/tee-session.js';
import { z } from 'zod';

// Free attestation retrieval only. No completion POST, wallet, database write,
// automatic allowlist approval, or transaction submission is available here.
const c = loadConfig({ ...process.env, EXECUTION_MODE: 'PAPER' });
if (!c.NEAR_AI_API_KEY || !c.NEAR_AI_MODEL) throw new Error('AI key and canonical model required');
const session = new TlsGatewaySession(new URL(c.NEAR_AI_BASE_URL).origin);
const nonce = randomBytes(32).toString('hex');
const url = new URL('/v1/attestation/report', c.NEAR_AI_BASE_URL);
for (const [key, value] of Object.entries({
  model: c.NEAR_AI_MODEL,
  provider: 'near',
  signing_algo: 'ecdsa',
  include_tls_fingerprint: 'true',
  nonce,
}))
  url.searchParams.set(key, value);
const verifier = new HardwareVerifier();
const checkedAt = new Date().toISOString();
try {
  const raw = z
    .object({
      gateway_attestation: z.unknown(),
      model_attestations: z.array(z.unknown()).min(1).max(32),
    })
    .parse(
      await httpJson(
        url,
        { headers: { authorization: `Bearer ${c.NEAR_AI_API_KEY}`, 'x-no-aliasing': 'true' } },
        session.fetch,
      ),
    );
  const reports = [raw.gateway_attestation, ...raw.model_attestations];
  const results = await Promise.all(
    reports.map(async (report, index) => {
      const role = index === 0 ? 'gateway' : 'model';
      try {
        const audit = await verifier.inspect(
          report,
          nonce,
          index !== 0,
          index === 0 ? session.peerSpkiSha256 : undefined,
        );
        const approvedCompose = (
          index === 0 ? c.TEE_GATEWAY_COMPOSE_HASHES : c.TEE_MODEL_COMPOSE_HASHES
        ).includes(audit.identity.composeHash);
        const approvedActions =
          !audit.identity.composeManagerActionsHash ||
          c.TEE_MODEL_ACTIONS_HASHES.includes(audit.identity.composeManagerActionsHash);
        return {
          role,
          hardwareVerified: true,
          identity: audit.identity,
          deploymentApproved: approvedCompose && approvedActions,
          composeApproved: approvedCompose,
          actionsApproved: approvedActions,
        };
      } catch (error) {
        return {
          role,
          hardwareVerified: false,
          deploymentApproved: false,
          code: error instanceof DomainError ? error.code : 'TEE_VERIFICATION_FAILED',
        };
      }
    }),
  );
  const summary = {
    checkedAt,
    model: c.NEAR_AI_MODEL,
    paidInferenceRequests: 0,
    transactionsPerformed: false,
    inferenceResponseVerified: false,
    results,
    readyForBoundedInference: results.every((r) => r.hardwareVerified && r.deploymentApproved),
  };
  await mkdir('.data/tee-gates', { recursive: true });
  await writeFile(
    '.data/tee-gates/latest-report.json',
    JSON.stringify({ nonce, peerSpkiSha256: session.peerSpkiSha256, response: raw }, null, 2),
    { mode: 0o600 },
  );
  await writeFile('.data/tee-gates/latest-verification.json', JSON.stringify(summary, null, 2), {
    mode: 0o600,
  });
  console.log(JSON.stringify(summary, null, 2));
  if (!summary.readyForBoundedInference) process.exitCode = 2;
} finally {
  session.close();
}
