import fs from 'fs';
import path from 'path';
import { guardedModulePaths } from './guarded-modules.mjs';

// =============================================================================
// apra-fleet-eft.3.3 -- dispatch-safety guard checker, extracted so it is
// exported/parameterizable by path.
//
// This module holds the bracket-aware `command(`/`agent(` call-site parser
// originally written inline in dispatch-safety-guard.test.mjs
// (apra-fleet-eft.3.1). It is factored out here so the checker can be
// pointed at an arbitrary source file -- in particular a test fixture that
// deliberately violates the invariant -- WITHOUT mutating
// packages/apra-fleet-se/fleet-sprint/runner.js itself to manufacture a
// failure case. dispatch-safety-guard.test.mjs imports this module both for
// its real runner.js baseline assertion and for fixture-driven tests that
// prove the checker actually detects a violation rather than passing
// vacuously.
//
// Invariant under test (unchanged from eft.3.1): EVERY `command(` / `agent(`
// call site in a scanned source file must supply an explicit `member_name`
// (or `member_id`) in its options object.
//
// MODULE-LIST GENERALIZATION: this guard is no longer pointed at a single
// hard-coded file. checkModules() below reads the SHARED guarded-module list
// (./guarded-modules.mjs) -- the one place a newly extracted fleet-sprint
// module is registered -- so a dispatch that moves out of runner.js into a
// new module stays covered instead of silently falling out of scan scope.
// checkPath() remains exported and behaves exactly as before; it is still the
// right entry point for scanning one specific file (a fixture, or a module
// like dolt-sync.mjs that is deliberately not on the shared list). This
// module is the reference implementation the sibling guards follow.
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

// A `/` that opens a REGEX literal (as opposed to a division/`/=` operator)
// is only ever preceded -- skipping whitespace -- by one of these punctuation
// characters, by the start of the file, or by one of the listed keywords.
// This is the same heuristic real tokenizers use to disambiguate the two: a
// division operator always follows a value (an identifier, number, `)`, `]`,
// `}`, or a closing quote), never one of these. Good enough for source text
// that is valid, already-linted JS (this repo's own modules), which is the
// only input maskComments() is ever run against.
const REGEX_PRECEDING_PUNCT_CHARS = new Set('([{,;:=!&|?+-*%^~<>'.split(''));
const REGEX_PRECEDING_KEYWORDS = new Set([
    'return', 'typeof', 'instanceof', 'in', 'of', 'new', 'delete', 'void',
    'yield', 'throw', 'case', 'do', 'else', 'await',
]);

/**
 * True when a `/` at position `idx` in `text` opens a regex literal rather
 * than a division or `/=` operator. Scans backward from `idx` (skipping
 * whitespace) to the last significant character/word and checks it against
 * REGEX_PRECEDING_PUNCT_CHARS/REGEX_PRECEDING_KEYWORDS above. `text` must
 * already have comments masked to whitespace at every position before `idx`
 * (both maskComments()'s own in-progress `out` buffer and its finished
 * return value satisfy this), so a `/` right after where a comment used to
 * be correctly sees whatever preceded the comment, not the comment itself.
 * EXPORTED so any OTHER walk over an already-masked copy of source (e.g. a
 * depth-count loop that must not miscount a quote or bracket embedded in a
 * regex body) can reuse the exact same regex-vs-division heuristic instead
 * of re-deriving it -- see extractBalancedCall() below and
 * unbracketed-push-guard.mjs's findFunctionBodyRange() for two consumers
 * that got this wrong before apra-fleet-btj9.10.
 */
export function canStartRegex(text, idx) {
    let j = idx - 1;
    while (j >= 0 && /\s/.test(text[j])) j--;
    if (j < 0) return true; // start of file
    if (REGEX_PRECEDING_PUNCT_CHARS.has(text[j])) return true;
    let k = j;
    while (k >= 0 && /[A-Za-z0-9_$]/.test(text[k])) k--;
    const word = text.slice(k + 1, j + 1);
    return REGEX_PRECEDING_KEYWORDS.has(word);
}

/**
 * Returns the index of the closing `/` of a regex literal that opens at
 * `start`, or -1 if none is found before end-of-line/end-of-file (a regex
 * literal can never span a raw newline in valid JS, so hitting one means the
 * leading `/` was misclassified as a regex start -- the caller falls back to
 * treating it as an ordinary character). Tracks bracket-expression state
 * (`[...]`) because a `/` inside a character class does not close the regex
 * (this is exactly what SAFE_TEXT_RE = /^[A-Za-z0-9 .,:;!?()'_/+[\]-]+$/ in
 * newtask-text.mjs relies on), and skips backslash-escaped characters
 * (inside or outside the class) the same way skipStringLiteral() does.
 * EXPORTED for the same reason as canStartRegex() above.
 */
export function skipRegexLiteral(src, start) {
    let inClass = false;
    for (let i = start + 1; i < src.length; i++) {
        const ch = src[i];
        if (ch === '\\') { i++; continue; }
        if (ch === '\n') return -1;
        if (inClass) {
            if (ch === ']') inClass = false;
            continue;
        }
        if (ch === '[') { inClass = true; continue; }
        if (ch === '/') return i;
    }
    return -1;
}

/**
 * Replaces every comment's characters with spaces (newlines preserved), so
 * the result has the SAME length and line numbering as `src` but no comment
 * text -- mirrors test/helpers/dispatch-pin-scanner.mjs's maskComments()
 * (that file's stripComments() helper is NOT length-preserving, which would
 * corrupt the positional index math extractBalancedCall depends on).
 *
 * WHY THIS EXISTS (apra-fleet-3swo.34): extractBalancedCall()'s depth walk
 * skips over string literals but, before this fix, did not skip comments.
 * runner.js's prose comments are full of apostrophes (e.g. "the streak's
 * scope"); an unmasked walk reads that apostrophe as an opening quote and
 * swallows everything -- including real closing parens -- until the next
 * apostrophe, so a call site's balanced range can silently run away to the
 * end of the file. Masking comments out before walking parens/quotes is what
 * makes the balanced range trustworthy; the returned callText is still
 * sliced from the ORIGINAL (unmasked) src so callers keep seeing real
 * comment text, just with correct boundaries.
 *
 * REGEX LITERALS (apra-fleet-btj9.10): a regex whose body contains a quote or
 * apostrophe -- e.g. newtask-text.mjs's
 * `SAFE_TEXT_RE = /^[A-Za-z0-9 .,:;!?()'_/+[\]-]+$/` or branch-ensure.mjs's
 * `/couldn't find remote ref/i` -- used to open the SAME kind of phantom
 * string the comment-blindness fix above closed for apostrophes in prose: the
 * string branch below would treat that quote as opening a real string and
 * copy everything up to the next matching quote through UNMASKED, including
 * any real comment in between (whose stray parens could then desync a later
 * extractBalancedCall() depth walk). Regex literals are recognized (via
 * canStartRegex()/skipRegexLiteral() above) and copied through verbatim --
 * like a string, not stripped -- BEFORE the string branch gets a chance to
 * misread the quote inside one.
 *
 * @param {string} src
 * @returns {string}
 */
export function maskComments(src) {
    let out = '';
    for (let i = 0; i < src.length; i++) {
        const ch = src[i];
        if (ch === '/' && src[i + 1] === '/') {
            while (i < src.length && src[i] !== '\n') { out += ' '; i++; }
            out += '\n';
            continue;
        }
        if (ch === '/' && src[i + 1] === '*') {
            const end = src.indexOf('*/', i + 2);
            const stop = end < 0 ? src.length - 1 : end + 1;
            for (; i <= stop; i++) out += src[i] === '\n' ? '\n' : ' ';
            i--;
            continue;
        }
        if (ch === '/' && canStartRegex(out, out.length)) {
            const end = skipRegexLiteral(src, i);
            if (end !== -1) {
                let flagEnd = end;
                while (flagEnd + 1 < src.length && /[a-zA-Z]/.test(src[flagEnd + 1])) flagEnd++;
                out += src.slice(i, flagEnd + 1);
                i = flagEnd;
                continue;
            }
            // Not actually a regex (no closing `/` before end of line) --
            // fall through and let the default branch below copy the `/`
            // as an ordinary character.
        }
        if (ch === '"' || ch === "'" || ch === '`') {
            const end = skipStringLiteral(src, i, ch);
            out += src.slice(i, end + 1);
            i = end;
            continue;
        }
        out += ch;
    }
    return out;
}

/**
 * Given the index of an opening '(' in `src`, returns the full call-site
 * text from that '(' through its matching ')', tracking paren depth and
 * skipping over string/template-literal contents (so parens embedded in
 * string/template content, e.g. `bd show ${ids.join(' ')}`, never disturb
 * the depth count) AND over comment spans (so an apostrophe in prose, e.g.
 * "the streak's scope", is never misread as opening a string -- see
 * maskComments() above). The depth/quote walk runs over a comment-masked
 * copy of `src`, but the returned text is sliced from the ORIGINAL `src` so
 * real comment content is preserved in the output.
 *
 * ALSO skips over regex literals in this SAME walk (apra-fleet-btj9.10):
 * maskComments() copies a regex literal's body through verbatim (like a
 * string's), so a quote/apostrophe inside one (e.g. a call argument written
 * `/it's ok/`) is still sitting right there in `masked`. Without this,
 * THIS walk's own quote branch below would re-discover that apostrophe and
 * misread it as opening a real string, potentially running the depth walk
 * away past the call's real closing paren. Uses the same
 * canStartRegex()/skipRegexLiteral() maskComments() itself uses, so a
 * `/` is only ever treated as a regex open here in the exact cases it would
 * have been treated as one during masking.
 */
export function extractBalancedCall(src, openParenIdx) {
    const masked = maskComments(src);
    let depth = 0;
    let i = openParenIdx;
    for (; i < masked.length; i++) {
        const ch = masked[i];
        if (ch === '(') {
            depth++;
        } else if (ch === ')') {
            depth--;
            if (depth === 0) {
                return src.slice(openParenIdx, i + 1);
            }
        } else if (ch === '/' && canStartRegex(masked, i)) {
            const end = skipRegexLiteral(masked, i);
            if (end !== -1) i = end;
        } else if (ch === '"' || ch === "'" || ch === '`') {
            i = skipStringLiteral(masked, i, ch);
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

/**
 * Aggregate entry point: scans EVERY module in the shared guarded-module list
 * (fleet-sprint/guarded-modules.mjs -- runner.js today, plus whatever is
 * extracted from it) and returns the union of their call sites and
 * violations. This is the reference implementation the other mechanical
 * guards in this directory follow.
 *
 * Each violation string already carries the basename of the file it came
 * from (findViolations' `fileLabel`), so an aggregate run over several
 * modules attributes every finding to the correct module rather than to a
 * single hard-coded runner.js label. `sitesByFile` gives per-module call-site
 * counts for baseline assertions that need them.
 *
 * `paths` defaults to the shared list; callers pass
 * guardedModulePaths([fixture]) to prove the list -- not a hard-coded name --
 * is what the guard actually reads.
 *
 * @param {string[]} [paths]
 * @returns {{ sites: object[], violations: string[], files: string[], sitesByFile: Record<string, object[]> }}
 */
export function checkModules(paths = guardedModulePaths()) {
    if (!Array.isArray(paths)) {
        throw new TypeError('checkModules(paths): paths must be an array of file paths');
    }
    const sites = [];
    const violations = [];
    const files = [];
    const sitesByFile = {};
    for (const p of paths) {
        const file = path.basename(p);
        const result = checkPath(p);
        files.push(file);
        sitesByFile[file] = result.sites;
        sites.push(...result.sites.map((s) => ({ ...s, file })));
        violations.push(...result.violations);
    }
    return { sites, violations, files, sitesByFile };
}
