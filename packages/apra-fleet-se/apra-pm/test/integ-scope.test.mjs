import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

// Regression guard: the integration tester must test/close ONLY features in THIS sprint's
// subtree. It used to be told `bd list --type=feature --status=open` -- every open feature in
// the whole beads DB -- so on a populated DB it would test, close, or file bugs against
// unrelated features from other epics/sprints. Now it is handed an explicit scoped list from
// getSprintOpenFeatures (strict bdSubtreeSnippet inventory).

const src = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), '../.claude/workflows/auto-sprint.js'),
  'utf-8',
);

test('integ tester dispatch does NOT instruct the global `bd list --type=feature --status=open`', () => {
  // Scope to the integ dispatch region (the getSprintOpenFeatures doc-comment legitimately
  // names the anti-pattern, so check the prompt itself, not the whole file).
  const integIdx = src.indexOf("label: integLabel, phase: 'Test', schema: INTEG_RUN_SCHEMA");
  const region = src.slice(Math.max(0, integIdx - 2400), integIdx);
  assert.doesNotMatch(region, /Run: bd list --type=feature --status=open/,
    'the integ-runner prompt must not list every open feature in the DB; it must use the sprint-scoped list');
});

test('getSprintOpenFeatures exists, uses bdSubtreeSnippet, filters open features in-subtree', () => {
  const idx = src.indexOf('async function getSprintOpenFeatures(');
  assert.ok(idx >= 0, 'getSprintOpenFeatures must be defined');
  const body = src.slice(idx, src.indexOf('\n}\n', idx));
  assert.match(body, /bdSubtreeSnippet\(/, 'must scope via bdSubtreeSnippet');
  assert.match(body, /issue_type==='feature'/, 'must filter to features');
  assert.match(body, /status!=='closed'/, 'must filter to open (non-closed) features');
  assert.match(body, /subtree\.has\(i\.id\)/, 'must keep only in-subtree issues');
});

test('Test phase computes the scoped feature list and passes it to the integ dispatch', () => {
  const integIdx = src.indexOf("label: integLabel, phase: 'Test', schema: INTEG_RUN_SCHEMA");
  assert.ok(integIdx >= 0, 'integ dispatch must exist');
  const region = src.slice(Math.max(0, integIdx - 2400), integIdx);
  assert.match(region, /getSprintOpenFeatures\(rootIds\)/, 'must compute sprint-scoped features');
  assert.match(region, /Integration-test ONLY these open features from THIS sprint/,
    'prompt must restrict testing to the scoped list');
});

// Functional: mirror getSprintOpenFeatures' extractor (bdSubtreeSnippet + feature/open filter)
// and prove it returns only the in-subtree OPEN feature.
test('scoped-feature extraction returns only in-subtree open features (not siblings/closed)', () => {
  const fnStart = src.indexOf('function bdSubtreeSnippet(');
  const fnEnd = src.indexOf('\n}', fnStart) + 2;
  // eslint-disable-next-line no-new-func
  const mkSnippet = new Function(src.slice(fnStart, fnEnd) + '\nreturn bdSubtreeSnippet;')();
  const snippet = mkSnippet(['gh-mi2']);
  // eslint-disable-next-line no-new-func
  const extract = new Function('g', `${snippet}
    return (g.issues||[]).filter(i=>subtree.has(i.id)&&i.issue_type==='feature'&&i.status!=='closed').map(i=>i.id);`);

  const g = {
    layout: { Nodes: {
      'gh-mi2':      { DependsOn: ['gh-mi2.1'] },
      'gh-mi2.1':    { DependsOn: null },  // in-subtree OPEN feature
      'gh-mi2.done': { DependsOn: null },  // in-subtree CLOSED feature
      'gh-4ef':      { DependsOn: null },  // SIBLING open feature (must be excluded)
      'gh-ww3':      { DependsOn: ['gh-mi2', 'gh-4ef'] },
    } },
    issues: [
      { id: 'gh-mi2', issue_type: 'epic', status: 'open' },
      { id: 'gh-mi2.1', issue_type: 'feature', status: 'open' },
      { id: 'gh-mi2.done', issue_type: 'feature', status: 'closed' },
      { id: 'gh-4ef', issue_type: 'feature', status: 'open' },
      { id: 'gh-ww3', issue_type: 'epic', status: 'open' },
    ],
  };
  assert.deepEqual(extract(g), ['gh-mi2.1'],
    'only the in-subtree open feature; the closed one and the sibling gh-4ef are excluded');
});
