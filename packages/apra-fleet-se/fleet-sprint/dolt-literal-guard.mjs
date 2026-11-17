import fs from 'fs';
import path from 'path';
import { doltLiteralModulePaths, DOLT_LITERAL_EXEMPT } from './guarded-modules.mjs';

// =============================================================================
// apra-fleet-417.2.3 -- dolt-literal guard checker.
//
// Invariant under test: NO source line in a scanned file may issue a direct
// `bd dolt pull` or `bd dolt push` command -- every dolt sync call must go
// through ./dolt-sync.mjs (the single permitted dolt command surface,
// apra-fleet-417.2.1/417.2.2). This is a mechanical, line-based scan, not a
// call-site parse: dolt-sync.mjs itself legitimately builds these exact
// command strings (that IS the sync module), so this guard is only ever
// pointed at OTHER files (runner.js in production; a throwaway fixture in
// this file's own tests) -- it is not meant to be run against dolt-sync.mjs.
//
// Two carve-outs, mirroring how runner.js already talks about dolt sync
// without issuing it directly:
//   - Full-line comments (a line whose trimmed text starts with `//`, `*` or
//     `/*`) -- prose that merely MENTIONS `bd dolt pull`/`bd dolt push`
//     (e.g. explaining what the sync module does) is not a violation.
//   - `import`/`require` lines referencing the sync module (dolt-sync.mjs) --
//     so a line like `import { doltPullBefore } from './dolt-sync.mjs'` is
//     never itself flagged.
// Anything else -- a live command()/template-literal/string containing the
// literal substring -- is a violation: the sync module must be called by its
// exported entry points, never re-inlined.
//
// MODULE-LIST GENERALIZATION: this guard is no longer pointed at a single
// hard-coded file. checkDoltLiteralModules() below reads the SHARED
// guarded-module list (./guarded-modules.mjs) -- the one place a newly
// extracted fleet-sprint module is registered -- and defines no list of its
// own. The dolt-sync.mjs carve-out described above is now MECHANICALLY
// enforced there (DOLT_LITERAL_EXEMPT) rather than left to whoever wires up
// the call. checkDoltLiteralPath() remains exported and behaves exactly as
// before.
// =============================================================================

const DOLT_LITERAL_RE = /\bbd dolt (pull|push)\b/;

function isCommentLine(text) {
    const trimmed = text.trim();
    return trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('/*');
}

function isSyncModuleReference(text) {
    return /\b(import|require)\b/.test(text) && /dolt-sync(\.mjs)?/.test(text);
}

/**
 * Scans `src` for direct `bd dolt pull` / `bd dolt push` literals, skipping
 * full-line comments and import/require lines that reference the sync
 * module. Returns an array of { line, text } for every violating line.
 */
export function findDoltLiteralViolations(src) {
    const lines = src.split('\n');
    const violations = [];
    for (let i = 0; i < lines.length; i++) {
        const text = lines[i];
        if (!DOLT_LITERAL_RE.test(text)) continue;
        if (isCommentLine(text)) continue;
        if (isSyncModuleReference(text)) continue;
        violations.push({ line: i + 1, text: text.trim() });
    }
    return violations;
}

/**
 * Reads and scans the source file at `filePath`, returning { violations },
 * each entry formatted as a human-readable message naming the offending
 * file:line and pointing at ./dolt-sync.mjs as the required entry point.
 */
export function checkDoltLiteralPath(filePath) {
    const src = fs.readFileSync(filePath, 'utf8');
    const fileLabel = path.basename(filePath);
    // The single-surface rule this message enforces was established by
    // apra-fleet-417.2.1/417.2.2 (dolt command consolidation into
    // ./dolt-sync.mjs). Provenance stays in this comment: the message itself
    // is runtime output and must not cite a tracker id.
    const violations = findDoltLiteralViolations(src).map(({ line, text }) =>
        `${fileLabel}:${line} issues a direct 'bd dolt pull'/'bd dolt push' literal ("${text}") -- ` +
        `route it through ./dolt-sync.mjs (DoltSync.syncBefore/syncAfter/status) instead, the single ` +
        `permitted dolt command surface.`
    );
    return { violations };
}

/**
 * Aggregate entry point: scans every module in the SHARED guarded-module list
 * (./guarded-modules.mjs), MINUS the dolt-literal exemptions, and returns the
 * union of their violations. Follows checkModules() in
 * dispatch-safety-guard.mjs -- the reference implementation -- so a dolt
 * command that moves out of runner.js into a newly extracted module stays
 * covered instead of silently falling out of scan scope.
 *
 * Each violation string already names the basename of the file it came from
 * (checkDoltLiteralPath's `fileLabel`), so an aggregate run attributes every
 * finding to the correct module.
 *
 * THE EXEMPTION IS ENFORCED HERE, NOT ASSUMED: dolt-sync.mjs is the single
 * permitted dolt command surface -- it BUILDS the `bd dolt pull`/`bd dolt
 * push` strings on purpose -- so it is filtered out by basename via
 * DOLT_LITERAL_EXEMPT even if someone registers it in the shared list or
 * passes it here explicitly. Byte-identical content under any OTHER name is
 * still a violation. This guard defines no list of its own.
 *
 * @param {string[]} [paths]
 * @returns {{ violations: string[], files: string[], skipped: string[] }}
 */
export function checkDoltLiteralModules(paths = doltLiteralModulePaths()) {
    if (!Array.isArray(paths)) {
        throw new TypeError('checkDoltLiteralModules(paths): paths must be an array of file paths');
    }
    const violations = [];
    const files = [];
    const skipped = [];
    for (const p of paths) {
        const file = path.basename(p);
        if (DOLT_LITERAL_EXEMPT.includes(file)) {
            skipped.push(file);
            continue;
        }
        files.push(file);
        violations.push(...checkDoltLiteralPath(p).violations);
    }
    return { violations, files, skipped };
}
