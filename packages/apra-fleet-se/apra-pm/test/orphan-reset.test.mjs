import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const src = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), '../.claude/workflows/auto-sprint.js'),
  'utf-8'
);

// Extract shellMaxTurns from source (it lives outside PURE_FUNCTIONS block).
const shellMaxTurnsMatch = src.match(/function shellMaxTurns\(cmds\)\s*\{([^}]+)\}/);
if (!shellMaxTurnsMatch) throw new Error('shellMaxTurns function not found in auto-sprint.js');
// eslint-disable-next-line no-new-func
const shellMaxTurns = new Function('cmds', shellMaxTurnsMatch[1]);

// ---- helpers -----------------------------------------------------------------

/** Build resetCmds for a list of inProgressIds, mirroring auto-sprint.js logic. */
function buildResetCmds(inProgressIds) {
  if (inProgressIds.length === 0) return null;  // no dispatch (guarded by if)
  return inProgressIds.map(id => `bd update ${id} --status=open`);
}

// ---- source-level assertions -------------------------------------------------

test('orphan reset is guarded: dispatch only when inProgressIds.length > 0', () => {
  const resetIdx = src.indexOf('reset-orphans');
  assert.ok(resetIdx >= 0, '"reset-orphans" label must exist in source');

  // The if-guard must appear before the reset dispatch.
  const region = src.slice(Math.max(0, resetIdx - 400), resetIdx);
  assert.match(region, /if\s*\(\s*cycleState\.inProgressIds\.length\s*>\s*0\s*\)/,
    'reset-orphans must be inside an if(inProgressIds.length > 0) guard');
});

test('reset command template is "bd update <id> --status=open" (source check)', () => {
  const resetIdx = src.indexOf('reset-orphans');
  const region = src.slice(Math.max(0, resetIdx - 400), resetIdx);
  assert.match(region, /bd update \$\{id\} --status=open/,
    'reset command must be "bd update ${id} --status=open"');
});

test('reset uses a single dispatchShell (not one dispatch per task)', () => {
  const resetIdx = src.indexOf('reset-orphans');
  // Look backward from the label to find the dispatchShell call.
  const region = src.slice(Math.max(0, resetIdx - 400), resetIdx);
  assert.match(region, /dispatchShell\s*\(resetCmds/,
    'orphan reset must use dispatchShell(resetCmds, ...) -- not individual dispatch calls');
});

// ---- functional tests -------------------------------------------------------

test('0 inProgressIds: no reset dispatch (buildResetCmds returns null)', () => {
  const result = buildResetCmds([]);
  assert.equal(result, null,
    '0 inProgressIds => no reset dispatch (guarded by if-check)');
});

test('1 inProgressId: single reset command "bd update <id> --status=open"', () => {
  const cmds = buildResetCmds(['BD-42']);
  assert.ok(Array.isArray(cmds), 'result must be an array');
  assert.equal(cmds.length, 1, 'must have exactly 1 command');
  assert.equal(cmds[0], 'bd update BD-42 --status=open');
});

test('N inProgressIds: N reset commands, one per id', () => {
  const ids = ['BD-1', 'BD-2', 'BD-3', 'BD-4', 'BD-5'];
  const cmds = buildResetCmds(ids);
  assert.ok(Array.isArray(cmds), 'result must be an array');
  assert.equal(cmds.length, 5, 'must have exactly 5 commands for 5 ids');
  for (let i = 0; i < ids.length; i++) {
    assert.equal(cmds[i], `bd update ${ids[i]} --status=open`,
      `command[${i}] must reset ${ids[i]}`);
  }
});

test('maxTurns for reset dispatchShell equals N + 1 (shellMaxTurns formula)', () => {
  for (const n of [1, 2, 5, 10]) {
    const ids = Array.from({ length: n }, (_, i) => `BD-${i}`);
    const cmds = buildResetCmds(ids);
    const maxTurns = shellMaxTurns(cmds);
    assert.equal(maxTurns, n + 1,
      `shellMaxTurns for ${n} reset commands must be ${n + 1}`);
  }
});

test('shellMaxTurns is cmds.length + 1 (verified for reset scenario)', () => {
  // Confirm the general shellMaxTurns formula used by dispatchShell.
  assert.equal(shellMaxTurns(['a']), 2);
  assert.equal(shellMaxTurns(['a', 'b', 'c']), 4);
  assert.equal(shellMaxTurns([]), 1);  // edge: 0 cmds => maxTurns 1
});
