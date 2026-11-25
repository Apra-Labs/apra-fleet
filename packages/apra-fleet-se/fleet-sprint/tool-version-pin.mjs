// =============================================================================
// Engine-side pins for the two tools every beads-touching member runs: bd and
// dolt. The engine cannot import the product's TypeScript pin
// (src/cli/beads-pin.ts), so -- like dolt-settle.mjs's own DOLT_VERSION -- it
// carries its own copy, guarded against drift by test/dolt-settle.test.mjs
// (and by the repo-wide @beads/bd@X.Y.Z specifier scan, which reads the
// BEADS_PACKAGE literal below).
//
// Why major.minor equality (never ">="): a newer bd migrates the shared beads
// remote one way on bootstrap/pull, locking out every older clone, and a bd
// older than the pinned minor silently overwrites on a duplicate
// `bd create --id`. Patch releases inside the pinned minor are accepted.
//
// Dependency-light and pure apart from the DOLT_VERSION re-export.
// =============================================================================

import { DOLT_VERSION } from './dolt-settle.mjs';

/** The npm package specifier the engine supports for bd. Keep the literal form: the repo-wide pin scan reads it. */
export const BEADS_PACKAGE = '@beads/bd@1.3.0';

/** The bd version the engine supports ("1.3.0"), derived from BEADS_PACKAGE. */
export const BEADS_VERSION = BEADS_PACKAGE.slice(BEADS_PACKAGE.lastIndexOf('@') + 1);

/**
 * First bd release believed to fix the conflicted-pull link loss: a plain
 * `bd dolt pull` that hits a merge conflict auto-resolves and commits only the
 * tables it resolved, so cleanly merged tables (dependencies: parent-child and
 * blocks links) keep the local copy and the next push silently reverts other
 * clones' links. Source: the project's operational note for bd 1.3.x, which
 * names 1.4.0 as the fixed version. UNVERIFIED against the beads release notes
 * (not reachable when this was written): until a release is confirmed fixed,
 * every version below this one is treated as affected. Mirrors
 * src/cli/beads-pin.ts BEADS_CONFLICTED_PULL_FIXED_IN; test/dolt-settle.test.mjs
 * fails if the two disagree.
 */
export const BEADS_CONFLICTED_PULL_FIXED_IN = '1.4.0';

/** True when `version` (any text holding x.y.z) is below BEADS_CONFLICTED_PULL_FIXED_IN. Unparseable -> false. */
export function bdConflictedPullAffected(version) {
    const parse = (s) => { const m = /(\d+)\.(\d+)\.(\d+)/.exec(String(s ?? '')); return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null; };
    const v = parse(version);
    const fixed = parse(BEADS_CONFLICTED_PULL_FIXED_IN);
    if (!v) return false;
    for (let i = 0; i < 3; i++) {
        if (v[i] !== fixed[i]) return v[i] < fixed[i];
    }
    return false;
}

/** The warning text (no prefix), same wording as the installer's. */
export function bdConflictedPullWarningText(version) {
    return `bd ${version} is affected by a known issue: a conflicted dolt pull can silently drop parent-child and blocks links (fixed in bd ${BEADS_CONFLICTED_PULL_FIXED_IN}, unverified). Links are verified before push; after any conflicted pull check them (see skills/fleet/beads-conflict-resolution.md).`;
}

/** The dolt pin is dolt-settle.mjs's; re-exported, never duplicated. */
export { DOLT_VERSION };

/**
 * The read-only version probes. Plain words only: they run unchanged under
 * POSIX shells, PowerShell and cmd (no expansion, no quoting).
 */
export const TOOL_VERSION_PROBES = Object.freeze({
    bd: 'bd --version',
    dolt: 'dolt version',
});

/** "1.3.0" from "bd version 1.3.0 (abc)", "dolt version 2.2.0", "v2.2.0"; null when no x.y.z is present. */
export function parseVersionLine(text) {
    const m = /(\d+)\.(\d+)\.(\d+)/.exec(String(text ?? ''));
    return m ? `${Number(m[1])}.${Number(m[2])}.${Number(m[3])}` : null;
}

/** "1.3" from "1.3.0" / "v1.3.0"; null when unparseable. */
export function majorMinor(version) {
    const m = /(\d+)\.(\d+)/.exec(String(version ?? ''));
    return m ? `${Number(m[1])}.${Number(m[2])}` : null;
}

/**
 * Compares a tool's version output against a pin on major.minor.
 * Unparseable output is a mismatch, never a pass.
 *
 * @param {string} output
 * @param {string} pin e.g. '1.3.0' or 'v2.2.0'
 * @returns {{ ok: boolean, found: string, expected: string, parsed: string|null }}
 *   `expected` is the pin's major.minor; `found` the parsed x.y.z or a
 *   description of the unparseable output.
 */
export function checkPinnedVersion(output, pin) {
    const expected = majorMinor(String(pin).replace(/^v/, ''));
    const parsed = parseVersionLine(output);
    if (!parsed) {
        const raw = String(output ?? '').split(/\r?\n/).map((l) => l.trim()).find(Boolean) || '';
        return { ok: false, found: raw ? `unparseable version output "${raw.slice(0, 80)}"` : 'no version output', expected, parsed: null };
    }
    return { ok: majorMinor(parsed) === expected, found: parsed, expected, parsed };
}
