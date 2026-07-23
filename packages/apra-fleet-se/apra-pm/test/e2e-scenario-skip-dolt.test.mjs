import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

// The e2e must run the sprint with skip_dolt_push: true so it never writes beads state to a
// real Dolt remote on GitHub (the toy is no-db anyway, but this makes the intent explicit and
// keeps the e2e side-effect-free even if the toy's backend ever changes).

const here = dirname(fileURLToPath(import.meta.url));

test('the auto-sprint e2e scenario instructs skip_dolt_push = true', () => {
  const scenario = readFileSync(join(here, '../../../../e2e/pm/scenario-auto-sprint.md'), 'utf-8');
  assert.match(scenario, /skip_dolt_push/,
    'scenario-auto-sprint.md must mention skip_dolt_push');
  assert.match(scenario, /skip_dolt_push[^\n]*\btrue\b/i,
    'scenario-auto-sprint.md must set skip_dolt_push to true');
});

test('the auto-sprint-args skill documents skip_dolt_push', () => {
  const skill = readFileSync(join(here, '../.claude/skills/auto-sprint-args/SKILL.md'), 'utf-8');
  assert.match(skill, /`skip_dolt_push`/,
    'auto-sprint-args SKILL.md must document the skip_dolt_push field');
});
