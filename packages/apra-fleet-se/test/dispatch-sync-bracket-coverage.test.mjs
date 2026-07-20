import { test } from 'node:test';
import assert from 'node:assert';
import path from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// =============================================================================
// apra-fleet-eft.8.2 -- dispatch sync-bracket coverage guard.
//
// Invariant under test: EVERY role-identified `agent(` dispatch call site in
// packages/apra-fleet-se/auto-sprint/runner.js -- planner, plan-reviewer,
// doer, reviewer (both the mid-cycle and final-review dispatches), deployer,
// integ-test-runner, harvester -- must be wrapped by a `withGitSync(...)`
// bracket call (apra-fleet-eft.8.1's syncMemberBefore/syncMemberAfter G-pull/
// G-push pair, with the beads-side D-pull/D-push layered on top per
// apra-fleet-eft.9.1). dispatch-safety-guard.test.mjs already locks in that
// every `agent()`/`command()` call site carries an explicit member_name/
// member_id; THIS test locks in the orthogonal, previously-uncovered
// invariant that every one of the seven dispatch types is actually
// bracketed -- a future edit that adds a new dispatch (or accidentally
// un-nests an existing one from its withGitSync(...) wrapper, e.g. during a
// refactor) fails THIS test instead of silently shipping an unsynced
// dispatch that only surfaces as a stale-checkout/stale-beads bug on a real
// multi-member fleet run.
//
// There is exactly ONE documented, deliberate exception: the "Streak
// Assignment" dispatch (see its own call-site comment in runner.js, just
// above the seven-dispatch-table comment). It carries no `agentType`/persona
// of its own, is not one of the seven dispatch types the 3.3 insertion-point
// table covers, and is explicitly called out as deliberately NOT bracketed.
// This test asserts there is exactly one such exception (identified
// structurally, by the `label: 'Streak Assignment'` literal every other
// dispatch call site lacks -- not by a brittle line number) and that every
// OTHER agent() call site is contained inside a withGitSync(...) call.
//
// Parsing approach mirrors dispatch-safety-guard.test.mjs: a real
// bracket-aware call-site parse (paired parens, skipping over string/
// template-literal contents) rather than a naive line grep, so a call site
// that spans multiple lines or contains nested parens (e.g. a template
// literal shell command) is never mis-parsed.
// =============================================================================

const RUNNER_PATH = path.join(__dirname, '../auto-sprint/runner.js');

// Kept in sync with dispatch-safety-guard.test.mjs's EXPECTED_AGENT_COUNT --
// see that file's header comment for the baseline-count rationale. If that
// count changes, this test's expectations (9 wrapped + 1 documented
// exemption) must be re-verified against the new call sites, not just bumped
// blindly.
//
// Bumped 9 -> 10 agent()/8 -> 9 withGitSync (2026-07-19): the doer
// max_turns-exhaustion resume path (dispatchDoerResume) is the SAME logical
// doer streak continuing (same session, same code/bead-writing
// responsibilities), so it is wrapped in its own withGitSync(...) bracket
// identical in shape to the original dispatchDoer -- one new agent() call
// site, one new withGitSync(...) call site.
// Bumped 10 -> 11 agent()/9 -> 10 withGitSync (2026-07-19, stabilization
// log Issue 9): dispatchReview() gained a reviewer max_turns-exhaustion
// resume path (dispatchReviewerResume), the same shape as the doer's --
// the SAME logical review continuing in the same session, wrapped in its
// own read-side (pushCode: false) withGitSync(...) bracket. One new
// agent() call site, one new withGitSync(...) call site.
// 11 -> 12 agent()/10 -> 11 withGitSync (stabilization log iteration 5):
// Final Review resume-and-continue (dispatchFinalReviewResume), a
// read-side bracket like the per-round reviewer resume.
// 12 -> 13: Streak Assignment semantic-repair re-ask -- the second
// documented exemption (same pure-compute grouping task as the first;
// no repo access, so no sync bracket).
const EXPECTED_AGENT_COUNT = 18;
const EXPECTED_WITHGITSYNC_CALL_COUNT = 16;
const STREAK_ASSIGNMENT_MARKERS = [
    "label: 'Streak Assignment'",
    "label: 'Streak Assignment (semantic repair)'",
];

/** Same helper as dispatch-safety-guard.test.mjs: is `col` inside an open same-line quote? */
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

/** Returns the index of the closing quote char matching the one at `start`. */
function skipStringLiteral(src, start, quoteChar) {
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
 * depth and skipping over string/template-literal contents.
 */
function balancedCallRange(src, openParenIdx) {
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

/**
 * Finds every real (non-comment, non-string-literal) call site of `fnName(`
 * in `src`. Returns `{ index, line, callText, range: [start, end] }` for each.
 * `excludeDeclaration` additionally skips a site whose containing line
 * starts (after trim) with `function`/`async function` -- i.e. a function
 * DEFINITION rather than a call (withGitSync's own `async function
 * withGitSync(...)` declaration line matches the naive `withGitSync(` regex
 * otherwise).
 */
function findCallSites(src, fnName, { excludeDeclaration = false } = {}) {
    const lines = src.split('\n');
    const lineStarts = [];
    let offset = 0;
    for (const line of lines) {
        lineStarts.push(offset);
        offset += line.length + 1;
    }
    function lineNumberForIndex(idx) {
        let ln = 0;
        for (let i = 0; i < lineStarts.length; i++) {
            if (lineStarts[i] > idx) break;
            ln = i;
        }
        return ln + 1;
    }
    function isCommentLine(ln) {
        const text = lines[ln - 1] ? lines[ln - 1].trim() : '';
        return text.startsWith('//') || text.startsWith('*') || text.startsWith('/*');
    }
    function isDeclarationLine(ln) {
        const text = lines[ln - 1] ? lines[ln - 1].trim() : '';
        return /^(async\s+)?function\b/.test(text);
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

test('every agent() dispatch call site is either wrapped by withGitSync(...) or is the one documented exemption', () => {
    const src = fs.readFileSync(RUNNER_PATH, 'utf8');

    const agentSites = findCallSites(src, 'agent');
    const withGitSyncSites = findCallSites(src, 'withGitSync', { excludeDeclaration: true });

    assert.strictEqual(
        agentSites.length,
        EXPECTED_AGENT_COUNT,
        `Expected ${EXPECTED_AGENT_COUNT} agent() call site(s) in runner.js, found ${agentSites.length}. ` +
        `Keep this in sync with dispatch-safety-guard.test.mjs's EXPECTED_AGENT_COUNT.`
    );
    assert.strictEqual(
        withGitSyncSites.length,
        EXPECTED_WITHGITSYNC_CALL_COUNT,
        `Expected ${EXPECTED_WITHGITSYNC_CALL_COUNT} withGitSync(...) call site(s) in runner.js, found ${withGitSyncSites.length}. ` +
        `A new dispatch site must be wrapped in a withGitSync(...) call (or, if it is genuinely one of the ` +
        `non-dispatch exceptions like Streak Assignment, this count should stay unchanged).`
    );

    const exemptSites = agentSites.filter((s) => STREAK_ASSIGNMENT_MARKERS.some((m) => s.callText.includes(m)));
    assert.strictEqual(
        exemptSites.length,
        STREAK_ASSIGNMENT_MARKERS.length,
        `Expected exactly ${STREAK_ASSIGNMENT_MARKERS.length} documented agent() exemptions (the Streak Assignment ` +
        `dispatch and its semantic-repair re-ask, identified by ${STREAK_ASSIGNMENT_MARKERS.join(' / ')}), found ` +
        `${exemptSites.length}. A new unbracketed dispatch must not silently reuse these markers to escape ` +
        `coverage, and the real call sites must not have been renamed without updating this test.`
    );

    const coveredSites = agentSites.filter((s) => !exemptSites.includes(s));
    assert.strictEqual(
        coveredSites.length,
        EXPECTED_AGENT_COUNT - STREAK_ASSIGNMENT_MARKERS.length,
        'Every agent() call site other than the one documented Streak Assignment exemption must be a dispatch this test checks for withGitSync coverage.'
    );

    const uncovered = coveredSites.filter((agentSite) => {
        return !withGitSyncSites.some((wgs) => agentSite.index > wgs.range[0] && agentSite.index < wgs.range[1]);
    });

    assert.deepStrictEqual(
        uncovered.map((s) => `runner.js:${s.line}`),
        [],
        `Found ${uncovered.length} agent() dispatch call site(s) NOT wrapped by withGitSync(...): ` +
        `${uncovered.map((s) => `runner.js:${s.line}`).join(', ')}. Every one of the seven dispatch types must be ` +
        `bracketed by withGitSync(...) per the Plan 3.3 insertion-point table (apra-fleet-eft.8.2) -- a new ` +
        `dispatch added outside that bracket is exactly the regression this test exists to catch.`
    );
});

test('pushCode is set true only for the code-writing dispatch roles (doer, harvester)', () => {
    const src = fs.readFileSync(RUNNER_PATH, 'utf8');
    const withGitSyncSites = findCallSites(src, 'withGitSync', { excludeDeclaration: true });

    assert.strictEqual(withGitSyncSites.length, EXPECTED_WITHGITSYNC_CALL_COUNT);

    // Each withGitSync(member, pushCode, dispatchFn, opts) call's second
    // positional argument is the literal `true`/`false` pushCode flag at
    // every current call site (never a variable) -- extract it directly via
    // a narrow, call-site-scoped regex rather than a full expression parser.
    // `callText` here is the balanced-paren slice starting at the opening
    // '(' itself (NOT prefixed with the `withGitSync` identifier), so the
    // pattern anchors on `^\(` rather than `withGitSync\(`.
    const pushCodeTrueSites = withGitSyncSites.filter((s) => /^\([^,]+,\s*true\s*,/.test(s.callText));
    const pushCodeFalseSites = withGitSyncSites.filter((s) => /^\([^,]+,\s*false\s*,/.test(s.callText));

    assert.strictEqual(
        pushCodeTrueSites.length + pushCodeFalseSites.length,
        withGitSyncSites.length,
        'Every withGitSync(...) call site must pass a literal true/false pushCode argument (second positional arg) so this check can classify it.'
    );

    // Two roles write code today: doer and harvester -- but doer now has TWO
    // pushCode:true sites (dispatchDoer and its max_turns-exhaustion
    // dispatchDoerResume, the same logical streak continuing), so 3 sites
    // total: doer, doer-resume, harvester.
    assert.strictEqual(
        pushCodeTrueSites.length,
        4,
        `Expected exactly 4 withGitSync(...) call sites with pushCode:true (doer, doer-resume, harvester, harvester-resume), found ${pushCodeTrueSites.length}.`
    );
    for (const site of pushCodeTrueSites) {
        assert.ok(
            /agentType:\s*'doer'/.test(site.callText) || /getMemberForRole\('harvester'\)/.test(site.callText),
            `withGitSync(...) call site with pushCode:true must be doer or harvester, got: ${site.callText.slice(0, 120)}...`
        );
    }
});
