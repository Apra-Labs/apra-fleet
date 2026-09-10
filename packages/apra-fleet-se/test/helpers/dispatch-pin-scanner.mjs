// Shared source-scanning primitives for the role-dispatch PIN tests.
//
// WHY THIS EXISTS: the two dispatch-pin test files (planning-role-dispatch-
// pins.test.mjs and execution-role-dispatch-pins.test.mjs, apra-fleet-3swo.5.1
// / .5.6) both need to read the SAME facts out of runner.js's source text --
// which member a dispatch routes to, whether it sits inside a withGitSync(...)
// bracket and with which pushCode flag, its max_turns/timeout_s, whether a
// withDispatchWatchdog(...) is armed around it, and which schema (i.e. which
// returnable verdicts) it carries. Those pins exist to freeze TODAY's
// behaviour before the dispatchRole engine refactor starts, so both files must
// derive their facts the same way; a hand-rolled copy in each would drift
// exactly when the refactor makes drift most expensive to notice.
//
// It builds on ./balanced-call-scanner.mjs (the paren-matching primitives
// shared with git-sync-brackets.test.mjs and dispatch-sync-bracket-
// coverage.test.mjs) and adds:
//   - findCallSites()      -- every real call site of a named function
//   - splitTopLevelArgs()  -- a call's positional arguments
//   - objectLiteralFor()   -- the text of a `const NAME = { ... }` literal
//   - optionField()        -- one `key: value` out of an options-object text
//   - numericConstant()    -- the value of a `const NAME = <number>;`
//
// These are deliberately TEXTUAL. runner.js's dispatch sites are not
// separately importable today (that is the whole point of the refactor these
// pins guard), so a static parse of the source is the only way to assert what
// each ladder does before the engine exists.
//
// MODULE-SET GENERALIZATION (apra-fleet-3swo.5.8): every function below still
// takes a single `src` string, but the THREE callers (the two pin files plus
// role-policies-table.test.mjs) no longer hard-code one RUNNER_PATH to build
// it. moduleSetSource()/dispatchLadderModulePaths() below let a caller build
// `src` from a SET of fleet-sprint modules instead, concatenated into one
// scannable string -- so an anchor that moves out of runner.js into a module
// the dispatchRole migration beads (apra-fleet-3swo.5.3/.5.6) extract keeps
// resolving without this file, or any individual pin, having to change.
// DISPATCH_LADDER_MODULES is deliberately a SEPARATE list from
// fleet-sprint/guarded-modules.mjs's GUARDED_MODULES: that list drives the
// mechanical SECURITY guards and must include every extracted module
// regardless of content; this list drives the BEHAVIOUR-PIN scanners and only
// needs the modules that actually host dispatch-ladder structure today.
//
// DECISION RECORDED (apra-fleet-3swo.5.8, do not defer): this scanner STAYS
// TEXTUAL even after the dispatch sites move into dispatch-role.mjs. The
// facts it locates -- whether a call sits inside a withGitSync(...) bracket,
// whether a withDispatchWatchdog(...) is armed around it, a ladder's
// retry/degrade CONTROL FLOW -- are properties of surrounding source
// structure, not of an importable value, so there is nothing to import even
// once dispatchRole exists. The one thing that genuinely becomes
// import-based is PER-DISPATCH OPTION VALUES (member/model/maxTurns/
// kbInjection/...): those already live in fleet-sprint/role-policies.mjs as
// the frozen, importable ROLE_POLICIES table (role-policies-table.test.mjs
// reads it directly today, no scanning involved). Once a ladder's inline
// options literal is replaced by a ROLE_POLICIES lookup, asserting an
// option's value should switch from this file's objectLiteralFor()/
// objectEntries() textual scan to importing ROLE_POLICIES and reading the
// field directly -- that migration is each dispatchRole bead's call to make
// per dispatch, not a blanket conversion of this shared helper.

import fs from 'node:fs';
import path from 'node:path';
import { balancedCallRange, skipStringLiteral } from './balanced-call-scanner.mjs';

/**
 * Filenames (relative to fleet-sprint/), in read order, of every module that
 * can host a role-dispatch ladder's structural facts TODAY. runner.js hosts
 * every UNMIGRATED ladder; dispatch-role.mjs (apra-fleet-3swo.5.3) hosts the
 * ONE generic dispatch every MIGRATED ladder runs through, and is on this
 * list so that the "every agent() call site in the scanned set is pinned by
 * one of the two pin tables" invariant keeps covering the engine's own call
 * site instead of losing sight of it the moment a ladder moves. role-policies
 * .mjs is on the list because it exists, even though it contributes no call
 * sites (it is pure frozen data) -- see this file's header DECISION note for
 * why that is fine.
 */
export const DISPATCH_LADDER_MODULES = ['runner.js', 'role-policies.mjs', 'dispatch-role.mjs'];

/**
 * Absolute paths for `fileNames` (default DISPATCH_LADDER_MODULES), resolved
 * against `fleetSprintDir`.
 *
 * @param {string} fleetSprintDir absolute path to packages/apra-fleet-se/fleet-sprint
 * @param {string[]} [fileNames]
 * @returns {string[]}
 */
export function dispatchLadderModulePaths(fleetSprintDir, fileNames = DISPATCH_LADDER_MODULES) {
    return fileNames.map((f) => path.join(fleetSprintDir, f));
}

/**
 * Reads and concatenates the source of a SET of fleet-sprint modules into ONE
 * scannable string, joined by a newline so every downstream function here --
 * all of which operate on a single `src` string and locate facts by
 * structural anchor search, never by absolute file identity -- keeps working
 * unchanged. Anchors are unique text, so concatenation is transparent as long
 * as no anchor search resolves inside the WRONG module.
 *
 * THIS IS NO LONGER "role-policies.mjs shares no anchor text with runner.js"
 * (that was true when this file was first written, but role-policies.mjs now
 * embeds every dispatch's `ladderAnchor` literal verbatim as data -- e.g.
 * 'plannerPrompt,', "label: 'Streak Assignment'," -- copied from runner.js's
 * own call sites). Nothing breaks TODAY only because runner.js is first in
 * DISPATCH_LADDER_MODULES, so indexOf()/regionBetween() resolve against
 * runner.js's copy first, and role-policies.mjs hosts no agent()/
 * withGitSync()/withDispatchWatchdog() call sites for findCallSites() to
 * find. This is a LATENT FALSE-GREEN, not a proven-safe invariant: if an
 * anchor were ever deleted from runner.js while role-policies.mjs still
 * carries the literal as data, regionBetween() would silently resolve inside
 * role-policies.mjs instead of throwing "region start anchor not found".
 * Module order in DISPATCH_LADDER_MODULES is load-bearing for that reason --
 * do not reorder it without re-auditing every anchor search against it.
 *
 * @param {string[]} paths absolute file paths to read, in order
 * @returns {string}
 */
export function moduleSetSource(paths) {
    return moduleSetSourceWithOffsets(paths).source;
}

/**
 * Same concatenation as moduleSetSource(), but also returns the per-module
 * LINE offsets a caller needs to resolve a concatenation-relative
 * site.line (from findCallSites() et al, which only ever see the joined
 * string) back to the real {file, line} it came from -- see
 * resolveModuleLocation() below.
 *
 * apra-fleet-3swo.28: before this, every pin failure message hard-coded
 * 'runner.js:' as the label, which was only correct because runner.js
 * happened to be DISPATCH_LADDER_MODULES[0]. Once a second module
 * (role-policies.mjs today, dispatch-role.mjs once the dispatchRole
 * migration lands) contributes call sites, a concatenation-relative line
 * must be resolved against the RIGHT module's own line numbering.
 *
 * @param {string[]} paths absolute file paths to read, in order
 * @returns {{source: string, offsets: Array<{file: string, path: string, startLine: number, lineCount: number}>}}
 */
export function moduleSetSourceWithOffsets(paths) {
    if (!Array.isArray(paths) || paths.length === 0) {
        throw new TypeError('moduleSetSourceWithOffsets(paths): paths must be a non-empty array of file paths');
    }
    const offsets = [];
    let startLine = 1;
    const texts = paths.map((p) => {
        const text = fs.readFileSync(p, 'utf8');
        // Matches how `.split('\n')` would count lines in this module's own
        // text -- including the phantom trailing entry a trailing newline
        // produces, which is exactly the blank line the join('\n') below
        // inserts before the next module. This is what keeps the cumulative
        // startLine math exact at the boundary between modules (AC#4).
        const lineCount = text.split('\n').length;
        offsets.push({ file: path.basename(p), path: p, startLine, lineCount });
        startLine += lineCount;
        return text;
    });
    return { source: texts.join('\n'), offsets };
}

/**
 * Resolves a 1-based line number into the concatenated source produced by
 * moduleSetSource()/moduleSetSourceWithOffsets() back to the {file, line}
 * it actually came from, `line` being 1-based and relative to that module's
 * OWN start (not the concatenation).
 *
 * @param {Array<{file: string, startLine: number}>} offsets from moduleSetSourceWithOffsets()
 * @param {number} concatLine
 * @returns {{file: string, line: number}}
 */
export function resolveModuleLocation(offsets, concatLine) {
    if (!Array.isArray(offsets) || offsets.length === 0) {
        throw new TypeError('resolveModuleLocation(offsets, concatLine): offsets must be a non-empty array');
    }
    let match = offsets[0];
    for (const o of offsets) {
        if (concatLine >= o.startLine) match = o;
        else break;
    }
    return { file: match.file, line: concatLine - match.startLine + 1 };
}

/**
 * Formats a list of sites (anything with a `.line` field, e.g. findCallSites()
 * results) as "file:line" pairs resolved via resolveModuleLocation(), joined
 * with ', ' -- the shared replacement for the four failure messages that used
 * to hard-code a 'runner.js:' label.
 *
 * @param {Array<{file: string, startLine: number}>} offsets from moduleSetSourceWithOffsets()
 * @param {Array<{line: number}>} sites
 * @returns {string}
 */
export function formatSiteLocations(offsets, sites) {
    return sites
        .map((s) => {
            const { file, line } = resolveModuleLocation(offsets, s.line);
            return `${file}:${line}`;
        })
        .join(', ');
}

/** Is `col` inside an open same-line quote? (mirrors dispatch-sync-bracket-coverage.test.mjs) */
function isInsideSameLineString(lineText, col) {
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

/**
 * Replaces every comment's characters with spaces (newlines preserved), so the
 * result has the SAME length and line numbering as `src` but no comment text.
 *
 * WHY: balanced-paren scanning skips over string literals, and runner.js's
 * prose comments are full of apostrophes ("this dispatch's session id"). An
 * unmasked scan reads that apostrophe as an opening quote and swallows real
 * code -- including closing parens -- until the next apostrophe, so a call's
 * balanced range silently runs away to the end of the file and every later
 * anchor then "matches" it. Masking first is what makes a call-site range
 * trustworthy.
 *
 * @param {string} src
 * @returns {string}
 */
export function maskComments(src) {
    let out = '';
    for (let i = 0; i < src.length; i++) {
        const ch = src[i];
        if (ch === '"' || ch === "'" || ch === '`') {
            const end = skipStringLiteral(src, i, ch);
            out += src.slice(i, end + 1);
            i = end;
            continue;
        }
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
        out += ch;
    }
    return out;
}

const MASKED_CACHE = new Map();
function maskedSourceFor(src) {
    let masked = MASKED_CACHE.get(src);
    if (masked === undefined) {
        masked = maskComments(src);
        MASKED_CACHE.set(src, masked);
    }
    return masked;
}

/**
 * Finds every real (non-comment, non-string-literal) call site of `fnName(`
 * in `src`.
 *
 * @param {string} src
 * @param {string} fnName
 * @param {{excludeDeclaration?: boolean}} [options]
 * @returns {Array<{index:number, line:number, callText:string, range:[number,number]}>}
 */
export function findCallSites(rawSrc, fnName, { excludeDeclaration = false } = {}) {
    // Ranges and callText come from the comment-masked source (see
    // maskComments) so a comment's apostrophe can never derail the scan; line
    // numbers are unaffected because masking is length-preserving.
    const src = maskedSourceFor(rawSrc);
    const lines = src.split('\n');
    const lineStarts = [];
    let offset = 0;
    for (const line of lines) {
        lineStarts.push(offset);
        offset += line.length + 1;
    }
    function lineNumberForIndex(idx) {
        let lo = 0;
        let hi = lineStarts.length - 1;
        let ans = 0;
        while (lo <= hi) {
            const mid = (lo + hi) >> 1;
            if (lineStarts[mid] <= idx) { ans = mid; lo = mid + 1; } else { hi = mid - 1; }
        }
        return ans + 1;
    }
    function isCommentLine(ln) {
        const text = lines[ln - 1] ? lines[ln - 1].trim() : '';
        return text.startsWith('//') || text.startsWith('*') || text.startsWith('/*');
    }
    function isDeclarationLine(ln) {
        const text = lines[ln - 1] ? lines[ln - 1].trim() : '';
        return /^(export\s+)?(async\s+)?function\b/.test(text);
    }

    const escaped = fnName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const callRe = new RegExp(`(?<![.\\w])${escaped}\\(`, 'g');
    const sites = [];
    let m;
    while ((m = callRe.exec(src)) !== null) {
        const openParenIdx = m.index + m[0].length - 1;
        const line = lineNumberForIndex(m.index);
        if (isCommentLine(line)) continue;
        if (excludeDeclaration && isDeclarationLine(line)) continue;
        const lineText = lines[line - 1] || '';
        const col = m.index - lineStarts[line - 1];
        if (isInsideSameLineString(lineText, col)) continue;
        const [start, end] = balancedCallRange(src, openParenIdx);
        sites.push({ index: m.index, line, callText: src.slice(start, end + 1), range: [start, end] });
    }
    return sites;
}

/**
 * Splits a balanced call's argument list -- `callText` as produced by
 * findCallSites(), i.e. INCLUDING the surrounding parens -- into its
 * top-level positional arguments. Nested calls, object/array literals and
 * string/template contents are skipped so a comma inside them never splits.
 *
 * @param {string} callText
 * @returns {string[]} trimmed argument texts (empty array for a no-arg call)
 */
export function splitTopLevelArgs(callText) {
    const inner = callText.slice(1, -1);
    const args = [];
    let depth = 0;
    let current = '';
    for (let i = 0; i < inner.length; i++) {
        const ch = inner[i];
        if (ch === '"' || ch === "'" || ch === '`') {
            const end = skipStringLiteral(inner, i, ch);
            current += inner.slice(i, end + 1);
            i = end;
            continue;
        }
        if (ch === '(' || ch === '[' || ch === '{') depth++;
        else if (ch === ')' || ch === ']' || ch === '}') depth--;
        if (ch === ',' && depth === 0) {
            args.push(current.trim());
            current = '';
            continue;
        }
        current += ch;
    }
    if (current.trim().length > 0) args.push(current.trim());
    return args;
}

/**
 * Returns the source text (braces included) of a `const <name> = { ... }`
 * object literal, or null when there is no such declaration.
 *
 * @param {string} src
 * @param {string} name
 * @returns {string|null}
 */
export function objectLiteralFor(src, name) {
    const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const declRe = new RegExp(`(?:const|let|var)\\s+${escaped}\\s*=\\s*\\{`);
    const m = declRe.exec(src);
    if (!m) return null;
    const openBraceIdx = m.index + m[0].length - 1;
    let depth = 0;
    for (let i = openBraceIdx; i < src.length; i++) {
        const ch = src[i];
        if (ch === '"' || ch === "'" || ch === '`') {
            i = skipStringLiteral(src, i, ch);
            continue;
        }
        if (ch === '{') depth++;
        else if (ch === '}') {
            depth--;
            if (depth === 0) return src.slice(openBraceIdx, i + 1);
        }
    }
    return null;
}

/**
 * Strips `//` line comments and block comments from `text`, skipping over
 * string/template contents so an apostrophe inside a comment (or a `//`
 * inside a string) never confuses the scan. Options objects in runner.js are
 * heavily commented, and a comment containing a comma or an unbalanced quote
 * would otherwise corrupt the entry split below.
 *
 * @param {string} text
 * @returns {string}
 */
export function stripComments(text) {
    let out = '';
    for (let i = 0; i < text.length; i++) {
        const ch = text[i];
        if (ch === '"' || ch === "'" || ch === '`') {
            const end = skipStringLiteral(text, i, ch);
            out += text.slice(i, end + 1);
            i = end;
            continue;
        }
        if (ch === '/' && text[i + 1] === '/') {
            while (i < text.length && text[i] !== '\n') i++;
            out += '\n';
            continue;
        }
        if (ch === '/' && text[i + 1] === '*') {
            const end = text.indexOf('*/', i + 2);
            i = end < 0 ? text.length : end + 1;
            continue;
        }
        out += ch;
    }
    return out;
}

/**
 * Splits the top-level entries of an object-literal text (braces included)
 * into `key -> value expression` pairs. Spread entries (`...opts`) and
 * shorthand properties carry no `key:` and are skipped -- use
 * spreadsOf()/the raw text for those.
 *
 * @param {string} optsText
 * @returns {Map<string,string>}
 */
export function objectEntries(optsText) {
    const entries = new Map();
    if (typeof optsText !== 'string') return entries;
    const stripped = stripComments(optsText).trim();
    const openIdx = stripped.indexOf('{');
    if (openIdx < 0) return entries;
    const inner = stripped.slice(openIdx + 1, stripped.lastIndexOf('}'));
    const segments = [];
    let depth = 0;
    let current = '';
    for (let i = 0; i < inner.length; i++) {
        const ch = inner[i];
        if (ch === '"' || ch === "'" || ch === '`') {
            const end = skipStringLiteral(inner, i, ch);
            current += inner.slice(i, end + 1);
            i = end;
            continue;
        }
        if (ch === '(' || ch === '[' || ch === '{') depth++;
        else if (ch === ')' || ch === ']' || ch === '}') depth--;
        if (ch === ',' && depth === 0) {
            segments.push(current);
            current = '';
            continue;
        }
        current += ch;
    }
    segments.push(current);
    const keyRe = /^\s*(?:'([^']+)'|"([^"]+)"|([A-Za-z_$][\w$]*))\s*:\s*([\s\S]+)$/;
    for (const segment of segments) {
        const m = keyRe.exec(segment);
        if (!m) continue;
        const key = m[1] || m[2] || m[3];
        entries.set(key, m[4].trim());
    }
    return entries;
}

/**
 * Reads one `key: value` out of an options-object text. Returns the value
 * expression, or null when the key is absent.
 *
 * @param {string} optsText
 * @param {string} key
 * @returns {string|null}
 */
export function optionField(optsText, key) {
    const value = objectEntries(optsText).get(key);
    return value === undefined ? null : value;
}

/**
 * The names spread into an object literal (`{ ...plannerDispatchOpts, ... }`
 * -> ['plannerDispatchOpts']). A dispatch site whose options are mostly
 * inherited from a shared const is only readable once its spreads are known.
 *
 * @param {string} optsText
 * @returns {string[]}
 */
export function spreadsOf(optsText) {
    if (typeof optsText !== 'string') return [];
    const names = [];
    const re = /\.\.\.\s*([A-Za-z_$][\w$]*)/g;
    let m;
    const stripped = stripComments(optsText);
    while ((m = re.exec(stripped)) !== null) names.push(m[1]);
    return names;
}

/**
 * Value of a `const NAME = <number>;` declaration, or null.
 *
 * @param {string} src
 * @param {string} name
 * @returns {number|null}
 */
export function numericConstant(src, name) {
    const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const m = new RegExp(`(?:const|let|var)\\s+${escaped}\\s*=\\s*(\\d+)\\s*;`).exec(src);
    return m ? Number(m[1]) : null;
}

/**
 * True when `index` falls strictly inside one of `sites`' balanced ranges.
 *
 * @param {Array<{range:[number,number]}>} sites
 * @param {number} index
 * @returns {boolean}
 */
export function isInsideAnyCall(sites, index) {
    return sites.some((s) => index > s.range[0] && index < s.range[1]);
}

/**
 * The INNERMOST of `sites` whose balanced range strictly contains `index`, or
 * null. Innermost matters for withGitSync: the scoped-replan sites nest
 * nothing today, but a future edit that wraps one bracket in another must not
 * silently have its pins read the outer one.
 *
 * @param {Array<{range:[number,number]}>} sites
 * @param {number} index
 * @returns {object|null}
 */
export function innermostEnclosingCall(sites, index) {
    let best = null;
    for (const s of sites) {
        if (index > s.range[0] && index < s.range[1]) {
            if (!best || s.range[0] > best.range[0]) best = s;
        }
    }
    return best;
}

/**
 * The source text between two anchor substrings, for region-scoped assertions
 * (a ladder's retry/degrade handling, which is control flow rather than a call
 * site and so cannot be pinned from `callText` alone).
 *
 * @param {string} src
 * @param {string} startAnchor
 * @param {string} endAnchor
 * @returns {string}
 */
export function regionBetween(src, startAnchor, endAnchor) {
    const start = src.indexOf(startAnchor);
    if (start < 0) throw new Error(`region start anchor not found in source: ${JSON.stringify(startAnchor)}`);
    const end = src.indexOf(endAnchor, start + startAnchor.length);
    if (end < 0) throw new Error(`region end anchor not found in source: ${JSON.stringify(endAnchor)}`);
    return src.slice(start, end + endAnchor.length);
}
