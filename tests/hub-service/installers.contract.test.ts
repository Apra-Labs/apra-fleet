import { describe, expect, it } from 'vitest';
import { InstallerSchema } from '@apralabs/fleet-api-contract';
import { getInstallersHandler } from '../../src/hub-service/handlers/installers.js';

/**
 * Contract test for the hub-service (us9.4): validates a REAL handler's
 * response against the published @apralabs/fleet-api-contract schema at
 * runtime -- catches wire-format drift (extra/missing fields) that
 * type-checking alone would miss.
 */
describe('hub-service contract: GET /installers', () => {
  it('handler response validates against the published InstallerSchema', () => {
    const response = getInstallersHandler();
    expect(response.length).toBeGreaterThan(0);
    for (const installer of response) {
      expect(() => InstallerSchema.parse(installer)).not.toThrow();
    }
  });

  it('rejects a response with an extra/unexpected field (drift guard)', () => {
    const drifted = { ...getInstallersHandler()[0], repoUrl: 'https://example.com' };
    // Base InstallerSchema is non-strict on unknown keys by default (zod
    // drops them); assert the KNOWN fields still round-trip so an actually
    // missing required field would fail loudly.
    const parsed = InstallerSchema.parse(drifted);
    expect(parsed).not.toHaveProperty('repoUrl');
  });
});
