import fs from 'fs';
import path from 'path';

// =============================================================================
// apra-fleet-eft.3.3 -- dispatch-safety guard checker, extracted so it is
// exported/parameterizable by path.
//
// This module holds the bracket-aware `command(`/`agent(` call-site parser
// originally written inline in dispatch-safety-guard.test.mjs
// (apra-fleet-eft.3.1). It is factored out here so the checker can be
// pointed at an arbitrary source file -- in particular a test fixture that
// deliberately violates the invariant -- WITHOUT mutating
// packages/apra-fleet-se/auto-sprint/runner.js itself to manufacture a
// failure case. dispatch-safety-guard.test.mjs imports this module both for
// its real runner.js baseline assertion and for fixture-driven tests that
// prove the checker actually detects a violation rather than passing
// vacuously.
//
// Invariant under test (unchanged from eft.3.1): EVERY `command(` / `agent(`
// call site in a scanned source file must supply an explicit `member_name`
// (or `member_id`) in its options object.
// =============================================================================

/**
 * Returns true if `col` (0-based index into `lineText`) sits inside an open
 * `"..."` or `'...'` string that started earlier on the SAME line -- i.e. an
 * odd number of unescaped quote characters of the currently-open type
 * precede it. Deliberately scoped to a single line (not a whole-file quote
 * scan): a whole-file scan misfires on stray apostrophes in prose comments
 * (e.g. "doesn't", "it's"), which would otherwise be misread as opening a
 * string and swallow everything up to the next quote -- including real
 * command()/agent() call sites many lines later. Backticks are deliberately
 * NOT tracked here: template literals legitimately span multiple lines (git
 * command strings) and are not a source of the false positive this guards
 * against (a real call site's own leading backtick is never itself inside a
 * string).
 */
export function isInsideSameLineString(lineText, col) {
    let quote = null;
    for (let i = 0; i < col; i++) {
        const ch = lineText[i];
        if (ch === '\\') { i++; continue; }
        if (quote) {
            if (ch === quote) quote = null;
        } else if (ch === '"' || ch === "'") {
            quote = ch;
        }
    }
    return quote !== null;
}

/** Returns the index of the closing quote char matching the one at `start`. */
export function skipStringLiteral(src, start, quoteChar) {
    let i = start + 1;
    for (; i < src.length; i++) {
        const ch = src[i];
        if (ch === '\\') {
            i++; // skip escaped char
            continue;
        }
        if (ch === quoteChar) return i;
    }
    return i;
}

/**
 * Given the index of an opening '(' in `src`, returns the full call-site
 * text from that '(' through its matching ')', tracking paren depth and
 * skipping over string/template-literal contents (so parens embedded in
 * string/template content, e.g. `bd show ${ids.join(' ')}`, never disturb
 * the depth count).
 */
export function extractBalancedCall(src, openParenIdx) {
    let depth = 0;
    let i = openParenIdx;
    for (; i < src.length; i++) {
        const ch = src[i];
        if (ch === '(') {
            depth++;
        } else if (ch === ')') {
            depth--;
            if (depth === 0) {
                return src.slice(openParenIdx, i + 1);
            }
        } else if (ch === '"' || ch === "'" || ch === '`') {
            i = skipStringLiteral(src, i, ch);
        }
    }
    // Unbalanced -- should never happen against real, syntactically-valid
    // source; return what we found so the caller's member_name check still
    // has something to inspect rather than throwing mid-scan.
    return src.slice(openParenIdx, i);
}

/**
 * Scans `src` for `command(`/`agent(` call sites, skipping call-site tokens
 * that only appear inside a full-line comment. Returns an array of
 * { fnName, line, callText } for every real call site found.
 */
export function findCallSites(src) {
    const lines = src.split('\n');
    // Byte offset of the start of each line, so a regex match index into
    // the whole-file string can be mapped back to a 1-based line number.
    const lineStarts = [];
    let offset = 0;
    for (const line of lines) {
        lineStarts.push(offset);
        offset += line.length + 1; // +1 for the '\n' stripped by split()
    }
    function lineNumberForIndex(idx) {
        // Binary search would be overkill for a single source file; linear
        // scan is fine here.
        let ln = 0;
        for (let i = 0; i < lineStarts.length; i++) {
            if (lineStarts[i] > idx) break;
            ln = i;
        }
        return ln + 1; // 1-based
    }
    function isCommentLine(ln) {
        const text = lines[ln - 1] ? lines[ln - 1].trim() : '';
        return text.startsWith('//') || text.startsWith('*') || text.startsWith('/*');
    }

    // Matches `command(` / `agent(` NOT preceded by a `.` or word character
    // (so e.g. `dispatchCommand(` or `.command(` -- neither of which occurs
    // for the fleet dispatch primitives, but this guards against false
    // positives from unrelated identifiers ending in the same substring).
    const callRe = /(?<![.\w])(command|agent)\(/g;
    const sites = [];
    let m;
    while ((m = callRe.exec(src)) !== null) {
        const fnName = m[1];
        const openParenIdx = m.index + m[0].length - 1; // index of the '(' itself
        const line = lineNumberForIndex(m.index);
        if (isCommentLine(line)) continue;
        // Reject matches where the literal text "command(" / "agent(" sits
        // inside a same-line quoted string (e.g. a `throw new Error("...
        // command() ...")` message) -- not a real dispatch call site.
        const lineText = lines[line - 1] || '';
        const col = m.index - lineStarts[line - 1];
        if (isInsideSameLineString(lineText, col)) continue;
        const callText = extractBalancedCall(src, openParenIdx);
        sites.push({ fnName, line, callText });
    }
    return sites;
}

const MEMBER_RE = /\b(member_name|member_id)\b/;

/**
 * Given an array of call sites (as returned by findCallSites), returns the
 * subset lacking an explicit member_name/member_id, each formatted as a
 * human-readable violation string naming `fileLabel` and the offending
 * line -- e.g. "fixture.mjs:4 (command()) is missing member_name/member_id".
 */
export function findViolations(sites, fileLabel) {
    return sites
        .filter((s) => !MEMBER_RE.test(s.callText))
        .map((s) => `${fileLabel}:${s.line} (${s.fnName}()) is missing member_name/member_id`);
}

/**
 * Reads and scans the source file at `filePath` for command()/agent() call
 * sites, returning { sites, violations }. This is the checker's main
 * path-parameterized entry point: callers -- real runner.js baseline
 * assertions, or fixture-driven tests exercising a deliberately
 * non-compliant call site -- pass whatever file path they want scanned,
 * without needing to mutate runner.js to manufacture a failing case.
 */
export function checkPath(filePath) {
    const src = fs.readFileSync(filePath, 'utf8');
    const sites = findCallSites(src);
    const fileLabel = path.basename(filePath);
    const violations = findViolations(sites, fileLabel);
    return { sites, violations };
}
