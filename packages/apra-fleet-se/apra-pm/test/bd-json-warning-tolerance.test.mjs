import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

// Regression guard for the s10 win32 failure: bd 1.1.0 prepends
// `warning: beads.role not configured (GH#2950)` to its --json stdout, and in the
// sandboxed shell-dispatch context stderr merges into stdout, so the warning is glued
// in front of the JSON. The extractors used to pipe bd output straight into JSON.parse(d),
// which threw -> the catch silently returned an empty ready/blocker set -> Develop saw
// "no ready tasks" -> spurious deadlock / zero doers. BD_JSON must strip that noise.

const src = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), '../.claude/workflows/auto-sprint.js'),
  'utf-8',
);

test('no raw JSON.parse(d) remains -- every bd-json extractor goes through BD_JSON', () => {
  assert.doesNotMatch(src, /JSON\.parse\(d\)/,
    'a bd-json extractor still parses raw stdin (JSON.parse(d)); it must use JSON.parse(${BD_JSON}) to tolerate a leading bd warning line');
});

test('BD_JSON is defined and backslash-free (survives the backtick->shell->node round-trip)', () => {
  const line = src.split('\n').find(l => l.trim().startsWith('const BD_JSON ='));
  assert.ok(line, 'BD_JSON constant must be defined');
  const body = line.slice(line.indexOf('`') + 1, line.lastIndexOf('`'));
  assert.ok(!body.includes('\\'),
    'BD_JSON must contain no backslashes -- backslash escaping does not survive the backtick->shell(double-quote)->node layers reliably');
  assert.match(body, /indexOf|lastIndexOf/, 'BD_JSON should locate the JSON span via indexOf/lastIndexOf on literal bracket chars');
});

test('BD_JSON extracts the JSON span from warning-polluted / clean / object / empty stdout', () => {
  const line = src.split('\n').find(l => l.trim().startsWith('const BD_JSON ='));
  const expr = line.slice(line.indexOf('`') + 1, line.lastIndexOf('`'));
  // BD_JSON is an expression that reads a variable `d` (the raw stdout) and returns the JSON span.
  const extract = (d) => Function('d', `return ${expr};`)(d);

  // Array payload with a single leading bd warning line.
  assert.deepEqual(
    JSON.parse(extract('warning: beads.role not configured (GH#2950).\n[{"id":"gh-toy-mi2.1","priority":1}]\n')),
    [{ id: 'gh-toy-mi2.1', priority: 1 }],
    'leading bd warning must be stripped for array payloads');

  // Multiple leading warnings + trailing noise.
  assert.deepEqual(
    JSON.parse(extract('warning: a\nwarning: b\n[{"id":"z"}]\ndone.\n')),
    [{ id: 'z' }],
    'multiple leading warnings and trailing noise must be stripped');

  // Object payload (bd graph --json shape).
  assert.deepEqual(
    JSON.parse(extract('warning: x\n{"issues":[{"id":"q"}]}\n')),
    { issues: [{ id: 'q' }] },
    'object payloads (graph --json) must extract correctly too');

  // Clean input is unchanged.
  assert.deepEqual(JSON.parse(extract('[{"id":"a"}]\n')), [{ id: 'a' }], 'clean input must still parse');

  // Empty array survives.
  assert.deepEqual(JSON.parse(extract('warning: x\n[]\n')), [], 'empty array payload must survive');
});
