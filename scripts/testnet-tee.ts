import { spawn } from 'node:child_process';
import { mkdir, open, readFile, writeFile, rename, unlink } from 'node:fs/promises';
import { applyTeeProbe, readTestnetReport } from '../src/testnet-report.js';

const dir = '.data/testnet-rehearsal';
await mkdir(dir, { recursive: true, mode: 0o700 });
const lock = await open(`${dir}/runner.lock`, 'wx', 0o600);
const log = await open(`${dir}/tee-probe.log`, 'w', 0o600);
try {
  const startedAt = new Date().toISOString();
  const code = await new Promise<number | null>((resolve, reject) => {
    const child = spawn(
      process.execPath,
      ['node_modules/tsx/dist/cli.mjs', 'scripts/probe-tee.ts'],
      { stdio: ['ignore', log.fd, log.fd] },
    );
    child.on('error', reject);
    child.on('exit', resolve);
  });
  if (code !== 0 && code !== 2) throw new Error('Free TEE probe failed; inspect the private log');
  const report = applyTeeProbe(
    await readTestnetReport(`${dir}/report.json`),
    JSON.parse(await readFile('.data/tee-gates/latest-verification.json', 'utf8')),
    startedAt,
  );
  const data = JSON.stringify(report, null, 2) + '\n';
  await writeFile(`${dir}/report.json.tmp`, data, { mode: 0o600 });
  await rename(`${dir}/report.json.tmp`, `${dir}/report.json`);
  // Publish only the strict report. Never publish raw attestation reports, keys or logs.
  await writeFile('artifacts/testnet-rehearsal.json.tmp', data, { mode: 0o644 });
  await rename('artifacts/testnet-rehearsal.json.tmp', 'artifacts/testnet-rehearsal.json');
  console.log(
    JSON.stringify(
      {
        profile: report.profile,
        checks: report.checks,
        paidInferenceRequests: 0,
        mainnetTransactions: 0,
      },
      null,
      2,
    ),
  );
  if (report.checks.some((c) => c.status === 'BLOCKED' || c.status === 'FAILED'))
    process.exitCode = 2;
} finally {
  await log.close();
  await lock.close();
  await unlink(`${dir}/runner.lock`);
}
