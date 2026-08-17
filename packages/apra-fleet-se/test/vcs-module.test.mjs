import { test, describe } from 'node:test';
import assert from 'node:assert';
import { VCSModule, buildCreatePrCommand, buildCommentCommand, resolveProvider } from '../fleet-sprint/vcs-module.mjs';

// apra-fleet-tfx.7: orchestrator-side VCSModule -- provider-dispatched
// PR-creation command builder. Pure/deterministic: no network calls in this
// suite, only string-building assertions.

describe('VCSModule.buildCreatePrCommand', () => {
    test('builds the exact GitHub create-pull-request curl command', () => {
        const result = buildCreatePrCommand({
            provider: 'github',
            repo: 'Apra-Labs/apra-fleet',
            base: 'main',
            head: 'auto-sprint/feature-x',
            title: 'Auto-sprint: feature-x',
            body: 'PASS -- see report',
            token: 'ghs_abcdef123456',
        });

        const expectedPayload = JSON.stringify({
            title: 'Auto-sprint: feature-x',
            head: 'auto-sprint/feature-x',
            base: 'main',
            body: 'PASS -- see report',
        });

        const expectedCommand = [
            'curl -sS -X POST',
            `-H 'Authorization: Bearer ghs_abcdef123456'`,
            `-H 'Accept: application/vnd.github+json'`,
            `-H 'Content-Type: application/json'`,
            `-H 'X-GitHub-Api-Version: 2022-11-28'`,
            `-d '${expectedPayload}'`,
            `-w '\n%{http_code}'`,
            'https://api.github.com/repos/Apra-Labs/apra-fleet/pulls',
        ].join(' ');

        assert.strictEqual(result.command, expectedCommand);
        assert.strictEqual(result.provider, 'github');
        assert.strictEqual(result.action, 'create-pull-request');
        assert.deepStrictEqual(result.interpret, {
            successStatusRange: [200, 299],
            alreadyExistsStatus: 422,
            alreadyExistsPattern: 'already exists',
        });
    });

    test('doubles embedded single quotes (PowerShell-safe) when os is windows', () => {
        const result = buildCreatePrCommand({
            provider: 'github',
            repo: 'Apra-Labs/apra-fleet',
            base: 'main',
            head: 'auto-sprint/feature-x',
            title: "Fix doer's crash",
            token: 'ghs_abcdef123456',
            os: 'windows',
        });

        // PowerShell single-quoted strings escape an embedded ' by doubling
        // it (''), never via the POSIX '\'' close-reopen trick -- so the
        // JSON payload's apostrophe surfaces as "doer''s crash" and there is
        // no backslash-quote sequence anywhere in the built command.
        assert.ok(result.command.includes(`"Fix doer''s crash"`));
        assert.ok(!result.command.includes(`\\'`));
    });

    test('keeps POSIX close-reopen escaping when os is omitted or non-windows', () => {
        const posixParams = {
            provider: 'github',
            repo: 'Apra-Labs/apra-fleet',
            base: 'main',
            head: 'auto-sprint/feature-x',
            title: "Fix doer's crash",
            token: 'ghs_abcdef123456',
        };
        const withoutOs = buildCreatePrCommand(posixParams);
        const withLinux = buildCreatePrCommand({ ...posixParams, os: 'linux' });

        assert.strictEqual(withoutOs.command, withLinux.command);
        assert.ok(withoutOs.command.includes(`"Fix doer'\\''s crash"`));
    });

    test('omits body from the JSON payload when not supplied', () => {
        const result = buildCreatePrCommand({
            provider: 'github',
            repo: 'Apra-Labs/apra-fleet',
            base: 'main',
            head: 'feature-y',
            title: 'no body here',
            token: 'ghs_tok',
        });
        assert.ok(!result.command.includes('"body"'));
    });

    test('never echoes the raw token in logSafeCommand', () => {
        const result = buildCreatePrCommand({
            provider: 'github',
            repo: 'Apra-Labs/apra-fleet',
            base: 'main',
            head: 'feature-x',
            title: 't',
            token: 'ghs_super_secret_value',
        });
        assert.ok(!result.logSafeCommand.includes('ghs_super_secret_value'));
        assert.ok(result.logSafeCommand.includes('***REDACTED***'));
        // The real command is still fully usable for execution.
        assert.ok(result.command.includes('ghs_super_secret_value'));
        // Every other part of the command is identical between the two forms.
        assert.strictEqual(
            result.logSafeCommand.replace('***REDACTED***', 'ghs_super_secret_value'),
            result.command,
        );
    });

    test('never emits a gh CLI invocation or a create_pull_request reference', () => {
        const result = buildCreatePrCommand({
            provider: 'github',
            repo: 'Apra-Labs/apra-fleet',
            base: 'main',
            head: 'feature-x',
            title: 't',
            token: 'ghs_tok',
        });
        assert.ok(!/(^|\s)gh(\s|$)/.test(result.command));
        assert.ok(!result.command.includes('gh pr create'));
        assert.ok(!result.command.toLowerCase().includes('create_pull_request'));
        assert.ok(!result.logSafeCommand.toLowerCase().includes('create_pull_request'));
    });

    test('unsupported provider fails with an ASCII ERROR: message, not a wrong command', () => {
        assert.throws(
            () => buildCreatePrCommand({
                provider: 'bitbucket',
                repo: 'ws/repo',
                base: 'main',
                head: 'feature-x',
                title: 't',
                token: 'tok',
            }),
            (err) => err.message.startsWith('ERROR: VCSModule: '),
        );
        assert.throws(
            () => buildCreatePrCommand({
                provider: 'gitlab',
                repo: 'ws/repo',
                base: 'main',
                head: 'feature-x',
                title: 't',
                token: 'tok',
            }),
            (err) => err.message.startsWith('ERROR: VCSModule: unsupported VCS provider "gitlab"'),
        );
    });

    test('missing required fields fail with an ASCII ERROR: message', () => {
        assert.throws(
            () => buildCreatePrCommand({ provider: 'github', repo: 'Apra-Labs/apra-fleet', base: 'main', head: 'x', title: 't' }),
            (err) => err.message.startsWith('ERROR: VCSModule: no token supplied'),
        );
        assert.throws(
            () => buildCreatePrCommand({ provider: 'github', repo: 'not-a-repo', base: 'main', head: 'x', title: 't', token: 'tok' }),
            (err) => err.message.startsWith('ERROR: VCSModule: invalid repo'),
        );
        assert.throws(
            () => buildCreatePrCommand({ provider: 'github', repo: 'a/b', head: 'x', title: 't', token: 'tok' }),
            (err) => err.message.startsWith('ERROR: VCSModule: "base" branch is required'),
        );
    });

    test('is pure/deterministic -- identical input yields byte-identical output, no network access attempted', () => {
        const params = {
            provider: 'github',
            repo: 'Apra-Labs/apra-fleet',
            base: 'main',
            head: 'feature-x',
            title: 'deterministic test',
            body: 'body text',
            token: 'ghs_tok',
        };
        const a = buildCreatePrCommand(params);
        const b = buildCreatePrCommand(params);
        assert.deepStrictEqual(a, b);
    });
});

describe('VCSModule.buildCommentCommand', () => {
    test('builds a GitHub issue-comment curl command for annotating an existing PR on abort', () => {
        const result = buildCommentCommand({
            provider: 'github',
            repo: 'Apra-Labs/apra-fleet',
            issue_number: 42,
            body: 'Sprint aborted -- see run log.',
            token: 'ghs_tok',
        });
        assert.strictEqual(result.provider, 'github');
        assert.strictEqual(result.action, 'comment');
        assert.ok(result.command.includes('https://api.github.com/repos/Apra-Labs/apra-fleet/issues/42/comments'));
        assert.ok(result.command.includes('ghs_tok'));
        assert.ok(!result.logSafeCommand.includes('ghs_tok'));
        assert.ok(!result.command.toLowerCase().includes('create_pull_request'));
    });

    test('unsupported provider fails with an ASCII ERROR: message', () => {
        assert.throws(
            () => buildCommentCommand({ provider: 'azure-devops', repo: 'a/b', issue_number: 1, body: 'x', token: 'tok' }),
            (err) => err.message.startsWith('ERROR: VCSModule: '),
        );
    });

    test('doubles embedded single quotes (PowerShell-safe) when os is windows', () => {
        const result = buildCommentCommand({
            provider: 'github',
            repo: 'Apra-Labs/apra-fleet',
            issue_number: 42,
            body: "doer's step failed -- see run log.",
            token: 'ghs_tok',
            os: 'windows',
        });
        assert.ok(result.command.includes(`"doer''s step failed`));
        assert.ok(!result.command.includes(`\\'`));
    });
});

describe('VCSModule default export', () => {
    test('exposes the same builders as the named exports', () => {
        assert.strictEqual(VCSModule.buildCreatePrCommand, buildCreatePrCommand);
        assert.strictEqual(VCSModule.buildCommentCommand, buildCommentCommand);
        assert.strictEqual(VCSModule.resolveProvider, resolveProvider);
    });
});

// =============================================================================
// VCSModule.resolveProvider (apra-fleet-647.1.2.1) -- reads a member's
// persisted vcsProvider from the fleet member registry via an injected
// fleetApi.memberDetail(), with NO default and NO guessing. A dedicated
// [test]-typed sibling bead (apra-fleet-647.1.2.2) owns the full runner.js
// call-site coverage (both provision_vcs_auth callers going through this);
// this suite exercises resolveProvider() itself, directly and in isolation.
// =============================================================================
describe('VCSModule.resolveProvider', () => {
    function fleetApiReturning(vcsProvider) {
        return {
            memberDetail: async () => ({ content: [{ text: JSON.stringify({ vcsProvider }) }] }),
        };
    }

    test('a member registered with GitHub resolves to provider "github" and its GitHub App auth mode', async () => {
        const result = await resolveProvider('fleet-mac', { fleetApi: fleetApiReturning('github') });
        assert.deepEqual(result, { provider: 'github', authMode: 'github-app' });
    });

    test('an absent vcsProvider (member never provisioned) throws an ASCII "ERROR:" naming the member and the known providers -- never defaults to GitHub', async () => {
        await assert.rejects(
            () => resolveProvider('fleet-mac', { fleetApi: fleetApiReturning(undefined) }),
            (err) => {
                assert.match(err.message, /^ERROR:/);
                assert.match(err.message, /fleet-mac/);
                assert.match(err.message, /github, bitbucket, azure-devops/);
                return true;
            },
        );
    });

    test('an unrecognized provider string throws an ASCII "ERROR:" naming the member, never silently coerced to a known provider', async () => {
        await assert.rejects(
            () => resolveProvider('fleet-mac', { fleetApi: fleetApiReturning('gitlab') }),
            /ERROR:.*fleet-mac/,
        );
    });

    test('memberDetail() call failure (e.g. fleet server unreachable) propagates as a typed "ERROR:" rejection, not a silent GitHub default', async () => {
        const fleetApi = { memberDetail: async () => { throw new Error('fleet server unreachable'); } };
        await assert.rejects(
            () => resolveProvider('fleet-mac', { fleetApi }),
            (err) => {
                assert.match(err.message, /^ERROR:/);
                assert.match(err.message, /fleet server unreachable/);
                return true;
            },
        );
    });

    test('a non-JSON memberDetail() response (e.g. "no member found") surfaces that text verbatim, not a generic parse error', async () => {
        const fleetApi = { memberDetail: async () => ({ content: [{ text: 'no member found matching "ghost"' }] }) };
        await assert.rejects(
            () => resolveProvider('ghost', { fleetApi }),
            /no member found matching "ghost"/,
        );
    });

    test('requires an injected fleetApi.memberDetail() -- throws a clear "ERROR:" rather than crashing on a missing method', async () => {
        await assert.rejects(
            () => resolveProvider('fleet-mac', {}),
            /ERROR:.*memberDetail/,
        );
    });

    test('a non-GitHub known provider (bitbucket) resolves to that provider with a null auth mode (no separate mode axis)', async () => {
        const result = await resolveProvider('fleet-mac', { fleetApi: fleetApiReturning('bitbucket') });
        assert.deepEqual(result, { provider: 'bitbucket', authMode: null });
    });
});
