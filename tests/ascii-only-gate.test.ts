// apra-fleet-oomh.16: wires scripts/check-ascii-only.mjs into root `npm test`
// (via vitest's tests/**/*.test.ts include glob), so a non-ASCII character
// landing in a file the baseline does not already cover fails the suite
// instead of relying on manual review (see apra-fleet-oomh.15, which caught
// commit c2cfc867's two U+2229 characters only by hand).
//
// The behavioural ratchet/shrink/binary-exclusion/self-check assertions live
// in tests/ascii-only-gate-behaviour.test.ts (apra-fleet-oomh.18); this file
// only proves the checker is reachable from root npm test and passes on the
// tree as it stands.

import { describe, it, expect } from 'vitest';
import { runCheck, formatReport } from '../scripts/check-ascii-only.mjs';

describe('ascii-only gate', () => {
    it('the repository as it stands (baseline applied) passes the ASCII-only check', async () => {
        const result = await runCheck();
        expect(result.ok, formatReport(result)).toBe(true);
    });
});
