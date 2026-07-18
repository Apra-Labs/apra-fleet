import { test } from 'node:test';
import assert from 'node:assert';
import path from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// =============================================================================
// apra-fleet-eft.3.1 (Plan Part 1.6) -- Dispatch-safety guard test.
//
// Invariant under test: EVERY `command(` / `agent(` call site in
// packages/apra-fleet-se/auto-sprint/runner.js must supply an explicit
// `member_name` (or `member_id`) in its options object. The workflow engine
// throws if neither is supplied, with no local-execution/"ambient member"
// fallback -- this test locks that invariant in at the source level so a
// future edit cannot silently introduce a call site that omits it (which
// would only surface at runtime, on a real fleet dispatch, in whatever
// heterogeneous-member topology happens to be running that day).
//
// This is a real (bracket-aware) call-site parse, not a naive line grep:
// each `command(`/`agent(` token is paired with its matching closing paren
// (skipping over string/template-literal contents so parens embedded in a
// shell command string, e.g. `${beadIds.join(' ')}`, can never be
// mis-attributed as call-site punctuation), and the resulting call-site
// text is checked for `member_name`/`member_id`. Full-line comments (a line
// whose trimmed text starts with `//` or `*`, i.e. JSDoc/line-comment
// bodies) are skipped so comments that merely MENTION `command()`/`agent()`
// prose-style (there are many in runner.js) are never counted as call
// sites.
//
// Baseline (verified against current HEAD by manual review of every site
// this parser finds, packages/apra-fleet-se/auto-sprint/runner.js as of
// apra-fleet-eft.3.1): 20 command() call sites and 9 agent() call sites,
// all 29 compliant. (The parent feature's description cites an earlier
// "12 command() / 9 agent()" audit figure; the file has grown call sites
// since that audit was written, e.g. finalizeAbort()'s two command() sites
// and bdListScoped()'s two command() sites. This test asserts the CURRENT,
// re-verified count so it passes on current HEAD, per its own acceptance
// criteria -- an out-of-date fixed number would defeat the test's purpose
// of catching real drift.) If this test's baseline counts need to change,
// that is a deliberate, reviewable signal: either a call site was added
// (bump the count, after confirming member_name/member_id is present) or
// one was silently dropped (an actual regression -- do NOT just bump the
// count without checking why).
// =============================================================================

const RUNNER_PATH = path.join(__dirname, '../auto-sprint/runner.js');
// Branch-split convention (established when the three auto-sprint
// stabilization fixes -- auto-sprint-9's branch-adopt fix, auto-sprint-3's
// bdListScoped rewrite, and the failSoft-discrimination follow-up -- were
// moved to feat/fleet-reorg and this branch was rebased on top of it):
// feat/fleet-reorg carries only those stabilization fixes and has NO
// eft-feature-specific runner.js additions, so ITS copy of this test asserts
// 18 command() sites. THIS branch (auto-sprint/eft-service) additionally
// carries eft-feature work (e.g. finalizeAbort()'s two dispatch sites,
// supervisor-skeleton additions) on top of that same base. Do not resolve a
// future count mismatch between the two branches by just copying one
// branch's number into the other -- confirm which commits actually
// introduced the delta first.
//
// Bumped 21 -> 22 (2026-07-18): commit 6d348f1a (apra-fleet-eft.8.1,
// syncMemberBefore/syncMemberAfter G-pull/G-push helpers) added exactly one
// new real command() call site (the injected `command(cmd, { member_name:
// member, ... })` inside runGitStep()), verified compliant. That commit's
// two `throw new Error("... requires an injected command() in opts")`
// lines are NOT call sites -- they were a false-positive in this test's own
// parser (the literal text "command()" inside a plain string), fixed here
// via isInsideSameLineString().
const EXPECTED_COMMAND_COUNT = 22;
// Bumped 9 -> 10 (2026-07-18): the doer max_turns-exhaustion resume path
// (dispatchDoerResume) adds one new agent() call site -- a resume-and-continue
// dispatch on the SAME session with an escalated max_turns, verified compliant
// with member_name.
const EXPECTED_AGENT_COUNT = 10;

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
 * Scans `src` for `command(`/`agent(` call sites, skipping call-site tokens
 * that only appear inside a full-line comment. Returns an array of
 * { fnName, line, callText } for every real call site found.
 */
function findCallSites(src) {
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

/**
 * Given the index of an opening '(' in `src`, returns the full call-site
 * text from that '(' through its matching ')', tracking paren depth and
 * skipping over string/template-literal contents (so parens embedded in
 * string/template content, e.g. `bd show ${ids.join(' ')}`, never disturb
 * the depth count).
 */
function extractBalancedCall(src, openParenIdx) {
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

/** Returns the index of the closing quote char matching the one at `start`. */
function skipStringLiteral(src, start, quoteChar) {
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

test('every command()/agent() call site in runner.js passes member_name or member_id', () => {
    const src = fs.readFileSync(RUNNER_PATH, 'utf8');
    const sites = findCallSites(src);

    const commandSites = sites.filter((s) => s.fnName === 'command');
    const agentSites = sites.filter((s) => s.fnName === 'agent');

    // Baseline counts asserted explicitly: a future edit that silently
    // DROPS a call site (e.g. a refactor that inlines a dispatch behind a
    // helper this parser can no longer see) changes these counts even
    // though every remaining site is individually compliant, and must be
    // caught rather than passing silently.
    assert.strictEqual(
        commandSites.length,
        EXPECTED_COMMAND_COUNT,
        `Expected ${EXPECTED_COMMAND_COUNT} command() call site(s) in runner.js, found ${commandSites.length}. ` +
        `If a call site was intentionally added or removed, update EXPECTED_COMMAND_COUNT after confirming ` +
        `every site still passes member_name/member_id.`
    );
    assert.strictEqual(
        agentSites.length,
        EXPECTED_AGENT_COUNT,
        `Expected ${EXPECTED_AGENT_COUNT} agent() call site(s) in runner.js, found ${agentSites.length}. ` +
        `If a call site was intentionally added or removed, update EXPECTED_AGENT_COUNT after confirming ` +
        `every site still passes member_name/member_id.`
    );

    const memberRe = /\b(member_name|member_id)\b/;
    const violations = sites
        .filter((s) => !memberRe.test(s.callText))
        .map((s) => `runner.js:${s.line} (${s.fnName}()) is missing member_name/member_id`);

    assert.deepStrictEqual(
        violations,
        [],
        `Found ${violations.length} dispatch-safety violation(s):\n${violations.join('\n')}`
    );
});
