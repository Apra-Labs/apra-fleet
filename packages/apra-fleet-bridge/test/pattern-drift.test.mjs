// Verify that the safe-arg charset pattern in src/beads-client.mjs
// matches the pattern in exec-bd.mjs. These two files maintain independent
// copies of the same pattern and must never drift.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const pkgRoot = path.resolve(__dirname, '..');

function extractPattern(fileContent, varName) {
  // Match const VARNAME = /...../;
  const regex = new RegExp(`const\\s+${varName}\\s*=\\s*(/.+?/);`);
  const match = fileContent.match(regex);
  if (!match) {
    throw new Error(`Could not find pattern "${varName}" in source`);
  }
  return match[1];
}

test('beads-client.mjs and exec-bd.mjs safe-arg patterns are identical', () => {
  // Read beads-client.mjs
  const beadsClientPath = path.join(pkgRoot, 'src', 'beads-client.mjs');
  const beadsClientContent = readFileSync(beadsClientPath, 'utf8');
  const beadsPattern = extractPattern(beadsClientContent, 'BD_SAFE_ARG_PATTERN');

  // Read exec-bd.mjs (located in apra-fleet-se supervisor lib)
  const execBdPath = path.resolve(pkgRoot, '..', 'apra-fleet-se', 'src', 'supervisor', 'lib', 'exec-bd.mjs');
  const execBdContent = readFileSync(execBdPath, 'utf8');
  const execBdPattern = extractPattern(execBdContent, 'SAFE_ARG_PATTERN');

  assert.strictEqual(
    beadsPattern,
    execBdPattern,
    [
      'Pattern mismatch: beads-client.mjs and exec-bd.mjs have diverged.',
      `beads-client BD_SAFE_ARG_PATTERN: ${beadsPattern}`,
      `exec-bd.mjs SAFE_ARG_PATTERN: ${execBdPattern}`,
      'Update one to match the other. Both patterns govern which arguments are safe to pass',
      'to the `bd` CLI command.',
    ].join('\n'),
  );
});

// ---------------------------------------------------------------------------
// Guard against reimplementing an engine export locally. This package
// previously grew two such duplicates -- computeBranchSlug in
// src/verbs/finalize.mjs and, briefly, computeSprintProgress-shaped logic
// alongside it -- because one file was written while the module that should
// have exported the real thing (src/snapshot.mjs) was being edited
// concurrently by another unit of the same build, and the two agents could
// not see each other's work. Both are engine exports this package must
// import, never redefine; this test makes a future recurrence fail loudly
// instead of silently drifting (see finalize.mjs's module header, "REUSE,
// NOT REIMPLEMENTATION", for the concrete failure mode: a duplicated
// computeBranchSlug that disagrees with the engine's would make finalize
// report a docs/sprint-analysis-<slug>.md path to a file that does not
// exist, and nothing would fail because it is only a string in a comment).
// ---------------------------------------------------------------------------

function listMjsFilesRecursive(dir) {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...listMjsFilesRecursive(full));
    } else if (entry.isFile() && entry.name.endsWith('.mjs')) {
      out.push(full);
    }
  }
  return out;
}

/**
 * Whether `content` DEFINES `symbolName` locally (a function declaration or
 * a const/let assignment) rather than merely importing or calling it. An
 * `import { symbolName } from '...'` line, or a call site like
 * `symbolName(x)`, must not trip this -- only `function symbolName(`,
 * `async function symbolName(`, or `const/let symbolName =` count as a
 * definition.
 */
function definesSymbolLocally(content, symbolName) {
  const defPattern = new RegExp(
    `(^|\\n)\\s*(export\\s+)?(async\\s+)?function\\s+${symbolName}\\s*\\(|(^|\\n)\\s*(export\\s+)?(const|let)\\s+${symbolName}\\s*=`
  );
  return defPattern.test(content);
}

test('no file under src/ redefines computeBranchSlug or computeSprintProgress -- both are engine exports', () => {
  const srcDir = path.join(pkgRoot, 'src');
  const engineSymbols = [
    { name: 'computeBranchSlug', importFrom: '@apralabs/apra-fleet-se/fleet-sprint/sprint-report.mjs' },
    { name: 'computeSprintProgress', importFrom: '@apralabs/apra-fleet-se/fleet-sprint/sprint-progress.mjs' },
  ];

  const offenders = [];
  for (const file of listMjsFilesRecursive(srcDir)) {
    const content = readFileSync(file, 'utf8');
    for (const { name, importFrom } of engineSymbols) {
      if (definesSymbolLocally(content, name)) {
        offenders.push(`${path.relative(pkgRoot, file)} defines its own "${name}" -- import it from "${importFrom}" instead`);
      }
    }
  }

  assert.deepStrictEqual(
    offenders,
    [],
    [
      'Found local reimplementation(s) of an engine export under src/:',
      ...offenders,
      'These must be imported from the engine, never redefined here -- a local copy can silently',
      'drift from the engine\'s behavior (see this test\'s header comment for the concrete failure mode).',
    ].join('\n'),
  );
});

test('no file under src/sinks/ defines its own record-stamping logic -- stampAndSerialize is shared', () => {
  const sinksDir = path.join(pkgRoot, 'src', 'sinks');
  const recordPath = path.join(sinksDir, 'record.mjs');

  const offenders = [];
  for (const file of listMjsFilesRecursive(sinksDir)) {
    // Skip record.mjs itself
    if (file === recordPath) continue;

    const content = readFileSync(file, 'utf8');
    // Check for the key identifier of record-stamping logic: receivedAt: clock.now()
    // This pattern is specific to the stamping operation and should only exist in record.mjs
    if (/receivedAt\s*:\s*clock\.now\(\)/.test(content)) {
      offenders.push(`${path.relative(pkgRoot, file)} defines its own record-stamping logic -- import stampAndSerialize from 'src/sinks/record.mjs'`);
    }
  }

  assert.deepStrictEqual(
    offenders,
    [],
    [
      'Found local reimplementation(s) of record-stamping logic under src/sinks/:',
      ...offenders,
      'The stampAndSerialize function must be imported from src/sinks/record.mjs, never redefined here',
      '-- a local copy can silently drift from the record.mjs implementation and break the byte-identical',
      'guarantee required for the append-blob restart-without-duplicates test.',
    ].join('\n'),
  );
});

test('no file under src/verbs/ defines buildFallbackSnapshot locally -- import from src/snapshot.mjs', () => {
  const verbsDir = path.join(pkgRoot, 'src', 'verbs');

  const offenders = [];
  for (const file of listMjsFilesRecursive(verbsDir)) {
    const content = readFileSync(file, 'utf8');
    if (definesSymbolLocally(content, 'buildFallbackSnapshot')) {
      offenders.push(`${path.relative(pkgRoot, file)} defines its own "buildFallbackSnapshot" -- import it from 'src/snapshot.mjs' instead`);
    }
  }

  assert.deepStrictEqual(
    offenders,
    [],
    [
      'Found local reimplementation(s) of buildFallbackSnapshot under src/verbs/:',
      ...offenders,
      'The buildFallbackSnapshot function must be imported from src/snapshot.mjs, never redefined here',
      '-- a local copy can silently drift from the snapshot.mjs implementation. This fallback snapshot',
      'is how we show a crashed sprint\'s last log when there is no structured state, so drifting',
      'between watch.mjs and status.mjs would cause different descriptions of the same failure.',
    ].join('\n'),
  );
});
