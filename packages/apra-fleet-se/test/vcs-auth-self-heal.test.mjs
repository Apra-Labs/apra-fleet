import { test, describe } from 'node:test';
import assert from 'node:assert';

import { createVcsAuthSelfHealCallback, parseOwnerRepoFromRemoteUrl } from '../fleet-sprint/runner.js';

// apra-fleet-fmu: unit coverage for the real end-to-end onAuthFailure
// self-heal wiring -- createVcsAuthSelfHealCallback() builds the callback
// runSprintCycle passes into withGitSync (and its D-push equivalent) when a
// real fleet `callTool` is available (mirrors createMemberSessionGuard's
// injection pattern, see member-session-guard.test.mjs). It derives `repos`
// GENERICALLY from the member's own git remote (never hardcoded -- fleet-
// sprint is a general-purpose product), then calls the new
// ApraFleet.provisionVcsAuth() client method (packages/apra-fleet-client).

describe('parseOwnerRepoFromRemoteUrl', () => {
    test('parses an https remote URL with a .git suffix', () => {
        assert.equal(parseOwnerRepoFromRemoteUrl('https://github.com/acme/widgets.git'), 'acme/widgets');
    });

    test('parses an https remote URL without a .git suffix', () => {
        assert.equal(parseOwnerRepoFromRemoteUrl('https://github.com/acme/widgets'), 'acme/widgets');
    });

    test('parses an scp-like (git@host:owner/repo.git) remote URL', () => {
        assert.equal(parseOwnerRepoFromRemoteUrl('git@github.com:acme/widgets.git'), 'acme/widgets');
    });

    test('parses an ssh:// remote URL', () => {
        assert.equal(parseOwnerRepoFromRemoteUrl('ssh://git@github.com/acme/widgets.git'), 'acme/widgets');
    });

    test('is generic across hosts/orgs -- not hardcoded to any specific repo name', () => {
        assert.equal(parseOwnerRepoFromRemoteUrl('https://gitlab.example.com/some-org/some-repo.git'), 'some-org/some-repo');
        assert.equal(parseOwnerRepoFromRemoteUrl('git@bitbucket.org:other-org/other-repo.git'), 'other-org/other-repo');
    });

    test('returns null for unrecognizable / empty input, never throws', () => {
        assert.equal(parseOwnerRepoFromRemoteUrl(''), null);
        assert.equal(parseOwnerRepoFromRemoteUrl(null), null);
        assert.equal(parseOwnerRepoFromRemoteUrl(undefined), null);
        assert.equal(parseOwnerRepoFromRemoteUrl('not a url'), null);
    });
});

// apra-fleet-647.1.2.1: provisionVcsAuthForMember now resolves the member's
// provider via VCSModule.resolveProvider(), which calls fleetApi.
// memberDetail() ('member_detail') BEFORE provision_vcs_auth. Every callTool
// mock below must answer that lookup with a registered 'github' provider,
// intercepted here (not counted alongside the provision_vcs_auth calls each
// test tracks) so the existing call-count assertions stay meaningful.
const MEMBER_DETAIL_GITHUB = { content: [{ text: JSON.stringify({ vcsProvider: 'github' }) }] };

describe('createVcsAuthSelfHealCallback', () => {
    test('calls provision_vcs_auth with the member, github-app defaults, and a repos list derived from the member\'s own git remote', async () => {
        const calls = [];
        const command = async (cmd, opts) => {
            if (cmd === 'git remote get-url origin') {
                return { ok: true, output: 'https://github.com/acme/widgets.git', error: null };
            }
            return { ok: true, output: '', error: null };
        };
        const callTool = async (name, args) => {
            if (name === 'member_detail') return MEMBER_DETAIL_GITHUB;
            calls.push({ name, args });
            return { status: 'ok' };
        };
        const logs = [];
        const onAuthFailure = createVcsAuthSelfHealCallback({ callTool, command, log: (m) => logs.push(m) });

        await onAuthFailure({ member: 'fleet-mac', label: 'G-push for \'fleet-mac\'', error: "fatal: could not read Username for 'https://github.com': Device not configured" });

        assert.equal(calls.length, 1);
        assert.equal(calls[0].name, 'provision_vcs_auth');
        assert.deepEqual(calls[0].args, {
            member_name: 'fleet-mac',
            provider: 'github',
            github_mode: 'github-app',
            git_access: 'push',
            repos: ['acme/widgets'],
        });
        assert.ok(logs.some((l) => /self-heal/.test(l) && /fleet-mac/.test(l)), `expected a self-heal log entry, got: ${JSON.stringify(logs)}`);
        assert.ok(logs.some((l) => /provision_vcs_auth succeeded/.test(l)), `expected a self-heal success log entry, got: ${JSON.stringify(logs)}`);
    });

    test('never hardcodes repos -- a DIFFERENT member\'s git remote yields a DIFFERENT repos value', async () => {
        const calls = [];
        const command = async (cmd) => {
            if (cmd === 'git remote get-url origin') {
                return { ok: true, output: 'git@github.com:other-org/other-repo.git', error: null };
            }
            return { ok: true, output: '', error: null };
        };
        const callTool = async (name, args) => {
            if (name === 'member_detail') return MEMBER_DETAIL_GITHUB;
            calls.push({ name, args });
            return { status: 'ok' };
        };
        const onAuthFailure = createVcsAuthSelfHealCallback({ callTool, command });

        await onAuthFailure({ member: 'some-other-member', label: 'D-push', error: 'auth failure' });

        assert.deepEqual(calls[0].args.repos, ['other-org/other-repo']);
    });

    test('omits `repos` (rather than guessing) when the git remote cannot be resolved to an owner/repo', async () => {
        const calls = [];
        const command = async (cmd) => {
            if (cmd === 'git remote get-url origin') {
                return { ok: false, output: '', error: 'fatal: No such remote origin' };
            }
            return { ok: true, output: '', error: null };
        };
        const callTool = async (name, args) => {
            if (name === 'member_detail') return MEMBER_DETAIL_GITHUB;
            calls.push({ name, args });
            return { status: 'ok' };
        };
        const onAuthFailure = createVcsAuthSelfHealCallback({ callTool, command });

        await onAuthFailure({ member: 'm1', label: 'G-push', error: 'auth failure' });

        assert.equal(calls.length, 1);
        assert.ok(!('repos' in calls[0].args), `expected no 'repos' key when the remote cannot be resolved, got: ${JSON.stringify(calls[0].args)}`);
    });

    test('propagates a provision_vcs_auth failure so the bounded one-shot self-heal in runGitStep/runDoltStep treats it as a failed heal (not silently swallowed)', async () => {
        const command = async () => ({ ok: true, output: 'https://github.com/acme/widgets.git', error: null });
        const callTool = async () => { throw new Error('provision_vcs_auth: fleet server unreachable'); };
        const onAuthFailure = createVcsAuthSelfHealCallback({ callTool, command });

        await assert.rejects(
            () => onAuthFailure({ member: 'm1', label: 'G-push', error: 'auth failure' }),
            /fleet server unreachable/,
        );
    });

    // =========================================================================
    // apra-fleet-647.1.2.2: the REACTIVE self-heal caller goes through
    // VCSModule.resolveProvider() too (via provisionVcsAuthForMember), exactly
    // like the proactive preflight covered in vcs-auth-preflight.test.mjs.
    // Two cases the module-level resolveProvider suite (vcs-module.test.mjs)
    // cannot exercise on its own, because they must prove runner.js's own
    // call site actually plumbs the registry lookup through end to end: a
    // non-GitHub-registered member (no 'github' literal leaks into the call),
    // and a member with no registered provider (typed error, no GitHub
    // default, no provision_vcs_auth call at all).
    // =========================================================================
    test('a member registered with a non-GitHub provider (bitbucket) resolves to that provider with NO github literal anywhere in the call', async () => {
        const calls = [];
        const command = async (cmd) => {
            if (cmd === 'git remote get-url origin') {
                return { ok: true, output: 'https://bitbucket.org/acme/widgets.git', error: null };
            }
            return { ok: true, output: '', error: null };
        };
        const callTool = async (name, args) => {
            if (name === 'member_detail') return { content: [{ text: JSON.stringify({ vcsProvider: 'bitbucket' }) }] };
            calls.push({ name, args });
            return { status: 'ok' };
        };
        const onAuthFailure = createVcsAuthSelfHealCallback({ callTool, command });

        await onAuthFailure({ member: 'bb-member', label: 'G-push', error: 'auth failure' });

        assert.equal(calls.length, 1);
        assert.equal(calls[0].name, 'provision_vcs_auth');
        assert.deepEqual(calls[0].args, {
            member_name: 'bb-member',
            provider: 'bitbucket',
            git_access: 'push',
            repos: ['acme/widgets'],
        });
        assert.ok(!('github_mode' in calls[0].args), `expected no github_mode field for a non-GitHub provider, got: ${JSON.stringify(calls[0].args)}`);
        assert.ok(
            JSON.stringify(calls[0].args).indexOf('github') === -1,
            `expected no 'github' literal anywhere in a bitbucket member's provision_vcs_auth call, got: ${JSON.stringify(calls[0].args)}`,
        );
    });

    test('a member with NO registered VCS provider throws a typed ASCII "ERROR:" naming the member and never calls provision_vcs_auth (no silent GitHub default)', async () => {
        const calls = [];
        const command = async () => ({ ok: true, output: 'https://github.com/acme/widgets.git', error: null });
        const callTool = async (name, args) => {
            if (name === 'member_detail') return { content: [{ text: JSON.stringify({ vcsProvider: undefined }) }] };
            calls.push({ name, args });
            return { status: 'ok' };
        };
        const onAuthFailure = createVcsAuthSelfHealCallback({ callTool, command });

        await assert.rejects(
            () => onAuthFailure({ member: 'unprovisioned-member', label: 'G-push', error: 'auth failure' }),
            (err) => {
                assert.match(err.message, /^ERROR:/);
                assert.match(err.message, /unprovisioned-member/);
                return true;
            },
        );
        assert.equal(calls.length, 0, `expected NO provision_vcs_auth call for a member with no registered provider, got: ${JSON.stringify(calls)}`);
    });
});
