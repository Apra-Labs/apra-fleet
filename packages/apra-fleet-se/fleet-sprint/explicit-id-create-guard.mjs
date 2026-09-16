import fs from 'fs';
import path from 'path';
import { findCallSites } from './dispatch-safety-guard.mjs';
import { explicitIdCreateModulePaths, EXPLICIT_ID_CREATE_EXEMPT } from './guarded-modules.mjs';

// =============================================================================
// apra-fleet-btj9.7 -- explicit-id-create guard checker.
//
// Invariant under test: no scanned `command(...)` call site may dispatch a
// bead-CREATION command (`bd create`, of ANY shape) unless it lives in
// beads-children.mjs -- the single module that pairs an explicit-id create
// with the probe-and-refuse seam (assertChildIdFree(), called from
// createChildBeadWithAllocatedId) that guards against `bd create`'s silent
// overwrite-on-collision behavior (apra-fleet-btj9). A second, unguarded
// bead-creation site anywhere else in this directory is exactly how that
// overwrite bug returns, so this is a mechanical scan -- same shape as the
// sibling guards -- rather than a call-graph proof that assertChildIdFree()
// actually ran first.
//
// RULE WIDENED PAST "carries a literal --id flag" (review round on this
// bead): the first cut of this guard matched `bd create` only when an
// explicit `--id` flag flag literal appeared LATER in the same balanced call
// text. That misses the one real call site's own shape --
// beads-children.mjs:287's `bd create "${title}" --body-file
// "${descriptionFile}" -p "${priority}" ${parentageFlags} --silent`, where
// the id flag is assembled into `parentageFlags` (`--id ${grant.childId}`)
// and never appears as literal text inside the command() call itself. A
// second, unguarded module that copies exactly that shape -- an interpolated
// flags variable in the create's flag position -- would scan clean under the
// literal-`--id` regex. Rather than try to chase every way an id flag can be
// assembled through a variable (an open-ended, unwinnable text-matching
// problem), this guard flags ANY `bd create` command() site outside the one
// exempt module, regardless of whether an id flag is literal, interpolated,
// or absent entirely. This is deliberately broader than "carries an explicit
// id": a census of every `command(`/`agent(` call site across the full
// GUARDED_MODULES set (this bead's own planning pass, re-verified while
// fixing this gap) found EXACTLY ONE `bd create` dispatch in the entire set
// -- beads-children.mjs:287 -- so today this widening has zero false
// positives, and it closes the interpolated-flag hole completely instead of
// leaving a narrower one of the same shape.
//
// CALL-SITE EXTRACTION REUSES dispatch-safety-guard.mjs's findCallSites()
// (that file's own header names it "the reference implementation the sibling
// guards follow"), rather than a naive per-line quote-stopping scan: a real
// `bd create "<title>" --body-file "<path>" --id <id> --silent` command
// literal has an inner quoted title BETWEEN "bd create" and the id flag, so a
// scan that stops at the first quote after "bd create" (the technique
// dolt-literal-guard.mjs/full-db-fetch-guard.mjs use, safe for THEIR simpler
// command shapes) would silently miss it. findCallSites() already extracts
// the FULL balanced call text -- including embedded quotes -- for every
// `command(`/`agent(` site, and already skips full-line comments and
// same-line-string false positives, so this guard reuses it rather than
// re-deriving that logic.
//
// Two carve-outs, mirroring the sibling guards in this directory:
//   - Only `command(` sites are considered; `agent(` never dispatches a bd
//     command.
//   - beads-children.mjs itself (EXPLICIT_ID_CREATE_EXEMPT), the single
//     permitted surface -- scanning it would flag the module for being the
//     module, same precedent as DOLT_LITERAL_EXEMPT/dolt-sync.mjs and
//     UNBRACKETED_PUSH_EXEMPT/git-sync.mjs.
//
// MODULE-LIST GENERALIZATION: this guard is not pointed at a single
// hard-coded file. checkExplicitIdCreateModules() below reads the SHARED
// guarded-module list (./guarded-modules.mjs), filtered through
// EXPLICIT_ID_CREATE_EXEMPT, and defines no list of its own.
// checkExplicitIdCreatePath() remains exported and behaves exactly as
// before for a single file (a fixture, or beads-children.mjs itself when a
// caller deliberately wants its own violations, none expected).
// =============================================================================

// Matches a bead-creation subcommand ANYWHERE in the balanced call text --
// deliberately not conditioned on an explicit id flag appearing later (see
// "RULE WIDENED" above): the one real call site assembles its id flag into
// an interpolated variable that never appears as literal `--id` text inside
// the command() call, so requiring a literal id flag would miss the exact
// shape a copy-paste of that site produces. Written as `bd` + `\s+` +
// `create` (never a literal space between "bd" and "create") so this guard's
// own definition line can never match itself.
const EXPLICIT_ID_CREATE_RE = /bd\s+create\b/;

/**
 * Scans `src` for `command(...)` call sites whose full balanced call text
 * carries a bead-creation subcommand (`bd create`, any shape -- see the
 * module header for why this is not conditioned on a literal `--id` flag).
 * Returns an array of { line, command } for every violating call site.
 */
export function findExplicitIdCreateViolations(src) {
    const sites = findCallSites(src);
    const violations = [];
    for (const site of sites) {
        if (site.fnName !== 'command') continue;
        if (!EXPLICIT_ID_CREATE_RE.test(site.callText)) continue;
        violations.push({ line: site.line, command: site.callText.replace(/\s+/g, ' ').trim() });
    }
    return violations;
}

/**
 * Reads and scans the source file at `filePath`, returning { violations },
 * each entry a human-readable message naming the offending file:line and
 * pointing at the single permitted surface.
 */
export function checkExplicitIdCreatePath(filePath) {
    const src = fs.readFileSync(filePath, 'utf8');
    const fileLabel = path.basename(filePath);
    const violations = findExplicitIdCreateViolations(src).map(({ line, command }) =>
        `${fileLabel}:${line} issues a bead-creation command ("${command}") outside the single guarded ` +
        `probe-and-refuse seam -- route it through beads-children.mjs's assertChildIdFree() / ` +
        'createChildBeadWithAllocatedId, the only permitted bead-creation surface. Flagged regardless of ' +
        'whether an id flag is literal, interpolated, or absent (see this module\'s header).'
    );
    return { violations };
}

/**
 * Aggregate entry point: scans every module in the SHARED guarded-module list
 * (./guarded-modules.mjs), MINUS EXPLICIT_ID_CREATE_EXEMPT, and returns the
 * union of their violations. Follows checkDoltLiteralModules()/
 * checkUnbracketedPushModules() -- the reference implementations for a
 * single-permitted-surface exemption -- so a create call that moves out of
 * beads-children.mjs into a newly extracted module stays covered instead of
 * silently falling out of scan scope.
 *
 * @param {string[]} [paths]
 * @returns {{ violations: string[], files: string[], skipped: string[] }}
 */
export function checkExplicitIdCreateModules(paths = explicitIdCreateModulePaths()) {
    if (!Array.isArray(paths)) {
        throw new TypeError('checkExplicitIdCreateModules(paths): paths must be an array of file paths');
    }
    const violations = [];
    const files = [];
    const skipped = [];
    for (const p of paths) {
        const file = path.basename(p);
        if (EXPLICIT_ID_CREATE_EXEMPT.includes(file)) {
            skipped.push(file);
            continue;
        }
        files.push(file);
        violations.push(...checkExplicitIdCreatePath(p).violations);
    }
    return { violations, files, skipped };
}
