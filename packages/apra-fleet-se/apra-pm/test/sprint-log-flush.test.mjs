import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const src = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), '../.claude/workflows/auto-sprint.js'),
  'utf-8'
);

// ---- appendNewEntries flush-timestamp behaviour (source-introspection) -------

test('appendNewEntries uses __FLUSH_TS__ placeholder, not the static sprint-start timestamp', () => {
  const fnStart = src.indexOf('async function appendNewEntries(');
  assert.ok(fnStart >= 0, 'appendNewEntries function must exist');
  // Find the closing brace of the function by scanning for the next top-level async function
  const fnEnd = src.indexOf('\nasync function ', fnStart + 1);
  const region = fnEnd > 0 ? src.slice(fnStart, fnEnd) : src.slice(fnStart, fnStart + 1500);

  assert.match(region, /__FLUSH_TS__/,
    'appendNewEntries must embed __FLUSH_TS__ placeholder in log lines, not the static sprintTs');
  assert.doesNotMatch(region, /ts:\s*sprintTs/,
    'appendNewEntries must not stamp log lines with the static sprint-start sprintTs');
});

test('appendNewEntries prompts the log-append agent to run date for local wall-clock time', () => {
  const fnStart = src.indexOf('async function appendNewEntries(');
  const fnEnd = src.indexOf('\nasync function ', fnStart + 1);
  const region = fnEnd > 0 ? src.slice(fnStart, fnEnd) : src.slice(fnStart, fnStart + 1500);

  assert.match(region, /date\s+\+%Y-%m-%dT%H:%M:%S%z/,
    'log-append prompt must invoke `date +%Y-%m-%dT%H:%M:%S%z` for local timestamp with tz offset');
  assert.doesNotMatch(region, /date\s+-u\s+\+%Y-%m-%dT%H:%M:%SZ/,
    'log-append prompt must not use UTC date (-u flag)');
});

test('appendNewEntries instructs agent to substitute __FLUSH_TS__ before appending', () => {
  const fnStart = src.indexOf('async function appendNewEntries(');
  const fnEnd = src.indexOf('\nasync function ', fnStart + 1);
  const region = fnEnd > 0 ? src.slice(fnStart, fnEnd) : src.slice(fnStart, fnStart + 1500);

  assert.match(region, /replace.*__FLUSH_TS__|__FLUSH_TS__.*replace/i,
    'log-append prompt must instruct the agent to replace __FLUSH_TS__ with the captured timestamp');
});

// ---- appendNewEntries write-only behaviour (no commit / push) ----------------

test('appendNewEntries prompt explicitly forbids commit and push', () => {
  const fnStart = src.indexOf('async function appendNewEntries(');
  const fnEnd = src.indexOf('\nasync function ', fnStart + 1);
  const region = fnEnd > 0 ? src.slice(fnStart, fnEnd) : src.slice(fnStart, fnStart + 2000);

  // The agent prompt must tell the agent NOT to commit or push.
  assert.match(region, /[Dd]o not commit/,
    'appendNewEntries prompt must say "Do not commit"');
  assert.match(region, /[Dd]o not (commit,? )?push/i,
    'appendNewEntries prompt must say "Do not ... push"');
});

test('appendNewEntries dispatch is fire-and-forget (not awaited)', () => {
  const fnStart = src.indexOf('async function appendNewEntries(');
  const fnEnd = src.indexOf('\nasync function ', fnStart + 1);
  const region = fnEnd > 0 ? src.slice(fnStart, fnEnd) : src.slice(fnStart, fnStart + 2000);

  // Must call dispatch without await.
  assert.match(region, /dispatch\(/, 'appendNewEntries must call dispatch');
  assert.doesNotMatch(region, /await\s+dispatch\(/,
    'appendNewEntries must NOT await dispatch (fire-and-forget)');
});

test('appendNewEntries prompt instructs writing to sprintLogFile (disk write)', () => {
  const fnStart = src.indexOf('async function appendNewEntries(');
  const fnEnd = src.indexOf('\nasync function ', fnStart + 1);
  const region = fnEnd > 0 ? src.slice(fnStart, fnEnd) : src.slice(fnStart, fnStart + 2000);

  // Must reference the sprint log file by variable or the sprint-logs/ directory.
  assert.match(region, /sprint-logs\/|sprintLogFile/,
    'appendNewEntries prompt must reference sprint-logs/ or sprintLogFile');
  // Must instruct appending (not overwriting).
  assert.match(region, /[Aa]ppend\s+\(do NOT overwrite\)|Append.*do not overwrite/i,
    'appendNewEntries prompt must specify append (not overwrite)');
});

// ---- beads-export-cleanup: git add sprint-logs/ before export+commit ---------

test('beads-export-cleanup prompt has "git add sprint-logs/" as first staged step', () => {
  const cleanupIdx = src.indexOf("label: 'beads-export-cleanup'");
  assert.ok(cleanupIdx >= 0, 'beads-export-cleanup dispatch must exist in source');

  // Look back up to 1800 chars for the prompt.
  const region = src.slice(Math.max(0, cleanupIdx - 3000), cleanupIdx);
  assert.match(region, /git[^\n]*add sprint-logs\//,
    'beads-export-cleanup must include "git add sprint-logs/"');
});

test('beads-export-cleanup stages sprint-logs/ before beads export and commit', () => {
  const cleanupIdx = src.indexOf("label: 'beads-export-cleanup'");
  const region = src.slice(Math.max(0, cleanupIdx - 3000), cleanupIdx);

  const addIdx   = region.indexOf('add sprint-logs/');
  const exportIdx = region.indexOf('bd export');
  const commitIdx = region.indexOf("commit -m \"chore: export beads state\"");

  assert.ok(addIdx >= 0,   '"git add sprint-logs/" must appear in cleanup prompt');
  assert.ok(exportIdx >= 0, '"bd export" must appear in cleanup prompt');
  assert.ok(commitIdx >= 0, 'export+commit must appear in cleanup prompt');
  assert.ok(addIdx < exportIdx,
    '"git add sprint-logs/" must appear before "bd export" in cleanup prompt');
  assert.ok(addIdx < commitIdx,
    '"git add sprint-logs/" must appear before the export commit in cleanup prompt');
});

test('beads-export-cleanup step 1 is unconditional (no "if" guard around git add sprint-logs)', () => {
  const cleanupIdx = src.indexOf("label: 'beads-export-cleanup'");
  // Use a larger lookback (3000 chars) to capture the full multi-step prompt string.
  const region = src.slice(Math.max(0, cleanupIdx - 3000), cleanupIdx);

  // The step description must say "unconditional" near the sprint-logs staging step.
  assert.match(region, /unconditional/i,
    'beads-export-cleanup must label the sprint-logs staging step as unconditional');
});
