import { test, describe } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// apra-fleet-eft.37.5: enforcement test for
// docs/workflow-core-boundary-refactoring.md's boundary rule -- CORE
// (packages/apra-fleet-workflow/src) must stay domain-neutral. auto-sprint
// (packages/apra-fleet-se) is one workflow built on top of this generic
// engine + viewer; it must never leak its own vocabulary (sprintId,
// sprint-logs/old_sprints paths, verdict/prUrl, the beads extension's
// naming) into core CODE.
//
// Scope: src/ only (NOT test/) -- test fixtures/mocks are allowed to use
// whatever domain vocabulary they like.
//
// "CODE positions" means identifier or string-literal positions, i.e.
// comments are stripped before scanning (see stripComments()) -- prose
// mentioning these words in an explanatory comment is fine; the same word
// used as an actual identifier or embedded in a string a core code path
// branches/writes on is not.

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SRC_DIR = path.join(__dirname, '..', 'src');

const FORBIDDEN_WORDS = [
    'sprintId',
    'sprint-logs',
    'old_sprints',
    'verdict',
    'prUrl',
    'beads',
    'sprintTasks',
    'backlogTasks',
];

function listSrcFiles(dir) {
    const out = [];
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
            out.push(...listSrcFiles(full));
        } else if (/\.mjs$/.test(entry.name)) {
            out.push(full);
        }
    }
    return out;
}

/**
 * Blanks out `//` line comments and `/* ... *\/` block comments with
 * spaces, leaving every other character -- crucially, string content --
 * untouched, and NEVER removing a newline, so line numbers in the output
 * line up exactly with the original source.
 *
 * This is a lightweight tokenizer, not a full JS parser, but it does track
 * enough nesting to handle this file's one genuinely tricky case: the
 * HTML_TEMPLATE backtick literal in viewer/index.mjs embeds a whole served
 * HTML/CSS/JS document as template-literal TEXT, which itself contains real
 * `//`/`/* *\/` comments (CSS/client-JS comments, never evaluated as core
 * JS) interleaved with `${...}` interpolations that ARE real core JS. So:
 *  - plain '/"  strings: comment markers inside them are inert, as usual.
 *  - backtick (template) text: comment markers inside it are treated as
 *    real comments and stripped too (this is what lets a stray "sprint"/
 *    "beads" mention in an embedded CSS/JS comment count as a comment
 *    rather than a "string literal" hit).
 *  - a `${` inside backtick text switches back to real-JS-code rules
 *    (its own comments/strings/nested backticks) until the matching `}`.
 */
export function stripComments(src) {
    let out = '';
    let i = 0;
    const n = src.length;
    // Stack of modes: 'code' (real JS, including inside ${...}), 'squote',
    // 'dquote', 'template' (raw backtick text). braceDepth[k] is only used
    // when stack[k] === 'code' AND it was entered via a `${` (i.e. every
    // 'code' frame past the first tracks the brace depth needed to find
    // its own closing `}`); the base/outermost 'code' frame's entry is null.
    const stack = [{ mode: 'code', braceDepth: null }];
    const top = () => stack[stack.length - 1];

    const stripLineComment = () => {
        while (i < n && src[i] !== '\n') { out += ' '; i += 1; }
    };
    const stripBlockComment = () => {
        out += '  ';
        i += 2;
        while (i < n && !(src[i] === '*' && i + 1 < n && src[i + 1] === '/')) {
            out += src[i] === '\n' ? '\n' : ' ';
            i += 1;
        }
        if (i < n) { out += '  '; i += 2; }
    };

    while (i < n) {
        const frame = top();
        const c = src[i];
        const c2 = i + 1 < n ? src[i + 1] : '';

        if (frame.mode === 'squote' || frame.mode === 'dquote') {
            const quote = frame.mode === 'squote' ? '\'' : '"';
            if (c === '\\') { out += c + c2; i += 2; continue; }
            out += c;
            if (c === quote) stack.pop();
            i += 1;
            continue;
        }

        if (frame.mode === 'template') {
            if (c === '\\') { out += c + c2; i += 2; continue; }
            if (c === '`') { out += c; stack.pop(); i += 1; continue; }
            if (c === '$' && c2 === '{') {
                out += '${';
                stack.push({ mode: 'code', braceDepth: 1 });
                i += 2;
                continue;
            }
            // Raw served-template text: real CSS/HTML/JS source, with its
            // own genuine comments -- strip them the same as top-level code.
            if (c === '/' && c2 === '/') { stripLineComment(); continue; }
            if (c === '/' && c2 === '*') { stripBlockComment(); continue; }
            if (c === '<' && src.startsWith('<!--', i)) {
                out += '    ';
                i += 4;
                while (i < n && !src.startsWith('-->', i)) {
                    out += src[i] === '\n' ? '\n' : ' ';
                    i += 1;
                }
                if (i < n) { out += '   '; i += 3; }
                continue;
            }
            out += c;
            i += 1;
            continue;
        }

        // frame.mode === 'code' (either the outermost file, or a ${...}
        // interpolation -- both are real JS with identical rules).
        if (c === '/' && c2 === '/') { stripLineComment(); continue; }
        if (c === '/' && c2 === '*') { stripBlockComment(); continue; }
        if (c === '\'') { out += c; stack.push({ mode: 'squote' }); i += 1; continue; }
        if (c === '"') { out += c; stack.push({ mode: 'dquote' }); i += 1; continue; }
        if (c === '`') { out += c; stack.push({ mode: 'template' }); i += 1; continue; }
        if (frame.braceDepth !== null) {
            if (c === '{') frame.braceDepth += 1;
            else if (c === '}') {
                frame.braceDepth -= 1;
                if (frame.braceDepth === 0) {
                    out += c;
                    i += 1;
                    stack.pop();
                    continue;
                }
            }
        }
        out += c;
        i += 1;
    }
    return out;
}

/**
 * Scans already-comment-stripped `code` for FORBIDDEN_WORDS occurrences in
 * code positions (identifier or string-literal -- stripComments() leaves
 * both intact). Returns hits sorted by source position; `line` is 1-based
 * and lines up with the ORIGINAL (unstripped) source since stripComments()
 * never removes newlines.
 */
export function scanForbiddenWords(code) {
    const hits = [];
    for (const word of FORBIDDEN_WORDS) {
        const escaped = word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const re = new RegExp(`(?<![A-Za-z0-9_])${escaped}(?![A-Za-z0-9_])`, 'g');
        let m;
        while ((m = re.exec(code)) !== null) {
            const line = code.slice(0, m.index).split('\n').length;
            hits.push({ word, line, index: m.index });
        }
    }
    return hits.sort((a, b) => a.index - b.index);
}

// The design doc's Enforcement section names exactly two back-compat
// identifier shims (M1: rename sprintId -> runId): "legacy opts.sprintId
// acceptance" and "old_sprints read fallback". Its separate M3 section (the
// on-demand-detail hook refactor, apra-fleet-eft.37.4) later sanctioned one
// more, narrower exception of its own -- the old GET /beads/:id/description
// route kept as a 302 alias "for one release" -- and that landed already
// tagged BOUNDARY-COMPAT too. All three are declared explicitly below, each
// anchored to its own BOUNDARY-COMPAT comment (not a hardcoded line number,
// so incidental reflow of surrounding code doesn't break this test); a
// forbidden-word occurrence anywhere in src/ that does NOT fall within one
// of these three declared windows is an unguarded leak and fails the test
// below. A fourth (or any additional) shim also fails it.
const ALLOWED_SHIMS = [
    {
        name: 'M1: legacy opts.sprintId acceptance',
        file: 'viewer/index.mjs',
        anchorRe: /BOUNDARY-COMPAT: opts\.sprintId is the pre-rename alias for opts\.runId\./,
        window: 10,
    },
    {
        name: 'M1: old_sprints read fallback',
        file: 'viewer/run-state-paths.mjs',
        anchorRe: /BOUNDARY-COMPAT: terminal run state written by pre-runId releases/,
        window: 12,
    },
    {
        name: 'M3: pre-rename /beads/ route alias (one release only)',
        file: 'viewer/index.mjs',
        anchorRe: /BOUNDARY-COMPAT \(apra-fleet-eft\.37\.4, one release only/,
        window: 14,
    },
];

function resolveShimRanges(contentsByRelPath) {
    return ALLOWED_SHIMS.map((shim) => {
        const content = contentsByRelPath[shim.file];
        assert.ok(content, `expected src file "${shim.file}" to exist for shim "${shim.name}"`);
        const lines = content.split('\n');
        const anchorLineIdx = lines.findIndex((l) => shim.anchorRe.test(l));
        assert.ok(
            anchorLineIdx !== -1,
            `expected to find the BOUNDARY-COMPAT anchor comment for shim "${shim.name}" in ${shim.file}`
        );
        const anchorLine = anchorLineIdx + 1; // 1-based
        return {
            ...shim,
            anchorLine,
            minLine: anchorLine - shim.window,
            maxLine: anchorLine + shim.window,
        };
    });
}

function loadSrcContents() {
    const files = listSrcFiles(SRC_DIR);
    const contents = {};
    for (const file of files) {
        const relPath = path.relative(SRC_DIR, file).split(path.sep).join('/');
        contents[relPath] = fs.readFileSync(file, 'utf8');
    }
    return contents;
}

describe('boundary-no-domain-leakage', () => {
    test('src/ has no forbidden se/auto-sprint identifiers outside the declared BOUNDARY-COMPAT shims', () => {
        const contents = loadSrcContents();
        const shimRanges = resolveShimRanges(contents);
        const violations = [];
        const shimHitCounts = new Map(shimRanges.map((s) => [s.name, 0]));

        for (const [relPath, raw] of Object.entries(contents)) {
            const code = stripComments(raw);
            const hits = scanForbiddenWords(code);
            for (const hit of hits) {
                const coveringShim = shimRanges.find(
                    (s) => s.file === relPath && hit.line >= s.minLine && hit.line <= s.maxLine
                );
                if (coveringShim) {
                    shimHitCounts.set(coveringShim.name, shimHitCounts.get(coveringShim.name) + 1);
                } else {
                    violations.push(
                        `${relPath}:${hit.line} forbidden identifier "${hit.word}" outside any declared BOUNDARY-COMPAT shim`
                    );
                }
            }
        }

        assert.deepStrictEqual(
            violations,
            [],
            `unguarded domain-leakage found (a 3rd/unlisted occurrence):\n${violations.join('\n')}`
        );

        // Every declared shim must actually be guarding a real occurrence --
        // a shim whose forbidden word has since been deleted from the code
        // is dead compat weight the allowlist should stop carrying.
        for (const shim of shimRanges) {
            assert.ok(
                shimHitCounts.get(shim.name) > 0,
                `expected shim "${shim.name}" to guard at least one forbidden-identifier occurrence -- ` +
                    'remove the stale BOUNDARY-COMPAT allowlist entry if it no longer does'
            );
        }

        // Exactly the 2 explicit back-compat identifier shims the design
        // doc's Enforcement section allowlists by name.
        const m1ShimCount = shimRanges.filter((s) => s.name.startsWith('M1:')).length;
        assert.strictEqual(
            m1ShimCount,
            2,
            'expected exactly 2 BOUNDARY-COMPAT-tagged M1 back-compat identifier shims ' +
                '(legacy opts.sprintId acceptance; old_sprints read fallback)'
        );
        // Plus exactly the 1 M3 route-alias exception -- a 2nd such alias
        // (or its disappearance) fails.
        const m3ShimCount = shimRanges.filter((s) => s.name.startsWith('M3:')).length;
        assert.strictEqual(m3ShimCount, 1, 'expected exactly 1 BOUNDARY-COMPAT-tagged M3 route-alias shim');
    });

    test('scanner catches a forbidden identifier seeded into src with no BOUNDARY-COMPAT tag (mutation self-check)', () => {
        // Self-mutation check: prove the scanner used above would actually
        // fail the suite if a forbidden identifier were introduced into src/
        // without a BOUNDARY-COMPAT tag, by feeding it a synthetic mutated
        // copy of a real, currently-clean src file. This never writes to the
        // real file on disk -- it only exercises the same stripComments() /
        // scanForbiddenWords() pipeline the enforcement test above uses.
        const contents = loadSrcContents();
        const cleanRelPath = 'viewer/lean-state.mjs';
        const clean = contents[cleanRelPath];
        assert.ok(clean, `fixture file ${cleanRelPath} missing`);

        const cleanHits = scanForbiddenWords(stripComments(clean));
        assert.deepStrictEqual(
            cleanHits,
            [],
            `expected ${cleanRelPath} to have zero forbidden-identifier occurrences before mutation`
        );

        const seededViolation = '\nconst leaked = { verdict: "seeded-violation", prUrl: "seeded" };\n';
        const mutated = clean + seededViolation;
        const mutatedHits = scanForbiddenWords(stripComments(mutated));
        const mutatedWords = mutatedHits.map((h) => h.word).sort();
        assert.deepStrictEqual(
            mutatedWords,
            ['prUrl', 'verdict'],
            'expected the scanner to catch both seeded forbidden identifiers'
        );
    });

    test('no non-compat "sprint" prose remains in the served viewer HTML/client-script template', () => {
        const contents = loadSrcContents();
        const indexContent = contents['viewer/index.mjs'];
        const startMarker = 'const HTML_TEMPLATE = ';
        const startIdx = indexContent.indexOf(startMarker);
        assert.ok(startIdx !== -1, 'expected to find HTML_TEMPLATE definition in viewer/index.mjs');
        const endIdx = indexContent.indexOf('\n};', startIdx);
        assert.ok(endIdx !== -1, 'expected to find the end of the HTML_TEMPLATE definition');
        const templateSrc = indexContent.slice(startIdx, endIdx);

        // Blank out ${...} JS interpolations (brace-depth counted, so
        // nested template literals inside an interpolation -- e.g. the
        // dashboardExtensions.map(...) tab-button markup -- are fully
        // consumed): that content is either generic (ext.id/ext.title) or
        // extension-owned, and extensions are free to say "sprint".
        let staticParts = '';
        let i = 0;
        while (i < templateSrc.length) {
            if (templateSrc[i] === '$' && templateSrc[i + 1] === '{') {
                let depth = 1;
                i += 2;
                while (i < templateSrc.length && depth > 0) {
                    if (templateSrc[i] === '{') depth += 1;
                    else if (templateSrc[i] === '}') depth -= 1;
                    staticParts += templateSrc[i] === '\n' ? '\n' : ' ';
                    i += 1;
                }
                continue;
            }
            staticParts += templateSrc[i];
            i += 1;
        }

        const offenders = [];
        staticParts.split('\n').forEach((line, idx) => {
            const withoutAutoSprint = line.replace(/auto-sprint/gi, '');
            if (/sprint/i.test(withoutAutoSprint)) {
                offenders.push(`template line ~${idx + 1}: ${line.trim()}`);
            }
        });
        assert.deepStrictEqual(
            offenders,
            [],
            `non-compat "sprint" prose found in the served viewer template:\n${offenders.join('\n')}`
        );
    });
});
