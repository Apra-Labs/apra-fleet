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
//      member provisions with a derived org_url and a secret placeholder, and
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

    test('derives org_url from the member ref and passes the PAT as a secret placeholder', () => {
        const built = AzureDevOpsVCS.buildProvisionArgs({
            base,
            repoRef: { org: 'apralabs', project: 'e2e-fleet-testing', repo: 'fleet-e2e-toy' },
            availableSecrets: ['azdevops_pat', 'other'],
        });
        assert.deepEqual(built.args, {
            member_name: 'fleet-mac',
            provider: 'azure-devops',
            org_url: 'https://dev.azure.com/apralabs',
            pat: '{{secret.azdevops_pat}}',
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

    // GitHub issue #502 -----------------------------------------------------
    const LEGACY_REF = { org: 'apralabs', project: 'e2e-fleet-testing', repo: 'fleet-e2e-toy' };

    test('a legacy visualstudio.com https remote binds the credential to that host via scope_url (issue #502)', () => {
        for (const remoteUrl of [
            'https://apralabs.visualstudio.com/DefaultCollection/e2e-fleet-testing/_git/fleet-e2e-toy',
            'https://ApraLabs.visualstudio.com/e2e-fleet-testing/_git/fleet-e2e-toy',
            'https://apralabs@apralabs.visualstudio.com/DefaultCollection/My%20Project/_git/fleet-e2e-toy',
        ]) {
            const built = AzureDevOpsVCS.buildProvisionArgs({ base, repoRef: LEGACY_REF, availableSecrets: ['azdevops_pat'], remoteUrl });
            assert.equal(built.error, undefined, remoteUrl);
            // The REST org URL stays on the modern host; only the git
            // credential scope moves to the legacy host.
            assert.equal(built.args.org_url, 'https://dev.azure.com/apralabs', remoteUrl);
            assert.equal(built.args.scope_url, 'https://apralabs.visualstudio.com', remoteUrl);
            assert.equal(built.note, undefined, remoteUrl);
        }
    });

    test('a modern dev.azure.com remote sends NO scope_url, so the server default applies unchanged', () => {
        const built = AzureDevOpsVCS.buildProvisionArgs({ base, repoRef: LEGACY_REF, availableSecrets: ['azdevops_pat'], remoteUrl: AZ_REMOTE });
        assert.equal('scope_url' in built.args, false);
        assert.equal(built.note, undefined);
    });

    test('an ssh remote (either host) still provisions the PAT for REST calls but notes that git push uses the SSH key', () => {
        for (const remoteUrl of [
            'apralabs@vs-ssh.visualstudio.com:v3/apralabs/e2e-fleet-testing/fleet-e2e-toy',
            'git@ssh.dev.azure.com:v3/apralabs/e2e-fleet-testing/fleet-e2e-toy',
        ]) {
            const built = AzureDevOpsVCS.buildProvisionArgs({ base, repoRef: LEGACY_REF, availableSecrets: ['azdevops_pat'], remoteUrl });
            assert.equal(built.args.org_url, 'https://dev.azure.com/apralabs', remoteUrl);
            assert.equal('scope_url' in built.args, false, 'a PAT cannot be bound to an ssh host');
            assert.match(built.note, /pushes over ssh/, remoteUrl);
            assert.match(built.note, /SSH key/, remoteUrl);
            assert.match(built.note, /pull-request calls only/, remoteUrl);
        }
    });

    test('an underivable org names its real cause: an unreadable remote is not a malformed one', () => {
        const unread = AzureDevOpsVCS.buildProvisionArgs({
            base, repoRef: null, availableSecrets: ['azdevops_pat'], remoteUrl: '', remoteReadError: 'Request "tools/call" (id=31) aborted before a response was received.',
        });
        assert.match(unread.error, /^ERROR: /);
        assert.match(unread.error, /git remote could not be read \(Request "tools\/call" \(id=31\) aborted/);
        assert.match(unread.error, /ORG\.visualstudio\.com/);

        const wrong = AzureDevOpsVCS.buildProvisionArgs({
            base, repoRef: null, availableSecrets: ['azdevops_pat'], remoteUrl: 'https://gitlab.example.com/x/y.git', remoteReadError: null,
        });
        assert.match(wrong.error, /remote 'https:\/\/gitlab\.example\.com\/x\/y\.git' is not a recognized Azure DevOps repository URL/);
        assert.match(wrong.error, /https:\/\/dev\.azure\.com\/ORG\/PROJECT\/_git\/REPO/);
    });

    test('a per-sprint secret-name override is honoured when one is supplied', () => {
        // The override is now wired through runner.js validated args (apra-fleet-5co8.2.3).
        const built = AzureDevOpsVCS.buildProvisionArgs({
            base, repoRef: { org: 'apralabs' }, availableSecrets: ['fleet-e2e-ado'], secretName: 'fleet-e2e-ado',
        });
        assert.equal(built.args.pat, '{{secret.fleet-e2e-ado}}');
    });
});

describe('unattended provisioning dispatches through the hook (apra-fleet-5co8.2.1)', () => {
    test('an Azure DevOps member provisions with a derived org_url and a secret placeholder', async () => {
        const { calls, callTool } = makeCallTool({ provider: 'azure-devops', secrets: ['azdevops_pat'] });
        const ensureVcsAuthFresh = createVcsAuthPreflightCallback({ callTool, command: remoteCommandFor(AZ_REMOTE) });

        await ensureVcsAuthFresh('fleet-mac');

        assert.equal(calls.length, 1);
        assert.equal(calls[0].name, 'provision_vcs_auth');
        assert.deepEqual(calls[0].args, {
            member_name: 'fleet-mac',
            provider: 'azure-devops',
            org_url: 'https://dev.azure.com/apralabs',
            pat: '{{secret.azdevops_pat}}',
        });
        // No raw token value anywhere in what the runner sent.
        assert.match(JSON.stringify(calls[0].args), /\{\{secret\.azdevops_pat\}\}/);
    });

    test('a legacy visualstudio.com member provisions with the modern org_url AND a legacy-host scope_url (issue #502)', async () => {
        const { calls, callTool } = makeCallTool({ provider: 'azure-devops', secrets: ['azdevops_pat'] });
        const ensureVcsAuthFresh = createVcsAuthPreflightCallback({
            callTool,
            command: remoteCommandFor('https://apralabs.visualstudio.com/DefaultCollection/e2e-fleet-testing/_git/fleet-e2e-toy'),
        });

        await ensureVcsAuthFresh('fleet-mac');

        assert.equal(calls.length, 1);
        assert.deepEqual(calls[0].args, {
            member_name: 'fleet-mac',
            provider: 'azure-devops',
            org_url: 'https://dev.azure.com/apralabs',
            pat: '{{secret.azdevops_pat}}',
            scope_url: 'https://apralabs.visualstudio.com',
        });
    });

    test('an ssh member provisions and the preflight logs the ssh-key note (issue #502)', async () => {
        const { calls, callTool } = makeCallTool({ provider: 'azure-devops', secrets: ['azdevops_pat'] });
        const logs = [];
        const ensureVcsAuthFresh = createVcsAuthPreflightCallback({
            callTool,
            command: remoteCommandFor('apralabs@vs-ssh.visualstudio.com:v3/apralabs/e2e-fleet-testing/fleet-e2e-toy'),
            log: (m) => logs.push(m),
        });

        await ensureVcsAuthFresh('fleet-mac');

        assert.equal(calls.length, 1);
        assert.equal(calls[0].args.org_url, 'https://dev.azure.com/apralabs');
        assert.ok(logs.some((l) => /note: .*pushes over ssh \(vs-ssh\.visualstudio\.com\)/.test(l)), JSON.stringify(logs));
    });

    test('an unreadable remote is reported as such, not as an unrecognized URL (issue #502)', async () => {
        const { calls, callTool } = makeCallTool({ provider: 'azure-devops', secrets: ['azdevops_pat'] });
        const logs = [];
        const ensureVcsAuthFresh = createVcsAuthPreflightCallback({
            callTool,
            command: async (cmd) => {
                if (cmd === 'git remote get-url origin') throw new Error('Request "tools/call" (id=31) aborted before a response was received.');
                return { ok: true, output: '', error: null };
            },
            log: (m) => logs.push(m),
        });

        await ensureVcsAuthFresh('fleet-mac');

        assert.equal(calls.length, 0, 'nothing can be provisioned without an org');
        assert.ok(
            logs.some((l) => /git remote could not be read \(Request "tools\/call" \(id=31\) aborted/.test(l)),
            `expected the preflight log to name the remote-read failure as the cause, got: ${JSON.stringify(logs)}`,
        );
        assert.ok(!logs.some((l) => /no organization could be derived/.test(l)), 'the old cause-blind wording must not appear');
    });

    test('a failSoft remote read ({ ok: false }, not thrown) is also reported as "could not be read" (issue #502)', async () => {
        const { calls, callTool } = makeCallTool({ provider: 'azure-devops', secrets: ['azdevops_pat'] });
        const logs = [];
        const ensureVcsAuthFresh = createVcsAuthPreflightCallback({
            callTool,
            command: async (cmd) => (
                cmd === 'git remote get-url origin'
                    ? { ok: false, output: '', error: "fatal: No such remote 'origin'" }
                    : { ok: true, output: '', error: null }
            ),
            log: (m) => logs.push(m),
        });

        await ensureVcsAuthFresh('fleet-mac');

        assert.equal(calls.length, 0, 'nothing can be provisioned without an org');
        assert.ok(
            logs.some((l) => /git remote could not be read \(fatal: No such remote 'origin'\)/.test(l)),
            `expected the preflight log to carry the failSoft read error verbatim, got: ${JSON.stringify(logs)}`,
        );
        assert.ok(!logs.some((l) => /is not a recognized Azure DevOps repository URL/.test(l)), 'an unread remote must not be reported as a malformed one');
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
