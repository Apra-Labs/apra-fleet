/**
 * Tests for widening compose_permissions' role enum to cover deployer,
 * integ-test-runner and regression-test-runner (apra-fleet-ivxi.3).
 *
 * Before this fix, composePermissionsSchema declared
 * role: z.enum(['doer', 'reviewer']), so the MCP tool's public input
 * validation rejected the other three roles outright -- even though
 * bounds-deployer.json, bounds-integ-test-runner.json and
 * bounds-regression-test-runner.json exist (apra-fleet-ivxi.1.1) and the
 * missing-permissions heal path (runner.js) needs to pass exactly those
 * role values. That made the three bounds files unreachable dead files
 * and the heal path fail at input validation.
 */
import { describe, it, expect } from 'vitest';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { composePermissionsSchema, loadBounds } from '../src/tools/compose-permissions.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const profilesDir = path.join(__dirname, '..', 'skills', 'fleet', 'profiles');

describe('composePermissionsSchema role enum (apra-fleet-ivxi.3)', () => {
  const allRoles = ['doer', 'reviewer', 'deployer', 'integ-test-runner', 'regression-test-runner'];

  it.each(allRoles)('accepts role "%s" via the tool\'s public input schema', (role) => {
    const result = composePermissionsSchema.safeParse({ member_id: 'x', role });
    expect(result.success).toBe(true);
  });

  it('still rejects an unrecognised role value', () => {
    const result = composePermissionsSchema.safeParse({ member_id: 'x', role: 'not-a-role' });
    expect(result.success).toBe(false);
  });

  it.each(allRoles)('every role accepted by the schema has a reachable, non-empty bounds-<role>.json', (role) => {
    const parsed = composePermissionsSchema.safeParse({ member_id: 'x', role });
    expect(parsed.success).toBe(true);
    const bounds = loadBounds(profilesDir, role);
    expect(Array.isArray(bounds)).toBe(true);
    expect(bounds.length).toBeGreaterThan(0);
  });
});
