import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

// Regression guard for the sibling-pollution bug: `bd graph --json <root>` returns the whole
// connected component (root's PARENT and therefore its SIBLINGS). The extractors used to
// scrape every `.issues[].id`, so unrelated siblings (e.g. gh-toy-4ef, a sibling of gh-toy-mi2
// under a shared parent) leaked into the sprint inventory -> work dispatched outside the
// charter + reviewer hallucinating "missing" tasks. bdSubtreeSnippet must build a STRICT
// inventory: roots + their dotted-ID descendants + DependsOn-reachable prerequisites, never
// siblings/parents. ID-prefix is the wiring-independent core (works with null DependsOn).

const src = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), '../.claude/workflows/auto-sprint.js'),
  'utf-8',
);

// Build a callable subtree(g, roots) from the REAL source snippet.
function subtreeFn(roots) {
  const fnStart = src.indexOf('function bdSubtreeSnippet(');
  const fnEnd = src.indexOf('\n}', fnStart) + 2;
  // eslint-disable-next-line no-new-func
  const mk = new Function(src.slice(fnStart, fnEnd) + '\nreturn bdSubtreeSnippet;')();
  const snippet = mk(roots);
  // eslint-disable-next-line no-new-func
  return new Function('g', `${snippet}\nreturn Array.from(subtree).sort();`);
}

test('no bd-graph extractor scrapes every .issues[].id (siblings would leak)', () => {
  assert.doesNotMatch(src, /issues\.map\(i=>i\.id\)/,
    'a `bd graph` extractor still scrapes .issues.map(i=>i.id) -- it must use bdSubtreeSnippet to exclude siblings/parents');
});

test('bdSubtreeSnippet is defined and backslash-free (survives backtick->shell->node)', () => {
  const start = src.indexOf('function bdSubtreeSnippet(');
  assert.ok(start >= 0, 'bdSubtreeSnippet must be defined');
  const body = src.slice(start, src.indexOf('\n}', start));
  assert.ok(!body.includes('\\'), 'bdSubtreeSnippet must contain no backslashes');
});

test('excludes siblings/parent when DependsOn IS wired (toy-repo shape)', () => {
  const g = {
    layout: { Nodes: {
      'gh-mi2':   { DependsOn: ['gh-mi2.1'] }, // parent depends on child
      'gh-mi2.1': { DependsOn: null },
      'gh-4ef':   { DependsOn: null },          // sibling: separate id under shared parent
      'gh-ww3':   { DependsOn: ['gh-mi2', 'gh-4ef'] }, // shared parent
    } },
    issues: [{ id: 'gh-mi2' }, { id: 'gh-mi2.1' }, { id: 'gh-4ef' }, { id: 'gh-ww3' }],
  };
  const got = subtreeFn(['gh-mi2'])(g);
  assert.deepEqual(got, ['gh-mi2', 'gh-mi2.1'],
    'subtree must be root + its child only; sibling gh-4ef and parent gh-ww3 excluded');
});

test('includes dotted descendants when DependsOn is ABSENT (null-edge DB -- never under-inclusive)', () => {
  const g = {
    layout: { Nodes: {
      'e':   { DependsOn: null },
      'e.1': { DependsOn: null },
      'e.2': { DependsOn: null },
      'x':   { DependsOn: null }, // unrelated top-level id
    } },
    issues: [{ id: 'e' }, { id: 'e.1' }, { id: 'e.2' }, { id: 'x' }],
  };
  const got = subtreeFn(['e'])(g);
  assert.deepEqual(got, ['e', 'e.1', 'e.2'],
    'with null DependsOn, ID-prefix must still capture all dotted children (and exclude unrelated x)');
});

test('root=leaf returns only the leaf, not its dotted siblings', () => {
  const g = {
    layout: { Nodes: {
      'e.1': { DependsOn: null },
      'e.2': { DependsOn: null }, // sibling leaf
    } },
    issues: [{ id: 'e.1' }, { id: 'e.2' }],
  };
  const got = subtreeFn(['e.1'])(g);
  assert.deepEqual(got, ['e.1'], 'a leaf root must not pull in its sibling e.2');
});
