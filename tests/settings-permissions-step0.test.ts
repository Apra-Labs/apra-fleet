/**
 * Verifies apra-fleet-3ik.1: .claude/settings.json's permissions.allow
 * covers every Bash(...) prefix required by integ-test-playbook.md's and
 * regression-test-playbook.md's '## Permissions' sections -- i.e. that a
 * dry run of regression-test-runner.md's/integ-test-runner.md's Step
 * 0/0a permission gate would not stop on a missing permission.
 *
 * apra-fleet-3ik (2026-07-31): a live regression-test-runner dry run found
 * .claude/settings.json with zero permissions.allow entries, which would
 * have stopped Step 0 immediately in an unsupervised dispatch. apra-fleet-
 * 3ik.1 fixed the local file; this test formalizes the check so a future
 * regression is caught rather than only ever discovered by a live dry run.
 *
 * .claude/settings.json is gitignored, machine-local operator config (see
 * .gitignore) -- it is not committed and will not exist on a fresh clone or
 * CI runner that has never dispatched a fleet role. The coverage assertions
 * below only run when the file is actually present (this dev checkout has
 * one); the pure parsing/coverage-logic unit tests always run regardless.
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import {
  repoRoot,
  extractRequiredBashPrefixes,
  commandPrefix,
  covers,
  checkSettingsPermissions,
} from '../scripts/check-settings-permissions.mjs';

const settingsPath = path.join(repoRoot, '.claude', 'settings.json');
const playbookPaths = [
  path.join(repoRoot, 'integ-test-playbook.md'),
  path.join(repoRoot, 'regression-test-playbook.md'),
];
const settingsExists = fs.existsSync(settingsPath);

describe('check-settings-permissions -- coverage logic (framework, always runs)', () => {
  it('extracts Bash(...) prefixes from a Permissions section', () => {
    const text = [
      '## Permissions',
      '',
      '- `Bash(npm test*)`',
      '- `Bash(bd *)` (for reporting)',
      '',
      '## Next section',
      '- `Bash(should not be picked up)`',
    ].join('\n');
    expect(extractRequiredBashPrefixes(text)).toEqual(['Bash(npm test*)', 'Bash(bd *)']);
  });

  it('commandPrefix normalizes :* and * suffixes', () => {
    expect(commandPrefix('Bash(npm:*)')).toBe('npm');
    expect(commandPrefix('Bash(bd *)')).toBe('bd');
    expect(commandPrefix('Bash(npm test*)')).toBe('npm test');
    expect(commandPrefix('Read')).toBeNull();
  });

  it('covers() treats exact matches and broader prefixes as coverage', () => {
    expect(covers('Bash(node:*)', 'Bash(node scripts/sandbox-lock.mjs *)')).toBe(true);
    expect(covers('Bash(bd *)', 'Bash(bd *)')).toBe(true);
    expect(covers('Bash(npm:*)', 'Bash(npm test*)')).toBe(true);
    // A narrower allow entry does not cover a broader/different requirement.
    expect(covers('Bash(node dist/index.js *)', 'Bash(node scripts/sandbox-lock.mjs *)')).toBe(false);
    expect(covers('Bash(git:*)', 'Bash(bd *)')).toBe(false);
  });

  it('flags a missing settings.json file as a structural error, not a silent pass', () => {
    const result = checkSettingsPermissions({
      settingsPath: path.join(repoRoot, 'DOES-NOT-EXIST-settings.json'),
      playbookPaths,
    });
    expect(result.ok).toBe(false);
    expect(result.errors.some(e => e.includes('does not exist'))).toBe(true);
    // Every required prefix is reported as missing when it cannot be verified.
    expect(result.missing.length).toBeGreaterThan(0);
  });

  it('flags a settings.json with no permissions.allow array (the exact apra-fleet-3ik symptom)', () => {
    const tmpFile = path.join(repoRoot, `.tmp-3ik2-settings-${process.pid}.json`);
    fs.writeFileSync(tmpFile, JSON.stringify({ attribution: { commit: '', pr: '' } }));
    try {
      const result = checkSettingsPermissions({ settingsPath: tmpFile, playbookPaths });
      expect(result.ok).toBe(false);
      expect(result.errors.some(e => e.includes('permissions.allow'))).toBe(true);
    } finally {
      fs.unlinkSync(tmpFile);
    }
  });

  it('names every uncovered prefix (not just the fact that some are missing)', () => {
    const tmpSettings = path.join(repoRoot, `.tmp-3ik2-settings-partial-${process.pid}.json`);
    const tmpPlaybook = path.join(repoRoot, `.tmp-3ik2-playbook-partial-${process.pid}.md`);
    fs.writeFileSync(tmpSettings, JSON.stringify({ permissions: { allow: ['Bash(bd:*)'] } }));
    fs.writeFileSync(tmpPlaybook, [
      '## Permissions',
      '- `Bash(node scripts/x.mjs *)`',
      '- `Bash(bd *)`',
      '- `Bash(docker *)`',
    ].join('\n'));
    try {
      const result = checkSettingsPermissions({ settingsPath: tmpSettings, playbookPaths: [tmpPlaybook] });
      expect(result.ok).toBe(false);
      expect(result.errors).toEqual([]);
      expect(result.missing.sort()).toEqual(['Bash(docker *)', 'Bash(node scripts/x.mjs *)'].sort());
      // The covered one must not be reported as missing.
      expect(result.missing).not.toContain('Bash(bd *)');
    } finally {
      fs.unlinkSync(tmpSettings);
      fs.unlinkSync(tmpPlaybook);
    }
  });

  it('passes when a synthetic settings.json covers every synthetic required prefix', () => {
    const tmpSettings = path.join(repoRoot, `.tmp-3ik2-settings-ok-${process.pid}.json`);
    const tmpPlaybook = path.join(repoRoot, `.tmp-3ik2-playbook-${process.pid}.md`);
    fs.writeFileSync(tmpSettings, JSON.stringify({ permissions: { allow: ['Bash(node:*)', 'Bash(bd:*)'] } }));
    fs.writeFileSync(tmpPlaybook, [
      '## Permissions',
      '- `Bash(node scripts/x.mjs *)`',
      '- `Bash(bd *)`',
    ].join('\n'));
    try {
      const result = checkSettingsPermissions({ settingsPath: tmpSettings, playbookPaths: [tmpPlaybook] });
      expect(result.ok).toBe(true);
      expect(result.missing).toEqual([]);
      expect(result.errors).toEqual([]);
    } finally {
      fs.unlinkSync(tmpSettings);
      fs.unlinkSync(tmpPlaybook);
    }
  });
});

describe.skipIf(!settingsExists)(
  'check-settings-permissions -- live .claude/settings.json vs integ/regression playbooks (apra-fleet-3ik.2)',
  () => {
    it('.claude/settings.json parses as valid JSON', () => {
      expect(() => JSON.parse(fs.readFileSync(settingsPath, 'utf-8'))).not.toThrow();
    });

    it('every Bash(...) prefix required by both playbooks is covered (PASS = zero uncovered prefixes)', () => {
      const result = checkSettingsPermissions({ settingsPath, playbookPaths });
      expect(
        result.ok,
        `Uncovered required permission prefixes (regression-test-runner.md/integ-test-runner.md Step 0/0a ` +
          `would stop here): ${result.missing.join(', ')}`
      ).toBe(true);
      expect(result.missing).toEqual([]);
      expect(result.errors).toEqual([]);
    });

    it('a dry run of regression-test-runner.md Step 0 alone does not stop on a missing permission', () => {
      const result = checkSettingsPermissions({
        settingsPath,
        playbookPaths: [path.join(repoRoot, 'regression-test-playbook.md')],
      });
      expect(result.ok, `regression-test-runner.md Step 0 would stop on: ${result.missing.join(', ')}`).toBe(true);
    });
  }
);

describe.skipIf(settingsExists)(
  'check-settings-permissions -- .claude/settings.json not present in this environment',
  () => {
    it('is a no-op skip (gitignored machine-local config, expected absent on fresh clones/CI)', () => {
      expect(settingsExists).toBe(false);
    });
  }
);
