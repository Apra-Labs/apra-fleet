import { test } from 'node:test';
import assert from 'node:assert/strict';

import { finalizeAbort } from '../fleet-sprint/runner.js';
import { capabilities as vcsCapabilities } from '../fleet-sprint/vcs-module.mjs';
import { AzureDevOpsVCS } from '../fleet-sprint/vcs-providers/azure-devops.mjs';
import { SprintPlanRejectedError } from '../fleet-sprint/errors.mjs';

const check = (cond, msg) => assert.ok(cond, msg);

// =============================================================================
// apra-fleet-lzfv.6 -- mock-sprint publish path over canned Azure DevOps
// responses (args.callTool stubbed, real runner.js publish code, no network).
//
// Exercises finalizeAbort() (runner.js) directly -- the SAME real, exported
// publish path both PR-raising call sites (Publish PR, finalizeAbort) share
// via raiseVcsPrForMember (see finalizeAbort's own doc comment: it is
// dependency-injected on `command`/`callTool` specifically so it is callable
// here, hermetically, with a hand-rolled mock and no live fleet/network --
// same rationale mock-sprint-abort-pr.test.mjs already relies on for its
// GitHub coverage). This file is the ADO-canned-response companion:
//   - a canned 201 body maps to a browsable PR URL CONSTRUCTED from the
//     provider's own pullRequestResponse.map (org/project/repo + id), not
//     any runner-side knowledge of the Azure DevOps dialect;
//   - a canned 409 body carrying TF401179 is treated as an idempotent
//     success (already exists), never a publish failure;
//   - a GitHub scenario alongside it still reports its unchanged html_url,
//     proving neither dialect leaked into the other.
//
// Kept small and fast -- test/mock-sprint-azure-devops-vcs-preflight.test.mjs
// (same mock-sprint-harness mutex family) already times out under the
// concurrent real-bd lane if a sibling file grows too large.
// =============================================================================

const AZ_ORIGIN = 'https://dev.azure.com/mock-org/mock-project/_git/mock-repo';
const AZ_REPO_REF = { org: 'mock-org', project: 'mock-project', repo: 'mock-repo' };

function buildMockCommand({ originUrl, credentialLine, prResponder }) {
    const log = [];
    const command = async (cmd, opts = {}) => {
        log.push(cmd);
        const failSoft = !!opts.failSoft;
        const ok = (output) => (failSoft ? { ok: true, output, error: null } : output);
        const fail = (error) => {
            if (failSoft) return { ok: false, output: '', error };
            throw new Error(error);
        };
        if (/^git fetch origin\b/.test(cmd)) return ok('');
        if (/^git rev-list --count\b/.test(cmd)) return ok('2');
        if (/^git push\b/.test(cmd)) return ok('To mock-remote\n * [new branch] (mocked)');
        if (/^git remote get-url origin\b/.test(cmd)) return ok(originUrl);
        if (/^\$HOME\/\.fleet-git-credential-/.test(cmd)) return ok(credentialLine);
        if (/^curl(?:\.exe)? -sS -X POST\b/.test(cmd) && (/\/pulls\b/.test(cmd) || /\/pullrequests\?/.test(cmd))) {
            return ok(prResponder(cmd));
        }
        throw new Error(`buildMockCommand: unexpected command dispatched in this scenario: '${cmd}'`);
    };
    return { command, log };
}

function mockCallTool(vcsProvider, { availableSecrets = [] } = {}) {
    return async (name, toolArgs) => {
        if (name === 'member_detail') return { content: [{ text: JSON.stringify({ vcsProvider }) }] };
        if (name === 'credential_store_list') {
            return { content: [{ text: JSON.stringify(availableSecrets.map((n) => ({ name: n, scope: 'persistent' }))) }] };
        }
        if (name === 'provision_vcs_auth') {
            const expiresAt = new Date(Date.now() + 60 * 60 * 1000).toISOString();
            return { content: [{ text: `check-mark Mock ${toolArgs && toolArgs.provider} credentials deployed on "${toolArgs && toolArgs.member_name}"\n  expiresAt: ${expiresAt}\n` }] };
        }
        return { content: [{ text: `mock ${name}` }] };
    };
}

const ADO_CREDENTIAL_LINE = 'protocol=https\nhost=dev.azure.com\nusername=x-access-token\npassword=mock-ado-pat\n';
const GH_CREDENTIAL_LINE = 'protocol=https\nhost=github.com\nusername=x-access-token\npassword=mock-vcs-module-token\n';

// -----------------------------------------------------------------------
// (1) Azure DevOps 201: the reported PR URL is built by
// AzureDevOpsVCS.pullRequestResponse.map -- proved by asserting the
// finalizeAbort() result equals that mapping's OWN output for the exact
// canned body, not a runner-side literal.
// -----------------------------------------------------------------------
test('finalizeAbort (Azure DevOps): a canned 201 body maps to a PR URL constructed from the provider-owned response mapping', async () => {
    const branch = 'auto-sprint/abort-ado-201';
    const { command, log } = buildMockCommand({
        originUrl: AZ_ORIGIN,
        credentialLine: ADO_CREDENTIAL_LINE,
        prResponder: () => `${JSON.stringify({ pullRequestId: 555 })}\n201`,
    });
    const logs = [];
    const error = new SprintPlanRejectedError('Plan rejected after 3 rounds', { notes: null });

    const result = await finalizeAbort({
        error,
        branch,
        baseBranch: 'main',
        member: 'local',
        command,
        log: (m) => logs.push(m),
        callTool: mockCallTool('azure-devops', { availableSecrets: ['azdevops_pat'] }),
    });

    check(result.reason === 'aborted-pr-created', `Expected reason 'aborted-pr-created', got: ${JSON.stringify(result)}`);
    check(result.pushed === true, `Expected pushed:true, got: ${JSON.stringify(result)}`);

    // The provider's OWN mapping, computed independently here, is the
    // source of truth this assertion pins runner.js against -- never a
    // hardcoded URL literal that could silently drift from the real hook.
    const expected = AzureDevOpsVCS.pullRequestResponse.map({ pullRequestId: 555 }, { repoRef: AZ_REPO_REF });
    check(!!expected.url, 'sanity: the provider mapping itself must produce a URL for this canned body');
    check(
        result.prUrl === expected.url,
        `Expected the reported PR URL to equal the provider mapping's own output (${expected.url}), got: ${result.prUrl}`,
    );
    check(
        result.prUrl === 'https://dev.azure.com/mock-org/mock-project/_git/mock-repo/pullrequest/555',
        `Expected the exact Azure DevOps browsable PR URL to be constructed from org/project/repo + id, got: ${result.prUrl}`,
    );

    // Revert-proofing for the mock-sprint publish path being ENTERED (not
    // skipped): this assertion is only reachable at all if the Azure DevOps
    // create-pull-request curl was actually dispatched -- confirmed here so
    // the assertions above cannot pass vacuously.
    const prCmd = log.find((c) => c.startsWith('curl') && /\/pullrequests\?/.test(c));
    check(!!prCmd, `Expected a VCSModule Azure DevOps 'curl .../pullrequests?...' command to be dispatched, command log: ${JSON.stringify(log)}`);
});

// -----------------------------------------------------------------------
// (2) Azure DevOps 409 + TF401179: treated as an idempotent success, never
// a publish failure.
// -----------------------------------------------------------------------
test('finalizeAbort (Azure DevOps): a canned 409 body carrying TF401179 is treated as an idempotent success, not a publish failure', async () => {
    const branch = 'auto-sprint/abort-ado-409';
    const { command, log } = buildMockCommand({
        originUrl: AZ_ORIGIN,
        credentialLine: ADO_CREDENTIAL_LINE,
        prResponder: () => `${JSON.stringify({
            message: 'TF401179: An active pull request for the source and target branch already exists.',
        })}\n409`,
    });
    const logs = [];
    const error = new SprintPlanRejectedError('Plan rejected after 3 rounds', { notes: null });

    let thrown = null;
    let result = null;
    try {
        result = await finalizeAbort({
            error,
            branch,
            baseBranch: 'main',
            member: 'local',
            command,
            log: (m) => logs.push(m),
            callTool: mockCallTool('azure-devops', { availableSecrets: ['azdevops_pat'] }),
        });
    } catch (e) {
        thrown = e;
    }

    check(thrown === null, `Expected the 409/TF401179 case to be treated as success (never throw), got: ${thrown && thrown.message}`);
    check(result.reason === 'already-exists', `Expected reason 'already-exists', got: ${JSON.stringify(result)}`);
    check(result.pushed === true, `Expected pushed:true even on the already-exists path, got: ${JSON.stringify(result)}`);
    check(
        logs.some((m) => /already exists/.test(m) && /idempotent success/.test(m)),
        `Expected a logged idempotent-success message, logs: ${JSON.stringify(logs)}`,
    );
    const prCmd = log.find((c) => c.startsWith('curl') && /\/pullrequests\?/.test(c));
    check(!!prCmd, `Expected the Azure DevOps create-pull-request curl to have actually been dispatched (not skipped), command log: ${JSON.stringify(log)}`);
});

// -----------------------------------------------------------------------
// (3) GitHub control: unaffected by the Azure DevOps mapping -- still
// reports its own unchanged html_url.
// -----------------------------------------------------------------------
test('finalizeAbort (GitHub): a canned 201 body still reports its unchanged html_url', async () => {
    const branch = 'auto-sprint/abort-gh-201';
    const ghUrl = 'https://github.com/mock-org/mock-repo/pull/909';
    const { command } = buildMockCommand({
        originUrl: 'https://github.com/mock-org/mock-repo.git',
        credentialLine: GH_CREDENTIAL_LINE,
        prResponder: () => `${JSON.stringify({ number: 909, html_url: ghUrl })}\n201`,
    });
    const logs = [];
    const error = new SprintPlanRejectedError('Plan rejected after 3 rounds', { notes: null });

    const result = await finalizeAbort({
        error,
        branch,
        baseBranch: 'main',
        member: 'local',
        command,
        log: (m) => logs.push(m),
        callTool: mockCallTool('github'),
    });

    check(result.reason === 'aborted-pr-created', `Expected reason 'aborted-pr-created', got: ${JSON.stringify(result)}`);
    check(result.prUrl === ghUrl, `Expected the reported PR URL to be GitHub's own unchanged html_url, got: ${result.prUrl}`);
});

// -----------------------------------------------------------------------
// (4) vcsCapabilities: dev.azure.com reports canOpenPullRequest true, other
// hosts are unchanged. Revert-proof by construction -- this reads the LIVE
// capabilitiesForHost() hook (vcs-providers/azure-devops.mjs), not a
// hardcoded expectation, so flipping that flag back to false makes this
// assertion fail rather than silently pass; and since the mock publish path
// above only gets entered because capabilities() reports true, that failure
// mode is already exercised end-to-end by tests (1)-(2)'s dispatched-curl
// assertions above.
// -----------------------------------------------------------------------
test('vcsCapabilities: dev.azure.com reports canOpenPullRequest true; github.com and gitlab.com are unchanged', () => {
    const adoCaps = vcsCapabilities(AZ_ORIGIN);
    check(adoCaps.canOpenPullRequest === true, `Expected dev.azure.com to be PR-capable, got: ${JSON.stringify(adoCaps)}`);
    check(adoCaps.host === 'dev.azure.com', `Expected host 'dev.azure.com', got: ${JSON.stringify(adoCaps)}`);

    const ghCaps = vcsCapabilities('https://github.com/mock-org/mock-repo.git');
    check(ghCaps.canOpenPullRequest === true, `Expected github.com to remain PR-capable, got: ${JSON.stringify(ghCaps)}`);

    const glCaps = vcsCapabilities('https://gitlab.com/mock-org/mock-repo.git');
    check(glCaps.canOpenPullRequest === false, `Expected gitlab.com (no registered provider) to remain non-PR-capable, got: ${JSON.stringify(glCaps)}`);
});
