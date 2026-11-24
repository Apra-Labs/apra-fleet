// Every member-bound `bd dolt pull` / `bd dolt push` runs git non-interactively:
// GIT_TERMINAL_PROMPT=0 and GCM_INTERACTIVE=never, built in JS in the member's
// shell dialect (a NAME=value prefix on linux/macOS/Git Bash, `$env:`
// assignment statements on PowerShell), so a credential helper that would
// prompt fails fast with git's own credential text instead of hanging the sync
// until its timeout. And a reviewer read-side D-pull that fails on a VCS
// credential is a typed infrastructure failure naming its remedy -- never a
// synthesized CHANGES_NEEDED or APPROVED verdict.
//
// ASCII only.

import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import { bdSyncCommandFor, logicalBdCommand, NON_INTERACTIVE_GIT_ENV } from '../fleet-sprint/bd-sync-command.mjs';
import {
    doltPullBefore,
    setMemberTargetResolver,
    invalidateSyncRemoteCache,
    clearLastSyncedTip,
    clearTipProbeFailures,
} from '../fleet-sprint/dolt-sync.mjs';
import {
    DoltSyncError,
    isDoltCredentialFailure,
    DOLT_CREDENTIAL_FAILURE_CLASS,
    DOLT_CREDENTIAL_REMEDY,
} from '../fleet-sprint/errors.mjs';
import { runDevelopLoopScenario, withScenarioMarkers, mockCmdResult } from './helpers/mock-sprint-harness.mjs';

const TARGETS = [
    { name: 'linux', target: { os: 'linux', shell: '' }, dialect: 'posix', gomaxprocs: false },
    { name: 'macOS', target: { os: 'darwin', shell: '' }, dialect: 'posix', gomaxprocs: false },
    { name: 'Windows Git Bash', target: { os: 'windows', shell: 'gitbash' }, dialect: 'posix', gomaxprocs: true },
    { name: 'Windows PowerShell 5', target: { os: 'windows', shell: 'powershell5' }, dialect: 'pwsh', gomaxprocs: true },
    { name: 'Windows pwsh 7', target: { os: 'windows', shell: 'pwsh7' }, dialect: 'pwsh', gomaxprocs: true },
    { name: 'Windows PowerShell (no shell recorded)', target: { os: 'windows', shell: '' }, dialect: 'pwsh', gomaxprocs: true },
];

describe('bdSyncCommandFor: the non-interactive git env in every member shell dialect', () => {
    test('the env pair is exactly GIT_TERMINAL_PROMPT=0 and GCM_INTERACTIVE=never', () => {
        assert.deepEqual(NON_INTERACTIVE_GIT_ENV.map(([n, v]) => `${n}=${v}`), ['GIT_TERMINAL_PROMPT=0', 'GCM_INTERACTIVE=never']);
    });

    for (const row of TARGETS) {
        for (const cmd of ['bd dolt pull', 'bd dolt push']) {
            test(`${row.name}: ${cmd}`, () => {
                const wire = bdSyncCommandFor(cmd, row.target);
                assert.ok(wire.endsWith(cmd), `the logical command ends the wire string: ${wire}`);
                const prefix = wire.slice(0, wire.length - cmd.length);
                if (row.dialect === 'posix') {
                    assert.match(prefix, /(^| )GIT_TERMINAL_PROMPT=0 /);
                    assert.match(prefix, /(^| )GCM_INTERACTIVE=never /);
                    assert.ok(!prefix.includes('$'), `a POSIX prefix reads no variable: ${wire}`);
                } else {
                    // PowerShell: assignment STATEMENTS with single-quoted
                    // values, and nothing else -- no `$` outside `$env:NAME=`.
                    assert.match(prefix, /\$env:GIT_TERMINAL_PROMPT='0'; /);
                    assert.match(prefix, /\$env:GCM_INTERACTIVE='never'; /);
                    assert.match(prefix, /^(?:\$env:[A-Za-z_][A-Za-z0-9_]*='[^'$`]*'; )+$/,
                        `the PowerShell prefix is only $env: assignments: ${wire}`);
                    const unassigned = prefix.replace(/\$env:[A-Za-z_][A-Za-z0-9_]*=/g, '');
                    assert.ok(!/[$`]/.test(unassigned), `no unassigned $ reference (shell expansion): ${wire}`);
                }
                if (row.gomaxprocs) assert.match(prefix, /GOMAXPROCS(=1 |='1'; )$/, `Windows keeps GOMAXPROCS=1, last before bd: ${wire}`);
                else assert.ok(!prefix.includes('GOMAXPROCS'), `no GOMAXPROCS off Windows: ${wire}`);
                assert.equal(logicalBdCommand(wire), cmd, `logicalBdCommand strips the prefix: ${wire}`);
            });
        }
    }

    test('an unresolved member (no OS) gets the bare command, the only form every shell runs', () => {
        assert.equal(bdSyncCommandFor('bd dolt pull', null), 'bd dolt pull');
        assert.equal(bdSyncCommandFor('bd dolt pull', { os: '', shell: '' }), 'bd dolt pull');
    });
});

const SYNC_REMOTE = 'git+https://example.invalid/org/beads.git';
const CREDENTIAL_STDERR = 'Error: fetch from origin/main: failed to get remote db; git command failed\n'
    + "fatal: could not read Username for 'https://example.invalid': terminal prompts disabled\n";

describe('a credential failure of a D-pull is a typed credential sync failure', () => {
    beforeEach(() => {
        invalidateSyncRemoteCache();
        clearLastSyncedTip();
        clearTipProbeFailures();
        setMemberTargetResolver(null);
    });
    afterEach(() => setMemberTargetResolver(null));

    test('a non-interactive prompt refusal carries the member-neutral remedy', async () => {
        const command = async (cmd) => {
            if (cmd.includes('bd config get sync.remote')) return { ok: true, output: JSON.stringify({ value: SYNC_REMOTE }), error: null };
            if (logicalBdCommand(cmd) === 'bd dolt pull') return { ok: false, output: '', error: CREDENTIAL_STDERR };
            return { ok: true, output: '', error: null };
        };
        const err = await doltPullBefore('m1', { command, remoteTipFingerprint: false, memberTarget: { os: 'linux', shell: '' } })
            .then(() => null, (e) => e);
        assert.ok(err instanceof DoltSyncError, `expected a DoltSyncError, got ${err && err.name}`);
        assert.equal(isDoltCredentialFailure(err), true);
        assert.ok(err.message.includes(DOLT_CREDENTIAL_REMEDY), `the message carries the remedy: ${err.message}`);
        assert.match(DOLT_CREDENTIAL_REMEDY, /without prompting/);
        assert.match(DOLT_CREDENTIAL_REMEDY, /remote member/);
    });

    test('a non-credential sync failure is not classified as a credential failure', () => {
        assert.equal(isDoltCredentialFailure(new DoltSyncError('x', { details: { kind: 'transient' } })), false);
        assert.equal(isDoltCredentialFailure(new Error('x')), false);
    });
});

// ---------------------------------------------------------------------------
// Mock sprint: the reviewer's read-side D-pull fails on a VCS credential.
// ---------------------------------------------------------------------------

const MERGE_BASE_RE = /^git merge-base origin\/\S+ \S+\s*$/;
const LS_REMOTE_RE = / ls-remote https:\/\/example\.invalid\/org\/beads\.git refs\/dolt\/data$/;

/**
 * One shared Dolt remote whose D-pulls succeed until the first per-round
 * review resolves its diff base (`git merge-base`, issued just before the
 * reviewer ladder's read-side sync); every D-pull after that fails with a
 * non-interactive git credential refusal. The tip moves on every probe so no
 * D-pull is skipped as provably current.
 */
function reviewerCredentialFailure() {
    const state = { probes: 0, failing: false, failedPulls: 0, pullsBeforeReview: 0 };
    const exit0 = (stdout = '') => mockCmdResult(0, stdout, '');
    const onCommand = async ({ command: wire }) => {
        const command = logicalBdCommand(wire);
        if (/^bd config get sync\.remote/.test(command)) return exit0(JSON.stringify({ key: 'sync.remote', value: SYNC_REMOTE }));
        if (LS_REMOTE_RE.test(command)) {
            state.probes += 1;
            return exit0(`${String(state.probes).padStart(40, '0')}\trefs/dolt/data\n`);
        }
        if (MERGE_BASE_RE.test(command)) state.failing = true;
        if (command === 'bd dolt pull') {
            if (state.failing) {
                state.failedPulls += 1;
                return mockCmdResult(1, '', CREDENTIAL_STDERR);
            }
            state.pullsBeforeReview += 1;
            return exit0('Pull complete.\n');
        }
        if (command === 'bd dolt push') return exit0('Push complete.\n');
        if (command === 'bd vc status --json') return exit0(JSON.stringify({ branch: 'main', commit: 'x', schema_version: 1 }));
        if (command === 'bd diff remotes/origin/main main --json') return exit0('[]');
        return undefined;
    };
    return { state, onCommand };
}

test('mock sprint: a reviewer read-side D-pull credential failure is a typed infra failure, not a verdict', { timeout: 300000 }, async () => {
    invalidateSyncRemoteCache();
    clearLastSyncedTip();
    clearTipProbeFailures();
    await withScenarioMarkers('revcredfail', async () => {
        const remote = reviewerCredentialFailure();
        let reviewerCalls = 0;
        const run = await runDevelopLoopScenario('revcredfail', {
            members: ['local'],
            taskSpecs: [{ title: 'Task: reviewer credential failure scenario work' }],
            maxCycles: 1,
            onCommand: remote.onCommand,
            reviewerHandler: async () => {
                reviewerCalls += 1;
                return { content: [{ text: JSON.stringify({ verdict: 'APPROVED', notes: 'ok', reopenIds: [], newTasks: [] }) }] };
            },
        });
        const dump = () => run.logs.join('\n');

        assert.ok(remote.state.failedPulls > 0, `the reviewer read-side D-pull was attempted and failed:\n${dump()}`);
        assert.equal(reviewerCalls, 0, 'the reviewer was never dispatched over a failed read-side sync');

        // Typed, loud, with the remedy.
        const typed = run.logs.filter((l) => l.includes(`[${DOLT_CREDENTIAL_FAILURE_CLASS}]`));
        assert.equal(typed.length, 1, `exactly one typed infrastructure line:\n${dump()}`);
        assert.match(typed[0], /^Reviewer: /);
        assert.match(typed[0], /INFRASTRUCTURE FAILURE/);
        assert.ok(typed[0].includes(DOLT_CREDENTIAL_REMEDY), `the typed line names the remedy: ${typed[0]}`);

        // No synthesized verdict for that review.
        assert.ok(!run.logs.some((l) => /Reviewer: agent dispatch failed, degrading/.test(l)), `no degraded round:\n${dump()}`);
        assert.ok(run.error, 'the credential failure propagates as the run error');
        assert.equal(isDoltCredentialFailure(run.error), true, `the run error is the credential sync failure: ${run.error && run.error.message}`);
    });
});
