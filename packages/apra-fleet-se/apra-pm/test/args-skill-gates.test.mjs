import { test } from 'node:test';
import assert from 'node:assert/strict';
import { evaluateGates } from '../../../../e2e/lib/validate-sprint.mjs';

const gateNames = (r) => r.gates.map((g) => g.name);
const gate = (r, name) => r.gates.find((g) => g.name === name);

test('evaluateGates: no args-skill gates unless expectArgsSkill is set', () => {
  const r = evaluateGates({ pr: { url: 'u', number: 1 } });
  assert.ok(!gateNames(r).includes('args-skill-installed'));
  assert.ok(!gateNames(r).includes('args-skill-used'));
});

test('evaluateGates: args-skill gates pass when installed AND used', () => {
  const r = evaluateGates({
    pr: { url: 'u', number: 1 }, expectArgsSkill: true,
    argsSkillInstalled: true, argsSkillUsed: true,
  });
  assert.equal(gate(r, 'args-skill-installed').pass, true);
  assert.equal(gate(r, 'args-skill-used').pass, true);
});

test('evaluateGates: args-skill-used fails when the skill was installed but never invoked', () => {
  const r = evaluateGates({
    pr: { url: 'u', number: 1 }, expectArgsSkill: true,
    argsSkillInstalled: true, argsSkillUsed: false,
  });
  assert.equal(gate(r, 'args-skill-installed').pass, true);
  assert.equal(gate(r, 'args-skill-used').pass, false);
  assert.equal(r.pass, false, 'overall must fail when a required gate fails');
});

test('evaluateGates: args-skill gates honor excludeGates', () => {
  const r = evaluateGates({
    pr: { url: 'u', number: 1 }, expectArgsSkill: true,
    argsSkillInstalled: false, argsSkillUsed: false,
    excludeGates: ['args-skill-installed', 'args-skill-used'],
  });
  assert.ok(!gateNames(r).includes('args-skill-installed'));
  assert.ok(!gateNames(r).includes('args-skill-used'));
});
