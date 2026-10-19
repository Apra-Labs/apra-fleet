import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { runPublishPrPhase } from '../fleet-sprint/phases/publish-pr.mjs';
import { finalizeAbort } from '../fleet-sprint/runner.js';
import { SprintPlanRejectedError } from '../fleet-sprint/errors.mjs';
import { BitbucketVCS } from '../fleet-sprint/vcs-providers/bitbucket.mjs';
import { raiseVcsPrForMember } from '../fleet-sprint/vcs-auth.mjs';
import { buildFindPrCommand } from '../fleet-sprint/vcs-module.mjs';
import { ApraFleet } from '@apralabs/apra-fleet-client';

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

function fakeBitbucket({ registered = true, registeredAs = 'bitbucket', credential = 'ok', existing = null, postStatus = null } = {}) {
    const state = { pr: existing ? { id: 42, ...existing } : null, calls: [], provisionCalls: [], execCommands: [], execLabels: [] };
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
            return { content: [{ text: JSON.stringify({ ...(registered ? { vcsProvider: registeredAs } : {}), os: 'linux', shell: '' }) }] };
        }
        if (name === 'provision_vcs_auth') {
            state.provisionCalls.push(toolArgs);
            return { content: [{ text: '[FAIL] unexpected provision' }], structuredContent: { ok: false, reason: 'credential_assembly_failed' } };
        }
        if (name === 'credential_store_list') return { content: [{ text: '[]' }] };
        if (name === 'vcs_credential_exec') {
            state.execLabels.push(toolArgs.label);
            return state.exec(toolArgs.command);
        }
        throw new Error(`unexpected tool ${name}`);
    };
    return state;
}

const remoteCommand = async (cmd) => (cmd === 'git remote get-url origin'
    ? { ok: true, output: BB_ORIGIN, error: null }
    : { ok: true, output: '', error: null });

async function publish({ bb, verdict = 'PASS', notes = 'ok', runId, member, targetIssues = [], commands = [] }) {
    const logs = [];
    const result = await runPublishPrPhase({
        phase: () => {},
        log: (m) => logs.push(m),
        command: async (cmd, opts) => { commands.push(cmd); return remoteCommand(cmd, opts); },
        args: { callTool: bb.callTool, run_id: runId },
        validated: { branch: 'feat/x', baseBranch: 'main', goal: 'Ship X', runId },
        targetIssues,
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

// Regex (not substring) checks: these are log-text assertions, not URL validation.
const REMEDY_URL_RE = /https:\/\/id\.atlassian\.com\/manage-profile\/security\/api-tokens/;
const PR_URL_RE = /https:\/\/bitbucket\.org\/acme\/widgets\/pull-requests\/42/;

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
            assert.ok(skipped.includes(credential) && REMEDY_URL_RE.test(skipped), skipped);
            assert.ok(skipped.includes(BitbucketVCS.authRemedy.hint), skipped);
            assert.deepEqual(bb.provisionCalls, [], 'the push+pr path must never dispatch provision_vcs_auth (no interactive prompt)');
        });
    }

    test('finalizeAbort: no credential -> pr-auth-failed, branch still pushed', async () => {
        const bb = fakeBitbucket({ registered: false, credential: 'credential_read_failed' });
        const { result, logs } = await abortRun({ bb, member: 'bb-abort-nocred' });
        assert.equal(result.reason, 'pr-auth-failed', JSON.stringify({ result, logs }));
        assert.equal(result.pushed, true);
        assert.ok(logs.some((m) => REMEDY_URL_RE.test(m)), JSON.stringify(logs));
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
        assert.ok(logs.some((m) => m.includes('updated its title and body') && PR_URL_RE.test(m)), JSON.stringify(logs));
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
        assert.ok(skipped && skipped.includes('HTTP 401') && REMEDY_URL_RE.test(skipped), JSON.stringify(logs));
    });

    test('the remedy points at Atlassian API tokens, not the retired app-password page', () => {
        assert.ok(REMEDY_URL_RE.test(BitbucketVCS.authRemedy.hint));
        assert.ok(BitbucketVCS.authRemedy.hint.includes('write:pullrequest:bitbucket'));
        assert.ok(!BitbucketVCS.authRemedy.hint.includes('account/settings/app-passwords'));
    });
});

describe('(F1) the PR provider follows the target remote host, not the member registry', () => {
    test('a GitHub-registered backlog member on a bitbucket.org sprint: no provision_vcs_auth call, the bitbucket label, a Bitbucket PR', async () => {
        const bb = fakeBitbucket({ registeredAs: 'github' });
        const { result, logs } = await publish({ bb, runId: 'run-f1', member: 'bb-gh-registered' });
        assert.deepEqual(result, { pushed: true });
        assert.deepEqual(bb.provisionCalls, [], 'the member\'s GitHub credential must never be minted for, or replaced by, a Bitbucket repo');
        assert.deepEqual(bb.execLabels, ['bitbucket']);
        assert.deepEqual(bb.calls, ['POST']);
        assert.ok(logs.some((m) => m.includes("registered for VCS provider 'github'") && m.includes("served by 'bitbucket'")), JSON.stringify(logs));
    });

    test('a GitHub-registered member with no Bitbucket credential degrades with the BITBUCKET remedy, not GitHub\'s', async () => {
        const bb = fakeBitbucket({ registeredAs: 'github', credential: 'credential_read_failed' });
        const { logs } = await publish({ bb, runId: 'run-f1b', member: 'bb-gh-registered-nocred' });
        assert.deepEqual(bb.provisionCalls, []);
        const skipped = logs.find((m) => m.startsWith('[Publish PR Skipped]'));
        assert.ok(skipped && skipped.includes(BitbucketVCS.authRemedy.hint), JSON.stringify(logs));
    });

    test('a provider that WOULD provision is never minted on a member registered for another provider (typed degrade, no provision call)', async () => {
        const calls = [];
        const callTool = async (name, toolArgs) => {
            calls.push(name);
            if (name === 'member_detail') return { content: [{ text: JSON.stringify({ vcsProvider: 'bitbucket', os: 'linux', shell: '' }) }] };
            if (name === 'credential_store_list') return { content: [{ text: '[]' }] };
            throw new Error(`unexpected tool ${name} ${JSON.stringify(toolArgs)}`);
        };
        const result = await raiseVcsPrForMember({
            fleetApi: new ApraFleet({ callTool }),
            command: async () => { throw new Error('no command expected'); },
            member: 'bb-registered-on-github-repo',
            base: 'main', head: 'feat/x', title: 't', body: 'b',
            logPrefix: '[Publish PR]',
            remoteUrlOverride: 'https://github.com/acme/widgets.git',
        });
        assert.equal(result.ok, false);
        assert.equal(result.authFailure, true);
        assert.match(result.error, /registered for VCS provider 'bitbucket', which does not serve this 'github' remote/);
        assert.ok(!calls.includes('provision_vcs_auth'), JSON.stringify(calls));
    });
});

describe('(F2) PASS with no Bitbucket credential keeps closing target issues directly', () => {
    test('PASS + no credential -> bd close for each target, loud "no pull request was opened" log', async () => {
        const bb = fakeBitbucket({ credential: 'credential_read_failed' });
        const commands = [];
        const { result, logs } = await publish({ bb, runId: 'run-f2', member: 'bb-f2-pass', targetIssues: ['t-1', 't-2'], commands });
        assert.deepEqual(result, { pushed: true });
        assert.deepEqual(commands.filter((c) => c.startsWith('bd close')), ['bd close t-1', 'bd close t-2']);
        assert.ok(logs.some((m) => m.startsWith('[Publish PR Skipped] NO pull request was opened') && m.includes('closing target issue(s) directly')), JSON.stringify(logs));
        assert.ok(logs.some((m) => m.includes("closed target issue 't-1' directly")), JSON.stringify(logs));
    });

    test('FAIL + no credential -> targets stay open', async () => {
        const bb = fakeBitbucket({ credential: 'credential_read_failed' });
        const commands = [];
        await publish({ bb, verdict: 'FAIL', runId: 'run-f2f', member: 'bb-f2-fail', targetIssues: ['t-1'], commands });
        assert.deepEqual(commands.filter((c) => c.startsWith('bd close')), []);
    });

    test('a DEPLOYED credential that fails (401) keeps targets open (closure waits for a PR)', async () => {
        const bb = fakeBitbucket({ postStatus: 401 });
        const commands = [];
        await publish({ bb, runId: 'run-f2-401', member: 'bb-f2-401', targetIssues: ['t-1'], commands });
        assert.deepEqual(commands.filter((c) => c.startsWith('bd close')), []);
    });

    test('a created PR keeps targets open (closure waits for the PR)', async () => {
        const bb = fakeBitbucket();
        const commands = [];
        await publish({ bb, runId: 'run-f2-ok', member: 'bb-f2-ok', targetIssues: ['t-1'], commands });
        assert.deepEqual(commands.filter((c) => c.startsWith('bd close')), []);
    });
});

describe('(F3/F4/F5) remedy cautions, fork filter, description retention', () => {
    test('the remedy warns about replacing another provider\'s credential and about local members', () => {
        assert.ok(BitbucketVCS.authRemedy.hint.includes('backlog member dedicated to Bitbucket'));
        assert.ok(BitbucketVCS.authRemedy.hint.includes('LOCAL member'));
    });

    const FIND = { provider: 'bitbucket', repoRef: { workspace: 'acme', repo: 'widgets' }, base: 'main', head: 'feat/x', token: 't', username: 'u', os: 'linux' };

    test('find drops a PR whose source repository is a fork', () => {
        const built = buildFindPrCommand(FIND);
        const mapped = built.mapResponse({
            values: [
                { id: 7, title: 'fork', description: 'x', source: { repository: { full_name: 'someone/widgets' } } },
                { id: 8, title: 'own', description: 'y', source: { repository: { full_name: 'ACME/Widgets' } } },
            ],
        });
        assert.deepEqual(mapped.map((p) => p.id), [8]);
    });

    test('find asks for the description explicitly, and falls back to summary.raw', () => {
        const built = buildFindPrCommand(FIND);
        const fields = encodeURIComponent('values.id,values.title,values.description,values.summary.raw,values.links.html.href,values.source.repository.full_name');
        assert.ok(built.command.includes(`&fields=${fields}`), built.command);
        const [pr] = built.mapResponse({ values: [{ id: 9, title: 't', summary: { raw: 'history body' } }] });
        assert.equal(pr.body, 'history body');
    });
});
