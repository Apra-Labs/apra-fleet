import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const skillMd = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), '../skills/pm/SKILL.md'),
  'utf-8'
);

// 1. No role-count 'four' language
test('SKILL.md does not contain stale "four roles" or "four kinds of subagent" language', () => {
  assert.doesNotMatch(skillMd, /four roles/i, 'must not contain "four roles"');
  assert.doesNotMatch(skillMd, /four kinds of subagent/i, 'must not contain "four kinds of subagent"');
  assert.doesNotMatch(skillMd, /The four roles/i, 'must not contain "The four roles"');
  assert.doesNotMatch(skillMd, /Four subagent roles/i, 'must not contain "Four subagent roles"');
});

// 2. Taxonomy present: sprint-core and lifecycle-support groupings
test('SKILL.md contains 8-role taxonomy with sprint-core and lifecycle-support groupings', () => {
  // Sprint core grouping naming planner, plan-reviewer, doer, reviewer
  assert.match(skillMd, /planner/, 'must contain "planner"');
  assert.match(skillMd, /plan-reviewer/, 'must contain "plan-reviewer"');
  assert.match(skillMd, /doer/, 'must contain "doer"');
  assert.match(skillMd, /reviewer/, 'must contain "reviewer"');

  // Lifecycle support grouping naming deployer, integ-test-runner, ci-watcher, harvester
  assert.match(skillMd, /deployer/, 'must contain "deployer"');
  assert.match(skillMd, /integ-test-runner/, 'must contain "integ-test-runner"');
  assert.match(skillMd, /ci-watcher/, 'must contain "ci-watcher"');
  assert.match(skillMd, /harvester/, 'must contain "harvester"');

  // Sprint core grouping label
  assert.match(skillMd, /[Ss]print[\s-]core/,
    'must contain a sprint-core grouping label');

  // Lifecycle support grouping label
  assert.match(skillMd, /[Ll]ifecycle[\s-]support/,
    'must contain a lifecycle-support grouping label');
});

// 3. Each lifecycle role appears with a dispatch condition
test('SKILL.md includes a dispatch condition for each lifecycle-support role', () => {
  // deployer: dispatched when deploy.md is present
  assert.match(skillMd, /deployer/,
    'SKILL.md must mention deployer');
  assert.match(skillMd, /deploy\.md/,
    'SKILL.md must mention deploy.md as deployer dispatch condition');

  // integ-test-runner: dispatched after successful deploy
  assert.match(skillMd, /integ-test-runner/,
    'SKILL.md must mention integ-test-runner');
  assert.match(skillMd, /integ-test-playbook\.md/,
    'SKILL.md must mention integ-test-playbook.md as integ-test-runner dispatch condition');

  // ci-watcher: polled inline when waiting for CI green
  assert.match(skillMd, /ci-watcher/,
    'SKILL.md must mention ci-watcher');
  assert.match(skillMd, /CI|ci green|waiting for CI/i,
    'SKILL.md must state ci-watcher dispatch condition (CI)');

  // harvester: dispatched at sprint close
  assert.match(skillMd, /harvester/,
    'SKILL.md must mention harvester');
  assert.match(skillMd, /sprint close|CHANGELOG/i,
    'SKILL.md must state harvester dispatch condition (sprint close / CHANGELOG)');
});

// 4. SKILL.md must not reference /auto-sprint (no cross-skill coupling)
test('SKILL.md must not reference /auto-sprint', () => {
  assert.doesNotMatch(skillMd, /\/auto-sprint/,
    'SKILL.md must not reference /auto-sprint');
});

// 5. Lifecycle-support roles must not mention /auto-sprint
test('SKILL.md lifecycle-support roles must not mention /auto-sprint', () => {
  assert.doesNotMatch(skillMd, /also used by.*\/auto-sprint|\/auto-sprint.*also used/is,
    'SKILL.md must not state that lifecycle agents are also used by /auto-sprint');
});

// 6. No auto-sprint internals leaked
test('SKILL.md does not leak auto-sprint internals (calibration.json or model-id strings)', () => {
  assert.doesNotMatch(skillMd, /calibration\.json/,
    'SKILL.md must not contain "calibration.json"');
  assert.doesNotMatch(skillMd, /claude-opus-4/,
    'SKILL.md must not contain model-id string "claude-opus-4"');
  assert.doesNotMatch(skillMd, /claude-sonnet-4/,
    'SKILL.md must not contain model-id string "claude-sonnet-4"');
  assert.doesNotMatch(skillMd, /claude-haiku-4/,
    'SKILL.md must not contain model-id string "claude-haiku-4"');
});
