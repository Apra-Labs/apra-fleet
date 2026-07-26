import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

// Regression guard for the /pm skill (suites s1-s9): the integ-test-runner must test/close
// ONLY the features in THIS sprint's root subtree, never the whole beads DB. The scoping is
// DETERMINISTIC and lives in ONE place -- the orchestrator (sprint.md Test phase) enumerates
// the sprint-root subtree's open features and hands the runner an explicit feature-id list;
// the runner does zero graph reasoning. This mirrors the auto-sprint (s10) getSprintOpenFeatures
// fix, but /pm always has a single sprint root (bd create "sprint: <name>"), so the orchestrator
// -- which already enumerates that subtree for the goal-check -- owns the scoping. See
// integ-scope.test.mjs for the s10 analog.

const dir = dirname(fileURLToPath(import.meta.url));
const agentMd = readFileSync(join(dir, '../agents/integ-test-runner.md'), 'utf-8');
const sprintMd = readFileSync(join(dir, '../skills/pm/sprint.md'), 'utf-8');

test('integ-test-runner agent has NO unscoped `bd list --type=feature --status=open` command', () => {
  assert.doesNotMatch(agentMd, /```bash\s*\n\s*bd list --type=feature --status=open/,
    'the agent must not have a fenced `bd list --type=feature --status=open` command block');
});

test('integ-test-runner agent consumes an explicit handed list and does not derive scope itself', () => {
  assert.match(agentMd, /explicit list of feature ids/i,
    'must say it is handed an explicit feature-id list');
  assert.match(agentMd, /Do \*\*NOT\*\* run `bd list --type=feature --status=open`/,
    'must explicitly warn against the unscoped global list');
  assert.match(agentMd, /Do \*\*NOT\*\* re-derive the set yourself/,
    'must instruct the agent NOT to re-derive scope from bd graph/bd list');
});

test('integ-test-runner agent fails safe (stops) when no scoped list is provided', () => {
  assert.match(agentMd, /do not guess and do not scan the DB/i,
    'a missing list must make it stop and report, never fall back to scanning the whole DB');
});

test('sprint.md Test phase makes the ORCHESTRATOR enumerate the subtree and pass an explicit list', () => {
  const idx = sprintMd.indexOf('**Integration tests');
  assert.ok(idx >= 0, 'sprint.md must have an Integration tests step');
  const region = sprintMd.slice(idx, idx + 800);
  // Orchestrator enumerates the sprint-root subtree itself...
  assert.match(region, /enumerate the open features in the sprint-root\s+subtree/i,
    'the orchestrator must enumerate the sprint-root subtree');
  assert.match(region, /bd graph --json <sprint-id>|bd list --tree <sprint-id>/,
    'must reference the subtree enumeration command');
  assert.match(region, /issue_type == feature/, 'must filter to features');
  assert.match(region, /status != closed/, 'must filter to open features');
  // ...and hands the runner an explicit list, not the raw sprint id to re-derive.
  assert.match(region, /explicit feature-id list/i,
    'must pass an explicit feature-id list to the runner');
  assert.match(region, /never the whole DB/i,
    'must forbid the whole-DB scan');
});
