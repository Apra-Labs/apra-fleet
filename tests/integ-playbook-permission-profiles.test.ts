import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

// Guards the contract between integ-test-playbook.md's declared permission
// requirements and the fleet permission profiles that compose_permissions
// actually delivers to members (skills/fleet/profiles/*.json).
//
// Background (sprint apra-fleet-cvb, 2026-08-01): the integ-test-runner was
// blocked in 3 of 4 cycles on fleet-mac because the playbook requires
// Bash(bd *) but no profile ever granted it, so features got closed with
// zero independent verification. The playbook is the single source of truth
// for what the integ-test-runner needs; this test makes the profiles keep up.

const repoRoot = path.resolve(__dirname, '..');
const profilesDir = path.join(repoRoot, 'skills', 'fleet', 'profiles');

function loadProfile(name: string): any {
  return JSON.parse(fs.readFileSync(path.join(profilesDir, `${name}.json`), 'utf-8'));
}

/** Extract the Bash(...) permission examples from the playbook's
 *  "## Permissions" section. */
function playbookRequiredBashPatterns(file = 'integ-test-playbook.md'): string[] {
  const playbook = fs.readFileSync(path.join(repoRoot, file), 'utf-8');
  const section = playbook.split(/^## Permissions$/m)[1]?.split(/^## /m)[0];
  expect(section, `${file} must have a "## Permissions" section`).toBeTruthy();
  const patterns = [...section!.matchAll(/^- .*?`(Bash\([^)]+\))`/gm)].map(m => m[1]);
  expect(patterns.length, 'Permissions section should declare at least one Bash requirement').toBeGreaterThan(0);
  return patterns;
}

/** Normalize a Bash(...) allowlist pattern to its command prefix.
 *  "Bash(npm:*)" -> "npm"; "Bash(bd *)" -> "bd"; "Bash(npm test*)" -> "npm test" */
function commandPrefix(pattern: string): string | null {
  const m = pattern.match(/^Bash\((.+)\)$/);
  if (!m) return null;
  return m[1].replace(/:\*$/, '').replace(/\*$/, '').trim();
}

/** True when `entry` (a profile allowlist pattern) covers the command family
 *  required by `required` (a playbook pattern): the required command prefix
 *  starts at a word boundary with the entry's command prefix. */
function covers(entry: string, required: string): boolean {
  if (entry === required) return true;
  const entryPrefix = commandPrefix(entry);
  const requiredPrefix = commandPrefix(required);
  if (entryPrefix === null || requiredPrefix === null) return false;
  return requiredPrefix === entryPrefix || requiredPrefix.startsWith(`${entryPrefix} `);
}

function composedAllow(base: string, stackKey: 'dev' | 'reviewer'): string[] {
  const baseAllow: string[] = loadProfile(base).permissions.allow;
  const stackAllow: string[] = loadProfile('node')[stackKey] ?? [];
  return [...baseAllow, ...stackAllow];
}

describe('integ-test-playbook.md permission requirements vs fleet profiles', () => {
  const required = playbookRequiredBashPatterns();

  it('declares the four known command families', () => {
    const prefixes = required.map(commandPrefix);
    expect(prefixes).toEqual(expect.arrayContaining(['npm test', 'npm run', 'npx vitest', 'bd']));
  });

  for (const [role, base, stackKey] of [
    ['doer', 'base-dev', 'dev'],
    ['reviewer', 'base-reviewer', 'reviewer'],
  ] as const) {
    it(`composed ${role} profile (${base} + node.${stackKey}) covers every playbook requirement`, () => {
      const allow = composedAllow(base, stackKey);
      for (const req of required) {
        const covered = allow.some(entry => covers(entry, req));
        expect(covered, `${req} is required by integ-test-playbook.md but not covered by any of: ${allow.join(', ')}`).toBe(true);
      }
    });
  }

  it('composed doer profile covers every regression-test-playbook.md requirement', () => {
    const regRequired = playbookRequiredBashPatterns('regression-test-playbook.md');
    const allow = composedAllow('base-dev', 'dev');
    for (const req of regRequired) {
      const covered = allow.some(entry => covers(entry, req));
      expect(covered, `${req} is required by regression-test-playbook.md but not covered by any of: ${allow.join(', ')}`).toBe(true);
    }
  });

  it('bd access comes from the BASE profiles (all roles on all stacks need bd)', () => {
    for (const base of ['base-dev', 'base-reviewer']) {
      const allow: string[] = loadProfile(base).permissions.allow;
      const covered = allow.some(entry => covers(entry, 'Bash(bd *)'));
      expect(covered, `${base}.json must grant bd (beads CLI is required by all fleet-sprint roles)`).toBe(true);
    }
  });
});
