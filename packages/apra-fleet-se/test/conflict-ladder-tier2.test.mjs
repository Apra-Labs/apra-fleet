import { test } from 'node:test';
import assert from 'node:assert/strict';
import { syncMemberAfter } from '../fleet-sprint/runner.js';
import {
    buildConflictResolutionRunbookPrompt,
    dispatchConflictResolutionAgent,
    detectAndAbortRebaseConflict,
} from '../fleet-sprint/conflict-ladder.mjs';
import { GitDivergedError, GitSyncError } from '../fleet-sprint/errors.mjs';

const check = (cond, msg) => assert.ok(cond, msg);

// Same scripted command() mock helper as git-sync-brackets.test.mjs.
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

function makeAgentMock(impl) {
    const calls = [];
    const agent = async (prompt, opts = {}) => {
        calls.push({ prompt, opts });
        if (impl) return impl(prompt, opts);
        return { status: 'RESOLVED' };
    };
    return { agent, calls };
}

const OK = { ok: true, output: '', error: null };
const fail = (error) => ({ ok: false, output: '', error });

// =============================================================================
// apra-fleet-eft.8.12 -- Tier 2 (agent-with-runbook) git conflict escalation.
//
// Tier 1 (already covered by git-sync-brackets.test.mjs) is
// unaffected -- these tests confirm that an unmerged-paths conflict, WITH an
// injected agent(), escalates to Tier 2 exactly once and that Tier 2's
// outcome is decided by mechanically re-observed git state, never the
// agent's own claim.
// =============================================================================

test('buildConflictResolutionRunbookPrompt: is ASCII-only and names every conflicted file, the member, and the branch', () => {
    const prompt = buildConflictResolutionRunbookPrompt({
        member: 'm1', branch: 'auto-sprint/eft-service', unmergedPaths: ['a.txt', 'src/b.js'],
    });
    check(/^[\x00-\x7F]*$/.test(prompt), 'runbook prompt must be ASCII-only');
    check(prompt.includes('a.txt') && prompt.includes('src/b.js'), 'prompt must list every conflicted file');
    check(prompt.includes('m1'), 'prompt must name the member');
    check(prompt.includes('auto-sprint/eft-service'), 'prompt must name the branch');
});

test('dispatchConflictResolutionAgent: throws a clear error when no agent() is injected', async () => {
    let err = null;
    try {
        await dispatchConflictResolutionAgent({ agent: undefined, member: 'm1', branch: 'b', unmergedPaths: ['a.txt'] });
    } catch (e) { err = e; }
    check(err instanceof Error && /requires an injected agent/.test(err.message), 'must fail loudly without an agent()');
});

test('dispatchConflictResolutionAgent: calls agent() exactly once with explicit member_name and the runbook prompt', async () => {
    const { agent, calls } = makeAgentMock();
    await dispatchConflictResolutionAgent({ agent, member: 'm1', branch: 'auto-sprint/eft-service', unmergedPaths: ['a.txt'] });
    check(calls.length === 1, `expected exactly one agent() dispatch, saw ${calls.length}`);
    check(calls[0].opts.member_name === 'm1', 'Tier 2 dispatch must carry explicit member_name');
    check(calls[0].prompt.includes('a.txt'), 'Tier 2 prompt must name the conflicted file');
});

test('syncMemberAfter Tier 2: a same-line conflict resolved by the agent (clean tree + successful re-push) succeeds without throwing', async () => {
    const { command, calls } = makeCommandMock({
        'git push': [fail(' ! [rejected] (non-fast-forward)'), OK], // initial reject, then Tier 2 re-push
        'git pull --rebase': [fail('CONFLICT (content): Merge conflict in a.txt')],
        'git status --porcelain': [
            { ok: true, output: 'UU a.txt\n', error: null }, // Tier 1 conflict-detection check
            { ok: true, output: '', error: null },           // Tier 1 post-abort clean-state check
            { ok: true, output: '', error: null },           // Tier 2 post-resolution clean-state check
        ],
        'git rebase --abort': [OK],
    });
    const { agent, calls: agentCalls } = makeAgentMock();

    const result = await syncMemberAfter('m1', { command, agent, branch: 'auto-sprint/eft-service' });

    check(result.ok === true && result.pushed === true && result.tier2Resolved === true, `expected a resolved success, got ${JSON.stringify(result)}`);
    check(agentCalls.length === 1, `expected exactly one Tier 2 agent() dispatch, saw ${agentCalls.length}`);
    check(agentCalls[0].opts.member_name === 'm1', 'Tier 2 dispatch must carry explicit member_name');

    const pushCalls = calls.filter((c) => /^git push/.test(c.cmd));
    check(pushCalls.length === 2, `expected exactly 2 'git push' attempts (initial + Tier 2 re-push), saw ${pushCalls.length}`);
});

test('syncMemberAfter Tier 2: agent() throwing falls back to the typed GitDivergedError, with exactly one bounded attempt (no retry loop)', async () => {
    const { command } = makeCommandMock({
        'git push': [fail(' ! [rejected] (non-fast-forward)')],
        'git pull --rebase': [fail('CONFLICT (content): Merge conflict in a.txt')],
        'git status --porcelain': [
            { ok: true, output: 'UU a.txt\n', error: null },
            { ok: true, output: '', error: null },
            { ok: true, output: 'UU a.txt\n', error: null }, // agent never actually fixed anything
        ],
        'git rebase --abort': [OK],
    });
    const { agent, calls: agentCalls } = makeAgentMock(() => { throw new Error('mock agent transport failure'); });

    let err = null;
    try {
        await syncMemberAfter('m1', { command, agent, branch: 'auto-sprint/eft-service' });
    } catch (e) { err = e; }

    check(err instanceof GitDivergedError, `expected GitDivergedError, got ${err && err.constructor.name}`);
    check(err.details.unmergedPaths.length === 1 && err.details.unmergedPaths[0] === 'a.txt', 'typed error must still carry the unmerged paths');
    check(agentCalls.length === 1, `Tier 2 must be attempted exactly once even on failure, saw ${agentCalls.length}`);
});

test('syncMemberAfter Tier 2: agent() completes but leaves the tree still conflicted -- typed error thrown, a second rebase --abort restores a clean tree', async () => {
    const { command, calls } = makeCommandMock({
        'git push': [fail(' ! [rejected] (non-fast-forward)')],
        'git pull --rebase': [fail('CONFLICT (content): Merge conflict in a.txt')],
        'git status --porcelain': [
            { ok: true, output: 'UU a.txt\n', error: null }, // Tier 1 detect
            { ok: true, output: '', error: null },           // Tier 1 post-abort
            { ok: true, output: 'UU a.txt\n', error: null }, // Tier 2 post-resolution: still conflicted
            { ok: true, output: 'UU a.txt\n', error: null }, // safety-restore detect: still unmerged
            { ok: true, output: '', error: null },           // safety-restore post-abort
        ],
        'git rebase --abort': [OK, OK],
    });
    const { agent, calls: agentCalls } = makeAgentMock(); // "succeeds" per its own claim, but git state disagrees

    let err = null;
    try {
        await syncMemberAfter('m1', { command, agent, branch: 'auto-sprint/eft-service' });
    } catch (e) { err = e; }

    check(err instanceof GitDivergedError, `expected GitDivergedError, got ${err && err.constructor.name}`);
    check(agentCalls.length === 1, 'Tier 2 must not be retried after an unsuccessful resolution');
    const abortCalls = calls.filter((c) => /git rebase --abort/.test(c.cmd));
    check(abortCalls.length === 2, `expected two rebase --abort calls (Tier 1 + Tier 2 safety restore), saw ${abortCalls.length}`);
});

test('syncMemberAfter Tier 2: a clean-tree resolution whose re-push still fails falls back to the typed GitDivergedError', async () => {
    const { command } = makeCommandMock({
        'git push': [fail(' ! [rejected] (non-fast-forward)'), fail(' ! [rejected] (non-fast-forward)')],
        'git pull --rebase': [fail('CONFLICT (content): Merge conflict in a.txt')],
        'git status --porcelain': [
            { ok: true, output: 'UU a.txt\n', error: null },
            { ok: true, output: '', error: null },
            { ok: true, output: '', error: null }, // Tier 2 leaves a clean tree...
        ],
        'git rebase --abort': [OK],
    });
    const { agent } = makeAgentMock();

    let err = null;
    try {
        await syncMemberAfter('m1', { command, agent, branch: 'auto-sprint/eft-service' });
    } catch (e) { err = e; }

    // ...but the re-push is still rejected (e.g. yet another concurrent
    // writer), so this must still surface the typed divergence error rather
    // than silently reporting success.
    check(err instanceof GitDivergedError, `expected GitDivergedError, got ${err && err.constructor.name}`);
});

test('syncMemberAfter Tier 2: a plain non-conflict divergence (no unmerged paths) never dispatches the agent, even when one is injected', async () => {
    const { command } = makeCommandMock({
        'git push': [fail(' ! [rejected] (non-fast-forward)')],
        'git pull --rebase': [fail('CONFLICT (content): Merge conflict in a.txt')],
        'git status --porcelain': [{ ok: true, output: '', error: null }], // clean -- not a real content conflict
    });
    const { agent, calls: agentCalls } = makeAgentMock();

    let err = null;
    try {
        await syncMemberAfter('m1', { command, agent, branch: 'auto-sprint/eft-service' });
    } catch (e) { err = e; }

    check(err instanceof GitDivergedError, `expected GitDivergedError, got ${err && err.constructor.name}`);
    check(agentCalls.length === 0, 'Tier 2 must only escalate on a genuine same-line/same-hunk conflict (unmerged paths), never a plain divergence');
});

test('syncMemberAfter Tier 2: omitting agent() entirely preserves the exact pre-8.12 Tier-1-only behavior', async () => {
    const { command } = makeCommandMock({
        'git push': [fail(' ! [rejected] (non-fast-forward)')],
        'git pull --rebase': [fail('CONFLICT (content): Merge conflict in a.txt')],
        'git status --porcelain': [
            { ok: true, output: 'UU a.txt\n', error: null },
            { ok: true, output: '', error: null },
        ],
        'git rebase --abort': [OK],
    });
    let err = null;
    try {
        await syncMemberAfter('m1', { command, branch: 'auto-sprint/eft-service' }); // no agent
    } catch (e) { err = e; }
    check(err instanceof GitDivergedError, `expected GitDivergedError, got ${err && err.constructor.name}`);
    check(!(err instanceof GitSyncError) || err instanceof GitDivergedError, 'still the diverged (not generic sync) error type');
});

// =============================================================================
// Pre-merge review fix: a failed post-abort `git status --porcelain` probe
// must never be reported as a clean tree. detectAndAbortRebaseConflict is
// exercised directly here (rather than through syncMemberAfter) so the log
// output of the Tier 1 abort/re-check sequence itself can be asserted.
// =============================================================================

/** A fake runGitStep -- detectAndAbortRebaseConflict only awaits it and reads `.output`, never re-implements its retry logic. */
function fakeRunGitStep(result) {
    return async () => result;
}

test('detectAndAbortRebaseConflict: a failed post-abort status probe is logged as UNKNOWN, never as a silently-clean tree', async () => {
    const { command, calls } = makeCommandMock({
        'git rebase --abort': [OK],
        // The raw post-abort `git status --porcelain` call (line ~97) fails
        // outright -- silent + failSoft means this comes back as ok:false
        // with no output, exactly what a clean tree ALSO looks like.
        'git status --porcelain': [{ ok: false, output: undefined, error: 'member unreachable' }],
    });
    const logLines = [];
    const log = (line) => logLines.push(line);

    const result = await detectAndAbortRebaseConflict({
        command, member: 'm1', log, maxTransientRetries: 0,
        runGitStep: fakeRunGitStep({ ok: true, output: 'UU a.txt\n', error: null }),
    });

    check(result.length === 1 && result[0] === 'a.txt', 'must still report the originally-detected unmerged path');
    const unknownLine = logLines.find((l) => /post-abort clean-state check for member 'm1' itself failed/.test(l));
    check(!!unknownLine, `expected a distinct "check itself failed" warning, got: ${JSON.stringify(logLines)}`);
    check(!logLines.some((l) => /did not fully restore a clean working tree/.test(l)), 'a failed PROBE must not be logged as a confirmed-dirty tree either -- it is unknown, not observed');

    const statusCalls = calls.filter((c) => /^git status --porcelain/.test(c.cmd));
    check(statusCalls.length === 1, `expected exactly one raw porcelain call (the post-abort one), saw ${statusCalls.length}`);
});

test('detectAndAbortRebaseConflict: a successful post-abort probe reporting a still-dirty tree still logs the existing warning', async () => {
    const { command } = makeCommandMock({
        'git rebase --abort': [OK],
        'git status --porcelain': [{ ok: true, output: 'UU a.txt\n', error: null }],
    });
    const logLines = [];
    const log = (line) => logLines.push(line);

    await detectAndAbortRebaseConflict({
        command, member: 'm1', log, maxTransientRetries: 0,
        runGitStep: fakeRunGitStep({ ok: true, output: 'UU a.txt\n', error: null }),
    });

    check(logLines.some((l) => /did not fully restore a clean working tree/.test(l)), 'a confirmed-dirty post-abort tree must still warn as before');
});

test('detectAndAbortRebaseConflict: a successful post-abort probe reporting a clean tree stays silent (no false warning)', async () => {
    const { command } = makeCommandMock({
        'git rebase --abort': [OK],
        'git status --porcelain': [{ ok: true, output: '', error: null }],
    });
    const logLines = [];
    const log = (line) => logLines.push(line);

    await detectAndAbortRebaseConflict({
        command, member: 'm1', log, maxTransientRetries: 0,
        runGitStep: fakeRunGitStep({ ok: true, output: 'UU a.txt\n', error: null }),
    });

    check(!logLines.some((l) => /WARNING/.test(l)), `a genuinely clean confirmed tree must not warn, got: ${JSON.stringify(logLines)}`);
});

test('detectAndAbortRebaseConflict: a failed "git rebase --abort" itself is now logged instead of silently discarded', async () => {
    const { command } = makeCommandMock({
        'git rebase --abort': [{ ok: false, output: '', error: 'index.lock exists' }],
        'git status --porcelain': [{ ok: true, output: '', error: null }],
    });
    const logLines = [];
    const log = (line) => logLines.push(line);

    await detectAndAbortRebaseConflict({
        command, member: 'm1', log, maxTransientRetries: 0,
        runGitStep: fakeRunGitStep({ ok: true, output: 'UU a.txt\n', error: null }),
    });

    check(logLines.some((l) => /'git rebase --abort' for member 'm1' reported failure/.test(l)), `expected the abort failure to be logged, got: ${JSON.stringify(logLines)}`);
});
