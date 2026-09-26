import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { raiseVcsPrForMember } from '../fleet-sprint/vcs-auth.mjs';

// The operator-chosen Azure DevOps PAT secret name on the PR-CAPABLE path.
//
// The sync preflight and self-heal paths already thread azdevopsPatSecretName
// into provisionVcsAuthForMember; the PR-capable path
// (provisionPrCapableAuthForMember, reached only from raiseVcsPrForMember)
// did not, so it minted the provider DEFAULT secret ('azdevops_pat'). On an
// operator machine where that name already belongs to an unrelated project
// this does double damage: the PR creation 401s AND the wrong credential is
// written over the member's working git credential on disk, breaking a plain
// git fetch on that member until it is re-provisioned by hand.
//
// These assert on the ARGUMENTS actually handed to provision_vcs_auth -- the
// `pat` placeholder is where the secret name lands, see azure-devops.mjs's
// buildProvisionArgs -- never on source text. Response shapes mirror the real
// collaborators exactly (same contract as vcs-auth-raise-pr.test.mjs).

function credExecResult({ status, body }) {
    return {
        content: [{ text: '' }],
        structuredContent: {
            ok: true, reason: 'ok', exitCode: 0,
            stdout: `${JSON.stringify(body)}\n${status}`,
            stderr: '',
        },
    };
}

const AZDO_PR_BODY = { pullRequestId: 7, repository: { webUrl: 'https://dev.azure.com/acme/proj/_git/widgets' } };

const azdoCommand = async (cmd) => {
    if (cmd === 'git remote get-url origin') {
        return { ok: true, output: 'https://dev.azure.com/acme/proj/_git/widgets', error: null };
    }
    return { ok: true, output: '', error: null };
};

const githubCommand = async (cmd) => {
    if (cmd === 'git remote get-url origin') {
        return { ok: true, output: 'https://github.com/acme/widgets.git', error: null };
    }
    return { ok: true, output: '', error: null };
};

function makeFleetApi({ provider, vcsCredentialExecImpl }) {
    const provisionCalls = [];
    const vcsCredentialExecCalls = [];
    return {
        provisionCalls,
        vcsCredentialExecCalls,
        async memberDetail() {
            return { content: [{ text: JSON.stringify({ vcsProvider: provider, os: 'linux', shell: '' }) }] };
        },
        async provisionVcsAuth(args) {
            provisionCalls.push(args);
            return { content: [{ text: 'ok' }], structuredContent: { ok: true, expiresAt: null } };
        },
        async vcsCredentialExec(args) {
            vcsCredentialExecCalls.push(args);
            return vcsCredentialExecImpl(args, vcsCredentialExecCalls.length);
        },
    };
}

function makeAzdoFleetApi() {
    return makeFleetApi({
        provider: 'azure-devops',
        vcsCredentialExecImpl: () => credExecResult({ status: 201, body: AZDO_PR_BODY }),
    });
}

describe('raiseVcsPrForMember: azdevopsPatSecretName on the PR-capable provisioning path', () => {
    test('forwards the operator-chosen secret name into the push+pr provision call', async () => {
        const fleetApi = makeAzdoFleetApi();
        const res = await raiseVcsPrForMember({
            fleetApi, command: azdoCommand, member: 'aztoy', base: 'main', head: 'feat/x',
            remoteUrlOverride: 'https://dev.azure.com/acme/proj/_git/widgets',
            title: 't', body: 'b', logPrefix: 'test',
            azdevopsPatSecretName: 'fleet_bridge_azdevops_pat',
        });
        assert.equal(res.ok, true);
        assert.equal(fleetApi.provisionCalls.length, 1);
        assert.equal(fleetApi.provisionCalls[0].pat, '{{secret.fleet_bridge_azdevops_pat}}');
    });

    test('omits it cleanly when absent -- provisioning falls back to the provider default, unchanged', async () => {
        const fleetApi = makeAzdoFleetApi();
        const res = await raiseVcsPrForMember({
            fleetApi, command: azdoCommand, member: 'aztoy', base: 'main', head: 'feat/x',
            remoteUrlOverride: 'https://dev.azure.com/acme/proj/_git/widgets',
            title: 't', body: 'b', logPrefix: 'test',
        });
        assert.equal(res.ok, true);
        assert.equal(fleetApi.provisionCalls.length, 1);
        assert.equal(fleetApi.provisionCalls[0].pat, '{{secret.azdevops_pat}}');
    });

    test('the reactive one-shot PR auth self-heal re-provision also carries the secret name', async () => {
        const fleetApi = makeAzdoFleetApi();
        fleetApi.vcsCredentialExec = async (args) => {
            fleetApi.vcsCredentialExecCalls.push(args);
            if (fleetApi.vcsCredentialExecCalls.length === 1) {
                return credExecResult({ status: 401, body: { message: 'Unauthorized' } });
            }
            return credExecResult({ status: 201, body: AZDO_PR_BODY });
        };
        await raiseVcsPrForMember({
            fleetApi, command: azdoCommand, member: 'aztoy', base: 'main', head: 'feat/x',
            remoteUrlOverride: 'https://dev.azure.com/acme/proj/_git/widgets',
            title: 't', body: 'b', logPrefix: 'test',
            azdevopsPatSecretName: 'fleet_bridge_azdevops_pat',
        });
        assert.equal(fleetApi.provisionCalls.length, 2, 'the one-shot self-heal must re-provision exactly once');
        for (const call of fleetApi.provisionCalls) {
            assert.equal(call.pat, '{{secret.fleet_bridge_azdevops_pat}}');
        }
    });

    test('git_access push+pr is still exactly what the PR-capable path requests', async () => {
        const fleetApi = makeFleetApi({
            provider: 'github',
            vcsCredentialExecImpl: () => credExecResult({
                status: 201, body: { html_url: 'https://github.com/acme/widgets/pull/42' },
            }),
        });
        await raiseVcsPrForMember({
            fleetApi, command: githubCommand, member: 'gh', base: 'main', head: 'feat/x',
            title: 't', body: 'b', logPrefix: 'test',
            azdevopsPatSecretName: 'fleet_bridge_azdevops_pat',
        });
        assert.equal(fleetApi.provisionCalls.length, 1);
        assert.equal(fleetApi.provisionCalls[0].git_access, 'push+pr');
    });
});
