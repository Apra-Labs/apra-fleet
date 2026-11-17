import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { mapAccessLevel } from '../src/services/github-app.js';

/**
 * Cross-check for the ONE hand-maintained copy of mapAccessLevel()'s
 * workflows-permission table (apra-fleet-rp7a.4 item 5).
 *
 * The fleet-sprint engine's Sync-step preflight decides whether a member's
 * minted credential will carry GitHub's 'workflows' permission -- the
 * permission without which any push touching .github/workflows/** is rejected
 * -- from its OWN local set, GITHUB_ACCESS_LEVELS_WITH_WORKFLOWS in
 * packages/apra-fleet-se/fleet-sprint/vcs-auth.mjs. That copy is deliberate:
 * fleet-sprint is the generic engine (docs/generic-engine-boundary.md) and a
 * sprint can target any fleet server, so it must not import server internals.
 *
 * But a copy cannot catch a regression in the thing it copies. Change
 * mapAccessLevel() (add a level, move 'workflows' on or off one) and the
 * engine's set silently disagrees: the preflight then either stays quiet for a
 * member that WILL be rejected, or cries wolf at one that will not. This test
 * is the guard that makes the copy safe -- it reads both halves from their
 * real sources (never a fixture) and asserts they agree exactly, so the two
 * can only be edited together.
 *
 * Reads only; writes nothing.
 */

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');

const VCS_AUTH_PATH = path.join(repoRoot, 'packages', 'apra-fleet-se', 'fleet-sprint', 'vcs-auth.mjs');
const GITHUB_APP_PATH = path.join(repoRoot, 'src', 'services', 'github-app.ts');

/** The levels named in the engine's local GITHUB_ACCESS_LEVELS_WITH_WORKFLOWS literal. */
function engineWorkflowsLevels(): Set<string> {
  const src = fs.readFileSync(VCS_AUTH_PATH, 'utf8');
  const marker = 'const GITHUB_ACCESS_LEVELS_WITH_WORKFLOWS = new Set([';
  const start = src.indexOf(marker);
  expect(start, `${marker} not found in ${VCS_AUTH_PATH} -- the engine-side copy was renamed or removed; update this guard with it`).not.toBe(-1);
  const end = src.indexOf(']);', start);
  expect(end, 'unterminated GITHUB_ACCESS_LEVELS_WITH_WORKFLOWS literal').not.toBe(-1);
  const body = src.slice(start + marker.length, end);
  return new Set([...body.matchAll(/'([^']+)'/g)].map(m => m[1]));
}

/** Every level key declared in mapAccessLevel()'s own `levels` table. */
function serverAccessLevelNames(): string[] {
  const src = fs.readFileSync(GITHUB_APP_PATH, 'utf8');
  const marker = 'const levels: Record<string, Record<string, string>> = {';
  const start = src.indexOf(marker);
  expect(start, `${marker} not found in ${GITHUB_APP_PATH} -- mapAccessLevel()'s table was restructured; update this guard with it`).not.toBe(-1);
  const end = src.indexOf('\n  };', start);
  expect(end, "unterminated mapAccessLevel() 'levels' table").not.toBe(-1);
  const body = src.slice(start + marker.length, end);
  // Each entry is a single line: `    read: { ... },` or `    'push+pr': { ... },`
  return [...body.matchAll(/^\s{4}'?([\w+-]+)'?:\s*\{/gm)].map(m => m[1]);
}

describe("fleet-sprint's workflows-permission table mirrors mapAccessLevel()", () => {
  it('finds both tables at their documented locations', () => {
    expect(serverAccessLevelNames().length).toBeGreaterThan(0);
    expect(engineWorkflowsLevels().size).toBeGreaterThan(0);
  });

  it("names exactly the access levels mapAccessLevel() grants workflows:'write' for", () => {
    const granting = serverAccessLevelNames().filter(level => mapAccessLevel(level).workflows === 'write');
    expect([...engineWorkflowsLevels()].sort()).toEqual([...granting].sort());
  });

  it("omits every access level mapAccessLevel() does NOT grant 'workflows' for", () => {
    const engine = engineWorkflowsLevels();
    const nonGranting = serverAccessLevelNames().filter(level => mapAccessLevel(level).workflows === undefined);
    // Non-empty by construction: 'read' and 'issues' are code-read /
    // collaboration levels that never request 'workflows'. If this list ever
    // empties, the preflight has nothing left to warn about and the check
    // above would pass vacuously.
    expect(nonGranting.length).toBeGreaterThan(0);
    for (const level of nonGranting) {
      expect(engine.has(level), `level '${level}' does not carry 'workflows' server-side but fleet-sprint's set claims it does`).toBe(false);
    }
  });
});
