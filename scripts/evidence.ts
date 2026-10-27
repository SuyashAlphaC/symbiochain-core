import { readFile, writeFile } from 'node:fs/promises';
import { loadConfig } from '../src/config.js';
import { createDatabase } from '../src/db.js';
import { Store } from '../src/store.js';
import { exportEvidence, verifyArchive } from '../src/evidence.js';
const [command, argument, destination] = process.argv.slice(2);
if (command === 'replay') {
  if (!argument) throw new Error('Usage: npm run evidence:replay -- archive.json');
  const data = await readFile(argument);
  if (data.length > 20_000_000) throw new Error('Archive exceeds 20 MB');
  const archive = verifyArchive(JSON.parse(data.toString('utf8')));
  console.log(
    JSON.stringify(
      {
        mode: 'REPLAY',
        sourceMode: archive.bundle.sourceMode,
        cycleId: archive.bundle.cycle.id,
        state: archive.bundle.cycle.state,
        checksumValid: true,
        decisions: archive.bundle.decisions,
        warning:
          'Historical archive only; no transactions, inference, or current hardware verification performed',
      },
      null,
      2,
    ),
  );
} else if (command === 'export') {
  if (!argument || !destination)
    throw new Error('Usage: npm run evidence:export -- cycle-uuid private-archive.json');
  const c = loadConfig(),
    db = createDatabase(c.DATABASE_URL);
  try {
    const archive = await exportEvidence(new Store(db, c), argument);
    await writeFile(destination, JSON.stringify(archive, null, 2), { mode: 0o600, flag: 'wx' });
    console.log(
      JSON.stringify({
        saved: destination,
        bundleHash: archive.bundleHash,
        sourceMode: archive.bundle.sourceMode,
        containsPrivateInferenceEvidence: true,
      }),
    );
  } finally {
    await db.$disconnect();
  }
} else throw new Error('Choose export or replay');
