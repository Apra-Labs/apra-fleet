import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createSyncBrackets, createGitSync } from '../fleet-sprint/git-sync.mjs';
import { syncMemberAfter } from '../fleet-sprint/runner.js';
import { guardedModulePath } from '../fleet-sprint/guarded-modules.mjs';

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
//   3.   A source-level scan of runner.js (read via the shared guarded-module
//        list, guarded-modules.mjs, per apra-fleet-3swo.8's registration
//        convention) proving there is no bare, unbracketed call site left for
//        either hole -- both go through `gitSync.pushBeadsAfter(`/
//        `gitSync.pushGitAfter(` by name, and there is no OTHER real call
//        site of the raw `doltPushAfter(`/`syncMemberAfter(` primitives
//        outside their one sanctioned internal use (syncMemberAfterOrdered's
//        own G-push step, itself only ever reached through a bracket).
//   4.   Falsification: a fixture reproducing the pre-3swo.4.1 shape (a bare
//        doltPushAfter()/syncMemberAfter() call sitting outside any bracket)
//        must make the scan report a violation -- proving the scan can
//        actually fail, not just vacuously pass against clean source.
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

// =============================================================================
// Source-level invariant: runner.js contains no bare doltPushAfter(),
// syncMemberAfter() or push call outside a bracket.
//
// Method mirrors dispatch-safety-guard.mjs / dispatch-sync-bracket-coverage.
// test.mjs: a real (non-comment) call-site scan, not a naive substring grep,
// so a mention inside a comment or the `export { ... } from './dolt-sync.mjs'`
// re-export list is never mistaken for a call. Exported so the falsification
// tests below can point it at a deliberately non-compliant fixture instead of
// mutating runner.js itself.
// =============================================================================

/** True when `col` sits inside a same-line `"..."`/`'...'` string. */
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
 * Finds every real (non-comment, non-same-line-string, non-declaration) call
 * site of `fnName(` in `src`. Returns `{ line, lineText }` for each.
 */
function findRealCallSites(src, fnName) {
    const lines = src.split('\n');
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
        sites.push({ line: lineNo, lineText: trimmed });
    }
    return sites;
}

/**
 * The mechanical scan itself: given a source string, returns every violation
 * -- a real call site of the raw `doltPushAfter(`/`syncMemberAfter(`
 * primitives that is NOT the one sanctioned internal use (syncMemberAfter
 * called from inside syncMemberAfterOrdered, itself only ever reached through
 * a bracket -- see git-sync.mjs's withGitSync and pushGitAfter). A bare
 * `doltPushAfter(` call site is ALWAYS a violation: after apra-fleet-3swo.4.1
 * there is no sanctioned direct caller left in runner.js at all -- the sole
 * bracketed entry point is gitSync.pushBeadsAfter() in git-sync.mjs.
 */
export function findUnbracketedPushViolations(src, fileLabel = 'source') {
    const violations = [];

    for (const site of findRealCallSites(src, 'doltPushAfter')) {
        violations.push(`${fileLabel}:${site.line} bare doltPushAfter() call site outside any bracket: ${site.lineText}`);
    }

    const syncMemberAfterSites = findRealCallSites(src, 'syncMemberAfter');
    // Exactly one sanctioned internal call is expected: syncMemberAfterOrdered's
    // own `gPush = await syncMemberAfter(...)` step. Anything else -- in
    // particular a DIRECT call from a dispatch/publish site that bypasses
    // gitSync.pushGitAfter() -- is the exact regression apra-fleet-3swo.4.1
    // fixed and this scan exists to catch.
    const sanctioned = syncMemberAfterSites.filter((s) => /gPush\s*=\s*await\s+syncMemberAfter\(/.test(s.lineText));
    const unsanctioned = syncMemberAfterSites.filter((s) => !sanctioned.includes(s));
    for (const site of unsanctioned) {
        violations.push(`${fileLabel}:${site.line} bare syncMemberAfter() call site outside any bracket: ${site.lineText}`);
    }
    if (sanctioned.length !== 1) {
        violations.push(`${fileLabel}: expected exactly ONE sanctioned internal syncMemberAfter() call (syncMemberAfterOrdered's own G-push step), found ${sanctioned.length}`);
    }

    return violations;
}

describe('apra-fleet-3swo.4.2: source-level scan -- runner.js has zero unbracketed push sites', () => {
    const RUNNER_PATH = guardedModulePath('runner.js');

    test('runner.js reports zero unbracketed doltPushAfter()/syncMemberAfter() call sites', () => {
        const src = fs.readFileSync(RUNNER_PATH, 'utf8');
        const violations = findUnbracketedPushViolations(src, 'runner.js');
        assert.deepEqual(violations, [], `expected no unbracketed push call sites, got: ${JSON.stringify(violations, null, 2)}`);
    });

    test('the Final Review findings D-push site calls gitSync.pushBeadsAfter(...) by name', () => {
        const src = fs.readFileSync(RUNNER_PATH, 'utf8');
        assert.match(
            src,
            /if \(dPushNeededAfterFinalFindings\) \{[\s\S]{0,400}?await gitSync\.pushBeadsAfter\(/,
            'the Final Review findings D-push must route through gitSync.pushBeadsAfter(), the bracketed standalone entry point',
        );
    });

    test('the Publish-PR push site calls gitSync.pushGitAfter(...) by name', () => {
        const src = fs.readFileSync(RUNNER_PATH, 'utf8');
        assert.match(
            src,
            /await gitSync\.pushGitAfter\(publishGitMember,/,
            'the Publish-PR G-push must route through gitSync.pushGitAfter(), the bracketed standalone entry point',
        );
    });
});

// =============================================================================
// Falsification: prove findUnbracketedPushViolations() can actually FAIL,
// against a fixture reproducing the pre-apra-fleet-3swo.4.1 shape (a BARE
// doltPushAfter()/syncMemberAfter() call, exactly what the Final Review/
// Publish-PR sites used to do before the git-sync.mjs extraction). Written to
// a throwaway temp file rather than mutating runner.js itself.
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

    test('a clean fixture with the correct ONE sanctioned syncMemberAfter() call (syncMemberAfterOrdered\'s own G-push step) reports zero violations -- proves the scan is not vacuously strict', () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sync-bracket-hole-'));
        try {
            const fixturePath = path.join(dir, 'clean-ordered.mjs');
            fs.writeFileSync(
                fixturePath,
                [
                    "import { syncMemberAfter } from './runner.js';",
                    'export async function syncMemberAfterOrdered(member, opts) {',
                    '    let gPush;',
                    '    gPush = await syncMemberAfter(member, opts);',
                    '    return gPush;',
                    '}',
                    '',
                ].join('\n'),
            );
            const src = fs.readFileSync(fixturePath, 'utf8');
            const violations = findUnbracketedPushViolations(src, 'clean-ordered.mjs');
            assert.deepEqual(violations, [], `expected the one sanctioned internal call to be accepted, got: ${JSON.stringify(violations)}`);
        } finally {
            fs.rmSync(dir, { recursive: true, force: true });
        }
    });
});
