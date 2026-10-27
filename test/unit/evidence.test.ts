import { it, expect } from 'vitest';
import { digest } from '../../src/domain.js';
import { verifyArchive } from '../../src/evidence.js';
it('labels historical source mode and detects archive mutation', () => {
  const bundle = {
    sourceMode: 'PAPER',
    cycle: { id: 'demo', state: 'CLOSED' },
    proofs: [],
    decisions: [],
  };
  const archive = { format: 'symbiochain-evidence-v1', bundleHash: digest(bundle), bundle };
  expect(verifyArchive(archive).bundle.sourceMode).toBe('PAPER');
  bundle.sourceMode = 'LIVE';
  expect(() => verifyArchive(archive)).toThrow('checksum mismatch');
});
