import { test } from 'node:test';
import assert from 'node:assert/strict';
import { evaluateGates } from '../e2e/validate-sprint.mjs';

// The sprint analysis file is local-only, so it is never harvest evidence and
// committing it fails the gate.
const gate = (finalFiles) => evaluateGates({ pr: { url: 'u', number: 1 }, finalFiles })
  .gates.find((g) => g.name === 'harvester-ran');

test('harvester-ran passes on docs/ or README.md changes', () => {
  assert.equal(gate(['docs/architecture.md']).pass, true);
  assert.equal(gate(['README.md']).pass, true);
});

test('harvester-ran does not count an analysis file as harvest evidence', () => {
  assert.equal(gate(['src/a.js']).pass, false);
});

test('harvester-ran fails when a sprint analysis file was committed', () => {
  for (const f of ['docs/sprint-analysis-feat-x-1234abcd.md', 'sprint-logs/feat-x-20261019_120000.analysis.md']) {
    const g = gate(['docs/architecture.md', f]);
    assert.equal(g.pass, false, f);
    assert.match(g.detail, /must stay local/);
  }
});
