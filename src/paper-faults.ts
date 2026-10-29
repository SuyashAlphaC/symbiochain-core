import { readFile, writeFile, rename, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { DomainError, sha256 } from './domain.js';
import type { Config } from './config.js';
import type { Store, ClaimedJob } from './store.js';

const Command = z
  .object({
    requestId: z.uuid(),
    cycleId: z.uuid(),
    role: z.enum(['SCOUT', 'BRAIN', 'HAND']),
  })
  .strict();
type Command = z.infer<typeof Command>;
const absent = (error: unknown) => (error as NodeJS.ErrnoException)?.code === 'ENOENT';

/** An ephemeral, single-use command for the colocated PAPER demonstration. Jobs stay in PostgreSQL. */
export class PaperFaultController {
  readonly file: string;
  constructor(
    readonly config: Config,
    file?: string,
  ) {
    this.file =
      file ??
      join(tmpdir(), `symbiochain-paper-fault-${sha256(config.DATABASE_URL).slice(0, 16)}.json`);
  }
  private guard() {
    if (this.config.EXECUTION_MODE !== 'PAPER' || !this.config.ENABLE_CHAOS_DEMO)
      throw new DomainError(
        'DEMO_DISABLED',
        'Worker crash controls require explicitly enabled PAPER mode',
        403,
      );
  }
  async arm(store: Store, cycleId: string, role: Command['role']) {
    this.guard();
    const cycle = await store.getCycle(cycleId);
    const control = await store.db.workerControl.findUniqueOrThrow({ where: { role } });
    if (!control.paused)
      throw new DomainError(
        'PAUSE_AGENT_FIRST',
        'Pause the selected agent before arming its pending job',
      );
    const pending = await store.db.job.findFirst({
      where: {
        cycleId: cycle.id,
        lane: role,
        doneAt: null,
        OR: [{ leaseUntil: null }, { leaseUntil: { lt: new Date() } }],
      },
    });
    if (!pending)
      throw new DomainError(
        'NO_PENDING_JOB',
        'This cycle has no unclaimed job for the selected agent',
      );
    const command = Command.parse({ requestId: randomUUID(), cycleId, role });
    try {
      await writeFile(this.file, JSON.stringify(command), { flag: 'wx', mode: 0o600 });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST')
        throw new DomainError('DEMO_ALREADY_ARMED', 'A worker crash is already armed');
      throw error;
    }
    try {
      await store.atomic((tx) => store.event(tx, 'demo.worker_crash_armed', command, cycleId));
    } catch (error) {
      await unlink(this.file).catch(() => {});
      throw error;
    }
    return command;
  }
  async cancel(store: Store) {
    this.guard();
    let command: Command;
    try {
      command = Command.parse(JSON.parse(await readFile(this.file, 'utf8')));
      await unlink(this.file);
    } catch (error) {
      if (absent(error)) return { cancelled: false };
      throw error;
    }
    await store.atomic((tx) =>
      store.event(tx, 'demo.worker_crash_cancelled', command, command.cycleId),
    );
    return { cancelled: true, requestId: command.requestId };
  }
  async afterClaim(
    store: Store,
    job: ClaimedJob,
    crash: () => void = () => {
      process.kill(process.pid, 'SIGKILL');
    },
  ) {
    this.guard();
    let command: Command;
    try {
      command = Command.parse(JSON.parse(await readFile(this.file, 'utf8')));
    } catch (error) {
      if (absent(error)) return;
      throw error;
    }
    if (command.cycleId !== job.cycleId || command.role !== job.lane) return;
    const consumed = `${this.file}.consumed-${randomUUID()}`;
    try {
      await rename(this.file, consumed);
    } catch (error) {
      if (absent(error)) return;
      throw error;
    }
    // Delete the one-shot request before crashing so a restart cannot create a crash loop.
    await unlink(consumed);
    await store.atomic((tx) =>
      store.event(
        tx,
        'demo.worker_crash_triggered',
        {
          ...command,
          jobId: job.id,
          attempt: job.attempts,
          leaseUntil: job.leaseUntil,
        },
        job.cycleId,
      ),
    );
    crash();
  }
}

export function colocatedPaperFaults(config: Config) {
  return config.EXECUTION_MODE === 'PAPER' &&
    config.ENABLE_CHAOS_DEMO &&
    process.env.SYMBIO_COLOCATED_WORKER === 'true'
    ? new PaperFaultController(config)
    : undefined;
}
