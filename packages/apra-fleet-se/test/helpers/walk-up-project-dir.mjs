// What a WALK-UP boot actually resolves from a given cwd, on THIS host.
//
// WHY THIS EXISTS: the walk-up (discoverBeadsDir() in
// src/supervisor/beads-identity.mjs) climbs to the filesystem root, so a
// fixture built under os.tmpdir() is only hermetic while no ANCESTOR of the
// temp dir happens to hold a `.beads`. That assumption holds on every POSIX
// CI runner and dev box, and does NOT hold on a Windows runner: there
// os.tmpdir() lives inside the user profile
// (C:\Users\<user>\AppData\Local\Temp), so a `.beads` anywhere in that
// profile is an ancestor of every fixture folder such a suite can create.
//
// windows-latest CI hit exactly that: a walk-up boot from
// <tmp>\apra-fleet-projdir-XXX\noBeads reported C:\Users\runneradmin. The
// product was right -- serve.mjs deliberately reports the folder the walk-up
// FOUND rather than the cwd it started from -- and the fixture's "it must be
// the cwd I passed" expectation was what could not be true there.
//
// These helpers let such an expectation be stated as "whatever the walk-up
// legitimately resolves here", while the PROPERTY that a walk-up reports the
// found root rather than its starting cwd stays asserted hermetically by the
// fixtures that put a `.beads` INSIDE the temp root (a cwd in
// projB/src/nested resolving to projB) -- no ancestor can influence those,
// so they keep their exact expectations.
//
// ASCII only.

import path from 'node:path';

import { discoverBeadsDir } from '../../src/supervisor/beads-identity.mjs';

/**
 * The project folder a walk-up boot started in `cwd` reports: the root of
 * the nearest `.beads` at or above it, or `cwd` itself when there is none.
 * Mirrors bin/serve.mjs's WALK_UP branch.
 * @param {string} cwd
 * @returns {string}
 */
export function expectedWalkUpProjectDir(cwd) {
    const found = discoverBeadsDir({ cwd });
    return found ? found.repoRoot : path.resolve(cwd);
}

/**
 * The `.beads`-bearing folder a walk-up from `cwd` finds OUTSIDE `boundary`
 * (the fixture's own temp root) -- i.e. host pollution the fixture cannot
 * control -- or `null` when the fixture is hermetic, which is the usual
 * case. A test uses this to skip only the assertions that such an ancestor
 * genuinely invalidates (a beads identity resolving where the fixture
 * intended none), rather than weakening the whole case everywhere.
 * @param {string} cwd
 * @param {string} boundary
 * @returns {string|null}
 */
export function hostBeadsAncestor(cwd, boundary) {
    const found = discoverBeadsDir({ cwd });
    if (!found) return null;
    const rel = path.relative(path.resolve(boundary), found.repoRoot);
    const insideFixture = rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
    return insideFixture ? null : found.repoRoot;
}
