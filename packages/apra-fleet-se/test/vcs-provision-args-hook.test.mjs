import { test, describe } from 'node:test';
import assert from 'node:assert';
import { createVcsAuthPreflightCallback } from '../fleet-sprint/runner.js';
import { AzureDevOpsVCS } from '../fleet-sprint/vcs-providers/index.mjs';

// apra-fleet-5co8.2.1 -- the buildProvisionArgs descriptor hook and its
// dispatch from the unattended provisioning path.
//
// Two layers are pinned:
//   1. the hook itself, called directly (pure/deterministic);
//   2. the runtime wiring, through createVcsAuthPreflightCallback -- the real
//      unattended preflight -- with a scripted callTool, so "an Azure DevOps
//      member provisions with a derived org_url and a secure placeholder, and
//      never reaches an out-of-band prompt" is a runtime assertion rather than
//      a source-code reading.

const AZ_REMOTE = 'https://dev.azure.com/apralabs/e2e-fleet-testing/_git/fleet-e2e-toy';
const GH_REMOTE = 'https://github.com/acme/widgets.git';

const remoteCommandFor = (url) => async (cmd) => (
    cmd === 'git remote get-url origin'
        ? { ok: true, output: url, error: null }
        : { ok: true, output: '', error: null }
);

const memberDetail = (provider) => ({ content: [{ text: JSON.stringify({ vcsProvider: provider }) }] });
const credentialList = (names) => ({
    content: [{ text: JSON.stringify(names.map((name) => ({ name, scope: 'persistent' }))) }],
});

function makeCallTool({ provider, secrets, onProvision }) {
    const calls = [];
    return {
        calls,
        callTool: async (name, args) => {
            if (name === 'member_detail') return memberDetail(provider);
            if (name === 'credential_store_list') return credentialList(secrets);
            calls.push({ name, args });
            if (name === 'provision_vcs_auth') {
                return onProvision
                    ? onProvision(args)
                    : { content: [{ text: 'Provisioned VCS credential (PAT mode, no expiry).' }] };
            }
            return { content: [{ text: '' }] };
        },
    };
}

describe('AzureDevOpsVCS.buildProvisionArgs (apra-fleet-5co8.2.1)', () => {
    const base = { member_name: 'fleet-mac', provider: 'azure-devops', git_access: 'push', repos: ['a/b/c'] };

    test('derives org_url from the member ref and passes the PAT as a secure placeholder', () => {
        const built = AzureDevOpsVCS.buildProvisionArgs({
            base,
            repoRef: { org: 'apralabs', project: 'e2e-fleet-testing', repo: 'fleet-e2e-toy' },
            availableSecrets: ['azdevops_pat', 'other'],
        });
        assert.deepEqual(built.args, {
            member_name: 'fleet-mac',
            provider: 'azure-devops',
            org_url: 'https://dev.azure.com/apralabs',
            pat: '{{secure.azdevops_pat}}',
        });
        // GitHub-App vocabulary must NOT be forwarded to a provider that has
        // no App/installation model.
        assert.equal('git_access' in built.args, false);
        assert.equal('repos' in built.args, false);
    });

    test('a missing credential-store entry is a typed ERROR naming credential_store_set and the secret name', () => {
        const built = AzureDevOpsVCS.buildProvisionArgs({
            base, repoRef: { org: 'apralabs' }, availableSecrets: ['something_else'],
        });
        assert.equal(built.args, undefined);
        assert.match(built.error, /^ERROR: /);
        assert.match(built.error, /credential_store_set name=azdevops_pat/);
        assert.match(built.error, /azdevops_pat/);
    });

    test('an unreadable credential store (null) skips the check rather than failing falsely', () => {
        const built = AzureDevOpsVCS.buildProvisionArgs({ base, repoRef: { org: 'apralabs' }, availableSecrets: null });
        assert.equal(built.args.org_url, 'https://dev.azure.com/apralabs');
    });

    test('an underivable org is a typed ERROR naming the expected remote shape', () => {
        for (const repoRef of [null, undefined, {}, { org: '  ' }]) {
            const built = AzureDevOpsVCS.buildProvisionArgs({ base, repoRef, availableSecrets: ['azdevops_pat'] });
            assert.match(built.error, /^ERROR: /);
            assert.match(built.error, /https:\/\/dev\.azure\.com\/ORG\/PROJECT\/_git\/REPO/);
        }
    });

    test('a per-sprint secret-name override is honoured when one is supplied', () => {
        // The override is not WIRED yet (that is its own task) -- the hook
        // simply must not hardcode the default so wiring it later is a
        // caller-side change only.
        const built = AzureDevOpsVCS.buildProvisionArgs({
            base, repoRef: { org: 'apralabs' }, availableSecrets: ['fleet-e2e-ado'], secretName: 'fleet-e2e-ado',
        });
        assert.equal(built.args.pat, '{{secure.fleet-e2e-ado}}');
    });
});

describe('unattended provisioning dispatches through the hook (apra-fleet-5co8.2.1)', () => {
    test('an Azure DevOps member provisions with a derived org_url and a secure placeholder', async () => {
        const { calls, callTool } = makeCallTool({ provider: 'azure-devops', secrets: ['azdevops_pat'] });
        const ensureVcsAuthFresh = createVcsAuthPreflightCallback({ callTool, command: remoteCommandFor(AZ_REMOTE) });

        await ensureVcsAuthFresh('fleet-mac');

        assert.equal(calls.length, 1);
        assert.equal(calls[0].name, 'provision_vcs_auth');
        assert.deepEqual(calls[0].args, {
            member_name: 'fleet-mac',
            provider: 'azure-devops',
            org_url: 'https://dev.azure.com/apralabs',
            pat: '{{secure.azdevops_pat}}',
        });
        // No raw token value anywhere in what the runner sent.
        assert.match(JSON.stringify(calls[0].args), /\{\{secure\.azdevops_pat\}\}/);
    });

    test('a missing secret fails the preflight with the remedial command, never a prompt', async () => {
        const { calls, callTool } = makeCallTool({ provider: 'azure-devops', secrets: [] });
        const logs = [];
        const ensureVcsAuthFresh = createVcsAuthPreflightCallback({
            callTool, command: remoteCommandFor(AZ_REMOTE), log: (m) => logs.push(m),
        });

        await ensureVcsAuthFresh('fleet-mac');

        assert.equal(calls.length, 0, 'provision_vcs_auth must not be called at all when the secret is absent');
        assert.ok(
            logs.some((l) => /credential_store_set name=azdevops_pat/.test(l)),
            `expected the remedial credential_store_set command in the preflight log, got: ${JSON.stringify(logs)}`,
        );
    });

    test('a GitHub member provisions with exactly the arguments it always did', async () => {
        const { calls, callTool } = makeCallTool({ provider: 'github', secrets: ['azdevops_pat'] });
        const ensureVcsAuthFresh = createVcsAuthPreflightCallback({ callTool, command: remoteCommandFor(GH_REMOTE) });

        await ensureVcsAuthFresh('fleet-mac');

        assert.deepEqual(calls[0].args, {
            member_name: 'fleet-mac',
            provider: 'github',
            github_mode: 'github-app',
            git_access: 'push',
            repos: ['acme/widgets'],
        });
    });
});
