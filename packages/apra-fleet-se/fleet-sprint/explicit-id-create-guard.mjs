import fs from 'fs';
import path from 'path';
import { findCallSites } from './dispatch-safety-guard.mjs';
import { explicitIdCreateModulePaths, EXPLICIT_ID_CREATE_EXEMPT } from './guarded-modules.mjs';

// =============================================================================
// apra-fleet-btj9.7 -- explicit-id-create guard checker.
//
// Invariant under test: no scanned `command(...)` call site may dispatch a
// bead-creation command that carries an explicit id flag unless it lives in
// beads-children.mjs -- the single module that pairs an explicit-id create
// with the probe-and-refuse seam (assertChildIdFree(), called from
// createChildBeadWithAllocatedId) that guards against `bd create`'s silent
// overwrite-on-collision behavior (apra-fleet-btj9). A second, unguarded
// explicit-id create site anywhere else in this directory is exactly how that
// overwrite bug returns, so this is a mechanical scan -- same shape as the
// sibling guards -- rather than a call-graph proof that assertChildIdFree()
// actually ran first.
//
// CALL-SITE EXTRACTION REUSES dispatch-safety-guard.mjs's findCallSites()
// (that file's own header names it "the reference implementation the sibling
// guards follow"), rather than a naive per-line quote-stopping scan: a real
// `bd create "<title>" --body-file "<path>" --id <id> --silent` command
// literal has an inner quoted title BETWEEN "bd create" and the id flag, so a
// scan that stops at the first quote after "bd create" (the technique
// dolt-literal-guard.mjs/full-db-fetch-guard.mjs use, safe for THEIR simpler
// command shapes) would silently miss the id flag entirely. findCallSites()
// already extracts the FULL balanced call text -- including embedded quotes
// -- for every `command(`/`agent(` site, and already skips full-line
// comments and same-line-string false positives, so this guard reuses it
// rather than re-deriving that logic.
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

// Matches a bead-creation subcommand followed, anywhere later in the same
// balanced call text, by an explicit id flag. `[\s\S]*?` (not `.*`) so it
// spans the embedded quoted title/body-file arguments a real create command
// carries between the subcommand and the id flag. Written as `bd` + `\s+` +
// `create` and `-{2}id` (never a literal space between "bd"/"create", never a
// literal "--id") so this guard's own definition line can never match itself.
const EXPLICIT_ID_CREATE_RE = /bd\s+create\b[\s\S]*?(?:^|\s)-{2}id(?:\s|$)/;

/**
 * Scans `src` for `command(...)` call sites whose full balanced call text
 * carries a bead-creation subcommand together with an explicit id flag.
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
        `${fileLabel}:${line} issues a bead-creation command with an explicit id flag ("${command}") outside the ` +
        `single guarded probe-and-refuse seam -- route it through beads-children.mjs's assertChildIdFree() / ` +
        'createChildBeadWithAllocatedId, the only permitted explicit-id create surface.'
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
