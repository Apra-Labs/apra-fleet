import { test } from 'node:test';
import assert from 'node:assert/strict';
import { redactNetworkCommandForLog } from './helpers/mock-sprint-harness.mjs';

// =============================================================================
// apra-fleet-5co8.31 -- guards the fix that widened
// redactNetworkCommandForLog() beyond its original four-shape allowlist
// (-u user:token, Authorization: Bearer|Basic <t>, URL userinfo,
// token=/access_token=) to also redact:
//   - any -H/--header '<name>: <value>' whose header name looks
//     credential-shaped (token/auth/key/secret), not just Authorization --
//     e.g. GitLab's PRIVATE-TOKEN or a generic X-Api-Key.
//   - a "token"/"password" JSON field carried in a -d/--data body.
// The guard this feeds (mock-sprint-harness.mjs's unmocked network-command
// error) fires precisely when an UNKNOWN provider/endpoint was added
// without a mock, so the whole point is to catch a credential shape NOT
// already on the list -- these tests pin exactly that class of shape.
// =============================================================================

test('redactNetworkCommandForLog', async (t) => {
    await t.test('still redacts the original four shapes (regression)', () => {
        assert.equal(
            redactNetworkCommandForLog("curl -u :abc123PAT https://dev.azure.com/x"),
            "curl -u :***REDACTED*** https://dev.azure.com/x",
        );
        assert.equal(
            redactNetworkCommandForLog("curl -H 'Authorization: Bearer ghp_secrettoken' https://api.github.com"),
            "curl -H 'Authorization: ***REDACTED***' https://api.github.com",
        );
        assert.equal(
            redactNetworkCommandForLog("curl https://user:hunter2@example.com/repo.git"),
            "curl https://user:***REDACTED***@example.com/repo.git",
        );
        assert.equal(
            redactNetworkCommandForLog("curl https://api.example.com?access_token=abc123"),
            "curl https://api.example.com?access_token=***REDACTED***",
        );
    });

    await t.test('redacts a GitLab-style PRIVATE-TOKEN header', () => {
        assert.equal(
            redactNetworkCommandForLog("curl -H 'PRIVATE-TOKEN: XYZSECRET' https://gitlab.example.com/api"),
            "curl -H 'PRIVATE-TOKEN: ***REDACTED***' https://gitlab.example.com/api",
        );
    });

    await t.test('redacts a generic X-Api-Key header', () => {
        assert.equal(
            redactNetworkCommandForLog('curl -H "X-Api-Key: abc123secret" https://example.com/api'),
            'curl -H "X-Api-Key: ***REDACTED***" https://example.com/api',
        );
    });

    await t.test('redacts a bespoke X-...-Token header via --header', () => {
        assert.equal(
            redactNetworkCommandForLog("curl --header 'X-Custom-Token: sekrit' https://example.com/api"),
            "curl --header 'X-Custom-Token: ***REDACTED***' https://example.com/api",
        );
    });

    await t.test('does not redact an unrelated -H header', () => {
        assert.equal(
            redactNetworkCommandForLog("curl -H 'Content-Type: application/json' https://example.com/api"),
            "curl -H 'Content-Type: application/json' https://example.com/api",
        );
    });

    await t.test('redacts a "token" JSON field in a -d body', () => {
        assert.equal(
            redactNetworkCommandForLog(`curl -d '{"token":"abc123","other":"val"}' https://example.com/api`),
            `curl -d '{"token":"***REDACTED***","other":"val"}' https://example.com/api`,
        );
    });

    await t.test('redacts a "password" JSON field (with a space after the colon) in a -d body', () => {
        assert.equal(
            redactNetworkCommandForLog(`curl -d '{"password": "hunter2"}' https://example.com/api`),
            `curl -d '{"password": "***REDACTED***"}' https://example.com/api`,
        );
    });

    await t.test('does not redact an unrelated JSON field', () => {
        assert.equal(
            redactNetworkCommandForLog(`curl -d '{"note":"nothing secret here"}' https://example.com/api`),
            `curl -d '{"note":"nothing secret here"}' https://example.com/api`,
        );
    });
});
