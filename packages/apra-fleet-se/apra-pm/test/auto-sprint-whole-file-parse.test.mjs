// Whole-file syntax guard for the shipped fleet-sprint workflow.
//
// Most auto-sprint tests only load the PURE_FUNCTIONS block, so a syntax error
// anywhere else in the file (for example a raw line break inside a string
// literal) shipped unnoticed. This test compiles the ENTIRE file without
// running it.
//
// The workflow is a script body: it uses top-level `await` and top-level
// `return`, and its only export is `export const meta` on line 1. It is
// therefore compiled as the body of an async function, with that single
// `export` keyword removed (line numbers are unchanged).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const WORKFLOW = join(dirname(fileURLToPath(import.meta.url)), '../.claude/workflows/auto-sprint.js');
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;

function compileWorkflowBody(src) {
  const exportLines = src.split(/\r?\n/).filter((l) => /^\s*export\s/.test(l));
  assert.ok(exportLines.length === 1 && /^export const meta\b/.test(exportLines[0]),
    'the workflow must have exactly one export, `export const meta`, for this guard to stay exact');
  const body = src.replace(/^export const meta\b/m, 'const meta');
  // Compiles only; the function is never called.
  return new AsyncFunction('args', body);
}

test('auto-sprint.js compiles as a whole (not just the PURE_FUNCTIONS block)', () => {
  const src = readFileSync(WORKFLOW, 'utf-8');
  assert.doesNotThrow(() => compileWorkflowBody(src));
});

test('the whole-file guard rejects a raw line break inside a string literal', () => {
  const src = readFileSync(WORKFLOW, 'utf-8');
  const broken = src.replace('// PURE_FUNCTIONS_END', "const _bad = 'a\nb';\n// PURE_FUNCTIONS_END");
  assert.notEqual(broken, src);
  assert.throws(() => compileWorkflowBody(broken), SyntaxError);
});
