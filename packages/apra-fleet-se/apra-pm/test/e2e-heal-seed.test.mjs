import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

// Regression guard: the e2e harness (shared by ALL suites s1-s10) must restore the toy's
// shared Dolt seed (refs/dolt/data) to golden as part of teardown, so the shared issue
// state stays constant across runs. This replaced the earlier proposal of a scheduled
// self-healing Action -- the heal now rides on every run's teardown instead.

const src = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), '../../../../e2e/pm/run-e2e.mjs'),
  'utf-8',
);

test('healDoltSeed is defined and called from teardown', () => {
  assert.match(src, /function healDoltSeed\(/, 'healDoltSeed must be defined');
  // Called after the other teardown steps, before returning the suite result.
  const teardownIdx = src.indexOf('if (!keepInstall) teardownInstall(');
  assert.ok(teardownIdx >= 0, 'teardownInstall call site must exist');
  const region = src.slice(teardownIdx, teardownIdx + 300);
  assert.match(region, /healDoltSeed\(token\)/, 'healDoltSeed(token) must be called in teardown');
});

test('healDoltSeed rebuilds golden from committed JSONL without adopting the polluted remote', () => {
  const idx = src.indexOf('function healDoltSeed(');
  const body = src.slice(idx, src.indexOf('\n}\n', idx));
  // Fresh clone for a pristine JSONL.
  assert.match(body, /git\(\['clone', cfg\.toy/, 'must fresh-clone the toy for a pristine seed');
  // CRITICAL: remove git origin BEFORE bd init so no pollution is adopted.
  assert.match(body, /remote', 'remove', 'origin'/, 'must remove git origin before init');
  assert.match(body, /'init', '-p', 'gh-toy'/, 'must bd init');
  assert.match(body, /'import', '\.beads\/issues\.jsonl'/, 'must import the committed JSONL');
});

test('healDoltSeed guards against pushing a non-golden seed', () => {
  const idx = src.indexOf('function healDoltSeed(');
  const body = src.slice(idx, src.indexOf('\n}\n', idx));
  assert.match(body, /refusing to push/, 'must refuse to push a bad rebuild');
  assert.match(body, /openCount !== issues\.length|issues\.length === 0/,
    'must require all-open, non-empty before pushing');
});

test('healDoltSeed force-pushes the golden seed and is best-effort', () => {
  const idx = src.indexOf('function healDoltSeed(');
  const body = src.slice(idx, src.indexOf('\n}\n', idx));
  assert.match(body, /'dolt', 'push', '--force', '--remote', 'origin'/, 'must force-push the seed');
  // Best effort: guarded by try/catch, never throws to fail the suite.
  assert.match(body, /try \{/, 'must wrap the heal in try/catch (best effort)');
  assert.match(body, /PMLITE_E2E_NO_HEAL/, 'must support an opt-out env var');
});
