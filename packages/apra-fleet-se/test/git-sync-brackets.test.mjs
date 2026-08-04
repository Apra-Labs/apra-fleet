import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
    checkMemberTopology,
    classifyGitFailure,
    syncMemberBefore,
    syncMemberAfter,
    syncMemberAfterOrdered,
    parseUnmergedPaths,
} from '../fleet-sprint/runner.js';
import { GitDivergedError, GitSyncError } from '../fleet-sprint/errors.mjs';
import { WorkflowError } from '@apralabs/apra-fleet-workflow';
import { runCmd, sleep, runDevelopLoopScenario, withScenarioMarkers } from './helpers/mock-sprint-harness.mjs';

// =============================================================================
// apra-fleet-eft.8.7 -- Orchestrator-bracketed git sync: consolidated
// end-to-end coverage for the Phase-2 sync-bracket feature (apra-fleet-eft.8).
//
// This suite locks in ONE assertion per plan risk / acceptance bullet so a
// future refactor that quietly drops any one bracket surfaces here. The eight
// cases mirror the bead's Cover list (a)-(h):
//
//   (a) all seven dispatch types are bracketed per the Plan 3.3 table;
//   (b) doer streaks across DIFFERENT members run strictly sequentially;
//   (c) a non-FF pull (an out-of-turn write) surfaces as a typed fail-fast
//       error, never a silent auto-merge;
//   (d) a G-push failure skips D-push entirely and marks the streak failed;
//   (e) the topology guard accepts same-origin + dolt-probe synced mode and
//       still enforces same-HEAD legacy mode;
//   (f) Tier 1 scripted conflict detection + `git rebase --abort` clean-state
//       restore;
//   (g) the retry classifier distinguishes transient (retried) from
//       divergence (never retried);
//   (h) NO vendored agent .md file gains orchestrator-side sync commands --
//       sync stays in runner.js, agents never run it themselves (Plan 3.2).
//
// Conventions follow the mock-sprint-* suites and the bd/git mock shims from
// commit 42ea354 (runCmd flows through the replay layer; command() is a
// dependency-injected mock so the sync helpers drive with no live fleet).
// =============================================================================

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const RUNNER_PATH = path.join(__dirname, '../fleet-sprint/runner.js');
const VENDOR_AGENTS_DIR = path.join(__dirname, '../apra-pm/agents');

const check = (cond, msg) => assert.ok(cond, msg);

const OK = { ok: true, output: '', error: null };
const fail = (error) => ({ ok: false, output: '', error });

// A tiny scripted command() mock: pass a map from cmd-substring -> a sequence
// of results (each { ok } or { ok:false, error }). Records every call with its
// opts so tests can assert explicit member threading (Plan 3.2). Matches the
// shim shape used in mock-sprint-git-sync-brackets.test.mjs.
function makeCommandMock(script) {
    const calls = [];
    const queues = new Map(Object.entries(script).map(([k, v]) => [k, [...v]]));
    const command = async (cmd, opts = {}) => {
        calls.push({ cmd, opts });
        for (const [key, queue] of queues) {
            if (cmd.includes(key)) {
                const next = queue.length > 1 ? queue.shift() : queue[0];
                return next;
            }
        }
        return { ok: true, output: '', error: null };
    };
    return { command, calls };
}

// ---------------------------------------------------------------------------
// Balanced-paren scanner (same technique as
// dispatch-sync-bracket-coverage.test.mjs): given the index of an opening
// '(' return [start, end] of its matching ')', skipping string/template
// contents so a multi-line call with nested parens is never mis-parsed.
// ---------------------------------------------------------------------------
function skipStringLiteral(src, start, quoteChar) {
    let i = start + 1;
    for (; i < src.length; i++) {
        const ch = src[i];
        if (ch === '\\') { i++; continue; }
        if (ch === quoteChar) return i;
    }
    return i;
}

function balancedCallRange(src, openParenIdx) {
    let depth = 0;
    for (let i = openParenIdx; i < src.length; i++) {
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
    return [openParenIdx, src.length - 1];
}

// Return every withGitSync(...) call's balanced [start, end] range (skipping
// the `async function withGitSync(...)` declaration itself).
function withGitSyncRanges(src) {
    const ranges = [];
    const re = /(?<![.\w])withGitSync\(/g;
    let m;
    while ((m = re.exec(src)) !== null) {
        const openParen = m.index + m[0].length - 1;
        // Skip the declaration line: `... function withGitSync(`.
        const lineStart = src.lastIndexOf('\n', m.index) + 1;
        const linePrefix = src.slice(lineStart, m.index);
        if (/function\s+$/.test(linePrefix)) continue;
        ranges.push(balancedCallRange(src, openParen));
    }
    return ranges;
}

// =============================================================================
// (a) All seven dispatch types are bracketed per the Plan 3.3 table.
//
// Each of the seven role dispatches (planner, plan-reviewer, doer, reviewer,
// deployer, integ-test-runner, harvester) must have at least one agent()
// dispatch whose role marker sits INSIDE a withGitSync(...) range. Removing
// any single bracket drops that role's marker out of every range and fails
// here.
// =============================================================================
const SEVEN_DISPATCH_MARKERS = {
    planner: /member_name:\s*getMemberForRole\('planner'\)/g,
    'plan-reviewer': /member_name:\s*getMemberForRole\('plan-reviewer'\)/g,
    doer: /agentType:\s*'doer'/g,
    reviewer: /member_name:\s*(getMemberForRole\('reviewer'\)|reviewerPool\[0\])/g,
    deployer: /member_name:\s*getMemberForRole\('deployer'\)/g,
    'integ-test-runner': /member_name:\s*getMemberForRole\('integ-test-runner'\)/g,
    harvester: /member_name:\s*getMemberForRole\('harvester'\)/g,
};

test('(a) every one of the seven dispatch types is wrapped in a withGitSync(...) bracket', () => {
    const src = fs.readFileSync(RUNNER_PATH, 'utf8');
    const ranges = withGitSyncRanges(src);
    check(ranges.length >= 7, `expected at least seven withGitSync(...) call sites, found ${ranges.length}`);

    const inSomeRange = (idx) => ranges.some(([s, e]) => idx > s && idx < e);

    for (const [role, re] of Object.entries(SEVEN_DISPATCH_MARKERS)) {
        re.lastIndex = 0;
        const markerIdxs = [];
        let m;
        while ((m = re.exec(src)) !== null) markerIdxs.push(m.index);
        check(markerIdxs.length > 0, `no dispatch marker found for role '${role}' -- the 3.3 table role marker was renamed?`);
        check(
            markerIdxs.some((idx) => inSomeRange(idx)),
            `dispatch for role '${role}' is NOT inside any withGitSync(...) bracket -- the 3.3 sync bracket was removed or un-nested`,
        );
    }
});

test('(a) pushCode:true is reserved for the two code-writing roles (doer, harvester); read-only roles pass false', () => {
    const src = fs.readFileSync(RUNNER_PATH, 'utf8');
    // Extract the literal second positional arg (pushCode) of each
    // withGitSync(member, pushCode, ...) call.
    const ranges = withGitSyncRanges(src);
    let trueCount = 0;
    let falseCount = 0;
    for (const [s, e] of ranges) {
        const callText = src.slice(s, e + 1);
        if (/^\([^,]+,\s*true\s*,/.test(callText)) {
            trueCount++;
            check(
                /agentType:\s*'doer'/.test(callText) || /getMemberForRole\('harvester'\)/.test(callText) || /doerMember/.test(callText),
                `a pushCode:true bracket must be doer or harvester, got: ${callText.slice(0, 100)}`,
            );
        } else if (/^\([^,]+,\s*false\s*,/.test(callText)) {
            falseCount++;
        }
    }
    check(trueCount >= 2, `expected at least two pushCode:true (code-writing) brackets, found ${trueCount}`);
    check(falseCount >= 5, `expected the read-only roles to pass pushCode:false, found ${falseCount}`);
});

// =============================================================================
// (b) Doer streaks across DIFFERENT members run strictly sequentially.
//
// The globalDoerTurn FIFO gate in runner.js means at most one doer streak is
// ever in flight, even across heterogeneous members -- the fast-forward-by-
// construction invariant the sync brackets depend on.
// =============================================================================
test('(b) doer streaks on two DIFFERENT members never overlap (global sequencing gate)', async () => {
    await withScenarioMarkers('8.7 (b) cross-member sequencing', async () => {
        let active = 0;
        let maxActive = 0;

        const doerHandler = async ({ opts, tempDir: td }) => {
            const match = opts.prompt.match(/Assigned bead ids \(comma-separated\):\s*(.+)/);
            const ids = match ? match[1].split(',').map((s) => s.trim()).filter(Boolean) : [];
            active += 1;
            maxActive = Math.max(maxActive, active);
            try {
                await sleep(30); // window a concurrent streak would overlap, absent the gate
                for (const id of ids) await runCmd(`bd close ${id}`, td);
                return { content: [{ text: JSON.stringify({ status: 'VERIFY', closedIds: ids, notes: 'Closed.' }) }] };
            } finally {
                active -= 1;
            }
        };

        const result = await runDevelopLoopScenario('gsb87seq', {
            members: ['member-x86', 'member-arm64'],
            taskSpecs: [
                { title: 'Task: Streak on member A' },
                { title: 'Task: Streak on member B' },
            ],
            doerHandler,
            reviewerHandler: async () => ({
                content: [{ text: JSON.stringify({ verdict: 'APPROVED', notes: 'Approved.', reopenIds: [], newTasks: [] }) }],
            }),
        });

        check(!result.error, `scenario should not abort: ${result.error ? result.error.message : ''}`);
        check(maxActive <= 1, `expected at most one doer streak in flight (global gate), observed ${maxActive}`);

        const membersUsed = new Set(result.dispatched.filter((d) => d.agent === 'doer').map((d) => d.member));
        check(membersUsed.size === 2, `expected two DIFFERENT members exercised, got: ${JSON.stringify([...membersUsed])}`);

        for (const task of result.tasks) {
            const bead = result.finalBeadsById.get(task.id);
            check(bead && bead.status === 'closed', `expected task '${task.id}' closed, got: ${JSON.stringify(bead)}`);
        }
    });
});

// =============================================================================
// (c) A non-FF pull (an out-of-turn write on the shared branch) surfaces as a
// typed fail-fast GitDivergedError -- never a silent auto-merge, never a retry.
// =============================================================================
test('(c) a non-FF pull raises a typed GitDivergedError (fail-fast, operation=pull)', async () => {
    const { command } = makeCommandMock({
        'git merge --ff-only': [fail('fatal: Not possible to fast-forward, aborting.')],
    });
    let err = null;
    try { await syncMemberBefore('m1', { command }); } catch (e) { err = e; }
    check(err instanceof GitDivergedError, `expected GitDivergedError, got ${err && err.constructor.name}`);
    check(err instanceof WorkflowError, 'GitDivergedError must extend WorkflowError');
    check(err.member === 'm1', 'error carries the member');
    check(err.operation === 'pull', 'operation must be pull');
    check(/fast-forward/i.test(err.gitOutput || ''), 'error carries the git output');
});

test('(c) an out-of-turn write during a doer streak (non-FF push, still rejected after one rebase) is a typed fail-fast error', async () => {
    const { command, calls } = makeCommandMock({
        'git push': [fail(' ! [rejected] (non-fast-forward)')], // always rejected
        'git pull --rebase': [OK],
    });
    let err = null;
    try { await syncMemberAfter('m1', { command }); } catch (e) { err = e; }
    check(err instanceof GitDivergedError, `expected GitDivergedError, got ${err && err.constructor.name}`);
    const pushCalls = calls.filter((c) => /git push/.test(c.cmd));
    const rebaseCalls = calls.filter((c) => /git pull --rebase/.test(c.cmd));
    check(pushCalls.length === 2, `push bounded to one re-push, saw ${pushCalls.length}`);
    check(rebaseCalls.length === 1, `rebase bounded to one, saw ${rebaseCalls.length}`);
});

// =============================================================================
// (d) A G-push failure skips D-push ENTIRELY and marks the streak failed --
// never advertising an unreachable close (a beads close with no code on the
// shared branch).
// =============================================================================
test('(d) a G-push failure skips D-push (zero bd dolt push) and rethrows the typed error', async () => {
    const { command, calls } = makeCommandMock({
        'git push': [fail(' ! [rejected] (non-fast-forward)')],
        'git pull --rebase': [fail(' ! [rejected] (non-fast-forward), still diverged')],
        'git status --porcelain': [{ ok: true, output: '', error: null }],
    });
    const logs = [];
    let err = null;
    try {
        await syncMemberAfterOrdered('m1', { command, pushCode: true, pushBeads: true, log: (m) => logs.push(m) });
    } catch (e) {
        err = e;
    }
    check(err instanceof GitDivergedError, `expected the typed G-push error rethrown, got ${err && err.constructor.name}`);
    const doltPushCalls = calls.filter((c) => c.cmd.includes('bd dolt push'));
    check(doltPushCalls.length === 0, `D-push must be skipped when G-push fails, saw ${doltPushCalls.length}`);
    check(
        logs.some((m) => /G-push failed/.test(m) && /skipping D-push/.test(m) && /unreachable close/.test(m)),
        `expected the explicit unreachable-close skip log, got: ${JSON.stringify(logs)}`,
    );
});

// =============================================================================
// (e) Topology guard: synced mode accepts same-origin + dolt-probe (differing
// HEADs allowed); legacy mode still enforces same-HEAD identity.
// =============================================================================
test('(e) synced mode ACCEPTS members that share one origin and pass the dolt probe (HEADs may differ)', async () => {
    const res = await checkMemberTopology({
        members: ['m1', 'm2'],
        mode: 'synced',
        getOriginUrl: async () => 'git@github.com:acme/repo.git',
        doltProbe: async () => { /* probe succeeds */ },
    });
    check(res.ok === true, `expected synced topology to pass, got: ${JSON.stringify(res)}`);
    check(res.mode === 'synced', 'mode echoed back');
});

test('(e) synced mode REJECTS divergent origin URLs (cannot reconcile two remotes)', async () => {
    const origins = { m1: 'git@github.com:acme/repo.git', m2: 'git@github.com:other/repo.git' };
    const res = await checkMemberTopology({
        members: ['m1', 'm2'],
        mode: 'synced',
        getOriginUrl: async (m) => origins[m],
        doltProbe: async () => {},
    });
    check(res.ok === false, 'divergent origins must be rejected in synced mode');
    check(/DIVERGENT origin/i.test(res.message), `message must name the divergent-origin failure, got: ${res.message}`);
});

test('(e) synced mode REJECTS a member whose dolt probe fails', async () => {
    const res = await checkMemberTopology({
        members: ['m1', 'm2'],
        mode: 'synced',
        getOriginUrl: async () => 'git@github.com:acme/repo.git',
        doltProbe: async (m) => { if (m === 'm2') throw new Error('dolt server unreachable'); },
    });
    check(res.ok === false, 'a failing dolt probe must be rejected in synced mode');
    check(/dolt pull probe failed/i.test(res.message) && /m2/.test(res.message), `message must name m2 + probe failure, got: ${res.message}`);
});

test('(e) legacy mode still ENFORCES same-HEAD: identical identity signals pass, divergent ones are rejected', async () => {
    const same = await checkMemberTopology({
        members: ['m1', 'm2'],
        mode: 'legacy',
        getIdentity: async () => 'HEAD-abc123',
    });
    check(same.ok === true, `identical legacy identities must pass, got: ${JSON.stringify(same)}`);

    const signals = { m1: 'HEAD-abc123', m2: 'HEAD-def456' };
    const diverged = await checkMemberTopology({
        members: ['m1', 'm2'],
        mode: 'legacy',
        getIdentity: async (m) => signals[m],
    });
    check(diverged.ok === false, 'divergent legacy identities must be rejected (no cross-member sync layer)');
    check(/disagree on their identity/i.test(diverged.message), `message must name the identity mismatch, got: ${diverged.message}`);
});

// =============================================================================
// (f) Tier 1 scripted conflict detection + `git rebase --abort` clean-state
// restore. A pull --rebase conflict is detected via git's own porcelain, the
// abort runs BEFORE the typed error propagates, and the error carries the
// unmerged paths. Tier 1 is script-only -- no agent dispatch occurs.
// =============================================================================
test('(f) parseUnmergedPaths picks only unmerged XY codes', () => {
    const porcelain = ['UU both-modified.txt', 'AA both-added.txt', 'M  staged.txt', '?? untracked.txt'].join('\n');
    const paths = parseUnmergedPaths(porcelain);
    check(paths.length === 2, `expected 2 unmerged paths, got ${JSON.stringify(paths)}`);
    check(paths.includes('both-modified.txt') && paths.includes('both-added.txt'), 'UU + AA paths reported');
});

test('(f) a rebase conflict is porcelain-detected, rebase --abort restores a clean tree, and the typed error carries the unmerged paths', async () => {
    const { command, calls } = makeCommandMock({
        'git push': [fail(' ! [rejected] (non-fast-forward)')],
        'git pull --rebase': [fail('CONFLICT (content): Merge conflict in a.txt')],
        'git status --porcelain': [
            { ok: true, output: 'UU a.txt\n', error: null }, // conflict-detection check
            { ok: true, output: '', error: null },           // post-abort clean check
        ],
        'git rebase --abort': [OK],
    });
    let err = null;
    try { await syncMemberAfter('m1', { command }); } catch (e) { err = e; }
    check(err instanceof GitDivergedError, `expected GitDivergedError, got ${err && err.constructor.name}`);
    check(
        Array.isArray(err.details && err.details.unmergedPaths) && err.details.unmergedPaths.length === 1 && err.details.unmergedPaths[0] === 'a.txt',
        `expected unmergedPaths ['a.txt'], got ${JSON.stringify(err.details && err.details.unmergedPaths)}`,
    );

    const abortIdx = calls.findIndex((c) => /git rebase --abort/.test(c.cmd));
    const statusIdxs = calls.reduce((acc, c, i) => (/git status --porcelain/.test(c.cmd) ? [...acc, i] : acc), []);
    check(abortIdx !== -1, 'a git rebase --abort must run');
    check(calls[abortIdx].opts.member_name === 'm1', 'rebase --abort must carry explicit member_name');
    check(statusIdxs.length === 2, `expected two porcelain checks (before + after abort), saw ${statusIdxs.length}`);
    check(statusIdxs[0] < abortIdx && abortIdx < statusIdxs[1], 'porcelain check -> abort -> re-check ordering must hold');
    check(calls.every((c) => !/dispatch|agent/i.test(c.cmd)), 'Tier 1 is script-only: no agent dispatch may occur');
});

// =============================================================================
// (g) The retry classifier distinguishes transient (retried) from divergence
// (never retried). Assert BOTH paths, and that they surface as DISTINCT types.
// =============================================================================
test('(g) classifyGitFailure: divergence vs transient vs unknown', () => {
    check(classifyGitFailure('fatal: Not possible to fast-forward, aborting.') === 'diverged', 'non-FF is diverged');
    check(classifyGitFailure(' ! [rejected] main -> main (non-fast-forward)') === 'diverged', 'rejected push is diverged');
    check(classifyGitFailure('Could not resolve host: github.com') === 'transient', 'dns is transient');
    check(classifyGitFailure('fatal: Unable to create /repo/.git/index.lock: File exists.') === 'transient', 'index.lock is transient');
    check(classifyGitFailure('some totally novel git failure') === 'unknown', 'novel is unknown (not silently transient)');
});

test('(g) a TRANSIENT fetch failure is retried to success; a DIVERGENCE is never retried', async () => {
    // Transient path: fetch fails once (transient), then succeeds -> retried.
    const transient = makeCommandMock({
        'git fetch': [fail('fatal: unable to access ... Could not resolve host: github.com'), OK],
    });
    const res = await syncMemberBefore('m1', { command: transient.command });
    check(res.ok, 'transient fetch failure should be retried to success');
    check(transient.calls.filter((c) => /git fetch/.test(c.cmd)).length === 2, 'transient fetch retried exactly once');

    // Divergence path: merge --ff-only is non-FF twice; must NOT retry.
    const diverged = makeCommandMock({
        'git merge --ff-only': [fail('fatal: Not possible to fast-forward, aborting.'), OK],
    });
    await assert.rejects(() => syncMemberBefore('m1', { command: diverged.command }), GitDivergedError);
    check(diverged.calls.filter((c) => /git merge --ff-only/.test(c.cmd)).length === 1, 'divergence must NOT be retried');
});

test('(g) a transient failure that exhausts its retries raises GitSyncError, NOT GitDivergedError', async () => {
    const { command } = makeCommandMock({
        'git push': [fail('fatal: unable to access ... Connection timed out')], // never recovers
    });
    let err = null;
    try { await syncMemberAfter('m1', { command, maxTransientRetries: 1 }); } catch (e) { err = e; }
    check(err instanceof GitSyncError, `expected GitSyncError, got ${err && err.constructor.name}`);
    check(!(err instanceof GitDivergedError), 'transient-exhausted must NOT be a divergence error');
});

// =============================================================================
// apra-fleet-fmu -- git/dolt credential-auth self-heal via provision_vcs_auth.
//
// classifyGitFailure() gains a THIRD kind, 'auth', checked after 'diverged'
// (never misclassified) but before 'transient' (blindly retrying a
// credential failure is pointless). An optional injected `onAuthFailure` on
// runGitStep (threaded through syncMemberBefore/syncMemberAfter) fires
// EXACTLY ONCE on an 'auth'-classified failure and, if it resolves without
// throwing, retries the SAME failed command exactly once more -- a distinct,
// bounded one-shot path, not folded into maxTransientRetries.
// =============================================================================
test('(fmu) classifyGitFailure recognizes the live-observed credential failure (and siblings) as a new "auth" kind, checked after diverged but before transient', () => {
    check(
        classifyGitFailure("fatal: could not read Username for 'https://github.com': Device not configured") === 'auth',
        'the exact live-observed message must classify as auth',
    );
    check(classifyGitFailure("fatal: could not read Password for 'https://github.com'") === 'auth', 'missing password is auth');
    check(classifyGitFailure('remote: Authentication failed for repo') === 'auth', 'authentication failed is auth');
    check(classifyGitFailure('Permission denied (publickey).') === 'auth', 'publickey denial is auth');
    check(classifyGitFailure('remote: Invalid username or token.') === 'auth', 'invalid token is auth');
    check(classifyGitFailure('remote: Invalid username or password.') === 'auth', 'invalid password is auth');
    check(classifyGitFailure('fatal: could not read Username for ...: terminal prompts disabled') === 'auth', 'terminal prompts disabled is auth');
    check(classifyGitFailure('remote: Support for password authentication was removed') === 'auth', 'password-auth-removed is auth');
    check(classifyGitFailure('remote: Bad credentials') === 'auth', 'bad credentials is auth');

    // Divergence must NEVER be misclassified as auth, even if it happened to
    // also carry an auth-sounding word.
    check(classifyGitFailure('fatal: Not possible to fast-forward, aborting.') === 'diverged', 'divergence stays diverged, never auth');
    check(classifyGitFailure(' ! [rejected] main -> main (non-fast-forward)') === 'diverged', 'rejected push stays diverged, never auth');

    // Transient stays transient, unaffected by the new auth kind.
    check(classifyGitFailure('Could not resolve host: github.com') === 'transient', 'transient patterns unaffected');
});

test('(fmu) self-heal success: an auth-classified G-push failure heals once via onAuthFailure and the single bounded retry succeeds', async () => {
    const { command, calls } = makeCommandMock({
        'git push': [fail("fatal: could not read Username for 'https://github.com': Device not configured"), OK],
    });
    let healCalls = 0;
    const onAuthFailure = async (info) => {
        healCalls += 1;
        check(info.member === 'm1', 'onAuthFailure receives the member');
        check(/could not read Username/.test(info.error), 'onAuthFailure receives the raw error text');
    };
    const res = await syncMemberAfter('m1', { command, onAuthFailure });
    check(res.ok === true && res.pushed === true, `expected the push to ultimately succeed after self-heal, got: ${JSON.stringify(res)}`);
    check(healCalls === 1, `expected exactly one self-heal call, got ${healCalls}`);
    check(calls.filter((c) => /git push/.test(c.cmd)).length === 2, 'push retried exactly once after self-heal (bounded, not a loop)');
});

test('(fmu) self-heal called but the retry STILL fails: the existing typed GitSyncError still surfaces, no hang / infinite loop, self-heal called exactly once', async () => {
    const { command, calls } = makeCommandMock({
        // Single-entry queue -> makeCommandMock returns the same failure on
        // every call (see its own doc comment), so both the first attempt
        // and the post-heal retry fail identically.
        'git push': [fail("fatal: could not read Username for 'https://github.com': Device not configured")],
    });
    let healCalls = 0;
    const onAuthFailure = async () => { healCalls += 1; };
    let err = null;
    try {
        await syncMemberAfter('m1', { command, onAuthFailure });
    } catch (e) {
        err = e;
    }
    check(err instanceof GitSyncError, `expected GitSyncError (non-diverged failure), got ${err && err.constructor.name}`);
    check(healCalls === 1, `self-heal must be invoked EXACTLY ONCE (bounded, never a loop), got ${healCalls}`);
    check(calls.filter((c) => /git push/.test(c.cmd)).length === 2, `expected exactly one bounded retry after self-heal (2 total push attempts), saw ${calls.filter((c) => /git push/.test(c.cmd)).length}`);
});

test('(fmu) omitting onAuthFailure preserves BYTE-IDENTICAL pre-existing behavior on an auth-classified failure (zero behavior change for non-opted-in callers)', async () => {
    const { command, calls } = makeCommandMock({
        'git push': [fail("fatal: could not read Username for 'https://github.com': Device not configured")],
    });
    let err = null;
    try {
        await syncMemberAfter('m1', { command }); // no onAuthFailure injected
    } catch (e) {
        err = e;
    }
    check(err instanceof GitSyncError, `expected the exact pre-existing GitSyncError, got ${err && err.constructor.name}`);
    check(
        calls.filter((c) => /git push/.test(c.cmd)).length === 1,
        `no self-heal retry may occur when onAuthFailure is not provided -- expected a single push attempt, saw ${calls.filter((c) => /git push/.test(c.cmd)).length}`,
    );
});

test('(fmu) an onAuthFailure that itself throws is treated as a failed self-heal -- falls through to the typed error, never retried further', async () => {
    const { command, calls } = makeCommandMock({
        'git push': [fail("fatal: could not read Username for 'https://github.com': Device not configured")],
    });
    let healCalls = 0;
    const onAuthFailure = async () => { healCalls += 1; throw new Error('provision_vcs_auth failed: fleet server unreachable'); };
    let err = null;
    try {
        await syncMemberAfter('m1', { command, onAuthFailure });
    } catch (e) {
        err = e;
    }
    check(err instanceof GitSyncError, `expected GitSyncError even though self-heal was attempted, got ${err && err.constructor.name}`);
    check(healCalls === 1, `self-heal must still be invoked exactly once, got ${healCalls}`);
    check(calls.filter((c) => /git push/.test(c.cmd)).length === 1, 'no retry is attempted when onAuthFailure itself throws');
});

// =============================================================================
// apra-fleet-647.1.3.3 -- an 'unknown' classification is no longer immediately
// sprint-fatal: it now gets the SAME bounded one-shot self-heal + single
// retry as 'auth', so an unrecognized provider auth string is not treated as
// automatically fatal. 'diverged' remains excluded from any retry -- see the
// module header's SINGLE-WRITER TOKEN PASSING stance.
// =============================================================================

test('(647.1.3.3) self-heal success: an UNKNOWN-classified G-push failure heals once via onAuthFailure and the single bounded retry succeeds', async () => {
    const novelText = 'some totally novel git failure the classifier has never seen before';
    const { command, calls } = makeCommandMock({
        'git push': [fail(novelText), OK],
    });
    check(classifyGitFailure(novelText) === 'unknown', 'precondition: the injected error text must classify as unknown');
    let healCalls = 0;
    const onAuthFailure = async (info) => {
        healCalls += 1;
        check(info.member === 'm1', 'onAuthFailure receives the member');
        check(info.error === novelText, 'onAuthFailure receives the raw provider text verbatim');
    };
    const res = await syncMemberAfter('m1', { command, onAuthFailure });
    check(res.ok === true && res.pushed === true, `expected the push to ultimately succeed after self-heal, got: ${JSON.stringify(res)}`);
    check(healCalls === 1, `expected exactly one self-heal call, got ${healCalls}`);
    check(calls.filter((c) => /git push/.test(c.cmd)).length === 2, 'push retried exactly once after self-heal (bounded, not a loop)');
});

test('(647.1.3.3) self-heal called but the retry STILL fails on an UNKNOWN failure: the typed GitSyncError still surfaces, self-heal called exactly once, no unbounded loop', async () => {
    const novelText = 'a second, still-unrecognized git failure';
    const { command, calls } = makeCommandMock({
        // Single-entry queue -> the same failure repeats on every call, so
        // both the first attempt and the post-heal retry fail identically.
        'git push': [fail(novelText)],
    });
    let healCalls = 0;
    const onAuthFailure = async () => { healCalls += 1; };
    let err = null;
    try {
        await syncMemberAfter('m1', { command, onAuthFailure });
    } catch (e) {
        err = e;
    }
    check(err instanceof GitSyncError, `expected GitSyncError (non-diverged failure), got ${err && err.constructor.name}`);
    check(err.constructor.name !== 'GitDivergedError', 'an unknown failure must never surface as GitDivergedError');
    check(healCalls === 1, `self-heal must be invoked EXACTLY ONCE (bounded, never a loop), got ${healCalls}`);
    check(calls.filter((c) => /git push/.test(c.cmd)).length === 2, `expected exactly one bounded retry after self-heal (2 total push attempts), saw ${calls.filter((c) => /git push/.test(c.cmd)).length}`);
});

test('(647.1.3.3) omitting onAuthFailure preserves pre-existing behavior on an unknown-classified failure: no retry, single attempt', async () => {
    const { command, calls } = makeCommandMock({
        'git push': [fail('yet another unrecognized git failure')],
    });
    let err = null;
    try {
        await syncMemberAfter('m1', { command }); // no onAuthFailure injected
    } catch (e) {
        err = e;
    }
    check(err instanceof GitSyncError, `expected a GitSyncError, got ${err && err.constructor.name}`);
    check(
        calls.filter((c) => /git push/.test(c.cmd)).length === 1,
        `no self-heal retry may occur when onAuthFailure is not provided -- expected a single push attempt, saw ${calls.filter((c) => /git push/.test(c.cmd)).length}`,
    );
});

test('(647.1.3.3) DIVERGED is still excluded from self-heal/retry even when onAuthFailure is provided -- never retried', async () => {
    const { command, calls } = makeCommandMock({
        'git merge --ff-only': [fail('fatal: Not possible to fast-forward, aborting.')],
    });
    let healCalls = 0;
    const onAuthFailure = async () => { healCalls += 1; };
    let err = null;
    try {
        await syncMemberBefore('m1', { command, onAuthFailure });
    } catch (e) {
        err = e;
    }
    check(err instanceof GitDivergedError, `expected GitDivergedError, got ${err && err.constructor.name}`);
    check(healCalls === 0, 'a diverged failure must never invoke onAuthFailure self-heal');
    check(calls.filter((c) => /git merge --ff-only/.test(c.cmd)).length === 1, 'diverged must not be retried at all, bounded to a single attempt');
});

// =============================================================================
// (h) NO vendored agent .md file gains orchestrator-side sync commands. The
// sync brackets live in runner.js; agents never run git/dolt sync themselves
// (Plan 3.2). This is a REAL assertion over the vendored markdown, not a note:
// it reads every vendored agent .md and fails if any bracket-mechanic token
// appears in one.
// =============================================================================
const FORBIDDEN_SYNC_TOKENS = [
    /git merge --ff-only/i,
    /git pull --rebase/i,
    /git rebase --abort/i,
    /bd dolt push/i,
    /bd dolt pull/i,
    /syncMemberBefore/i,
    /syncMemberAfter/i,
    /withGitSync/i,
    /\bG-push\b/i,
    /\bG-pull\b/i,
    /\bD-push\b/i,
    /\bD-pull\b/i,
];

// =============================================================================
// apra-fleet-ta3.2 -- unit coverage for apra-fleet-ta3.1's missing-remote-ref
// guard in syncMemberAfter (G-push on a never-pushed sprint branch), plus a
// regression guard on syncMemberBefore's pre-existing missing-remote-ref skip
// (isMissingRemoteRefError() was factored out as a SHARED predicate in
// ta3.1 -- case 4 below guards that refactor didn't change syncMemberBefore's
// behavior). All four cases use an injected fake command() -- no real git, no
// network.
// =============================================================================

test('(ta3.2-1) fresh branch: G-push on a never-pushed branch resolves { ok: true, pushed: true } and issues a real create-push for the branch', async () => {
    const { command, calls } = makeCommandMock({
        // First push is rejected with git's generic non-FF trailer (the root
        // cause ta3.1 diagnoses: this same generic trailer is printed for a
        // brand-new branch too, not just a genuine divergence) -> classified
        // 'diverged', so syncMemberAfter attempts a pull --rebase to recover.
        'git push': [fail(' ! [rejected] main -> main (non-fast-forward)'), OK],
        // The rebase attempt fails with git's exact, unambiguous "branch does
        // not exist on the remote" message -- this is what tells the guard
        // there is nothing to rebase against, only a branch to create.
        'git pull --rebase': [fail("fatal: couldn't find remote ref refs/heads/mybranch")],
    });

    const res = await syncMemberAfter('m1', { command, branch: 'mybranch', remote: 'origin' });

    check(res.ok === true && res.pushed === true, `expected { ok: true, pushed: true }, got: ${JSON.stringify(res)}`);

    const pushCalls = calls.filter((c) => c.cmd === 'git push origin mybranch');
    check(pushCalls.length === 2, `expected the initial push plus one real create-push retry for 'mybranch', saw ${pushCalls.length} matching calls: ${JSON.stringify(calls.map((c) => c.cmd))}`);
});

test('(ta3.2-2) no blind rebase: the missing-remote-ref guard probes pull --rebase exactly once and never re-issues it (no blind repeat rebase before the create-push retry)', async () => {
    const { command, calls } = makeCommandMock({
        'git push': [fail(' ! [rejected] main -> main (non-fast-forward)'), OK],
        'git pull --rebase': [fail("fatal: couldn't find remote ref refs/heads/mybranch")],
    });

    const res = await syncMemberAfter('m1', { command, branch: 'mybranch', remote: 'origin' });
    check(res.ok === true, 'precondition: the fresh-branch path must still resolve ok');

    const rebaseCalls = calls.filter((c) => /git pull --rebase/.test(c.cmd));
    check(rebaseCalls.length === 1, `expected 'git pull --rebase' issued exactly once (single probe, never blindly repeated), saw ${rebaseCalls.length}`);
});

test('(ta3.2-3) genuine divergence unchanged: remote branch exists, non-FF push -> exactly one pull --rebase then one re-push, still rejected -> GitDivergedError', async () => {
    const { command, calls } = makeCommandMock({
        // Single-entry queues repeat the same result on every call (see
        // makeCommandMock's doc comment) -- both the initial push and the
        // post-rebase re-push are rejected identically, as a genuine
        // divergence would behave.
        'git push': [fail(' ! [rejected] main -> main (non-fast-forward)')],
        'git pull --rebase': [OK],
    });

    let err = null;
    let res = null;
    try {
        res = await syncMemberAfter('m1', { command, branch: 'mybranch', remote: 'origin' });
    } catch (e) {
        err = e;
    }
    check(res === null, `expected no successful resolution for genuine divergence, got: ${JSON.stringify(res)}`);
    check(err instanceof GitDivergedError, `expected GitDivergedError, got ${err && err.constructor.name}`);

    const pushCalls = calls.filter((c) => c.cmd === 'git push origin mybranch');
    const rebaseCalls = calls.filter((c) => /git pull --rebase/.test(c.cmd));
    check(pushCalls.length === 2, `expected the initial push plus exactly one re-push after rebase, saw ${pushCalls.length}`);
    check(rebaseCalls.length === 1, `expected exactly one pull --rebase, saw ${rebaseCalls.length}`);
});

test('(ta3.2-4) syncMemberBefore missing-remote-ref benign skip is unchanged by the shared isMissingRemoteRefError() refactor: returns { ok: true } and skips the ff-only merge', async () => {
    const { command, calls } = makeCommandMock({
        'git fetch': [fail("fatal: couldn't find remote ref refs/heads/mybranch")],
    });

    const res = await syncMemberBefore('m1', { command, branch: 'mybranch', remote: 'origin' });
    check(res && res.ok === true, `expected { ok: true }, got: ${JSON.stringify(res)}`);

    const mergeCalls = calls.filter((c) => /git merge --ff-only/.test(c.cmd));
    check(mergeCalls.length === 0, `expected the ff-only merge to be skipped entirely on a benign missing-remote-ref fetch, saw ${mergeCalls.length} merge call(s)`);
});

test('(h) the vendored agent markdown tree contains NO orchestrator-side sync commands', () => {
    check(fs.existsSync(VENDOR_AGENTS_DIR), `vendored agents dir must exist at ${VENDOR_AGENTS_DIR}`);
    const mdFiles = fs.readdirSync(VENDOR_AGENTS_DIR).filter((f) => f.endsWith('.md'));
    check(mdFiles.length >= 7, `expected the seven+ vendored agent .md files, found ${mdFiles.length}: ${mdFiles.join(', ')}`);

    const offenders = [];
    for (const file of mdFiles) {
        const content = fs.readFileSync(path.join(VENDOR_AGENTS_DIR, file), 'utf8');
        for (const re of FORBIDDEN_SYNC_TOKENS) {
            if (re.test(content)) offenders.push(`${file} :: ${re}`);
        }
    }
    assert.deepStrictEqual(
        offenders,
        [],
        `Vendored agent markdown must not carry orchestrator-side sync-bracket commands (sync stays in runner.js per Plan 3.2). ` +
        `Offending file(s)/token(s): ${offenders.join(' | ')}`,
    );
});
