import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { runDevelopLoopScenario, withScenarioMarkers, defaultMockCallTool } from './helpers/mock-sprint-harness.mjs';
import { scaledTimeout } from './helpers/scaled-timeout.mjs';
import { TEST_CONCURRENCY } from './helpers/test-concurrency.mjs';
import { VCS_PROVIDER_MISMATCH } from '../fleet-sprint/vcs-auth.mjs';

// =============================================================================
// A sprint whose repository is served by one VCS provider while the
// PR-raising (backlog) member is registered for another fails at Sprint
// Setup with one typed error naming both providers and the member -- before
// any credential is minted for the wrong provider, and without an unrelated
// credential remedy (a GitHub App "Invalid repo name format" mint failure, an
// expired-PAT hint). Matching providers, and a member with no registered
// provider (the detect-from-remote path), set up normally.
// Driven end to end through runner.js with the member registry answered by
// args.callTool's member_detail, as in
// mock-sprint-member-vcs-provider-threading.test.mjs.
// =============================================================================

const ORIGINS = {
    github: 'https://github.com/mock-org/mock-repo.git',
    bitbucket: 'https://bitbucket.org/mock-workspace/mock-repo.git',
    'azure-devops': 'https://dev.azure.com/mock-org/mock-project/_git/mock-repo',
};

const UNRELATED_REMEDY_RE = /Invalid repo name format|\bPAT\b|expir/i;

/**
 * Runs a one-cycle mock sprint with member 'local' registered for
 * `registered` (undefined = no vcsProvider in the record) on `origin`.
 * Returns the scenario plus every provision_vcs_auth call recorded.
 */
async function runWith(tag, { origin, registered }) {
    const provisionCalls = [];
    const base = defaultMockCallTool();
    const callTool = async (name, args) => {
        if (name === 'member_detail') {
            const record = { type: 'remote', os: 'linux', shell: 'bash' };
            if (registered) record.vcsProvider = registered;
            return { content: [{ text: JSON.stringify(record) }] };
        }
        if (name === 'provision_vcs_auth') provisionCalls.push(args);
        return base(name, args);
    };
    const scenario = await runDevelopLoopScenario(tag, {
        members: ['local'],
        taskSpecs: [{ title: 'Task: provider match at Sprint Setup' }],
        maxCycles: 1,
        callTool,
        originUrl: origin,
    });
    return { scenario, provisionCalls };
}

const errorText = (err) => String((err && err.message) || err || '');
const reachedEnsureBranch = (scenario) => scenario.commandLog.some((c) => /^git fetch origin /.test(String(c)));

describe('a repo/member VCS provider mismatch fails at Sprint Setup', () => {
    const mismatches = [
        { repo: 'azure-devops', member: 'github' },
        { repo: 'bitbucket', member: 'azure-devops' },
    ];
    for (const { repo, member } of mismatches) {
        test(`${repo} origin + member registered for ${member}: typed Sprint Setup error naming both, no mint, no unrelated remedy`, { timeout: scaledTimeout(180000, { concurrency: TEST_CONCURRENCY }) }, async () => {
            await withScenarioMarkers(`provider mismatch ${repo}/${member}`, async () => {
                const { scenario, provisionCalls } = await runWith(`pmm_${repo}_${member}`.replace(/-/g, ''), { origin: ORIGINS[repo], registered: member });
                const msg = errorText(scenario.error);
                assert.ok(scenario.error, `the sprint must fail, got no error. logs: ${JSON.stringify(scenario.logs.slice(-20))}`);
                assert.equal(scenario.error.code, VCS_PROVIDER_MISMATCH, `typed error expected, got: ${msg}`);
                assert.match(msg, /Sprint Setup/);
                assert.ok(msg.includes(`'${repo}'`), `names the repo provider '${repo}': ${msg}`);
                assert.ok(msg.includes(`'${member}'`), `names the registered provider '${member}': ${msg}`);
                assert.ok(msg.includes("member 'local'"), `names the member: ${msg}`);
                assert.match(msg, /Fix: register member 'local' for/);
                assert.doesNotMatch(msg, UNRELATED_REMEDY_RE);
                assert.deepEqual(provisionCalls, [], `no credential may be minted on a mismatch: ${JSON.stringify(provisionCalls)}`);
                assert.ok(!reachedEnsureBranch(scenario), 'the sprint stops before Ensure Sprint Branch');
                assert.ok(!scenario.logs.some((l) => /Invalid repo name format/.test(l)), 'no mint failure in the run log');
            });
        });
    }
});

describe('matching providers and an unregistered member set up normally', () => {
    for (const provider of ['github', 'bitbucket', 'azure-devops']) {
        test(`${provider} origin + member registered for ${provider}: setup proceeds`, { timeout: scaledTimeout(180000, { concurrency: TEST_CONCURRENCY }) }, async () => {
            await withScenarioMarkers(`provider match ${provider}`, async () => {
                const { scenario } = await runWith(`pmok_${provider}`.replace(/-/g, ''), { origin: ORIGINS[provider], registered: provider });
                assert.notEqual(scenario.error && scenario.error.code, VCS_PROVIDER_MISMATCH, errorText(scenario.error));
                assert.ok(!scenario.logs.some((l) => l.includes(VCS_PROVIDER_MISMATCH)), 'no mismatch logged');
                assert.ok(reachedEnsureBranch(scenario), `setup must reach Ensure Sprint Branch. error: ${errorText(scenario.error)}`);
            });
        });
    }

    test('member with no registered provider: the detect-from-remote path, no failure at setup', { timeout: scaledTimeout(180000, { concurrency: TEST_CONCURRENCY }) }, async () => {
        await withScenarioMarkers('provider unregistered', async () => {
            const { scenario } = await runWith('pmnone', { origin: ORIGINS['azure-devops'], registered: undefined });
            assert.notEqual(scenario.error && scenario.error.code, VCS_PROVIDER_MISMATCH, errorText(scenario.error));
            assert.ok(!scenario.logs.some((l) => l.includes(VCS_PROVIDER_MISMATCH)), 'no mismatch logged');
            assert.ok(reachedEnsureBranch(scenario), `setup must reach Ensure Sprint Branch. error: ${errorText(scenario.error)}`);
        });
    });
});
