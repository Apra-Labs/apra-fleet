import { test } from 'node:test';
import assert from 'node:assert/strict';

import { finalizeAbort } from '../fleet-sprint/runner.js';
import { capabilities as vcsCapabilities, buildCreatePrCommand, parseProviderRepoRef, getVcsProvider } from '../fleet-sprint/vcs-module.mjs';
import { BitbucketVCS } from '../fleet-sprint/vcs-providers/bitbucket.mjs';
import { SprintPlanRejectedError } from '../fleet-sprint/errors.mjs';
import { defaultMockCallTool, legacyCommandExecuteCommandAdapter } from './helpers/mock-sprint-harness.mjs';

const check = (cond, msg) => assert.ok(cond, msg);

// =============================================================================
// apra-fleet-qeq1.6.1 -- End-to-end verification: a Bitbucket remote reaches
// a real create-pull-request call. Modelled on
// test/mock-sprint-azure-devops-vcs-publish.test.mjs: the chain test below
// drives finalizeAbort() directly -- the SAME real, exported publish path
// both PR-raising call sites (Publish PR, finalizeAbort) share via
// raiseVcsPrForMember -- through a hand-rolled command mock and no live
// fleet/network, reusing the SAME production entry points VCSModule exposes
// (capabilities, parseProviderRepoRef, buildCreatePrCommand, getVcsProvider)
// rather than re-implementing them.
//
// Steps 1-4 (default suite, no network/credentials):
//   1. capabilities() reports canOpenPullRequest:true for bitbucket.org, so
//      the Publish PR / abort-path gate does not skip -- proved BOTH as a
//      direct assertion and, more strongly, by construction: the chain test
//      below only reaches its dispatched curl at all if this gate passed.
//   2. parseProviderRepoRef yields workspace/repo coordinates.
//   3. buildCreatePrCommand's URL, method, body and -u argument are pinned
//      EXACTLY (full string equality, not substring checks), with both
//      credential halves carried as the server placeholders
//      {{vcs_username_inline}}/{{vcs_token_inline}} in that exact order --
//      this is the one assertion that proves the bb-cred lane (the
//      {{vcs_username}} placeholder pair) and the bb-provider lane (this
//      builder) actually meet.
//   4. logSafeCommand redacts both credential halves.
//   Plus a chain test driving finalizeAbort() end to end: the mock-sprint
//   harness's vcs_credential_exec simulator (mock-sprint-harness.mjs)
//   substitutes the SAME placeholders with mock username/token values, and
//   the dispatched curl is asserted to carry both, in order, in its -u
//   argument -- proving steps 1-3 compose all the way to a real REST
//   dispatch, not just at the VCSModule level in isolation.
//
// FALSIFICATION (run manually, not automated -- see bead notes): reverting
// bitbucket.mjs's capabilitiesForHost to return canOpenPullRequest:false made
// the "capabilities" test below AND the finalizeAbort chain test fail (the
// chain test fails because the abort-path gate then reports
// reason:'non-hosted-remote' and never dispatches the curl at all).
// Reverting the 'create-pull-request' entry out of bitbucket.mjs's builders
// made the "buildCreatePrCommand" step-3 test AND the finalizeAbort chain
// test fail (buildCreatePrCommand throws a typed ERROR naming the provider
// and action with no builder registered). Both reverts were restored
// immediately after confirming the failure; `git status --porcelain` was
// clean before and after.
//
// OUTSTANDING LIVE CHECK: the opt-in live scenario (opening a real Bitbucket
// PR against apra-analytics) has not been run in this dispatch -- see
// helpers/bitbucket-real-e2e.mjs and bitbucket-real-e2e.test.mjs for the
// gated scenario and helpers/bitbucket-real-e2e-runbook.md for the
// configuration contract. Recorded as outstanding on this bead's notes and
// on the epic apra-fleet-qeq1's notes.
// =============================================================================

const BB_ORIGIN = 'git@bitbucket.org:kumaakh/apra-analytics.git';
const BB_REPO_REF = { workspace: 'kumaakh', repo: 'apra-analytics' };

// Mirrors mock-sprint-azure-devops-vcs-publish.test.mjs's buildMockCommand
// byte-for-byte (git fetch/rev-list/push/remote-get-url, plus the
// create-pull-request curl). `credentialFiles` is passed through unchanged
// for parity with that file's signature, but the finalizeAbort() chain never
// reads a `$HOME/.fleet-git-credential-*` file directly any more -- the
// create-PR command goes out through vcs_credential_exec instead (see
// mockCallTool below) -- so a credential-file read reaching this mock at all
// would itself be a regression; the chain test below asserts none occurs.
function buildMockCommand({ originUrl, credentialFiles, prResponder }) {
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
        const credRead = /^\$HOME\/\.fleet-git-credential-([A-Za-z0-9._-]+)$/.exec(cmd);
        if (credRead) {
            const line = credentialFiles[credRead[1]];
            if (line === undefined) return fail(`bash: $HOME/.fleet-git-credential-${credRead[1]}: No such file or directory`);
            return ok(line);
        }
        if (/^curl(?:\.exe)? -sS -X POST\b/.test(cmd) && /\/pullrequests\b/.test(cmd)) {
            return ok(prResponder(cmd));
        }
        throw new Error(`buildMockCommand: unexpected command dispatched in this scenario: '${cmd}'`);
    };
    return { command, log };
}

// Mirrors mock-sprint-azure-devops-vcs-publish.test.mjs's mockCallTool:
// `command` threads into legacyCommandExecuteCommandAdapter so
// vcs_credential_exec delegates to the SHARED defaultMockCallTool()
// simulator (reusing its placeholder substitution and redaction, now taught
// the {{vcs_username}}/{{vcs_username_inline}} pair for the 'bitbucket'
// label -- see mock-sprint-harness.mjs's MOCK_VCS_CREDENTIAL_USERNAMES).
function mockCallTool(vcsProvider, { availableSecrets = [] } = {}, command) {
    const base = defaultMockCallTool({ executeCommand: legacyCommandExecuteCommandAdapter(command) });
    return async (name, toolArgs) => {
        if (name === 'member_detail') return { content: [{ text: JSON.stringify({ vcsProvider }) }] };
        if (name === 'credential_store_list') {
            return { content: [{ text: JSON.stringify(availableSecrets.map((n) => ({ name: n, scope: 'persistent' }))) }] };
        }
        if (name === 'provision_vcs_auth') {
            const expiresAt = new Date(Date.now() + 60 * 60 * 1000).toISOString();
            return { content: [{ text: `[OK] Mock ${toolArgs && toolArgs.provider} credentials deployed on "${toolArgs && toolArgs.member_name}"\n  expiresAt: ${expiresAt}\n` }] };
        }
        return base(name, toolArgs);
    };
}

// =============================================================================
// DEFAULT SUITE (no network, no live Bitbucket): Steps 1-4 in separate
// named assertions.
// =============================================================================

// (1) Capabilities: a bitbucket.org remote is recognized and IS PR-capable.
test('vcs-bitbucket-publish-e2e: capabilities - a bitbucket.org remote is recognized and IS PR-capable', () => {
    for (const url of ['git@bitbucket.org:kumaakh/apra-analytics.git', 'https://bitbucket.org/kumaakh/apra-analytics.git']) {
        const caps = vcsCapabilities(url);
        check(caps.hasRemote === true, `Expected hasRemote:true for ${url}, got: ${JSON.stringify(caps)}`);
        check(caps.canOpenPullRequest === true, `Expected canOpenPullRequest:true for ${url}, got: ${JSON.stringify(caps)}`);
        check(caps.host === 'bitbucket.org', `Expected host 'bitbucket.org' for ${url}, got: ${JSON.stringify(caps)}`);
    }
});

// (2) parseProviderRepoRef: yields workspace/repo coordinates.
test('vcs-bitbucket-publish-e2e: parseProviderRepoRef - yields workspace/repo coordinates', () => {
    const sshRef = parseProviderRepoRef('git@bitbucket.org:kumaakh/apra-analytics.git');
    check(sshRef && !sshRef.error, `Expected parseProviderRepoRef to resolve Bitbucket SSH, got error: ${sshRef && sshRef.error}`);
    check(sshRef.ref.workspace === 'kumaakh', `Expected workspace 'kumaakh', got: ${sshRef.ref.workspace}`);
    check(sshRef.ref.repo === 'apra-analytics', `Expected repo 'apra-analytics', got: ${sshRef.ref.repo}`);

    const httpsRef = parseProviderRepoRef('https://bitbucket.org/kumaakh/apra-analytics.git');
    check(httpsRef && !httpsRef.error, `Expected parseProviderRepoRef to resolve Bitbucket HTTPS, got error: ${httpsRef && httpsRef.error}`);
    check(httpsRef.ref.workspace === 'kumaakh', `Expected workspace 'kumaakh' from HTTPS, got: ${httpsRef.ref.workspace}`);
    check(httpsRef.ref.repo === 'apra-analytics', `Expected repo 'apra-analytics' from HTTPS, got: ${httpsRef.ref.repo}`);
});

// (3) buildCreatePrCommand: the URL, method, body and -u argument are pinned
// EXACTLY (full string equality), not by substring checks -- a substring
// check cannot catch the two credential halves being swapped or reordered,
// which is exactly the property this assertion exists to pin (see the
// module doc comment above).
test('vcs-bitbucket-publish-e2e: buildCreatePrCommand - URL, method, body and -u argument are pinned EXACTLY with server placeholders in order', () => {
    const built = buildCreatePrCommand({
        provider: 'bitbucket',
        repoRef: BB_REPO_REF,
        base: 'main',
        head: 'auto-sprint/feat-x',
        title: 'Test PR',
        body: 'Test body',
        token: '{{vcs_token_inline}}',
        username: '{{vcs_username_inline}}',
        os: 'linux',
        shell: 'sh',
    });

    check(built.provider === 'bitbucket', `Expected provider 'bitbucket', got: ${built.provider}`);
    check(built.action === 'create-pull-request', `Expected action 'create-pull-request', got: ${built.action}`);

    const expectedPayload = '{"title":"Test PR","source":{"branch":{"name":"auto-sprint/feat-x"}},"destination":{"branch":{"name":"main"}},"description":"Test body"}';
    const expectedCommand = [
        'curl -sS -X POST',
        "-u '{{vcs_username_inline}}:{{vcs_token_inline}}'",
        "-H 'Content-Type: application/json'",
        "-H 'Accept: application/json'",
        `-d '${expectedPayload}'`,
        "-w '\n%{http_code}'",
        'https://api.bitbucket.org/2.0/repositories/kumaakh/apra-analytics/pullrequests',
    ].join(' ');

    check(
        built.command === expectedCommand,
        `Expected the EXACT pinned command (server placeholders in username:token order), got:\n${built.command}\nexpected:\n${expectedCommand}`,
    );

    const expectedLogSafeCommand = expectedCommand
        .replace('{{vcs_username_inline}}', '***REDACTED***')
        .replace('{{vcs_token_inline}}', '***REDACTED***');
    check(
        built.logSafeCommand === expectedLogSafeCommand,
        `Expected the EXACT pinned logSafeCommand, got:\n${built.logSafeCommand}\nexpected:\n${expectedLogSafeCommand}`,
    );
});

// (4) logSafeCommand redaction: contains neither placeholder's substituted
// value when real credentials are passed through a mock (proves the
// redaction layer independently of step 3's placeholder-shape pin).
test('vcs-bitbucket-publish-e2e: logSafeCommand - redacts both username and token', () => {
    const built = buildCreatePrCommand({
        provider: 'bitbucket',
        repoRef: BB_REPO_REF,
        base: 'main',
        head: 'auto-sprint/feat-x',
        title: 'Test PR',
        token: 'mock-bb-app-password',
        username: 'bbuser@example.com',
        os: 'linux',
        shell: 'sh',
    });

    check(built.command.includes('mock-bb-app-password'), `Expected command to carry real token, got: ${built.command}`);
    check(built.command.includes('bbuser@example.com'), `Expected command to carry real username, got: ${built.command}`);
    check(built.logSafeCommand.includes('***REDACTED***'), `Expected logSafeCommand to carry redaction marker, got: ${built.logSafeCommand}`);
    check(!built.logSafeCommand.includes('mock-bb-app-password'), `Expected logSafeCommand to NOT contain token, got: ${built.logSafeCommand}`);
    check(!built.logSafeCommand.includes('bbuser@example.com'), `Expected logSafeCommand to NOT contain username, got: ${built.logSafeCommand}`);
});

// Response mapping: the provider's pullRequestResponse.map works correctly
// in isolation (the chain test below proves the SAME mapping is what
// finalizeAbort() actually reports).
test('vcs-bitbucket-publish-e2e: response mapping - a Bitbucket 201 body maps to a PR URL via the provider', () => {
    const respBody = { id: 42, links: { html: { href: 'https://bitbucket.org/kumaakh/apra-analytics/pull-requests/42' } } };

    const impl = getVcsProvider('bitbucket');
    const mapped = impl.pullRequestResponse.map(respBody, { repoRef: BB_REPO_REF });

    check(mapped.id === 42, `Expected mapped id 42, got: ${mapped.id}`);
    check(
        mapped.url === 'https://bitbucket.org/kumaakh/apra-analytics/pull-requests/42',
        `Expected the exact Bitbucket browsable PR URL, got: ${mapped.url}`,
    );
});

// =============================================================================
// CHAIN TEST: finalizeAbort() end to end -- the property the epic opened on.
// Drives the SAME real publish path (raiseVcsPrForMember) a Bitbucket member
// hitting the abort-path or Publish PR gate would, through the mock-sprint
// harness's vcs_credential_exec simulator (now taught the bitbucket
// username/token pair -- see mock-sprint-harness.mjs). Proves steps 1-3
// compose: capabilities() does not skip the gate, parseProviderRepoRef
// resolves the coordinates raiseVcsPrForMember passes to the builder, and
// the substituted curl actually dispatched carries BOTH credential halves,
// in order, exactly as the unit-level step-3 test pins them in placeholder
// form.
// =============================================================================
test('finalizeAbort (Bitbucket): a canned 201 body maps to a PR URL constructed from the provider-owned response mapping, with both credential halves substituted in order', async () => {
    const branch = 'auto-sprint/abort-bb-201';
    const { command, log } = buildMockCommand({
        originUrl: BB_ORIGIN,
        credentialFiles: {},
        prResponder: () => `${JSON.stringify({ id: 777, links: { html: { href: 'https://bitbucket.org/kumaakh/apra-analytics/pull-requests/777' } } } )}\n201`,
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
        callTool: mockCallTool('bitbucket', {}, command),
    });

    check(result.reason === 'aborted-pr-created', `Expected reason 'aborted-pr-created', got: ${JSON.stringify(result)} (logs: ${JSON.stringify(logs)})`);
    check(result.pushed === true, `Expected pushed:true, got: ${JSON.stringify(result)}`);

    // The provider's OWN mapping, computed independently here, is the source
    // of truth this assertion pins runner.js against -- never a hardcoded
    // URL literal that could silently drift from the real hook.
    const expected = BitbucketVCS.pullRequestResponse.map({ id: 777, links: { html: { href: 'https://bitbucket.org/kumaakh/apra-analytics/pull-requests/777' } } }, { repoRef: BB_REPO_REF });
    check(!!expected.url, 'sanity: the provider mapping itself must produce a URL for this canned body');
    check(
        result.prUrl === expected.url,
        `Expected the reported PR URL to equal the provider mapping's own output (${expected.url}), got: ${result.prUrl}`,
    );
    check(
        result.prUrl === 'https://bitbucket.org/kumaakh/apra-analytics/pull-requests/777',
        `Expected the exact Bitbucket browsable PR URL, got: ${result.prUrl}`,
    );

    // Revert-proofing for the gate being ENTERED (not skipped): reachable
    // only if capabilities() reported canOpenPullRequest:true for this
    // bitbucket.org remote AND the builder actually produced a command.
    const prCmd = log.find((c) => c.startsWith('curl') && /\/pullrequests\b/.test(c));
    check(!!prCmd, `Expected a VCSModule Bitbucket 'curl .../pullrequests' command to be dispatched, command log: ${JSON.stringify(log)}`);

    // No credential-helper file read: the create-PR command goes out
    // entirely through vcs_credential_exec now (same property the Azure
    // DevOps analogue pins).
    check(!log.some((c) => /^\$HOME\/\.fleet-git-credential-/.test(c)), `The orchestrator must dispatch NO credential-helper read of its own; the handoff reads it server-side. Command log: ${JSON.stringify(log)}`);

    // The property no single-lane test can show: the DISPATCHED curl (after
    // server-side substitution) carries BOTH credential halves in the exact
    // 'username:token' order buildBitbucketCreatePrCommand's -u argument
    // requires -- proving the bb-cred lane's placeholder substitution and
    // the bb-provider lane's builder actually meet.
    check(
        prCmd.includes("-u 'mock-bitbucket-username:mock-bitbucket-app-password'"),
        `Expected the curl -u argument to carry 'username:token' in that exact order after substitution, got: ${prCmd}`,
    );
    check(!prCmd.includes('{{vcs_username_inline}}') && !prCmd.includes('{{vcs_token_inline}}'), `Expected no unsubstituted placeholder in the dispatched command, got: ${prCmd}`);
});
