// Drift guard: the role-contract schemas inlined into .claude/workflows/auto-sprint.js
// (between ROLE_SCHEMAS_GENERATED_BEGIN/END) must always match what
// scripts/gen-auto-sprint-schemas.mjs would produce from the canonical
// agents/schemas/<role>-output.json files right now. Runtime require('fs') to load
// them was removed because auto-sprint.js executes inside Claude's Workflow tool
// sandbox, which has no filesystem/require access (that crash -- "require is not
// defined" -- took down apra-pm e2e s10 on 2026-07-17, run 29605783512). Regenerating
// at build time instead of at runtime means a schema edit that forgets to re-run the
// generator must fail here, not silently ship a stale inlined copy.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dir = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(__dir, '..');
const schemasDir = join(repoRoot, 'agents', 'schemas');
const targetFile = join(repoRoot, '.claude', 'workflows', 'auto-sprint.js');

const ROLES = [
  ['reviewer', 'REVIEW_SCHEMA'],
  ['plan-reviewer', 'PLAN_REVIEW_SCHEMA'],
  ['doer', 'DOER_STATUS_SCHEMA'],
  ['deployer', 'DEPLOYER_SCHEMA'],
  ['integ-test-runner', 'INTEG_RUN_SCHEMA'],
  ['ci-watcher', 'CI_SCHEMA'],
  ['harvester', 'HARVEST_SCHEMA'],
];

const BEGIN_MARKER = '// ROLE_SCHEMAS_GENERATED_BEGIN -- do not hand-edit; run `node scripts/gen-auto-sprint-schemas.mjs` to regenerate from agents/schemas/*.json';
const END_MARKER = '// ROLE_SCHEMAS_GENERATED_END';

function loadStrippedSchema(role) {
  const file = join(schemasDir, `${role}-output.json`);
  const parsed = JSON.parse(readFileSync(file, 'utf-8'));
  const { version, ...rest } = parsed;
  return rest;
}

// Strips block comments, line comments, and all string/template literals from a JS
// source so what remains is only real executable code. Needed because auto-sprint.js
// legitimately contains dozens of `require('fs')` occurrences INSIDE backtick
// template literals -- those build `node -e "..."` shell command strings for a
// separate, real Node subprocess the doer/Haiku dispatch actually runs (outside the
// Workflow sandbox), and are not require() calls the Workflow engine itself would
// ever try to evaluate. A require() call must never appear in what's left after
// stripping -- that would mean the Workflow script body itself calls require(),
// which always crashes ("require is not defined") since the sandbox has none.
function stripStringsAndComments(src) {
  // Order matters: template literals first (may contain quotes), then line/block
  // comments, then single/double-quoted strings. `[^\\]` + escaped-char alternation
  // handles backslash-escaped delimiters/backslashes well enough for this file (no
  // nested template literals with backticks inside ${...} are used here).
  return src
    .replace(/`(?:\\.|[^`\\])*`/gs, '``')
    .replace(/\/\/[^\n]*/g, '')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/"(?:\\.|[^"\\])*"/g, '""')
    .replace(/'(?:\\.|[^'\\])*'/g, "''");
}

test('auto-sprint.js has no real require() call anywhere in its executable script body -- the Workflow tool sandbox has neither filesystem nor require access', () => {
  const src = readFileSync(targetFile, 'utf-8');
  const stripped = stripStringsAndComments(src);
  // This intentionally catches ANY require(...) left in real code, not just the
  // specific `const fs = require('fs')` / `const path = require('path')` statements
  // the old runtime schema loader had -- a future addition anywhere in the file must
  // fail here too, since the Workflow sandbox rejects require() unconditionally.
  assert.doesNotMatch(stripped, /\brequire\s*\(/, 'auto-sprint.js must not call require() anywhere in its executable script body -- the Workflow tool sandbox has no filesystem/require access ("require is not defined" crashed apra-pm e2e s10 on 2026-07-17, run 29605783512)');
  assert.doesNotMatch(src, /loadRoleSchema/, 'auto-sprint.js must not load role schemas from disk at runtime -- they must be inlined at build time by scripts/gen-auto-sprint-schemas.mjs');
});

test('auto-sprint.js role schemas are not stale -- matches what scripts/gen-auto-sprint-schemas.mjs would generate right now', () => {
  const src = readFileSync(targetFile, 'utf-8');
  const beginIdx = src.indexOf(BEGIN_MARKER);
  const endIdx = src.indexOf(END_MARKER);
  assert.ok(beginIdx >= 0 && endIdx >= 0, 'ROLE_SCHEMAS_GENERATED_BEGIN/END markers must be present in auto-sprint.js');

  for (const [role, constName] of ROLES) {
    const expected = loadStrippedSchema(role);
    const expectedLiteral = `const ${constName} = ${JSON.stringify(expected, null, 2)};`;
    assert.ok(
      src.includes(expectedLiteral),
      `${constName} in auto-sprint.js is stale relative to agents/schemas/${role}-output.json -- run \`node scripts/gen-auto-sprint-schemas.mjs\` and commit the result`
    );
  }
});

test('every inlined role schema has the "version" key stripped (strict-mode agent-tool validator rejects it)', () => {
  const src = readFileSync(targetFile, 'utf-8');
  const beginIdx = src.indexOf(BEGIN_MARKER);
  const endIdx = src.indexOf(END_MARKER) + END_MARKER.length;
  const block = src.slice(beginIdx, endIdx);
  assert.doesNotMatch(block, /"version":\s*\d/, 'no inlined role schema may carry a "version" key -- the agent tool\'s strict-mode schema validator rejects unrecognized keywords (see the s10 2026-07-17 failure, run 29605783512)');
});
