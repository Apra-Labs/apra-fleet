import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isNetworkShapedCommand } from './helpers/mock-sprint-harness.mjs';

// =============================================================================
// apra-fleet-5co8.32 -- guards the fix that relaxed
// mock-sprint-harness.mjs's network-shaped-command guard from an anchored
// "curl/wget is the literal first token of the whole string" regex to
// isNetworkShapedCommand(), which detects a curl/wget invocation at the
// start of ANY top-level sub-command (composed via &&/||/;/|, an env `VAR=1`
// prefix, or one level inside a `bash -c "..."` / `sh -c "..."` script) --
// closing the exact slip-through class apra-fleet-5co8.16 exists to guard
// against for any FUTURE call site that composes its command instead of
// emitting a bare leading curl/wget.
// =============================================================================

test('isNetworkShapedCommand', async (t) => {
    await t.test('matches a bare leading curl/wget command (pre-existing behavior)', () => {
        assert.equal(isNetworkShapedCommand('curl https://example.com/api'), true);
        assert.equal(isNetworkShapedCommand('wget https://example.com/file'), true);
        assert.equal(isNetworkShapedCommand('curl.exe https://example.com/api'), true);
    });

    await t.test('matches curl composed after a cd && prefix', () => {
        assert.equal(
            isNetworkShapedCommand('cd /tmp && curl https://example.com/api'),
            true,
            'a curl composed via `cd X && curl ...` must be detected',
        );
    });

    await t.test('matches curl wrapped inside a bash -c "..." script', () => {
        assert.equal(
            isNetworkShapedCommand('bash -c "curl https://example.com/api"'),
            true,
            'a curl wrapped inside bash -c "..." must be detected',
        );
        assert.equal(
            isNetworkShapedCommand("sh -c 'curl https://example.com/api'"),
            true,
            'a curl wrapped inside sh -c \'...\' must be detected',
        );
    });

    await t.test('matches curl composed after an env VAR=1 prefix', () => {
        assert.equal(
            isNetworkShapedCommand('VAR=1 curl https://example.com/api'),
            true,
            'a curl composed after an env VAR=1 prefix must be detected',
        );
    });

    await t.test('matches curl chained after ; or ||', () => {
        assert.equal(isNetworkShapedCommand('echo hi ; curl https://example.com'), true);
        assert.equal(isNetworkShapedCommand('false || curl https://example.com'), true);
    });

    await t.test('does not false-positive on a literal "curl" inside another command\'s payload/message', () => {
        assert.equal(
            isNetworkShapedCommand('git commit -m "mention curl in the message, not a real call"'),
            false,
            'curl mentioned only as quoted payload text for an unrelated command must not match',
        );
        assert.equal(
            isNetworkShapedCommand('node -e "console.log(\'curl\')"'),
            false,
        );
    });

    await t.test('does not match an unrelated command', () => {
        assert.equal(isNetworkShapedCommand('git status'), false);
        assert.equal(isNetworkShapedCommand('bd show apra-fleet-5co8.32'), false);
    });
});
