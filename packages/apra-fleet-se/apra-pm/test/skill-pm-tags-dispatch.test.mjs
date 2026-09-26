import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const skillMd = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), '../skills/pm/SKILL.md'),
  'utf-8'
);

const fleetAddendumMd = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), '../skills/pm/fleet-addendum.md'),
  'utf-8'
);

const doerReviewerLoopMd = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), '../skills/pm/doer-reviewer-loop.md'),
  'utf-8'
);

// Test 1: tags: ['doer'] appears in permission-composition guidance in SKILL.md
test('SKILL.md R9 uses tags: [\'doer\'] for doer member permission selection', () => {
  assert.match(skillMd, /tags:\s*\[\s*['"]doer['"]\s*\]/,
    'SKILL.md must contain tags: [\'doer\'] for member selection');
});

// Test 2: tags: ['reviewer'] appears in permission-composition guidance in SKILL.md
test('SKILL.md R9 uses tags: [\'reviewer\'] for reviewer member permission selection', () => {
  assert.match(skillMd, /tags:\s*\[\s*['"]reviewer['"]\s*\]/,
    'SKILL.md must contain tags: [\'reviewer\'] for member selection');
});

// Test 3: No role-based dispatch wording in SKILL.md
test('SKILL.md dispatch guidance must not contain role: doer or role: reviewer', () => {
  // Specifically look for role-based wording in permission context (not general usage of "role")
  const roleBasedDispatch = /compose_permissions.*?role:\s*['"]?(doer|reviewer)/is;
  assert.doesNotMatch(skillMd, roleBasedDispatch,
    'SKILL.md must not use role: doer or role: reviewer in dispatch/permission context');
});

// Test 4: compose_permissions is called before dispatch
test('SKILL.md R9 states compose_permissions called before dispatch', () => {
  assert.match(skillMd, /compose_permissions.*?before.*?dispatch/is,
    'SKILL.md R9 must specify compose_permissions is called before dispatch');
});

// Test 5: Verify compose_permissions is mentioned in fleet-mode rule R9
test('SKILL.md R9 rule mentions compose_permissions', () => {
  assert.match(skillMd, /R9.*compose_permissions/is,
    'SKILL.md R9 must mention compose_permissions');
});

// Test 6: fleet-addendum.md uses tags: ['doer']
test('fleet-addendum.md Permissions section uses tags: [\'doer\'] for doer members', () => {
  assert.match(fleetAddendumMd, /tags:\s*\[\s*['"]doer['"]\s*\]/,
    'fleet-addendum.md must contain tags: [\'doer\'] in permission guidance');
});

// Test 7: fleet-addendum.md uses tags: ['reviewer']
test('fleet-addendum.md Permissions section uses tags: [\'reviewer\'] for reviewer members', () => {
  assert.match(fleetAddendumMd, /tags:\s*\[\s*['"]reviewer['"]\s*\]/,
    'fleet-addendum.md must contain tags: [\'reviewer\'] in permission guidance');
});

// Test 8: No role-based dispatch wording in fleet-addendum.md
test('fleet-addendum.md permission guidance must not contain role: doer or role: reviewer', () => {
  const roleBasedDispatch = /member using tag-based selection.*?role:\s*['"]?(doer|reviewer)/is;
  assert.doesNotMatch(fleetAddendumMd, roleBasedDispatch,
    'fleet-addendum.md must not use role-based dispatch wording in permission context');
});

// Test 9: compose_permissions is called before every dispatch in fleet-addendum.md
test('fleet-addendum.md states compose_permissions called before EVERY dispatch', () => {
  assert.match(fleetAddendumMd, /compose_permissions.*?before.*?EVERY.*?dispatch/is,
    'fleet-addendum.md must state compose_permissions is called before every dispatch');
});

// Phase 4b Tests: doer-reviewer-loop.md tag-based dispatch validation

// Test 10: tags: ['doer'] appears in dispatch guidance in doer-reviewer-loop.md
test('doer-reviewer-loop.md Continuity section uses tags: [\'doer\'] for doer dispatch', () => {
  assert.match(doerReviewerLoopMd, /tags:\s*\[\s*['"]doer['"]\s*\]/,
    'doer-reviewer-loop.md must contain tags: [\'doer\'] in dispatch/continuity guidance');
});

// Test 11: tags: ['reviewer'] appears in dispatch guidance in doer-reviewer-loop.md
test('doer-reviewer-loop.md Continuity section uses tags: [\'reviewer\'] for reviewer dispatch', () => {
  assert.match(doerReviewerLoopMd, /tags:\s*\[\s*['"]reviewer['"]\s*\]/,
    'doer-reviewer-loop.md must contain tags: [\'reviewer\'] in dispatch/continuity guidance');
});

// Test 12: No role-based dispatch wording in doer-reviewer-loop.md
test('doer-reviewer-loop.md dispatch guidance must not contain role: doer or role: reviewer', () => {
  // Look for "dispatch" followed by "role: doer" or "role: reviewer" in dispatch context
  const roleBasedDispatch = /dispatch.*?role:\s*['"]?(doer|reviewer)/is;
  assert.doesNotMatch(doerReviewerLoopMd, roleBasedDispatch,
    'doer-reviewer-loop.md must not use role-based dispatch wording');
});

// Test 13: Git identities pm-doer and pm-reviewer preserved in doer-reviewer-loop.md
test('doer-reviewer-loop.md preserves git identity pm-doer', () => {
  assert.match(doerReviewerLoopMd, /pm-doer/,
    'doer-reviewer-loop.md must contain git identity pm-doer');
});

test('doer-reviewer-loop.md preserves git identity pm-reviewer', () => {
  assert.match(doerReviewerLoopMd, /pm-reviewer/,
    'doer-reviewer-loop.md must contain git identity pm-reviewer');
});

test('doer-reviewer-loop.md preserves git identity pm-planner', () => {
  assert.match(doerReviewerLoopMd, /pm-planner/,
    'doer-reviewer-loop.md must contain git identity pm-planner');
});

test('doer-reviewer-loop.md preserves git identity pm-plan-reviewer', () => {
  assert.match(doerReviewerLoopMd, /pm-plan-reviewer/,
    'doer-reviewer-loop.md must contain git identity pm-plan-reviewer');
});

// Test 14: Per-role prompt templates section and headings are intact
test('doer-reviewer-loop.md preserves "Per-role prompt templates" section heading', () => {
  assert.match(doerReviewerLoopMd, /Per-role prompt templates/,
    'doer-reviewer-loop.md must contain "Per-role prompt templates" section');
});

test('doer-reviewer-loop.md preserves planner/plan-reviewer/doer/reviewer template headings', () => {
  assert.match(doerReviewerLoopMd, /### planner/,
    'doer-reviewer-loop.md must contain planner template section');
  assert.match(doerReviewerLoopMd, /### plan-reviewer/,
    'doer-reviewer-loop.md must contain plan-reviewer template section');
  assert.match(doerReviewerLoopMd, /### doer/,
    'doer-reviewer-loop.md must contain doer template section');
  assert.match(doerReviewerLoopMd, /### reviewer/,
    'doer-reviewer-loop.md must contain reviewer template section');
});

// Test 15: Loop structure and section headings are intact
test('doer-reviewer-loop.md preserves "The loop (the Develop phase of one cycle)" section', () => {
  assert.match(doerReviewerLoopMd, /The loop \(the Develop phase of one cycle\)/,
    'doer-reviewer-loop.md must contain "The loop" section');
});

test('doer-reviewer-loop.md preserves doer-reviewer cycle safeguard table', () => {
  assert.match(doerReviewerLoopMd, /Doer-reviewer cycle/,
    'doer-reviewer-loop.md must contain doer-reviewer cycle safeguard');
});

// Test 16: Tag switch resume rule is documented
test('doer-reviewer-loop.md documents tag switch requires fresh dispatch', () => {
  assert.match(doerReviewerLoopMd, /Tag switch.*?tags.*?\['doer'\].*?\['reviewer'\]/is,
    'doer-reviewer-loop.md must document tag switch requires fresh dispatch');
});
