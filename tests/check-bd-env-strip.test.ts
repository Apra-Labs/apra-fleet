import { describe, it, expect } from 'vitest';
import { runScan, formatReport } from '../scripts/check-bd-env-strip.mjs';

// Guards the BEADS_DIR leak fixed in my-beads-db-qy8.9 (and its follow-ups,
// my-beads-db-qy8.9.3): bd resolves BEADS_DIR before it ever looks at cwd, so
// any test harness that spawns the real bd CLI into a scratch/tempdir/toy-repo
// clone without stripping BEADS_DIR from the child env silently hits the
// operator's own ambient beads workspace instead -- this already rewrote a
// real beads remote twice via the f34 test before the fix landed. Nothing
// mechanically stops the NEXT contributor from adding one more unstripped
// real-bd spawn; this is that mechanical net. See
// scripts/check-bd-env-strip.mjs for the full rule, scanned file set, and the
// allowlist/exception mechanism.
describe('bd child-env strip check', () => {
  it('reports zero real bd child-process spawns that do not provably strip BEADS_DIR', () => {
    const { violations, stale } = runScan();
    expect(violations, formatReport(violations, stale)).toEqual([]);
    expect(stale, formatReport([], stale)).toEqual([]);
  });
});
