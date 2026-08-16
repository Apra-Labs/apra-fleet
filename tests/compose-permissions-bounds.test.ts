/**
 * Tests for loadBounds() (apra-fleet-ivxi.1.1): the per-role bounds loader
 * used by compose_permissions' upcoming out-of-bounds ledger flagging.
 *
 * loadBounds is plumbing only at this stage -- not yet wired into the grant
 * path (see apra-fleet-ivxi.1.2/.3) -- so these tests exercise it directly
 * rather than through composePermissions().
 */
import { describe, it, expect } from 'vitest';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadBounds } from '../src/tools/compose-permissions.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const profilesDir = path.join(__dirname, '..', 'skills', 'fleet', 'profiles');

describe('loadBounds', () => {
  it('loads the doer bounds profile as a flat array of Bash prefixes', () => {
    const bounds = loadBounds(profilesDir, 'doer');
    expect(Array.isArray(bounds)).toBe(true);
    expect(bounds.length).toBeGreaterThan(0);
    expect(bounds).toContain('Bash(git:*)');
    expect(bounds).toContain('Bash(bd:*)');
  });

  it('loads bounds profiles for every role with a runbook (reviewer, deployer, integ-test-runner, regression-test-runner)', () => {
    for (const role of ['reviewer', 'deployer', 'integ-test-runner', 'regression-test-runner']) {
      const bounds = loadBounds(profilesDir, role);
      expect(Array.isArray(bounds)).toBe(true);
      expect(bounds.length).toBeGreaterThan(0);
    }
  });

  it('returns a defined empty array for an unknown role (never deny-all/undefined)', () => {
    const bounds = loadBounds(profilesDir, 'some-role-that-does-not-exist');
    expect(bounds).toEqual([]);
  });

  it('returns a defined empty array when role is undefined (no-role case)', () => {
    const bounds = loadBounds(profilesDir, undefined);
    expect(bounds).toEqual([]);
  });
});
