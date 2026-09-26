import { test } from 'node:test';
import assert from 'node:assert';
import path from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs';
import { balancedCallRange } from './helpers/balanced-call-scanner.mjs';
// apra-fleet-3swo.5.7: the push flags now live in the policy table, so the
// census below reads them from there rather than from runner.js source.
// apra-fleet-j918.7.3: ROLE_POLICIES is also needed now that the runner.js
// call-site counts below are DERIVED from migration state instead of
// hand-maintained literals.
import { allDispatchPolicies, ROLE_POLICIES } from '../fleet-sprint/role-policies.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// =============================================================================
// apra-fleet-eft.8.2 -- dispatch sync-bracket coverage guard.
//
// Invariant under test: EVERY role-identified `agent(` dispatch call site in
// packages/apra-fleet-se/fleet-sprint/runner.js -- planner, plan-reviewer,
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

const RUNNER_PATH = path.join(__dirname, '../fleet-sprint/runner.js');

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
// 18 -> 20 agent()/16 -> 18 withGitSync (apra-fleet-eft.68.1): the in-cycle
// SCOPED replan added two new agent() dispatches in the develop loop -- the
// scoped planner and the scoped plan-review -- each wrapped in its own
// read-side (pushCode:false) withGitSync(...) bracket. The scoped planner's
// bracket additionally carries pushBeads:true (it re-scopes/mutates the
// flagged subtree); neither writes code, so pushCode:true stays at 4.
// 20 -> 22 agent()/18 -> 20 withGitSync (integ/regression split): the new
// once-per-sprint Regression Test phase adds its dispatch plus a
// max_turns-exhaustion resume, each in its own read-side (pushCode:false,
// pushBeads:true -- it files carry-over bug beads but never writes code)
// withGitSync(...) bracket. pushCode:true stays at 4.
// apra-fleet-j918.7.3 -- HISTORY UP TO HERE PRESERVED IN GIT, NOT RE-STATED:
// this comment block used to carry a hand-maintained magic number, bumped by
// hand on every one of the ~11 migration commits that moved a role's ladder
// off runner.js onto the dispatchRole engine (see `git log -p` on this file
// for the full sequence, "22 -> 20 agent()" through "2 -> 0"). Once EVERY role
// finished migrating (role-policies.mjs marks all 13 `migrated: true`), that
// literal was permanently pinned at 0 -- a runner.js text scan can no longer
// observe a regression in a migrated role's bracket, because the migrated
// dispatch's bracket is now DATA (role-policies.mjs's `bracket` field) read
// by ONE generic call site in fleet-sprint/dispatch-role.mjs, not source text
// in runner.js. Hardcoding the expected count to that permanent 0 meant this
// test could never again fail no matter what happened to a migrated role's
// bracket -- exactly the "permanently vacuous" defect apra-fleet-j918.7.3
// exists to fix.
//
// FIX: EXPECTED_AGENT_COUNT/EXPECTED_WITHGITSYNC_CALL_COUNT are now DERIVED
// from role-policies.mjs's migration state instead of hand-typed, so they
// self-adjust (instead of silently going stale) if a role's `migrated` flag
// is ever flipped without its runner.js ladder actually being added/removed.
// A non-migrated dispatch is still expected to have exactly one hand-written
// `agent(` call site in runner.js, wrapped by its own `withGitSync(...)` iff
// its policy row says `bracket.wrapped`.
//
// COVERAGE OWNERSHIP: the runner.js-only scan below can only ever prove
// things about NON-migrated dispatches (there are none left today, so both
// derived counts are 0, same as before) plus the narrower fact that no new
// ad hoc `agent(` ladder was hand-added to runner.js bypassing the engine.
// The property this test's TITLE claims -- "every dispatch is bracketed,
// full stop" -- is proved for MIGRATED roles by three other, non-runner.js-
// scanning guards that this file deliberately does not re-implement:
// test/git-sync-brackets.test.mjs's "(a)" case (declared-table coverage per
// role), test/role-policies-table.test.mjs (re-derives every bracket field
// from REAL behaviour by running the engine), and
// test/inline-ladder-guard.test.mjs (fails if a migrated role's inline
// ladder survives ANYWHERE in GUARDED_MODULES, not just runner.js). The
// direct policy-table check added to this test below intentionally restates
// git-sync-brackets.test.mjs's own per-role assertion rather than leaving
// this file silently unable to ever catch that class of regression again --
// see this bead's notes for why the file was repointed rather than deleted.
function nonMigratedDispatches() {
    return allDispatchPolicies().filter((p) => ROLE_POLICIES[p.ladder].migrated !== true);
}
const EXPECTED_AGENT_COUNT = nonMigratedDispatches().length;
const EXPECTED_WITHGITSYNC_CALL_COUNT = nonMigratedDispatches().filter((p) => p.bracket.wrapped).length;
// The exemption markers list is likewise derived: a non-migrated, genuinely
// unbracketed dispatch (like the old Streak Assignment ladder used to be)
// would need its own call-site marker added here so the census below can
// still tell "documented exemption" apart from "regression". Today there are
// zero non-migrated dispatches at all, so this is empty by derivation, not
// by a hand-typed literal -- and the sanity check right after this constant
// keeps that tied to the real table instead of drifting silently.
const STREAK_ASSIGNMENT_MARKERS = [];
assert.strictEqual(
    STREAK_ASSIGNMENT_MARKERS.length,
    nonMigratedDispatches().filter((p) => !p.bracket.wrapped).length,
    'STREAK_ASSIGNMENT_MARKERS must carry one marker per non-migrated, genuinely unbracketed dispatch -- ' +
    'add the new exemption marker here rather than letting this census go stale.'
);

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

// skipStringLiteral/balancedCallRange are shared with git-sync-brackets.
// test.mjs via ./helpers/balanced-call-scanner.mjs (apra-fleet-7h6n.3) --
// both files used to hand-roll their own near-identical copy.

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

    // apra-fleet-j918.7.3: the runner.js-only scan above cannot see a MIGRATED
    // role losing its bracket (its dispatch is DATA now, not runner.js text --
    // see the comment above EXPECTED_AGENT_COUNT). Re-assert the same fact
    // directly against the policy table so this test does not go permanently
    // blind to that regression class just because every role finished
    // migrating. This restates test/git-sync-brackets.test.mjs's own "(a)"
    // assertion deliberately -- it is intentional redundancy, not new
    // coverage, kept here rather than deleted per this bead's notes.
    const declaredUnbracketed = allDispatchPolicies().filter((p) => !p.bracket.wrapped);
    assert.deepStrictEqual(
        [...new Set(declaredUnbracketed.map((p) => p.role))],
        ['streak-assignment'],
        'Only the pure-compute Streak Assignment grouping call may be declared unbracketed in the policy table; ' +
        'every other dispatch, migrated or not, must carry bracket.wrapped === true.'
    );
});

test('pushCode is set true only for the code-writing dispatch roles (doer, harvester)', () => {
    // apra-fleet-3swo.5.7: RE-ANCHORED, not deleted. Every dispatch ladder has
    // migrated onto fleet-sprint/dispatch-role.mjs, whose single withGitSync
    // call passes an EXPRESSION (`dispatch.bracket.pushCode === true`) rather
    // than a literal, so there is nothing left in runner.js for the textual
    // scan to classify -- a scan that stayed here would pass vacuously forever.
    //
    // The FACT it pinned is unchanged and is asserted against the policy table
    // that now carries it, plus the guard that every bracket flag really is a
    // literal boolean in that table (which is what made the old scan possible).
    // The flags each dispatch's bracket actually RECEIVES are proved
    // behaviourally by test/execution-role-dispatch-pins.test.mjs and
    // test/planning-role-dispatch-pins.test.mjs, which run the real engine.
    const src = fs.readFileSync(RUNNER_PATH, 'utf8');
    const withGitSyncSites = findCallSites(src, 'withGitSync', { excludeDeclaration: true });
    assert.strictEqual(
        withGitSyncSites.length,
        EXPECTED_WITHGITSYNC_CALL_COUNT,
        'A new INLINE dispatch bracket must be added to this count deliberately, not slipped in.'
    );

    const codePushers = allDispatchPolicies().filter((p) => p.bracket.pushCode === true);
    assert.deepStrictEqual(
        codePushers.map((p) => p.role).sort(),
        ['doer', 'doer-resume', 'harvester', 'harvester'].sort(),
        'Exactly the doer pair and the harvester pair write code and therefore G-push; every other role is read-side.'
    );
    for (const p of allDispatchPolicies()) {
        if (!p.bracket.wrapped) {
            assert.strictEqual(p.bracket.pushCode, null, `${p.role}: an unbracketed dispatch carries no push flags.`);
            continue;
        }
        assert.ok(
            p.bracket.pushCode === true || p.bracket.pushCode === false || p.bracket.pushCode === null,
            `${p.role}: every bracketed dispatch must record a literal pushCode flag so this check can classify it.`
        );
    }
});
