import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { runPublishPrPhase } from '../fleet-sprint/phases/publish-pr.mjs';
import { finalizeAbort } from '../fleet-sprint/runner.js';
import { SprintPlanRejectedError } from '../fleet-sprint/errors.mjs';
import { BitbucketVCS } from '../fleet-sprint/vcs-providers/bitbucket.mjs';

// =============================================================================
// Bitbucket Cloud PR publishing: degrade + existing-PR update parity.
//
// (a) A backlog member with no Bitbucket credential deployed (the common case
//     for an SSH-only remote) must degrade to a skipped PR that names the fix
//     -- including a member with NO registered vcsProvider, whose provider is
//     only detected from its remote -- never fail the sprint.
// (b) A relaunch on a branch with an open Bitbucket PR must find it and
//     rewrite its title/body (PUT), the same as GitHub/Azure DevOps do. The
//     duplicate-create response is undocumented, so the provider declares
//     probeExistingOnFailure instead of a guessed already-exists dialect.
// (c) Auth failures carry the API-token remedy, and a provider whose
//     provisioning is skipped is not pointlessly re-provisioned and retried.
//
// No network: a fake Bitbucket sits behind vcs_credential_exec.
// ASCII only.
// =============================================================================

const BB_ORIGIN = 'git@bitbucket.org:acme/widgets.git';
const PR_URL = 'https://bitbucket.org/acme/widgets/pull-requests/42';

function posixDashD(command) {
    const m = /-d '((?:[^']|'\\'')*)' -w/.exec(command);
    assert.ok(m, `no POSIX -d payload in: ${command}`);
    return JSON.parse(m[1].replace(/'\\''/g, "'"));
}

function fakeBitbucket({ registered = true, credential = 'ok', existing = null, postStatus = null } = {}) {
    const state = { pr: existing ? { id: 42, ...existing } : null, calls: [], provisionCalls: [], execCommands: [] };
    const respond = (status, body) => ({ content: [{ text: '' }], structuredContent: { ok: true, reason: 'ok', exitCode: 0, stdout: `${JSON.stringify(body)}\n${status}`, stderr: '' } });
    const pull = () => ({ id: state.pr.id, title: state.pr.title, description: state.pr.description, links: { html: { href: PR_URL } } });
    state.exec = (cmd) => {
        state.execCommands.push(cmd);
        if (credential !== 'ok') {
            return { content: [{ text: `[FAIL] credential (${credential})` }], structuredContent: { ok: false, reason: credential, exitCode: null, stdout: '', stderr: '' } };
        }
        const method = /^curl -sS -X (\w+)/.exec(cmd)[1];
        state.calls.push(method);
        if (method === 'POST') {
            if (postStatus) return respond(postStatus, { type: 'error', error: { message: `mock HTTP ${postStatus}` } });
            if (state.pr) return respond(400, { type: 'error', error: { message: 'mock: a pull request for this source/destination is already open' } });
            const p = posixDashD(cmd);
            state.pr = { id: 42, title: p.title, description: p.description };
            return respond(201, pull());
        }
        if (method === 'GET') return respond(200, { values: state.pr ? [pull()] : [] });
        if (method === 'PUT') {
            const p = posixDashD(cmd);
            state.pr = { ...state.pr, title: p.title, description: p.description };
            return respond(200, pull());
        }
        throw new Error(`unexpected method ${method}`);
    };
    state.callTool = async (name, toolArgs) => {
        if (name === 'member_detail') {
            return { content: [{ text: JSON.stringify({ ...(registered ? { vcsProvider: 'bitbucket' } : {}), os: 'linux', shell: '' }) }] };
        }
        if (name === 'provision_vcs_auth') {
            state.provisionCalls.push(toolArgs);
            return { content: [{ text: '[FAIL] unexpected provision' }], structuredContent: { ok: false, reason: 'credential_assembly_failed' } };
        }
        if (name === 'credential_store_list') return { content: [{ text: '[]' }] };
        if (name === 'vcs_credential_exec') return state.exec(toolArgs.command);
        throw new Error(`unexpected tool ${name}`);
    };
    return state;
}

const remoteCommand = async (cmd) => (cmd === 'git remote get-url origin'
    ? { ok: true, output: BB_ORIGIN, error: null }
    : { ok: true, output: '', error: null });

async function publish({ bb, verdict = 'PASS', notes = 'ok', runId, member }) {
    const logs = [];
    const result = await runPublishPrPhase({
        phase: () => {},
        log: (m) => logs.push(m),
        command: remoteCommand,
        args: { callTool: bb.callTool, run_id: runId },
        validated: { branch: 'feat/x', baseBranch: 'main', goal: 'Ship X', runId },
        targetIssues: [],
        backlogMember: member,
        finalCycleLabel: '1',
        gitSync: { pushGitAfter: async () => {}, syncBeadsAfter: async () => {} },
        getMemberForRole: () => member,
        finalVerdictResult: { verdict, notes },
    });
    return { result, logs };
}

function abortCommand() {
    return async (cmd, opts = {}) => {
        const out = (output) => (opts.failSoft ? { ok: true, output, error: null } : output);
        if (/^git fetch origin\b/.test(cmd)) return out('');
        if (/^git rev-list --count\b/.test(cmd)) return out('2');
        if (/^git push\b/.test(cmd)) return out('To mock-remote');
        if (/^git remote get-url origin\b/.test(cmd)) return out(BB_ORIGIN);
        throw new Error(`abortCommand: unexpected command '${cmd}'`);
    };
}

async function abortRun({ bb, member }) {
    const logs = [];
    const result = await finalizeAbort({
        error: new SprintPlanRejectedError('Plan rejected after 3 rounds', { notes: null }),
        branch: 'feat/x', baseBranch: 'main', member, command: abortCommand(),
        log: (m) => logs.push(m), callTool: bb.callTool, runId: 'run-abort',
    });
    return { result, logs };
}

const REMEDY_URL = 'https://id.atlassian.com/manage-profile/security/api-tokens';

describe('(a) no Bitbucket credential on the member degrades, never fails the sprint', () => {
    for (const [label, registered, credential] of [
        ['unregistered member (provider detected from remote), no credential file', false, 'credential_read_failed'],
        ['registered member, empty credential', true, 'credential_empty'],
        ['registered member, credential without a username', true, 'username_empty'],
    ]) {
        test(`Publish PR: ${label} -> [Publish PR Skipped] naming the API-token fix`, async () => {
            const bb = fakeBitbucket({ registered, credential });
            const { result, logs } = await publish({ bb, runId: 'run-a', member: `bb-nocred-${credential}-${registered}` });
            assert.deepEqual(result, { pushed: true });
            const skipped = logs.find((m) => m.startsWith('[Publish PR Skipped]'));
            assert.ok(skipped, JSON.stringify(logs));
            assert.ok(skipped.includes(credential) && skipped.includes(REMEDY_URL), skipped);
            assert.ok(skipped.includes(BitbucketVCS.authRemedy.hint), skipped);
            assert.deepEqual(bb.provisionCalls, [], 'the push+pr path must never dispatch provision_vcs_auth (no interactive prompt)');
        });
    }

    test('finalizeAbort: no credential -> pr-auth-failed, branch still pushed', async () => {
        const bb = fakeBitbucket({ registered: false, credential: 'credential_read_failed' });
        const { result, logs } = await abortRun({ bb, member: 'bb-abort-nocred' });
        assert.equal(result.reason, 'pr-auth-failed', JSON.stringify({ result, logs }));
        assert.equal(result.pushed, true);
        assert.ok(logs.some((m) => m.includes(REMEDY_URL)), JSON.stringify(logs));
    });
});

describe('(b) a relaunch rewrites the open Bitbucket PR', () => {
    test('Publish PR FAIL -> PASS: POST fails, the open PR is found (GET) and rewritten (PUT)', async () => {
        const bb = fakeBitbucket();
        await publish({ bb, verdict: 'FAIL', notes: 'gate failed', runId: 'run-1', member: 'bb-relaunch' });
        assert.equal(bb.pr.title, 'fleet-sprint [FAIL]: feat/x');
        const { result, logs } = await publish({ bb, verdict: 'PASS', notes: 'all good', runId: 'run-2', member: 'bb-relaunch' });
        assert.deepEqual(result, { pushed: true });
        assert.deepEqual(bb.calls, ['POST', 'POST', 'GET', 'PUT']);
        assert.equal(bb.pr.title, 'fleet-sprint [PASS]: feat/x');
        assert.ok(bb.pr.description.includes('all good') && !bb.pr.description.includes('gate failed'), bb.pr.description);
        assert.ok(logs.some((m) => m.includes('updated its title and body') && m.includes(PR_URL)), JSON.stringify(logs));
        const find = bb.execCommands.find((c) => c.startsWith('curl -sS -X GET'));
        assert.ok(find.includes("-u '{{vcs_username_inline}}:{{vcs_token_inline}}'"), `find must authenticate with both halves: ${find}`);
    });

    test('finalizeAbort on a branch with an open PR -> already-exists, rewritten as ABORTED', async () => {
        const bb = fakeBitbucket({ existing: { title: 'fleet-sprint [PASS]: feat/x', description: 'old' } });
        const { result } = await abortRun({ bb, member: 'bb-abort-existing' });
        assert.equal(result.reason, 'already-exists');
        assert.equal(result.prUrl, PR_URL);
        assert.deepEqual(bb.calls, ['POST', 'GET', 'PUT']);
        assert.equal(bb.pr.title, 'fleet-sprint [ABORTED]: feat/x');
    });

    test('a non-auth create failure with NO open PR still fails loudly (the probe does not swallow real errors)', async () => {
        const bb = fakeBitbucket({ postStatus: 400 });
        await assert.rejects(
            () => publish({ bb, runId: 'run-x', member: 'bb-real-400' }),
            /\[Publish PR Failed\].*HTTP 400: mock HTTP 400/,
        );
        assert.deepEqual(bb.calls, ['POST', 'GET']);
    });
});

describe('(c) auth failures on a skip-provisioned provider', () => {
    test('a 401 on create is reported once with the API-token remedy -- no pointless re-provision + retry', async () => {
        const bb = fakeBitbucket({ postStatus: 401 });
        const { result, logs } = await publish({ bb, runId: 'run-401', member: 'bb-401' });
        assert.deepEqual(result, { pushed: true });
        assert.deepEqual(bb.calls, ['POST']);
        assert.deepEqual(bb.provisionCalls, []);
        const skipped = logs.find((m) => m.startsWith('[Publish PR Skipped]'));
        assert.ok(skipped && skipped.includes('HTTP 401') && skipped.includes(REMEDY_URL), JSON.stringify(logs));
    });

    test('the remedy points at Atlassian API tokens, not the retired app-password page', () => {
        assert.ok(BitbucketVCS.authRemedy.hint.includes(REMEDY_URL));
        assert.ok(BitbucketVCS.authRemedy.hint.includes('write:pullrequest:bitbucket'));
        assert.ok(!BitbucketVCS.authRemedy.hint.includes('account/settings/app-passwords'));
    });
});
