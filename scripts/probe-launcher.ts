import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { promisify } from 'node:util';
import { z } from 'zod';

// This diagnostic deliberately does not import application config or load .env.
// It checks one public image using Brave's pinned, unmodified verification code.
const run = promisify(execFile);
const revision = '72a1a994f3ab44c00ed4747398c68d38ac46bffa';
const cosignHash = 'c956e5dfcac53d52bcf058360d579472f0c1d2d9b69f55209e256fe7783f4c74';
const repository = resolve('.data/tee-gates/brave-near-verifier');
const binary = resolve('.data/tee-gates/bin/cosign');
const directory = resolve('.data/tee-gates/brave-audit');
const image =
  'nearaidev/compose-manager-launcher@sha256:079a14b41deb11e0e27f9b69648e8b3d89bd6fb9ccf6071643b8f447fa415085';
await mkdir(directory, { recursive: true, mode: 0o700 });
try {
  const head = await run('git', ['rev-parse', 'HEAD'], { cwd: repository, timeout: 10000 });
  if (head.stdout.trim() !== revision) throw new Error('Unreviewed verifier revision');
  await run('git', ['diff', '--quiet', 'HEAD', '--'], { cwd: repository, timeout: 10000 });
  if (
    createHash('sha256')
      .update(await readFile(binary))
      .digest('hex') !== cosignHash
  )
    throw new Error('Unreviewed cosign binary');
  const python = `
import json
from verifier.models import create_verification_policy
from verifier.config import CERT_EXPECTED_COMMITS
from verifier.verifications.image import verify_image_full
registry = 'nearaidev/compose-manager-launcher'
policy = create_verification_policy({registry: 'nearai/compose-manager'})
result = verify_image_full('${image.split('@')[1]}', registry, policy)
print(json.dumps({'rebuildExempt': registry in policy.skip_reproducibility_images,
  'expectedCommit': CERT_EXPECTED_COMMITS[registry], 'result': result}))
`;
  const result = await run(`${repository}/.venv/bin/python`, ['-c', python], {
    cwd: repository,
    timeout: 90000,
    maxBuffer: 1_000_000,
    env: {
      PATH: `${resolve('.data/tee-gates/bin')}:${process.env.PATH ?? '/usr/bin:/bin'}`,
      PYTHONPATH: repository,
      PRE_VERIFY_DISABLED: '1',
      NEAR_ENV: 'prod',
      MODEL_NAME: 'z-ai/glm-5.3-flash',
    },
  });
  await writeFile(`${directory}/pinned-verifier.log`, result.stderr, { mode: 0o600 });
  const parsed = z
    .object({
      rebuildExempt: z.literal(true),
      expectedCommit: z.literal('8e07c3583909c9ab9da94d883e87add1ae90832d'),
      result: z.object({
        image: z.literal(image),
        provenance_found: z.boolean(),
        provenance_verified: z.boolean(),
      }),
    })
    .parse(JSON.parse(result.stdout));
  if (parsed.result.provenance_verified && !parsed.result.provenance_found)
    throw new Error('Inconsistent provenance result');
  const report = {
    checkedAt: new Date().toISOString(),
    scope: 'EXACT_LAUNCHER_PROVENANCE_ONLY',
    verifier: { repository: 'https://github.com/brave/near-verifier', revision },
    cosign: { version: '3.0.6', sha256: cosignHash },
    image,
    expectedSourceCommit: parsed.expectedCommit,
    provenanceFound: parsed.result.provenance_found,
    provenanceVerified: parsed.result.provenance_verified,
    launcherRebuildExempt: true,
    reproducibleBuildPerformed: false,
    fullServiceVerificationPerformed: false,
    deploymentApproved: false,
    apiKeyProvided: false,
    paidInferenceRequests: 0,
  };
  await writeFile(
    'artifacts/launcher-provenance-verification.json',
    JSON.stringify(report, null, 2) + '\n',
  );
  console.log(JSON.stringify(report, null, 2));
  if (!report.provenanceVerified) process.exitCode = 2;
} catch {
  console.error(
    'Launcher diagnostic unavailable. Check the pinned prerequisites in docs/TEE_LAUNCHER_POLICY.md. No inference was requested.',
  );
  process.exitCode = 2;
}
