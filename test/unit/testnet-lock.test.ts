import { it, expect } from 'vitest';
import { mkdtemp, rm, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { testnetLock, recoverTestnetLock } from '../../src/testnet-ledger.js';

it('refuses concurrent runners and explicit recovery of a living process', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'symbio-lock-'));
  const unlock = await testnetLock(dir);
  try {
    await expect(testnetLock(dir)).rejects.toMatchObject({ code: 'TESTNET_RUNNER_LOCKED' });
    await expect(recoverTestnetLock(dir)).rejects.toMatchObject({ code: 'TESTNET_RUNNER_ACTIVE' });
  } finally {
    await unlock();
    await rm(dir, { recursive: true, force: true });
  }
});
it('recovers an identified dead process without changing any transaction journal', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'symbio-lock-'));
  const child = spawnSync(process.execPath, ['-e', '']);
  try {
    await writeFile(
      `${dir}/runner.lock`,
      JSON.stringify({ pid: child.pid, startedAt: new Date().toISOString() }),
    );
    await writeFile(`${dir}/near-journal.json`, '{"immutableSignedBytes":"sentinel"}');
    await recoverTestnetLock(dir);
    expect(await readFile(`${dir}/near-journal.json`, 'utf8')).toContain('immutableSignedBytes');
    const unlock = await testnetLock(dir);
    await unlock();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
