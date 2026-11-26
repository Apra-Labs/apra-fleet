// Single source of truth for the Beads (bd) npm pin (apra-fleet-i9ag.13.7.2).
//
// bd ships as an npm GLOBAL package, not a standalone release binary -- the
// owner re-scope recorded on apra-fleet-i9ag.13 (which supersedes that bead's
// original description) removed the download-a-release-binary approach and the
// src/cli/beads-install.ts module that used to own this constant. That left
// the pin as a bare literal in src/cli/install.ts while
// packages/apra-fleet-se/apra-pm/install.mjs kept its own copy, i.e. no single
// owner at all -- the exact drift shape that caused apra-fleet-i9ag.12.4 (the
// pm installer pinned 1.1.2 long after the product moved to 1.3.0).
//
// This module is that owner. It is deliberately dependency-free (no imports,
// no side effects) so anything may import it -- the installer, tests, and any
// future status/health reporter -- without dragging in the installer itself.
//
// The unavoidable duplicates are sites that cannot import this TypeScript module:
// packages/apra-fleet-se/apra-pm/install.mjs (plain, build-free Node: node:
// builtins only), .github/e2e/fleet-setup.mjs, and the shell steps and env of
// .github/workflows/ci.yml and pm-e2e.yml. tests/apra-pm-beads-pin.test.ts reads
// every tracked script, source, workflow and markdown file and fails the moment a
// pin there disagrees with this one.

/** The exact @beads/bd version this product installs and supports. */
export const BEADS_VERSION = '1.3.0';

/** The npm package specifier to install -- always built from BEADS_VERSION. */
export const BEADS_PACKAGE = `@beads/bd@${BEADS_VERSION}`;

/**
 * First bd release believed to fix the conflicted-pull link loss: a plain
 * `bd dolt pull` that hits a merge conflict auto-resolves and commits only the
 * tables it resolved, so cleanly merged tables (dependencies: parent-child and
 * blocks links) keep the local copy and the next push silently reverts other
 * clones' links. Source: the project's operational note for bd 1.3.x, which
 * names 1.4.0 as the fixed version. UNVERIFIED against the beads release notes
 * (not reachable when this was written): until a release is confirmed fixed,
 * treat every version below this one as affected. Mirrored in
 * packages/apra-fleet-se/fleet-sprint/tool-version-pin.mjs (the engine cannot
 * import this module); test/dolt-settle.test.mjs fails if the two disagree.
 */
export const BEADS_CONFLICTED_PULL_FIXED_IN = '1.4.0';

/** True when `version` ("1.3.0", "bd version 1.3.0 (abc)") is below BEADS_CONFLICTED_PULL_FIXED_IN. Unparseable -> false. */
export function bdConflictedPullAffected(version: string | null | undefined): boolean {
  const parse = (s: string) => /(\d+)\.(\d+)\.(\d+)/.exec(s)?.slice(1, 4).map(Number);
  const v = parse(String(version ?? ''));
  const fixed = parse(BEADS_CONFLICTED_PULL_FIXED_IN)!;
  if (!v) return false;
  for (let i = 0; i < 3; i++) {
    if (v[i] !== fixed[i]) return v[i] < fixed[i];
  }
  return false;
}

/** The one warning line (no prefix) shared by the installer; the engine carries the same wording. */
export function bdConflictedPullWarningText(version: string): string {
  return `bd ${version} is affected by a known issue: a conflicted dolt pull can silently drop parent-child and blocks links (fixed in bd ${BEADS_CONFLICTED_PULL_FIXED_IN}, unverified). Links are verified before push; after any conflicted pull check them (see skills/fleet/beads-conflict-resolution.md).`;
}
