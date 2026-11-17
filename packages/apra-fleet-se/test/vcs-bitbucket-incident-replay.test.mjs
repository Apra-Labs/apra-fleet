import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { runDevelopLoopScenario, withScenarioMarkers, defaultMockCallTool, mockCmdResult } from './helpers/mock-sprint-harness.mjs';
import { raiseVcsPrForMember, VCS_CREDENTIAL_PROBE_FAILED } from '../fleet-sprint/vcs-auth.mjs';
import { ApraFleet } from '@apralabs/apra-fleet-client';

// =============================================================================
// Incident replay: a masked failing Bitbucket PR credential.
//
// The incident: a LOCAL Bitbucket member whose `git ls-remote` succeeded
// because ANOTHER host credential helper answered, while the fleet's
// bitbucket-labelled helper -- the one Publish PR reads through
// vcs_credential_exec -- held a repository access token for a different
// repository, with the username line `{{secret.e2e_bb_user}}` (an unresolved
// placeholder). Preflight logged "credential works", the whole sprint ran,
// and Publish PR then failed with a 403 whose hint blamed a missing scope on
// a healthy API token.
//
// Replayed through the REAL runner.js sprint cycle (runDevelopLoopScenario):
// fake member_detail / credential_store_list / vcs_credential_exec, member
// commands answered by onCommand, and Bitbucket's recorded 403 (curl -D -
// header block + JSON body + -w status line). Asserts the preflight verdict,
// the exact ERROR line and when it lands (before any develop dispatch),
// which fleet tools were called (no provision_vcs_auth for the local member)
// and the Publish PR failure text. A sentinel token placed in the fake
// credential must never appear in any captured line. No network.
// ASCII only.
// =============================================================================

const BB_ORIGIN = 'git@bitbucket.org:acme/widgets.git';
const SENTINEL = 'SENTINEL-incident-token-9d2c';

/** Recorded: a repository access token (for another repo) asked to list or
 *  open pull requests. */
const REPO_ACCESS_TOKEN_403 = [
    'HTTP/2 403 ',
    'content-type: application/json; charset=utf-8',
    'x-credential-type: repo_access_token',
    'x-oauth-scopes: repository:write',
    'x-accepted-oauth-scopes: pullrequest',
    '',
    '{"type": "error", "error": {"message": "Your credentials lack one or more required privilege scopes.", "detail": {"required": ["pullrequest"], "granted": ["repository:write"]}}}',
].join('\r\n') + '\n403';

/** Recorded: an Atlassian API token without the pull-request write scope. */
const API_TOKEN_403 = [
    'HTTP/2 403 ',
    'content-type: application/json; charset=utf-8',
    'x-credential-type: api_token',
    'x-oauth-scopes: read:repository:bitbucket, write:repository:bitbucket, read:pullrequest:bitbucket',
    '',
    '{"type": "error", "error": {"message": "Your credentials lack one or more required privilege scopes.", "detail": {"required": ["write:pullrequest:bitbucket"], "granted": ["read:repository:bitbucket", "write:repository:bitbucket", "read:pullrequest:bitbucket"]}}}',
].join('\r\n') + '\n403';

/** The fake server-side vcs_credential_exec: substitutes the sentinel for the
 *  inline placeholder (so a leak would be visible), answers the recording,
 *  and redacts the token from what it returns -- like the real tool. */
function credentialExec(state, args, recording) {
    state.execs.push({ label: args.label, command: args.command });
    const substituted = args.command.replaceAll('{{vcs_token_inline}}', SENTINEL);
    assert.ok(substituted.includes(SENTINEL), `no token placeholder in a credential-requiring command: ${args.command}`);
    return {
        content: [{ text: '[OK] Ran credential-requiring command (exit 0).' }],
        structuredContent: { ok: true, reason: 'ok', exitCode: 0, stdout: recording.replaceAll(SENTINEL, '[REDACTED:vcs_token]'), stderr: '' },
    };
}

/** True for the member-side username-line read of the labelled helper. */
const isUsernameRead = (cmd) => cmd.includes("grep '^username='");

async function replayIncident(tag, { store = ['bitbucket_api_token'] } = {}) {
    const state = { execs: [], provisions: [], memberCommands: [], timeline: [] };
    const callToolFactory = (executeCommand) => {
        const base = defaultMockCallTool({ executeCommand });
        return async (name, args) => {
            if (name === 'member_detail') {
                return { content: [{ text: JSON.stringify({ type: 'local', os: 'linux', shell: '', vcsProvider: 'bitbucket' }) }] };
            }
            if (name === 'credential_store_list') {
                return { content: [{ text: JSON.stringify(store.map((n) => ({ name: n, scope: 'persistent' }))) }] };
            }
            if (name === 'provision_vcs_auth') {
                state.provisions.push(args);
                return { content: [{ text: '[FAIL] unexpected provision in incident replay' }], structuredContent: { ok: false, reason: 'unexpected' } };
            }
            if (name === 'vcs_credential_exec') return credentialExec(state, args, REPO_ACCESS_TOKEN_403);
            return base(name, args);
        };
    };
    const onCommand = async ({ command }) => {
        if (command.includes('git ls-remote origin')) {
            // Another host helper answers: git works.
            state.memberCommands.push(command);
            return mockCmdResult(0, '0123456789abcdef0123456789abcdef01234567\tHEAD\n', '');
        }
        if (isUsernameRead(command)) {
            state.memberCommands.push(command);
            // The labelled helper. Even if a member-side filter let the token
            // line through, only the username= line may be looked at.
            return mockCmdResult(0, `username={{secret.e2e_bb_user}}\npassword=${SENTINEL}\n`, '');
        }
        return undefined;
    };
    const onWorkflow = async (workflow) => {
        workflow.on('log', (e) => state.timeline.push({ kind: 'log', msg: e.msg }));
        workflow.on('activity:start', (meta) => state.timeline.push({ kind: 'activity', meta }));
    };
    const scenario = await runDevelopLoopScenario(tag, {
        members: ['local'],
        taskSpecs: [{ title: 'Task: incident replay for a masked Bitbucket PR credential' }],
        maxCycles: 1,
        callToolFactory,
        onCommand,
        onWorkflow,
        originUrl: BB_ORIGIN,
    });
    return { scenario, state };
}

/** Index of the first develop (doer) dispatch in the ordered timeline. */
function firstDoerDispatchIndex(timeline) {
    return timeline.findIndex((e) => e.kind === 'activity' && e.meta
        && e.meta.type === 'agent' && /^Develop\b/.test(String(e.meta.phase || '')));
}

/** Index of the first agent dispatch of any kind (planner included). */
function firstAgentDispatchIndex(timeline) {
    return timeline.findIndex((e) => e.kind === 'activity' && e.meta && e.meta.type === 'agent');
}

describe('incident replay through the real sprint cycle', () => {
    test('preflight: one ERROR line, before any develop dispatch, naming the real cause and the exact fix; no provision for the local member', async () => {
        await withScenarioMarkers('skl2.3 incident replay', async () => {
            const homeBefore = fs.readdirSync(os.homedir()).filter((n) => n.startsWith('.fleet-git-credential')).sort();
            const { scenario, state } = await replayIncident('skl23_incident');
            assert.ok(!scenario.error, `the sprint keeps going (PR skipped, not a launch stop): ${scenario.error && scenario.error.message}`);

            // The verdict: failed, logged exactly once.
            const errors = scenario.logs.filter((l) => l.includes(VCS_CREDENTIAL_PROBE_FAILED));
            assert.equal(errors.length, 1, `expected exactly one probe ERROR line, got:\n${errors.join('\n')}`);
            const line = errors[0];
            assert.match(line, /^\[Sync\] preflight: ERROR vcs_credential_probe_failed: local member 'local' \(provider 'bitbucket'\)/);
            assert.ok(!scenario.logs.some((l) => /credential works; provision_vcs_auth skipped/.test(l)), 'the masked credential is NOT reported as working');

            // Names the credential type, required/granted scopes, the
            // username problem, the exact command and the consequence.
            assert.match(line, /repo_access_token/);
            assert.match(line, /required: pullrequest; granted: repository:write/);
            assert.match(line, /username line is the unresolved placeholder literal \{\{secret\.e2e_bb_user\}\}, not x-bitbucket-api-token-auth/);
            assert.ok(line.includes('provision_vcs_auth member_name=local provider=bitbucket workspace=acme api_token={{secret.bitbucket_api_token}}'), line);
            assert.match(line, /rewrites the host's global bitbucket\.org git credential helper/);
            assert.match(line, /No PR will be opened this sprint/);
            assert.ok([...line].every((ch) => ch.charCodeAt(0) < 128), 'ASCII only');

            // At preflight time: before the first develop dispatch.
            const errorIdx = state.timeline.findIndex((e) => e.kind === 'log' && e.msg.includes(VCS_CREDENTIAL_PROBE_FAILED));
            const doerIdx = firstDoerDispatchIndex(state.timeline);
            assert.ok(errorIdx >= 0, 'the ERROR line is in the ordered timeline');
            assert.ok(doerIdx >= 0, `a develop dispatch happened: ${JSON.stringify(state.timeline.filter((e) => e.kind === 'activity').map((e) => e.meta))}`);
            assert.ok(errorIdx < doerIdx, `ERROR (at ${errorIdx}) must precede the first develop dispatch (at ${doerIdx})`);
            assert.ok(errorIdx < firstAgentDispatchIndex(state.timeline), 'in fact before any agent dispatch at all');

            // Which fleet tools ran: the labelled REST probe under the
            // bitbucket label, and never provision_vcs_auth.
            assert.equal(state.provisions.length, 0, `no provision_vcs_auth for a local member: ${JSON.stringify(state.provisions)}`);
            const probeExecs = state.execs.filter((e) => /pullrequests\?pagelen=1/.test(e.command));
            assert.equal(probeExecs.length, 1, 'the labelled credential is REST-probed once per run');
            assert.equal(probeExecs[0].label, 'bitbucket');
            assert.equal(state.memberCommands.filter((c) => c.includes('git ls-remote origin')).length, 1);
            assert.equal(state.memberCommands.filter(isUsernameRead).length, 1);

            // Publish PR still meets the recorded 403, and its text reports the
            // real cause with the re-provision fix (token stored).
            const prLines = scenario.logs.filter((l) => /HTTP 403/.test(l) && /Publish PR|PR/.test(l));
            const prText = prLines.join('\n');
            assert.ok(prLines.length > 0, `expected the Publish PR 403 to be logged, got:\n${scenario.logs.filter((l) => /PR/.test(l)).join('\n')}`);
            assert.match(prText, /repo_access_token/);
            assert.match(prText, /required: pullrequest; granted: repository:write/);
            assert.ok(!/API token is missing/.test(prText), prText);
            assert.ok(prText.includes("Fix: re-provision member 'local' from the stored bitbucket_api_token"), prText);

            // No secret anywhere we captured.
            const captured = [...scenario.logs, ...state.timeline.map((e) => (e.kind === 'log' ? e.msg : JSON.stringify(e.meta))), ...scenario.commandLog, ...state.execs.map((e) => e.command)];
            for (const l of captured) assert.ok(!String(l).includes(SENTINEL), `sentinel leaked: ${l}`);

            // Nothing written to the real home's credential helpers.
            const homeAfter = fs.readdirSync(os.homedir()).filter((n) => n.startsWith('.fleet-git-credential')).sort();
            assert.deepEqual(homeAfter, homeBefore);
        });
    });
});

describe('Publish PR 403 wording', () => {
    async function raiseWith(recording, store) {
        const state = { execs: [] };
        const callTool = async (name, args) => {
            if (name === 'member_detail') return { content: [{ text: JSON.stringify({ type: 'local', os: 'linux', shell: '', vcsProvider: 'bitbucket' }) }] };
            if (name === 'credential_store_list') return { content: [{ text: JSON.stringify(store.map((n) => ({ name: n }))) }] };
            if (name === 'vcs_credential_exec') return credentialExec(state, args, recording);
            throw new Error(`unexpected tool ${name}`);
        };
        const logs = [];
        const result = await raiseVcsPrForMember({
            fleetApi: new ApraFleet({ callTool }),
            command: async (cmd) => (cmd === 'git remote get-url origin' ? { ok: true, output: BB_ORIGIN, error: null } : { ok: true, output: '', error: null }),
            member: 'local', base: 'main', head: 'feat/x', title: 'T', body: 'B',
            log: (m) => logs.push(m), logPrefix: '[Publish PR]', remoteUrlOverride: BB_ORIGIN,
        });
        return { result, logs };
    }

    test('an api_token 403 recording produces api_token wording; with bitbucket_api_token stored the remedy re-provisions from it and never says to create a token', async () => {
        const { result, logs } = await raiseWith(API_TOKEN_403, ['bitbucket_api_token']);
        const msg = result.error;
        assert.match(msg, /the Bitbucket API token \(X-Credential-Type api_token\) is missing a required scope/);
        assert.match(msg, /required: write:pullrequest:bitbucket/);
        const remedy = msg.slice(msg.indexOf('Fix: '));
        assert.ok(remedy.startsWith("Fix: re-provision member 'local' from the stored bitbucket_api_token: provision_vcs_auth member_name=local provider=bitbucket workspace=acme api_token={{secret.bitbucket_api_token}}"), remedy);
        assert.ok(!/create/i.test(remedy), remedy);
        for (const l of [...logs, msg]) assert.ok(!l.includes(SENTINEL), `sentinel leaked: ${l}`);
    });

    test('with no stored token the same 403 points at creating one', async () => {
        const { result } = await raiseWith(API_TOKEN_403, []);
        assert.match(result.error, /Fix: the credential store has no bitbucket_api_token entry; store an Atlassian API token/);
    });
});
