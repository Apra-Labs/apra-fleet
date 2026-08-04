/**
 * Guards the dev-mode asset manifest that gates the workflow subsystem
 * install (`apra-fleet install` -> extractWorkflowSubsystemAssets).
 *
 * This is a GUARD, not a fix: the paths are already correct on main. It exists
 * because this class of breakage was observed for real on a pre-bd01665 tree,
 * where buildDevManifest() still located agent schemas at
 * vendor/apra-pm/agents/schemas -- a submodule retired when apra-pm moved to
 * packages/apra-fleet-se/apra-pm/. That path has no fallback, so agentSchemas
 * silently stayed undefined; hasWorkflowSubsystemAssets() requires ALL THREE
 * sections, so the install warned and returned before creating
 * ~/.apra-fleet/workflows/ at all. The install still printed success and
 * recorded workflowsMode:"all", leaving `apra-fleet workflow fleet-sprint`
 * dead with "No workflows installed" -- a total failure with no failing exit
 * code anywhere. Nothing prevents the next directory move from doing it again,
 * which is what these assertions are for.
 *
 * These assertions run against the real checkout rather than a fixture,
 * because the bug is precisely that a real directory moved and a hardcoded
 * path did not follow. A mocked filesystem would have happily passed.
 */
import { describe, it, expect } from 'vitest';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { buildDevManifest } from '../src/cli/install.js';
import { hasWorkflowSubsystemAssets } from '../src/cli/workflow-assets.js';

const root = path.resolve(__dirname, '..');

describe('buildDevManifest -- workflow subsystem sections', () => {
  it('carries all three sections, so the workflow install is not skipped', () => {
    const manifest = buildDevManifest(root);

    // Report which section is missing rather than a bare false.
    const present = {
      workflowRuntime: !!manifest.workflowRuntime,
      agentSchemas: !!manifest.agentSchemas,
      builtinWorkflows: !!manifest.builtinWorkflows,
    };
    expect(present).toEqual({
      workflowRuntime: true,
      agentSchemas: true,
      builtinWorkflows: true,
    });

    expect(hasWorkflowSubsystemAssets(manifest)).toBe(true);
  });

  it('resolves agent schemas to real files at apra-pm\'s current location', () => {
    const manifest = buildDevManifest(root);
    const entries = Object.entries(manifest.agentSchemas ?? {});
    expect(entries.length).toBeGreaterThan(0);

    // Every manifest value is a repo-relative path; a stale directory would
    // yield entries pointing at files that do not exist.
    const missing = entries
      .filter(([, relPath]) => !existsSync(path.join(root, relPath)))
      .map(([key]) => key);
    expect(missing).toEqual([]);
  });

  it('references no retired vendor/apra-pm paths', () => {
    // The submodule is gone; any manifest entry still rooted there is stale
    // by construction.
    const manifest = buildDevManifest(root);
    const allPaths = [
      ...Object.values(manifest.agentSchemas ?? {}),
      ...Object.values(manifest.builtinWorkflows ?? {}),
      ...Object.values(manifest.workflowRuntime ?? {}),
    ];
    expect(allPaths.filter((p) => p.includes('vendor/apra-pm'))).toEqual([]);
    expect(existsSync(path.join(root, 'vendor', 'apra-pm'))).toBe(false);
  });
});
