import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// apra-fleet-v6t7.4 -- scripts/dist-pm.mjs vendors the current source tree
// into dist/agents (and the other dist/skills, dist/workflows targets) via
// cpSync, which only OVERLAYS an existing destination -- it never deletes a
// destination-only file. That let an orphan survive `npm run dist-pm`
// (reproduced upstream with sprint-doctor-input.json / sprint-doctor-
// output.json left over from a prior checkout of a different branch),
// which meant contracts-schema-dist-staleness-guard.test.mjs's documented
// remediation ("run `npm run dist-pm` to fix it") did not actually fix
// anything for an ONLY-IN-DIST drift. The fix makes dist-pm clear each
// destination tree before copying; this test seeds an orphan file directly
// into dist/agents/schemas, runs the real vendoring script end-to-end, and
// asserts the orphan is gone afterward.

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');
const scriptPath = path.join(repoRoot, 'scripts', 'dist-pm.mjs');
const submoduleAgents = path.join(repoRoot, 'packages', 'apra-fleet-se', 'apra-pm', 'agents');
const distAgentsSchemas = path.join(repoRoot, 'dist', 'agents', 'schemas');

const submoduleSourceAvailable = fs.existsSync(submoduleAgents) && fs.readdirSync(submoduleAgents).length > 0;

describe.skipIf(!submoduleSourceAvailable)('dist-pm.mjs orphan pruning (apra-fleet-v6t7.4)', () => {
  it('removes a destination-only (orphan) file from dist/agents/schemas when re-vendored', () => {
    fs.mkdirSync(distAgentsSchemas, { recursive: true });
    const orphanPath = path.join(distAgentsSchemas, 'sprint-doctor-orphan-regression-fixture.json');
    fs.writeFileSync(orphanPath, '{"orphan": true}', 'utf-8');
    expect(fs.existsSync(orphanPath)).toBe(true);

    execFileSync(process.execPath, [scriptPath], {
      cwd: repoRoot,
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    expect(fs.existsSync(orphanPath)).toBe(false);
    // The real, current schema files must still be present -- this is a
    // prune of destination-only entries, not a wholesale wipe.
    expect(fs.existsSync(distAgentsSchemas)).toBe(true);
    expect(fs.readdirSync(distAgentsSchemas).filter((f) => f.endsWith('.json')).length).toBeGreaterThan(0);
  });
});
