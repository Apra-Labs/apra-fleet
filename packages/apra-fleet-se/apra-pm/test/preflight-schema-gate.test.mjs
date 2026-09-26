import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const src = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), '../.claude/workflows/auto-sprint.js'),
  'utf-8'
);

// The beads schema-gate preflight must catch a bd remote-migrate block (#4259) BEFORE any
// sprint work, so a schema-behind DB fails fast with the migration runbook instead of dying
// mid-sprint with a cryptic error and no PR.

test('a preflight probe runs a read-only bd command labeled preflight-bd-schema', () => {
  assert.match(src, /label:\s*['"]preflight-bd-schema['"]/,
    'the schema-gate probe dispatch must be labeled preflight-bd-schema');
  const idx = src.indexOf("label: 'preflight-bd-schema'");
  const region = src.slice(Math.max(0, idx - 600), idx);
  assert.match(region, /bd ready/, 'the probe must run a read-only bd command (bd ready)');
});

test('the probe matches the bd remote-migrate gate signatures', () => {
  const idx = src.indexOf("label: 'preflight-bd-schema'");
  const region = src.slice(Math.max(0, idx - 600), idx + 200);
  for (const sig of ['refusing to auto-apply', 'writes are blocked', 'remote-backed database']) {
    assert.ok(region.includes(sig), `probe grep must include the "${sig}" gate signature`);
  }
});

test('a detected gate aborts preflight with the migration runbook pointer', () => {
  const idx = src.indexOf("label: 'preflight-bd-schema'");
  const region = src.slice(idx, idx + 1600);
  assert.match(region, /BD_ALLOW_REMOTE_MIGRATE=1 bd migrate/,
    'the abort message must include the designated-migrator fix command');
  assert.match(region, /docs\/beads-1\.1\.0-migration\.md/,
    'the abort message must point to the migration runbook');
  assert.match(region, /return \{ error: 'preflight: beads schema gate \(remote-migrate block\)' \}/,
    'a detected gate must return a preflight error (hard-fail before any work)');
});

test('the gate check runs after the branch/lock preflight and before the sprint loop', () => {
  const gateIdx = src.indexOf("label: 'preflight-bd-schema'");
  const lockIdx = src.indexOf('another auto-sprint run appears active');
  const loopIdx = src.indexOf('while (cycleCount < maxCycles)');
  assert.ok(lockIdx >= 0 && gateIdx > lockIdx, 'schema gate must come after the concurrency-lock preflight');
  assert.ok(loopIdx >= 0 && gateIdx < loopIdx, 'schema gate must run before the sprint loop starts');
});
