import fs from 'fs';
import path from 'path';

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
    const violations = findDoltLiteralViolations(src).map(({ line, text }) =>
        `${fileLabel}:${line} issues a direct 'bd dolt pull'/'bd dolt push' literal ("${text}") -- ` +
        `route it through ./dolt-sync.mjs (DoltSync.syncBefore/syncAfter/status) instead, the single ` +
        `permitted dolt command surface (apra-fleet-417.2.1/417.2.2).`
    );
    return { violations };
}
