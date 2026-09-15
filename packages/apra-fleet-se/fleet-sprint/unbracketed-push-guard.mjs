import fs from 'fs';
import path from 'path';
import { isInsideSameLineString, skipStringLiteral } from './dispatch-safety-guard.mjs';
import { unbracketedPushModulePaths, UNBRACKETED_PUSH_EXEMPT } from './guarded-modules.mjs';

// =============================================================================
// apra-fleet-3swo.4.2 -- unbracketed-push guard checker.
//
// Invariant under test: NO scanned module may issue a bare, real call site of
// doltPushAfter(), syncMemberAfter(), DoltSync.syncBefore() or
// DoltSync.syncAfter() -- the four raw sync/push primitives -- outside the
// two structurally-sanctioned wrapper functions (SANCTIONED_WRAPPER_FUNCTIONS
// below) that are themselves only ever reached from inside an already-open
// sync bracket (git-sync.mjs's withGitSync() calls syncMemberAfterOrdered();
// every runner.js call site of verifyDoerStreakClosed() wraps it in
// gitSync.withOpenSyncBracket()). Every other caller must route through one
// of createGitSync()'s bracketed entry points (withGitSync,
// syncBeadsBefore/After, pushBeadsAfter, pushGitAfter) instead of reaching
// for a primitive directly -- a bare call is exactly the kind of hole
// apra-fleet-3swo.4.1 closed for the two sites the epic named, and this scan
// is the regression lock that keeps a future one from reopening either by
// construction or by adding a NEW hand-rolled call site.
//
// MODULE-LIST GENERALIZATION, mirroring dispatch-safety-guard.mjs /
// dolt-literal-guard.mjs: this guard reads the SHARED guarded-module list
// (./guarded-modules.mjs) rather than a single hard-coded file, so a bare
// call that moves out of runner.js into a newly extracted module stays
// covered. git-sync.mjs is exempted via UNBRACKETED_PUSH_EXEMPT -- it is the
// ONE module allowed to call these primitives directly, since that IS its
// bracketed-entry-point implementation (mirrors DOLT_LITERAL_EXEMPT's
// dolt-sync.mjs precedent for the sibling dolt-literal guard).
//
// PER-SITE, NOT PER-FILE: an earlier version of this scan required "exactly
// one sanctioned call" per whole file, keyed off a local variable name
// (`gPush = await syncMemberAfter(...)`). That broke on every module with
// ZERO calls to these primitives (a legitimate, common case once the guard
// scans the full module list, not just runner.js) and was brittle against an
// unrelated rename. This version flags each REAL call site individually,
// exempting only those whose containing function body is one of the two
// structurally-sanctioned wrappers -- meaningful for any module, including
// ones that never mention these primitives at all (zero call sites is not a
// violation).
// =============================================================================

/** The four raw sync/push primitives no module but git-sync.mjs may call bare. */
const SCANNED_PRIMITIVES = ['doltPushAfter', 'syncMemberAfter', 'DoltSync.syncBefore', 'DoltSync.syncAfter'];

/**
 * Function names whose ENTIRE body is only ever reached through an
 * already-open sync bracket, so a bare primitive call inside one is
 * sanctioned:
 *   - syncMemberAfterOrdered: git-sync.mjs's withGitSync() is the only
 *     caller, and withGitSync() itself always runs inside
 *     brackets.withOpenSyncBracket(...).
 *   - verifyDoerStreakClosed: every call site in runner.js wraps it in
 *     gitSync.withOpenSyncBracket(() => verifyDoerStreakClosed(...)).
 */
const SANCTIONED_WRAPPER_FUNCTIONS = ['syncMemberAfterOrdered', 'verifyDoerStreakClosed'];

/**
 * Finds every real (non-comment, non-same-line-string, non-declaration) call
 * site of `fnName(` in `src` (fnName may be dotted, e.g. `DoltSync.syncAfter`).
 * Returns `{ index, line, lineText }` for each -- `index` is the character
 * offset of the match, used to test containment inside a sanctioned wrapper's
 * body range.
 */
export function findRealCallSites(src, fnName) {
    const escaped = fnName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const callRe = new RegExp(`(?<![.\\w])${escaped}\\(`, 'g');
    const sites = [];
    let m;
    while ((m = callRe.exec(src)) !== null) {
        const lineStart = src.lastIndexOf('\n', m.index) + 1;
        const lineEnd = src.indexOf('\n', m.index);
        const lineNo = src.slice(0, m.index).split('\n').length;
        const lineText = src.slice(lineStart, lineEnd === -1 ? src.length : lineEnd);
        const trimmed = lineText.trim();
        if (trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('/*')) continue;
        if (/^(export\s+)?(async\s+)?function\b/.test(trimmed)) continue; // the function's own declaration
        const col = m.index - lineStart;
        if (isInsideSameLineString(lineText, col)) continue;
        sites.push({ index: m.index, line: lineNo, lineText: trimmed });
    }
    return sites;
}

/**
 * Returns the [start, end) character-offset range of `fnName`'s body --
 * from its opening `{` through the matching closing `}` -- or `null` if no
 * top-level `function fnName(` declaration is found. Tracks brace depth while
 * skipping over string/template-literal contents and comments so a `{`/`}`
 * embedded in a quoted value or a comment never disturbs the count.
 */
function findFunctionBodyRange(src, fnName) {
    const declRe = new RegExp(`(?:export\\s+)?(?:async\\s+)?function\\s+${fnName}\\s*\\(`);
    const decl = declRe.exec(src);
    if (!decl) return null;

    // Skip past the parameter list (balanced parens, so default values
    // containing '(' -- e.g. `opts = {}` never does, but a future
    // `(a = f())` shape would -- do not end the scan early).
    let depth = 0;
    let i = src.indexOf('(', decl.index);
    for (; i < src.length; i++) {
        const ch = src[i];
        if (ch === '(') depth++;
        else if (ch === ')') {
            depth--;
            if (depth === 0) break;
        } else if (ch === '"' || ch === "'" || ch === '`') {
            i = skipStringLiteral(src, i, ch);
        }
    }

    const braceOpen = src.indexOf('{', i);
    if (braceOpen === -1) return null;

    depth = 0;
    for (let j = braceOpen; j < src.length; j++) {
        const ch = src[j];
        if (ch === '/' && src[j + 1] === '/') {
            const nl = src.indexOf('\n', j);
            j = nl === -1 ? src.length : nl;
            continue;
        }
        if (ch === '/' && src[j + 1] === '*') {
            const end = src.indexOf('*/', j + 2);
            j = end === -1 ? src.length : end + 1;
            continue;
        }
        if (ch === '"' || ch === "'" || ch === '`') {
            j = skipStringLiteral(src, j, ch);
            continue;
        }
        if (ch === '{') depth++;
        else if (ch === '}') {
            depth--;
            if (depth === 0) return [braceOpen, j];
        }
    }
    return [braceOpen, src.length - 1];
}

/**
 * The mechanical scan itself: given a source string, returns every violation
 * -- a real call site of one of SCANNED_PRIMITIVES that does NOT sit inside
 * one of SANCTIONED_WRAPPER_FUNCTIONS' bodies. A module with zero call sites
 * of these primitives reports zero violations (it simply never touches them
 * -- not every module needs to).
 */
export function findUnbracketedPushViolations(src, fileLabel = 'source') {
    const violations = [];
    const wrapperRanges = SANCTIONED_WRAPPER_FUNCTIONS
        .map((name) => findFunctionBodyRange(src, name))
        .filter((range) => range !== null);

    for (const primitive of SCANNED_PRIMITIVES) {
        for (const site of findRealCallSites(src, primitive)) {
            const sanctioned = wrapperRanges.some(([start, end]) => site.index > start && site.index < end);
            if (sanctioned) continue;
            violations.push(`${fileLabel}:${site.line} bare ${primitive}() call site outside any bracket: ${site.lineText}`);
        }
    }
    return violations;
}

/**
 * Reads and scans the source file at `filePath`, returning { violations }.
 * The path-parameterized entry point -- callers pass a fixture path to prove
 * the scan actually detects a violation without mutating real source.
 */
export function checkUnbracketedPushPath(filePath) {
    const src = fs.readFileSync(filePath, 'utf8');
    const fileLabel = path.basename(filePath);
    return { violations: findUnbracketedPushViolations(src, fileLabel) };
}

/**
 * Aggregate entry point: scans every module in the SHARED guarded-module list
 * (./guarded-modules.mjs), MINUS UNBRACKETED_PUSH_EXEMPT, and returns the
 * union of their violations. Follows checkModules()/checkDoltLiteralModules()
 * -- the dispatch-safety-guard.mjs / dolt-literal-guard.mjs reference
 * implementations -- so a bare primitive call that moves out of runner.js
 * into a newly extracted module stays covered instead of silently falling
 * out of scan scope. Defines no list of its own.
 *
 * @param {string[]} [paths]
 * @returns {{ violations: string[], files: string[], skipped: string[] }}
 */
export function checkUnbracketedPushModules(paths = unbracketedPushModulePaths()) {
    if (!Array.isArray(paths)) {
        throw new TypeError('checkUnbracketedPushModules(paths): paths must be an array of file paths');
    }
    const violations = [];
    const files = [];
    const skipped = [];
    for (const p of paths) {
        const file = path.basename(p);
        if (UNBRACKETED_PUSH_EXEMPT.includes(file)) {
            skipped.push(file);
            continue;
        }
        files.push(file);
        violations.push(...checkUnbracketedPushPath(p).violations);
    }
    return { violations, files, skipped };
}
