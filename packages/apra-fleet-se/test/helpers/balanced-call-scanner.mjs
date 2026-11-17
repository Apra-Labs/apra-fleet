// apra-fleet-7h6n.3 -- shared balanced-paren source-scanner primitives.
//
// WHY THIS EXISTS: git-sync-brackets.test.mjs and dispatch-sync-bracket-
// coverage.test.mjs each hand-rolled their OWN, near-identical copy of these
// two functions to find a call site's matching closing paren in runner.js's
// source text (skipping over string/template-literal contents so a
// multi-line call with nested parens, or a paren inside a quoted shell
// command, is never mis-parsed). Factored out here so a future fix to the
// scanning logic (e.g. a new literal-quoting edge case) is made once, not
// replayed at both call sites and left to drift.
//
// Both original assertion sets are UNCHANGED -- this module carries only the
// shared low-level primitives; each test file keeps its own higher-level
// scanning logic built on top (git-sync-brackets.test.mjs's
// withGitSyncRanges(), dispatch-sync-bracket-coverage.test.mjs's more general
// findCallSites()).

/**
 * Returns the index of the closing quote char matching the one at `start`.
 * @param {string} src
 * @param {number} start - index of the OPENING quote char
 * @param {string} quoteChar - `"`, `'`, or `` ` ``
 * @returns {number}
 */
export function skipStringLiteral(src, start, quoteChar) {
    let i = start + 1;
    for (; i < src.length; i++) {
        const ch = src[i];
        if (ch === '\\') { i++; continue; }
        if (ch === quoteChar) return i;
    }
    return i;
}

/**
 * Given the index of an opening '(' in `src`, returns [start, end] -- the
 * index of that '(' and the index of its matching ')' -- tracking paren
 * depth and skipping over string/template-literal contents (via
 * skipStringLiteral above) so a nested paren inside a quoted value is never
 * mistaken for the call's own closing paren.
 * @param {string} src
 * @param {number} openParenIdx
 * @returns {[number, number]}
 */
export function balancedCallRange(src, openParenIdx) {
    let depth = 0;
    let i = openParenIdx;
    for (; i < src.length; i++) {
        const ch = src[i];
        if (ch === '(') {
            depth++;
        } else if (ch === ')') {
            depth--;
            if (depth === 0) return [openParenIdx, i];
        } else if (ch === '"' || ch === "'" || ch === '`') {
            i = skipStringLiteral(src, i, ch);
        }
    }
    return [openParenIdx, i]; // unbalanced -- should never happen on valid source
}
