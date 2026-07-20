/**
 * Integration test for scripts/gen-sea-config.mjs -- the standalone build
 * script that scans hooks/, scripts/, skills/, and vendor/apra-pm/ and writes
 * dist/sea-manifest.json (baked into the SEA binary at build time).
 *
 * Runs the real script against the real vendor/apra-pm submodule checkout
 * (no mocking -- this script has no exported functions to unit test, and its
 * only job is to describe what's actually on disk). Guards against
 * regressions like the GAP A bug: a nested-directory walker that silently
 * drops agents/schemas/ and agents/_shared/, or omits the auto-sprint-args
 * skill from the manifest entirely.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { execFileSync } from 'node:child_process';
import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';

const root = path.resolve(__dirname, '..');
const manifestPath = path.join(root, 'dist', 'sea-manifest.json');

describe('gen-sea-config.mjs -- generated SEA manifest', () => {
  let manifest: {
    agents: Record<string, string>;
    autoSprintArgsSkill: Record<string, string>;
    skills: Record<string, string>;
  };

  beforeAll(() => {
    if (!existsSync(path.join(root, 'vendor', 'apra-pm', 'agents'))) {
      throw new Error('vendor/apra-pm submodule is not initialized -- run: git submodule update --init');
    }
    execFileSync('node', ['scripts/gen-sea-config.mjs'], { cwd: root, stdio: 'pipe' });
    manifest = JSON.parse(readFileSync(manifestPath, 'utf-8'));
  });

  it('includes agents/schemas/*.json role I/O contracts', () => {
    const schemaKeys = Object.keys(manifest.agents).filter(k => k.startsWith('schemas/') && k.endsWith('.json'));
    expect(schemaKeys.length).toBeGreaterThan(0);
    expect(schemaKeys).toContain('schemas/doer-output.json');
  });

  it('includes agents/_shared/GRAPH-SEMANTICS.md', () => {
    expect(Object.keys(manifest.agents)).toContain('_shared/GRAPH-SEMANTICS.md');
  });

  it('includes the auto-sprint-args skill file collection', () => {
    const keys = Object.keys(manifest.autoSprintArgsSkill);
    expect(keys.length).toBeGreaterThan(0);
    expect(keys).toContain('SKILL.md');
  });

  it('still includes plain role-agent files alongside the nested ones', () => {
    expect(Object.keys(manifest.agents)).toContain('doer.md');
    expect(Object.keys(manifest.agents)).toContain('planner.md');
  });
});
