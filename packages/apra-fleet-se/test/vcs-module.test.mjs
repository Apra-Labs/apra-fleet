import { test, describe } from 'node:test';
import assert from 'node:assert';
import { VCSModule, buildCreatePrCommand, buildCommentCommand } from '../fleet-sprint/vcs-module.mjs';

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
});

describe('VCSModule default export', () => {
    test('exposes the same builders as the named exports', () => {
        assert.strictEqual(VCSModule.buildCreatePrCommand, buildCreatePrCommand);
        assert.strictEqual(VCSModule.buildCommentCommand, buildCommentCommand);
    });
});
