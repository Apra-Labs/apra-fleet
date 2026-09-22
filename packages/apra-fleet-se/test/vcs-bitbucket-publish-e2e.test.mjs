import { test } from 'node:test';
import assert from 'node:assert/strict';

import { ApraFleet } from '@apralabs/apra-fleet-client';

import { finalizeAbort } from '../fleet-sprint/runner.js';
import { raiseVcsPrForMember } from '../fleet-sprint/vcs-auth.mjs';
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
//   apra-fleet-qeq1.9 adds a fifth property to the chain test and a unit
//   suite for the provisioning hook it depends on: raiseVcsPrForMember's
//   FIRST act is a just-in-time push+pr re-provision, so the chain below is
//   only honest if what that step dispatches is asserted rather than
//   rubber-stamped. BitbucketVCS.buildProvisionArgs skips it at that
//   git-access level, so the assertion is that NOTHING reaches
//   provision_vcs_auth and the PR goes out on the already-deployed
//   credential.
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
// apra-fleet-qeq1.9: `provisionCalls` is the ARGUMENT RECORDER this stub's
// provision_vcs_auth branch writes to. It used to return [OK] for ANY
// arguments and assert nothing about them, which is precisely why this file
// stayed green against a chain that could not work in production: the real
// path dispatched GitHub-App-shaped arguments with no api_token at all, which
// server-side is a missing-credential OOB prompt, not a success. The stub now
// records every call and FAILS it, so any dispatch at all is both visible to
// the assertions below and unable to rubber-stamp itself into a pass.
function mockCallTool(vcsProvider, { availableSecrets = [], provisionCalls = [] } = {}, command) {
    const base = defaultMockCallTool({ executeCommand: legacyCommandExecuteCommandAdapter(command) });
    return async (name, toolArgs) => {
        if (name === 'member_detail') return { content: [{ text: JSON.stringify({ vcsProvider }) }] };
        if (name === 'credential_store_list') {
            return { content: [{ text: JSON.stringify(availableSecrets.map((n) => ({ name: n, scope: 'persistent' }))) }] };
        }
        if (name === 'provision_vcs_auth') {
            provisionCalls.push(toolArgs);
            return {
                content: [{ text: `[FAIL] Mock provision_vcs_auth refused: this scenario expects NO provisioning dispatch, got ${JSON.stringify(toolArgs)}` }],
                structuredContent: { ok: false, reason: 'credential_assembly_failed' },
            };
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
    const provisionCalls = [];

    const result = await finalizeAbort({
        error,
        branch,
        baseBranch: 'main',
        member: 'local',
        command,
        log: (m) => logs.push(m),
        callTool: mockCallTool('bitbucket', { provisionCalls }, command),
    });

    check(result.reason === 'aborted-pr-created', `Expected reason 'aborted-pr-created', got: ${JSON.stringify(result)} (logs: ${JSON.stringify(logs)})`);
    check(result.pushed === true, `Expected pushed:true, got: ${JSON.stringify(result)}`);

    // apra-fleet-qeq1.9 -- the provisioning ARGUMENTS assertion this file
    // previously lacked. raiseVcsPrForMember's FIRST statement is the
    // just-in-time push+pr re-provision, so whatever it sends decides whether
    // a PR is ever attempted at all. BitbucketVCS.buildProvisionArgs answers
    // `skip` at that git-access level (the app password has no scope axis to
    // widen and cannot be re-assembled orchestrator-side), so the correct
    // dispatched-argument set here is the EMPTY one: nothing at all reaches
    // provision_vcs_auth, and the PR goes out on the credential already
    // deployed. Reverting that hook out of bitbucket.mjs makes the shared
    // caller fall back to its GitHub-App-shaped default arguments, which this
    // assertion then prints verbatim -- and which the stub above also fails,
    // so the chain degrades to authFailure and the 'aborted-pr-created'
    // assertion above goes red too.
    assert.deepStrictEqual(
        provisionCalls,
        [],
        `Expected NO provision_vcs_auth dispatch on the Bitbucket PR path (the provider's buildProvisionArgs hook skips it); got: ${JSON.stringify(provisionCalls)}`,
    );
    check(
        logs.some((m) => /nothing to re-provision/.test(m)),
        `Expected the skip to be logged, not silent; logs: ${JSON.stringify(logs)}`,
    );

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

// =============================================================================
// apra-fleet-qeq1.9 -- the provisioning hook itself.
//
// The chain test above proves the PR path no longer dies in the just-in-time
// re-provision that runs before it. These pin WHY, at the unit the shared
// caller actually consults, so a future edit to the hook cannot quietly
// change which git-access level skips or what an operator is told.
// =============================================================================

const PROVISION_BASE = {
    member_name: 'bb-member',
    provider: 'bitbucket',
    repos: ['kumaakh/apra-analytics'],
};

test('BitbucketVCS.buildProvisionArgs: the push+pr level SKIPS, with a note explaining why', () => {
    const built = BitbucketVCS.buildProvisionArgs({
        base: { ...PROVISION_BASE, git_access: 'push+pr' },
        repoRef: BB_REPO_REF,
        availableSecrets: [],
        remoteUrl: BB_ORIGIN,
    });

    check(built.skip === true, `Expected skip:true for the just-in-time push+pr re-provision, got: ${JSON.stringify(built)}`);
    check(built.args === undefined, `A skip must not also carry args, got: ${JSON.stringify(built)}`);
    check(built.error === undefined, `A skip is not a failure and must not carry an error, got: ${JSON.stringify(built)}`);
    check(
        typeof built.note === 'string' && built.note.includes('kumaakh'),
        `Expected a note naming the workspace so the skip is never silent, got: ${JSON.stringify(built.note)}`,
    );
});

test('BitbucketVCS.buildProvisionArgs: every other git-access level sends workspace + an api_token PLACEHOLDER, never a value and never an absent token', () => {
    const built = BitbucketVCS.buildProvisionArgs({
        base: { ...PROVISION_BASE, git_access: 'push' },
        repoRef: BB_REPO_REF,
        availableSecrets: ['bitbucket_api_token'],
        remoteUrl: BB_ORIGIN,
    });

    check(!built.error && !built.skip, `Expected buildable args for the shared preflight/self-heal level, got: ${JSON.stringify(built)}`);
    assert.deepStrictEqual(built.args, {
        member_name: 'bb-member',
        provider: 'bitbucket',
        git_access: 'push',
        repos: ['kumaakh/apra-analytics'],
        workspace: 'kumaakh',
        api_token: '{{secret.bitbucket_api_token}}',
    });
    // The whole point of sending api_token at all: provision_vcs_auth's
    // Bitbucket path opens an OUT-OF-BAND operator prompt when that field is
    // absent, which would stall an unattended sprint. It is a placeholder,
    // resolved hub-side -- never a credential value.
    check(/^\{\{secret\.[A-Za-z0-9._-]+\}\}$/.test(built.args.api_token), `api_token must be a bare {{secret.NAME}} placeholder, got: ${built.args.api_token}`);
});

test('BitbucketVCS.buildProvisionArgs: a missing credential-store entry is a typed ERROR carrying the remedy, not a prompt', () => {
    const built = BitbucketVCS.buildProvisionArgs({
        base: { ...PROVISION_BASE, git_access: 'push' },
        repoRef: BB_REPO_REF,
        availableSecrets: ['some-other-secret'],
        remoteUrl: BB_ORIGIN,
    });

    check(typeof built.error === 'string' && built.error.startsWith('ERROR: '), `Expected a typed ERROR string, got: ${JSON.stringify(built)}`);
    check(built.error.includes('bitbucket_api_token'), `Expected the error to name the credential-store entry, got: ${built.error}`);
    check(built.error.includes(BitbucketVCS.authRemedy.hint), `Expected the error to carry the provider's own remedy hint, got: ${built.error}`);
});

test('BitbucketVCS.buildProvisionArgs: an UNREADABLE remote errors by its real cause, on the PR path too', () => {
    const unread = BitbucketVCS.buildProvisionArgs({
        base: { ...PROVISION_BASE, git_access: 'push+pr' },
        repoRef: null,
        availableSecrets: [],
        remoteUrl: '',
        remoteReadError: 'git remote get-url origin printed nothing',
    });
    check(typeof unread.error === 'string', `Expected an error with no workspace to derive, got: ${JSON.stringify(unread)}`);
    check(unread.error.includes('could not be read'), `An unreadable remote is not a malformed one; got: ${unread.error}`);

    const malformed = BitbucketVCS.buildProvisionArgs({
        base: { ...PROVISION_BASE, git_access: 'push' },
        repoRef: null,
        availableSecrets: [],
        remoteUrl: 'https://bitbucket.org/only-one-segment',
    });
    check(malformed.error.includes('not a recognized Bitbucket repository URL'), `Expected the malformed-remote wording, got: ${malformed.error}`);
    check(malformed.error.includes(BitbucketVCS.repoRefHint), `Expected the expected-remote-shape hint, got: ${malformed.error}`);
});

test('BitbucketVCS.authRemedy: declares a non-empty hint and serverSideReMintable:false', () => {
    check(!!BitbucketVCS.authRemedy, 'Expected BitbucketVCS to declare authRemedy');
    check(BitbucketVCS.authRemedy.serverSideReMintable === false, `Bitbucket app passwords are minted by a human, never server-side; got: ${JSON.stringify(BitbucketVCS.authRemedy)}`);
    check(
        typeof BitbucketVCS.authRemedy.hint === 'string' && BitbucketVCS.authRemedy.hint.trim().length > 0,
        'Expected a non-empty authRemedy.hint -- the degrade path prints nothing without one',
    );
});

// The OTHER half of the epic's observable property: when the PR path DOES
// degrade, it must no longer be the bare "provision_vcs_auth failed ..." with
// no remedy text. Drives the real exported raiseVcsPrForMember against a
// member whose git remote cannot be read at all -- the one condition that
// still reaches the hook's error branch at the push+pr level.
test('raiseVcsPrForMember (Bitbucket): a degraded PR attempt carries the provider authRemedy hint, not a bare provisioning failure', async () => {
    const command = async (cmd, opts = {}) => {
        if (/^git remote get-url origin\b/.test(cmd)) {
            if (opts.failSoft) return { ok: false, output: '', error: 'fatal: No such remote' };
            throw new Error('fatal: No such remote');
        }
        throw new Error(`unexpected command in this scenario: '${cmd}'`);
    };
    const logs = [];
    const fleetApi = new ApraFleet({ callTool: mockCallTool('bitbucket', {}, command) });

    const result = await raiseVcsPrForMember({
        fleetApi,
        command,
        member: 'bb-member',
        base: 'main',
        head: 'auto-sprint/feat-x',
        title: 'Test PR',
        log: (m) => logs.push(m),
        logPrefix: '[Publish PR]',
    });

    check(result.ok === false, `Expected the attempt to fail, got: ${JSON.stringify(result)}`);
    check(result.authFailure === true, `Expected authFailure:true (a degrade, never a thrown abort), got: ${JSON.stringify(result)}`);
    check(
        result.error.includes(BitbucketVCS.authRemedy.hint),
        `Expected the degraded error to CONTAIN the provider's remedy hint, got: ${result.error}`,
    );
});
