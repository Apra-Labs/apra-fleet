import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createSyncBrackets, createGitSync } from '../fleet-sprint/git-sync.mjs';
import { syncMemberAfter } from '../fleet-sprint/runner.js';
import { guardedModulePath } from '../fleet-sprint/guarded-modules.mjs';
import { findUnbracketedPushViolations, checkUnbracketedPushPath } from '../fleet-sprint/unbracketed-push-guard.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// =============================================================================
// apra-fleet-3swo.4.2 -- both pause-bracket holes the epic named are closed,
// and a pause cannot land mid-push.
//
// apra-fleet-3swo.4.1 moved the open-sync-bracket counter into git-sync.mjs
// and rewired the two known holes -- the Final Review findings D-push
// (runner.js's `dPushNeededAfterFinalFindings` branch) and the Publish-PR
// G-push (`publishGitMember`'s push) -- from a BARE doltPushAfter()/
// syncMemberAfter() call to gitSync.pushBeadsAfter()/gitSync.pushGitAfter(),
// the bracketed standalone entry points createGitSync() returns. This suite
// is the regression lock for that fix:
//
//   1/2. Drive each bracketed entry point directly (not through a full mock
//        sprint) with an injected SLOW command(), and prove the clean-state
//        pause guard reads false for the WHOLE duration of the push -- not
//        just "eventually true" -- and true again only once it resolves.
//        NOTE: these two tests exercise git-sync.mjs's entry points
//        directly, not runner.js's actual Final Review / Publish-PR code
//        paths; the link back to runner.js is the by-name source pins in the
//        second describe block below (`gitSync.pushBeadsAfter(` /
//        `gitSync.pushGitAfter(publishGitMember,`). This is a real chain --
//        both the entry points' bracket behaviour AND runner.js's use of
//        them by name are pinned -- but it is not, by itself, an end-to-end
//        test of the Final Review/Publish-PR branches through a live sprint.
//   3.   A source-level scan of runner.js (read via the shared guarded-module
//        list, guarded-modules.mjs, per apra-fleet-3swo.8's registration
//        convention), factored into fleet-sprint/unbracketed-push-guard.mjs
//        and registered in the shared guard module list (wired into
//        runAllGuards() in guarded-modules-coverage.test.mjs) so it stays
//        covered the same way the other three mechanical guards do. It
//        proves there is no bare, unbracketed call site left for any of the
//        four raw sync/push primitives (doltPushAfter, syncMemberAfter,
//        DoltSync.syncBefore, DoltSync.syncAfter) outside the two
//        structurally-sanctioned wrapper functions (syncMemberAfterOrdered,
//        verifyDoerStreakClosed) that are themselves only ever reached from
//        inside an open bracket.
//   4.   Falsification: a fixture reproducing the pre-3swo.4.1 shape (a bare
//        doltPushAfter()/syncMemberAfter()/DoltSync.syncBefore()/
//        DoltSync.syncAfter() call sitting outside any bracket) must make the
//        scan report a violation -- proving the scan can actually fail, not
//        just vacuously pass against clean source.
// =============================================================================

function deferred() {
    let resolve;
    const promise = new Promise((res) => { resolve = res; });
    return { promise, resolve };
}

/**
 * A command() mock where the FIRST call whose command string includes
 * `slowMatch` blocks on an externally-controlled gate before resolving `ok`
 * -- letting a test observe bracket/guard state while that "push" is still
 * in flight. Every other call resolves immediately with a generic ok result
 * (sufficient for the pre-gates doltPushAfter/syncMemberAfter run before the
 * push itself, e.g. isMemberSyncRemoteConfigured's `bd config get
 * sync.remote` probe, which fails safe -- "configured" -- on the empty
 * output this mock returns for it).
 */
function makeSlowCommandMock(slowMatch) {
    const calls = [];
    const gate = deferred();
    let gateHit = false;
    const command = async (cmd, opts = {}) => {
        calls.push({ cmd, opts });
        if (!gateHit && cmd.includes(slowMatch)) {
            gateHit = true;
            await gate.promise;
        }
        return { ok: true, output: '', error: null };
    };
    return { command, calls, resolveGate: gate.resolve, wasGateHit: () => gateHit };
}

// Yield the microtask queue a few times so an async function's execution
// reaches (and blocks on) the gate before the test inspects bracket state.
async function letMicrotasksDrain() {
    for (let i = 0; i < 5; i++) await Promise.resolve();
}

describe('apra-fleet-3swo.4.2: the pause guard is false for the FULL duration of both known holes', () => {
    test('(1) Final Review findings D-push (gitSync.pushBeadsAfter) -- guard false throughout, true only after the push resolves', async () => {
        let guard = null;
        const brackets = createSyncBrackets({ setPauseGuard: (fn) => { guard = fn; } });
        const { command, calls, resolveGate, wasGateHit } = makeSlowCommandMock('bd dolt push');
        const gitSync = createGitSync({ brackets, command, log: () => {}, doltPushMutex: undefined, sprintId: 'sprint-3swo-4-2' });

        assert.equal(guard(), true, 'idle before any push: guard must permit a pause');
        assert.equal(brackets.openBracketCount(), 0);

        const pushPromise = gitSync.pushBeadsAfter('memberA', { pushBeads: true });
        await letMicrotasksDrain();

        assert.ok(wasGateHit(), 'precondition: the mock D-push must actually be in flight (gate reached) before asserting guard state');
        assert.equal(brackets.openBracketCount(), 1, 'the sync bracket must be open for the WHOLE duration of the D-push');
        assert.equal(guard(), false, 'the clean-state pause guard must DENY a pause while the Final Review D-push is in flight');

        resolveGate();
        const res = await pushPromise;

        assert.equal(res.ok, true, 'sanity: the D-push itself must have completed successfully');
        assert.equal(res.pushed, true, 'sanity: this was a real (non-skipped) push');
        assert.ok(calls.some((c) => c.cmd.includes('bd dolt push')), 'sanity: a bd dolt push command was actually issued');
        assert.equal(brackets.openBracketCount(), 0, 'the bracket must close once the D-push resolves');
        assert.equal(guard(), true, 'the guard must permit a pause again once the D-push has fully finished');
    });

    test('(2) Publish-PR git push (gitSync.pushGitAfter) -- guard false throughout, true only after the push resolves', async () => {
        let guard = null;
        const brackets = createSyncBrackets({ setPauseGuard: (fn) => { guard = fn; } });
        const { command, calls, resolveGate, wasGateHit } = makeSlowCommandMock('git push');
        const gitSync = createGitSync({ brackets, command, log: () => {}, branch: 'feat/3swo-4-2', syncMemberAfter });

        assert.equal(guard(), true, 'idle before any push: guard must permit a pause');
        assert.equal(brackets.openBracketCount(), 0);

        const pushPromise = gitSync.pushGitAfter('memberA', { remote: 'origin', setUpstream: true });
        await letMicrotasksDrain();

        assert.ok(wasGateHit(), 'precondition: the mock G-push must actually be in flight (gate reached) before asserting guard state');
        assert.equal(brackets.openBracketCount(), 1, 'the sync bracket must be open for the WHOLE duration of the G-push');
        assert.equal(guard(), false, 'the clean-state pause guard must DENY a pause while the Publish-PR G-push is in flight');

        resolveGate();
        const res = await pushPromise;

        assert.equal(res.ok, true, 'sanity: the G-push itself must have completed successfully');
        assert.equal(res.pushed, true, 'sanity: this was a real (non-skipped) push');
        assert.ok(calls.some((c) => c.cmd.includes('git push')), 'sanity: a git push command was actually issued');
        assert.equal(brackets.openBracketCount(), 0, 'the bracket must close once the G-push resolves');
        assert.equal(guard(), true, 'the guard must permit a pause again once the G-push has fully finished');
    });
});

describe('apra-fleet-3swo.4.2: source-level scan -- runner.js has zero unbracketed push sites', () => {
    const RUNNER_PATH = guardedModulePath('runner.js');
    // apra-fleet-3swo.6.6 sliced the Final Review phase out of runner.js into
    // fleet-sprint/phases/final-review.mjs, and the findings D-push went WITH
    // it. Scanning runner.js alone from here would have kept reporting green
    // while the site this file exists to protect sat in a file nothing scanned
    // -- so the module is scanned as a SECOND source and the by-name pin below
    // is re-anchored onto it. Both paths come from guardedModulePath(), so the
    // shared registration in guarded-modules.mjs is what makes them reachable.
    const FINAL_REVIEW_PHASE_PATH = guardedModulePath('phases/final-review.mjs');
    // apra-fleet-3swo.6.9 did the same to the OTHER site this file protects:
    // the Publish PR phase moved into fleet-sprint/phases/publish-pr.mjs and
    // the sprint branch's own G-push -- gitSync.pushGitAfter(), the single
    // most consequential push in the run -- went with it. Same re-anchoring as
    // above, for the same reason: runner.js alone would keep reporting green
    // over a site no scan reads.
    const PUBLISH_PR_PHASE_PATH = guardedModulePath('phases/publish-pr.mjs');

    test('runner.js reports zero unbracketed doltPushAfter()/syncMemberAfter()/DoltSync.syncBefore()/DoltSync.syncAfter() call sites', () => {
        const { violations } = checkUnbracketedPushPath(RUNNER_PATH);
        assert.deepEqual(violations, [], `expected no unbracketed push call sites, got: ${JSON.stringify(violations, null, 2)}`);
    });

    test('phases/final-review.mjs reports zero unbracketed push call sites either', () => {
        const { violations } = checkUnbracketedPushPath(FINAL_REVIEW_PHASE_PATH);
        assert.deepEqual(violations, [], `expected no unbracketed push call sites in the sliced Final Review phase, got: ${JSON.stringify(violations, null, 2)}`);
    });

    test('the Final Review findings D-push site calls gitSync.pushBeadsAfter(...) by name', () => {
        const src = fs.readFileSync(FINAL_REVIEW_PHASE_PATH, 'utf8');
        assert.match(
            src,
            /if \(dPushNeededAfterFinalFindings\) \{[\s\S]{0,400}?await gitSync\.pushBeadsAfter\(/,
            'the Final Review findings D-push must route through gitSync.pushBeadsAfter(), the bracketed standalone entry point',
        );
    });

    test('runner.js no longer owns the Final Review findings D-push -- the pin above is not scanning a leftover copy', () => {
        const src = fs.readFileSync(RUNNER_PATH, 'utf8');
        assert.ok(
            !/if \(dPushNeededAfterFinalFindings\)/.test(src),
            'the Final Review findings D-push branch must live ONLY in phases/final-review.mjs after apra-fleet-3swo.6.6 -- a duplicate left behind in runner.js would let the two drift apart with both pins green',
        );
    });

    test('phases/publish-pr.mjs reports zero unbracketed push call sites either', () => {
        const { violations } = checkUnbracketedPushPath(PUBLISH_PR_PHASE_PATH);
        assert.deepEqual(violations, [], `expected no unbracketed push call sites in the sliced Publish PR phase, got: ${JSON.stringify(violations, null, 2)}`);
    });

    test('the Publish-PR push site calls gitSync.pushGitAfter(...) by name', () => {
        const src = fs.readFileSync(PUBLISH_PR_PHASE_PATH, 'utf8');
        assert.match(
            src,
            /await gitSync\.pushGitAfter\(publishGitMember,/,
            'the Publish-PR G-push must route through gitSync.pushGitAfter(), the bracketed standalone entry point',
        );
    });

    test('runner.js no longer owns the Publish-PR G-push -- the pin above is not scanning a leftover copy', () => {
        const src = fs.readFileSync(RUNNER_PATH, 'utf8');
        assert.ok(
            !/gitSync\.pushGitAfter\(/.test(src),
            'the sprint branch push must live ONLY in phases/publish-pr.mjs after apra-fleet-3swo.6.9 -- a duplicate left behind in runner.js would let the two drift apart with both pins green',
        );
    });
});

// =============================================================================
// Falsification: prove findUnbracketedPushViolations() (fleet-sprint/
// unbracketed-push-guard.mjs) can actually FAIL, against fixtures reproducing
// the pre-apra-fleet-3swo.4.1 shape (a BARE doltPushAfter()/syncMemberAfter()/
// DoltSync.syncBefore()/DoltSync.syncAfter() call, exactly what the Final
// Review/Publish-PR sites -- and, per the reviewed false negative this round
// fixes, any hand-rolled DoltSync.syncAfter()/syncBefore() call -- used to do
// before routing through the bracketed entry points). Written to throwaway
// temp files, or reasoned about directly against the real runner.js source,
// rather than mutating runner.js on disk.
// =============================================================================
describe('apra-fleet-3swo.4.2: falsification -- the scan detects a reverted (bare, unbracketed) push site', () => {
    test('a fixture with a bare doltPushAfter() call (no gitSync.pushBeadsAfter wrapper) is flagged', () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sync-bracket-hole-'));
        try {
            const fixturePath = path.join(dir, 'reverted-final-review.mjs');
            fs.writeFileSync(
                fixturePath,
                [
                    "import { doltPushAfter } from './dolt-sync.mjs';",
                    'export async function finalReviewFindings(dPushNeeded, orchestratorMember) {',
                    '    if (dPushNeeded) {',
                    '        // reverted: bare call, no gitSync.pushBeadsAfter bracket',
                    '        await doltPushAfter(orchestratorMember, { pushBeads: true });',
                    '    }',
                    '}',
                    '',
                ].join('\n'),
            );
            const src = fs.readFileSync(fixturePath, 'utf8');
            const violations = findUnbracketedPushViolations(src, 'reverted-final-review.mjs');
            assert.ok(
                violations.some((v) => v.includes('bare doltPushAfter() call site')),
                `expected the scan to flag the reverted bare doltPushAfter() call, got: ${JSON.stringify(violations)}`,
            );
        } finally {
            fs.rmSync(dir, { recursive: true, force: true });
        }
    });

    test('a fixture with a bare syncMemberAfter() call (no gitSync.pushGitAfter wrapper) is flagged', () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sync-bracket-hole-'));
        try {
            const fixturePath = path.join(dir, 'reverted-publish-pr.mjs');
            fs.writeFileSync(
                fixturePath,
                [
                    "import { syncMemberAfter } from './runner.js';",
                    'export async function publishPr(publishGitMember) {',
                    '    // reverted: bare call, no gitSync.pushGitAfter bracket',
                    '    await syncMemberAfter(publishGitMember, { remote: "origin", setUpstream: true });',
                    '}',
                    '',
                ].join('\n'),
            );
            const src = fs.readFileSync(fixturePath, 'utf8');
            const violations = findUnbracketedPushViolations(src, 'reverted-publish-pr.mjs');
            assert.ok(
                violations.some((v) => v.includes('bare syncMemberAfter() call site')),
                `expected the scan to flag the reverted bare syncMemberAfter() call, got: ${JSON.stringify(violations)}`,
            );
        } finally {
            fs.rmSync(dir, { recursive: true, force: true });
        }
    });

    // -------------------------------------------------------------------
    // Blocker 2 fix (prior review round): the earlier scan only looked for
    // `doltPushAfter(`/`syncMemberAfter(`, so a bare DoltSync.syncAfter()/
    // syncBefore() call -- the dominant unbracketed-sync shape 8 of the 9
    // hand-rolled sites apra-fleet-3swo.4.1 actually routed through the
    // module used before that fix -- was invisible to it. These two tests
    // reproduce that exact false negative against the REAL runner.js source
    // (mutated in memory only) and prove the current scan catches it.
    // -------------------------------------------------------------------

    // apra-fleet-3swo.6.6: the Final Review phase (and its findings D-push)
    // moved to fleet-sprint/phases/final-review.mjs, so this mutation runs
    // against THAT module's real source now. Left pointed at runner.js it
    // would have failed on the `sanctioned` pin rather than silently passing,
    // but the point of re-anchoring is that the falsification keeps covering
    // the site itself wherever it lives.
    test('mutating the real phases/final-review.mjs Final Review D-push back to a bare DoltSync.syncAfter() call is flagged (prior false negative)', () => {
        const cleanSrc = fs.readFileSync(guardedModulePath('phases/final-review.mjs'), 'utf8');
        assert.deepEqual(findUnbracketedPushViolations(cleanSrc, 'final-review.mjs'), [], 'sanity: the real, unmutated source must be clean');

        const sanctioned = 'await gitSync.pushBeadsAfter(orchestratorMember, { pushBeads: true });';
        assert.ok(cleanSrc.includes(sanctioned), 'the Final Review D-push call text must still match this pin -- re-anchor if it drifted');

        const mutated = cleanSrc.replace(
            sanctioned,
            'await DoltSync.syncAfter(orchestratorMember, { command, pushBeads: true, log, mutex: doltPushMutex, sprintId: sprintMutexId });',
        );
        assert.notEqual(mutated, cleanSrc, 'the replacement must actually have changed the source');

        const violations = findUnbracketedPushViolations(mutated, 'final-review.mjs');
        assert.ok(
            violations.some((v) => v.includes('bare DoltSync.syncAfter() call site')),
            `expected the reverted Final Review site to be flagged as a bare DoltSync.syncAfter() call, got: ${JSON.stringify(violations, null, 2)}`,
        );
    });

    // apra-fleet-3swo.6.9: the Publish PR phase (and the sprint branch G-push)
    // moved to fleet-sprint/phases/publish-pr.mjs, so this mutation runs
    // against THAT module's real source now -- the same re-anchoring, and for
    // the same reason, as the Final Review one above.
    test('mutating the real phases/publish-pr.mjs Publish-PR G-push back to a bare DoltSync.syncBefore() call is flagged (prior false negative)', () => {
        const cleanSrc = fs.readFileSync(guardedModulePath('phases/publish-pr.mjs'), 'utf8');
        assert.deepEqual(findUnbracketedPushViolations(cleanSrc, 'publish-pr.mjs'), [], 'sanity: the real, unmutated source must be clean');

        const sanctioned = "await gitSync.pushGitAfter(publishGitMember, { remote: 'origin', setUpstream: true });";
        assert.ok(cleanSrc.includes(sanctioned), 'the Publish-PR G-push call text must still match this pin -- re-anchor if it drifted');

        const mutated = cleanSrc.replace(
            sanctioned,
            "await DoltSync.syncBefore(publishGitMember, { command, log, fatal: true });",
        );
        assert.notEqual(mutated, cleanSrc, 'the replacement must actually have changed the source');

        const violations = findUnbracketedPushViolations(mutated, 'publish-pr.mjs');
        assert.ok(
            violations.some((v) => v.includes('bare DoltSync.syncBefore() call site')),
            `expected the reverted Publish-PR site to be flagged as a bare DoltSync.syncBefore() call, got: ${JSON.stringify(violations, null, 2)}`,
        );
    });

    test('a fixture using the sanctioned wrapper function name (syncMemberAfterOrdered) for its ONE call reports zero violations -- proves the exemption is structural, not vacuously strict', () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sync-bracket-hole-'));
        try {
            const fixturePath = path.join(dir, 'clean-ordered.mjs');
            fs.writeFileSync(
                fixturePath,
                [
                    "import { syncMemberAfter } from './runner.js';",
                    'export async function syncMemberAfterOrdered(member, opts) {',
                    '    const gPush = await syncMemberAfter(member, opts);',
                    '    return gPush;',
                    '}',
                    '',
                ].join('\n'),
            );
            const src = fs.readFileSync(fixturePath, 'utf8');
            const violations = findUnbracketedPushViolations(src, 'clean-ordered.mjs');
            assert.deepEqual(violations, [], `expected the call inside the sanctioned wrapper's own body to be accepted, got: ${JSON.stringify(violations)}`);
        } finally {
            fs.rmSync(dir, { recursive: true, force: true });
        }
    });

    test('the SAME call outside any sanctioned wrapper function is flagged -- the exemption is scoped to the wrapper body, not global', () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sync-bracket-hole-'));
        try {
            const fixturePath = path.join(dir, 'not-ordered.mjs');
            fs.writeFileSync(
                fixturePath,
                [
                    "import { syncMemberAfter } from './runner.js';",
                    'export async function someOtherFunction(member, opts) {',
                    '    const gPush = await syncMemberAfter(member, opts);',
                    '    return gPush;',
                    '}',
                    '',
                ].join('\n'),
            );
            const src = fs.readFileSync(fixturePath, 'utf8');
            const violations = findUnbracketedPushViolations(src, 'not-ordered.mjs');
            assert.ok(
                violations.some((v) => v.includes('bare syncMemberAfter() call site')),
                `expected the call outside the sanctioned wrapper to be flagged, got: ${JSON.stringify(violations)}`,
            );
        } finally {
            fs.rmSync(dir, { recursive: true, force: true });
        }
    });
});
