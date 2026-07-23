import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const src = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), '../.claude/workflows/auto-sprint.js'),
  'utf-8'
);

// ---- setup dispatchShell (Phase 1: deterministic commands) -------------------

test('setup dispatchShell is labeled "setup-shell" (source check)', () => {
  assert.match(src, /label:\s*['"]setup-shell['"]/,
    'setup dispatchShell must use label "setup-shell"');
});

test('setup dispatchShell commands include git rev-parse --show-toplevel (repo root)', () => {
  const shellIdx = src.indexOf("label: 'setup-shell'");
  assert.ok(shellIdx >= 0, '"setup-shell" label must exist');
  const region = src.slice(Math.max(0, shellIdx - 4500), shellIdx);
  assert.match(region, /git rev-parse --show-toplevel/,
    'setup dispatchShell must include "git rev-parse --show-toplevel" for repo root');
});

test('setup dispatchShell fetches and cuts a new branch from origin/<base_branch> (stale-main guard)', () => {
  const shellIdx = src.indexOf("label: 'setup-shell'");
  const region = src.slice(Math.max(0, shellIdx - 4500), shellIdx);
  assert.match(region, /git fetch origin --quiet/,
    'setup must git fetch before branching so the new sprint branch is off the latest base');
  assert.match(region, /git checkout -b "\$\{branch\}" "origin\/\$\{base_branch\}"/,
    'a new sprint branch must be created from origin/<base_branch>, not stale local HEAD');
});

test('setup dispatchShell commands include git checkout (branch handling)', () => {
  const shellIdx = src.indexOf("label: 'setup-shell'");
  const region = src.slice(Math.max(0, shellIdx - 4500), shellIdx);
  assert.match(region, /git checkout/,
    'setup dispatchShell must include a git checkout command for branch setup');
});

test('setup dispatchShell commands include git rev-parse --abbrev-ref HEAD (branch confirmation)', () => {
  const shellIdx = src.indexOf("label: 'setup-shell'");
  const region = src.slice(Math.max(0, shellIdx - 4500), shellIdx);
  assert.match(region, /git rev-parse --abbrev-ref HEAD/,
    'setup dispatchShell must confirm branch with git rev-parse --abbrev-ref HEAD');
});

test('setup dispatchShell commands include existence checks for deploy.md and integ-test-playbook.md', () => {
  const shellIdx = src.indexOf("label: 'setup-shell'");
  const region = src.slice(Math.max(0, shellIdx - 4500), shellIdx);
  assert.match(region, /test -f deploy\.md/,
    'setup dispatchShell must check deploy.md existence');
  assert.match(region, /test -f integ-test-playbook\.md/,
    'setup dispatchShell must check integ-test-playbook.md existence');
});

test('setup dispatchShell commands include date +%Y%m%d_%H%M%S (startedAt timestamp)', () => {
  const shellIdx = src.indexOf("label: 'setup-shell'");
  const region = src.slice(Math.max(0, shellIdx - 4500), shellIdx);
  assert.match(region, /date \+%Y%m%d_%H%M%S/,
    'setup dispatchShell must capture startedAt timestamp with date +%Y%m%d_%H%M%S');
});

test('setup dispatchShell has 8 command slots (output indices 0-7, fetch at 1)', () => {
  // The comments in source enumerate the output indices. After the stale-main guard
  // (fetch at index 1) and the permission-precompute (index 7), there are 8 slots.
  const shellIdx = src.indexOf("label: 'setup-shell'");
  const region = src.slice(Math.max(0, shellIdx - 4500), shellIdx);
  assert.match(region, /0: repo root[\s\S]*1: fetch result[\s\S]*2: branch checkout[\s\S]*3: confirmed branch[\s\S]*4: startedAt[\s\S]*5: deploy\.md[\s\S]*6: integ-test-playbook[\s\S]*7: newline-joined list of permission/,
    'setup dispatchShell must document output slots 0-7 with fetch at index 1');
});

// ---- setup Phase 2: free-form agent with maxTurns: 20 -----------------------

test('free-form setup agent (Phase 2) has maxTurns: 20', () => {
  // The free-form setup dispatch must set maxTurns: 20.
  // maxTurns appears in the options object AFTER the label, so search around the label.
  const setupDispatchIdx = src.indexOf("label: 'setup'");
  assert.ok(setupDispatchIdx >= 0, '"setup" label must exist for Phase 2 dispatch');
  // Scan 200 chars around the label (both before and after the label within the options object).
  const region = src.slice(Math.max(0, setupDispatchIdx - 100), setupDispatchIdx + 200);
  assert.match(region, /maxTurns:\s*20/,
    'free-form setup agent must have maxTurns: 20');
});

test('free-form setup agent (Phase 2) is dispatched after setup-shell Phase 1', () => {
  const shellIdx = src.indexOf("label: 'setup-shell'");
  const setupIdx = src.indexOf("label: 'setup'");
  assert.ok(shellIdx >= 0, '"setup-shell" label must exist');
  assert.ok(setupIdx >= 0, '"setup" label must exist');
  assert.ok(shellIdx < setupIdx,
    'setup-shell (Phase 1) must appear before setup (Phase 2) in source');
});

test('free-form setup agent prompt mentions "Phase 2" and pre-known values', () => {
  const setupIdx = src.indexOf("label: 'setup'");
  // The prompt string spans ~40 lines before the label; use a 3500-char lookback.
  const region = src.slice(Math.max(0, setupIdx - 3500), setupIdx);
  assert.match(region, /Phase 2/i,
    'setup Phase 2 prompt must reference Phase 2');
  assert.match(region, /Pre-known values|pre-known values|do NOT re-run/i,
    'setup Phase 2 prompt must tell the agent not to re-run deterministic commands');
});
