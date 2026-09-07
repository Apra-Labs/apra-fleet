import { test, describe } from 'node:test';
import assert from 'node:assert';

import {
    createVcsAuthPreflightCallback,
    createVcsAuthSelfHealCallback,
} from '../fleet-sprint/runner.js';

// =============================================================================
// apra-fleet-5oo (LAYER 2): provisionVcsAuthForMember's dispatch-time
// self-heal for a member registered with NO vcsProvider at all.
//
// register_member could mint a fully dispatch-capable member (llm_provider
// 'claude') while leaving Agent.vcsProvider unset -- nothing in registration
// ever asked for or detected it. VCSModule.resolveProvider() then throws
// "member has no registered VCS provider" on that member's first push/PR,
// typically hours into an unattended sprint, and the self-heal path itself
// dies on the same lookup, so retrying can never help. Layer 1 fixes new
// registrations; this layer heals every member ALREADY in that state, by
// falling back to the member's own git remote -- the SAME read
// provisionVcsAuthForMember already performs to derive its repos scope.
//
// Both callbacks below funnel into provisionVcsAuthForMember, so the fallback
// is exercised through the two real call sites (reactive self-heal and
// proactive preflight) rather than a private function.
//
// Persistence needs no separate call: provision_vcs_auth already writes
// vcsProvider back to the member registry (src/tools/provision-vcs-auth.ts),
// so "the fallback persisted" is asserted as "provision_vcs_auth was called
// with the detected provider".
// =============================================================================

/** member_detail for a member with NO registered vcsProvider -- exactly the
 *  shape src/tools/member-detail.ts returns for one, and what makes
 *  resolveProvider() throw its typed ERROR. */
const MEMBER_DETAIL_NO_PROVIDER = { content: [{ text: JSON.stringify({ friendlyName: 'worker' }) }] };

const remoteCommandFor = (url) => async (cmd) => {
    if (cmd === 'git remote get-url origin') {
        return url === null
            ? { ok: false, output: '', error: 'not a git repository' }
            : { ok: true, output: url, error: null };
    }
    return { ok: true, output: '', error: null };
};

const farFutureExpiry = () => new Date(Date.now() + 60 * 60 * 1000).toISOString();

function makeCallTool(calls) {
    return async (name, args) => {
        if (name === 'member_detail') return MEMBER_DETAIL_NO_PROVIDER;
        calls.push({ name, args });
        return { content: [{ text: `Provisioned VCS credential.\n  expiresAt: ${farFutureExpiry()}` }] };
    };
}

describe('provisionVcsAuthForMember: VCS-provider fallback for a member with none registered (apra-fleet-5oo)', () => {
    test('preflight: detects github from the member git remote, logs the self-heal, and provisions (which persists it)', async () => {
        const calls = [];
        const logs = [];
        const ensureVcsAuthFresh = createVcsAuthPreflightCallback({
            callTool: makeCallTool(calls),
            command: remoteCommandFor('https://github.com/acme/widgets.git'),
            log: (m) => logs.push(m),
        });

        await ensureVcsAuthFresh('worker');

        assert.equal(calls.length, 1, `expected exactly one provision_vcs_auth call, got ${JSON.stringify(calls)}`);
        assert.equal(calls[0].name, 'provision_vcs_auth');
        assert.deepEqual(calls[0].args, {
            member_name: 'worker',
            provider: 'github',
            github_mode: 'github-app',
            git_access: 'push',
            repos: ['acme/widgets'],
        });
        assert.ok(
            logs.some((l) => /had no registered VCS provider; detected 'github' from its git remote/.test(l)),
            `expected a self-heal log line naming the detected provider, got: ${JSON.stringify(logs)}`,
        );
    });

    test("detects azure-devops (whose defaultAuthMode is null, so no '<provider>_mode' field is sent) from an scp-like remote", async () => {
        const calls = [];
        const ensureVcsAuthFresh = createVcsAuthPreflightCallback({
            callTool: makeCallTool(calls),
            command: remoteCommandFor('git@ssh.dev.azure.com:v3/acme/widgets/widgets'),
        });

        await ensureVcsAuthFresh('worker');

        // Azure DevOps' own buildProvisionArgs hook makes an extra credential-
        // store lookup of its own, so filter rather than index blindly.
        const provisionCalls = calls.filter((c) => c.name === 'provision_vcs_auth');
        assert.equal(provisionCalls.length, 1, `expected exactly one provision_vcs_auth call, got: ${JSON.stringify(calls)}`);
        assert.equal(provisionCalls[0].args.provider, 'azure-devops');
        assert.ok(!('azure-devops_mode' in provisionCalls[0].args), `no auth-mode field expected for azure-devops, got ${JSON.stringify(provisionCalls[0].args)}`);
    });

    test('detects bitbucket from a bitbucket.org remote', async () => {
        const calls = [];
        const ensureVcsAuthFresh = createVcsAuthPreflightCallback({
            callTool: makeCallTool(calls),
            command: remoteCommandFor('git@bitbucket.org:acme/widgets.git'),
        });

        await ensureVcsAuthFresh('worker');

        const provisionCalls = calls.filter((c) => c.name === 'provision_vcs_auth');
        assert.equal(provisionCalls.length, 1, `expected exactly one provision_vcs_auth call, got: ${JSON.stringify(calls)}`);
        assert.equal(provisionCalls[0].args.provider, 'bitbucket');
    });

    test('the reactive self-heal path gets the same fallback (both callbacks share the call site)', async () => {
        const calls = [];
        const onAuthFailure = createVcsAuthSelfHealCallback({
            callTool: makeCallTool(calls),
            command: remoteCommandFor('git@github.com:acme/widgets.git'),
        });

        await onAuthFailure('worker');

        assert.ok(
            calls.some((c) => c.name === 'provision_vcs_auth' && c.args.provider === 'github'),
            `expected a provision_vcs_auth call with the detected provider, got: ${JSON.stringify(calls)}`,
        );
    });

    test('an UNREADABLE remote preserves the original resolveProvider throw -- nothing to detect, so nothing is guessed', async () => {
        const command = async (cmd) => {
            if (cmd === 'git remote get-url origin') throw new Error('ssh: connect to host worker port 22: Connection refused');
            return { ok: true, output: '', error: null };
        };
        // The self-heal callback (not the preflight, which NEVER throws by
        // design) is where a genuinely unresolvable provider must stay loud.
        const onAuthFailure = createVcsAuthSelfHealCallback({ callTool: makeCallTool([]), command });

        await assert.rejects(
            () => onAuthFailure('worker'),
            /has no registered VCS provider/,
            'an unreadable remote must surface resolveProvider\'s own typed error, not a fallback guess',
        );
    });

    test('an UNRECOGNIZED remote host preserves the original resolveProvider throw (generic-git is not an auth backend)', async () => {
        const onAuthFailure = createVcsAuthSelfHealCallback({
            callTool: makeCallTool([]),
            command: remoteCommandFor('https://gitlab.example.com/group/repo.git'),
        });

        await assert.rejects(
            () => onAuthFailure('worker'),
            /has no registered VCS provider/,
        );
    });

    test('an EMPTY remote (work folder with no git repo) preserves the original resolveProvider throw', async () => {
        const onAuthFailure = createVcsAuthSelfHealCallback({
            callTool: makeCallTool([]),
            command: remoteCommandFor(null),
        });

        await assert.rejects(
            () => onAuthFailure('worker'),
            /has no registered VCS provider/,
        );
    });
});
