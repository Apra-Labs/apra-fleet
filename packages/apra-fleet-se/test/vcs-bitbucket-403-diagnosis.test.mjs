import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { raiseVcsPrForMember } from '../fleet-sprint/vcs-auth.mjs';
import { BitbucketVCS } from '../fleet-sprint/vcs-providers/bitbucket.mjs';
import { buildCreatePrCommand, buildFindPrCommand, buildUpdatePrCommand } from '../fleet-sprint/vcs-module.mjs';
import { ApraFleet } from '@apralabs/apra-fleet-client';

// =============================================================================
// Bitbucket 403 diagnosis: the refusal's own facts reach the operator.
//
// Bitbucket answers a refused REST call with the credential type
// (X-Credential-Type), the scopes it carries (X-OAuth-Scopes) and the scope
// the endpoint needed (body error.detail.required / .granted). The PR path
// captures the response headers with curl `-D -` and hands { status, body,
// headers } to the provider's httpFailureHint, which names the real cause and
// leads with a fix that fits what is in the credential store.
//
// The recordings below are curl -sS -D - -w '\n%{http_code}' stdout shapes
// (header block, blank line, JSON body, status line). No network.
// ASCII only.
// =============================================================================

const BB_ORIGIN = 'git@bitbucket.org:acme/widgets.git';
const SENTINEL = 'SENTINEL-bb-token-7f3e9c1d';

const REPO_ACCESS_TOKEN_403 = [
    'HTTP/2 403 ',
    'date: Sun, 08 Nov 2026 10:00:00 GMT',
    'content-type: application/json; charset=utf-8',
    'x-credential-type: repo_access_token',
    'x-oauth-scopes: repository:write',
    'x-accepted-oauth-scopes: pullrequest',
    'set-cookie: session=should-never-be-quoted',
    '',
    '{"type": "error", "error": {"message": "Your credentials lack one or more required privilege scopes.", "detail": {"required": ["pullrequest"], "granted": ["repository:write"]}}}',
].join('\r\n') + '\n403';

const API_TOKEN_403 = [
    'HTTP/2 403 ',
    'content-type: application/json; charset=utf-8',
    'x-credential-type: api_token',
    'x-oauth-scopes: read:repository:bitbucket, write:repository:bitbucket',
    '',
    '{"type": "error", "error": {"message": "Your credentials lack one or more required privilege scopes.", "detail": {"required": ["write:pullrequest:bitbucket"], "granted": ["read:repository:bitbucket", "write:repository:bitbucket"]}}}',
].join('\r\n') + '\n403';

/**
 * A fleet whose vcs_credential_exec simulates the server: substitutes the
 * sentinel token for the inline placeholder, "runs" the command (answers the
 * recording) and redacts the token from what it returns.
 */
function fakeFleet({ recording, store }) {
    const state = { dispatched: [], tools: [] };
    const callTool = async (name, args) => {
        state.tools.push(name);
        if (name === 'member_detail') return { content: [{ text: JSON.stringify({ vcsProvider: 'bitbucket', os: 'linux', shell: '' }) }] };
        if (name === 'credential_store_list') return { content: [{ text: JSON.stringify(store.map((n) => ({ name: n }))) }] };
        if (name === 'provision_vcs_auth') return { content: [{ text: '[FAIL] unexpected' }], structuredContent: { ok: false, reason: 'unexpected' } };
        if (name === 'vcs_credential_exec') {
            assert.ok(args.command.includes('{{vcs_token_inline}}'), 'the orchestrator sends the placeholder, never a token');
            const substituted = args.command.replaceAll('{{vcs_token_inline}}', SENTINEL);
            state.dispatched.push(substituted);
            const stdout = recording.replaceAll(SENTINEL, '[REDACTED:vcs_token]');
            return { content: [{ text: '[OK]' }], structuredContent: { ok: true, reason: 'ok', exitCode: 0, stdout, stderr: '' } };
        }
        throw new Error(`unexpected tool ${name}`);
    };
    return { state, callTool };
}

async function raise({ recording, store }) {
    const { state, callTool } = fakeFleet({ recording, store });
    const logs = [];
    const result = await raiseVcsPrForMember({
        fleetApi: new ApraFleet({ callTool }),
        command: async (cmd) => (cmd === 'git remote get-url origin' ? { ok: true, output: BB_ORIGIN, error: null } : { ok: true, output: '', error: null }),
        member: 'bb-dev', base: 'main', head: 'feat/x', title: 'T', body: 'B',
        log: (m) => logs.push(m), logPrefix: '[Publish PR]', remoteUrlOverride: BB_ORIGIN,
    });
    return { result, logs, state };
}

describe('recorded repo_access_token 403', () => {
    test('names repo_access_token, required pullrequest and granted repository:write; never blames a missing API token scope', async () => {
        const { result } = await raise({ recording: REPO_ACCESS_TOKEN_403, store: ['bitbucket_api_token'] });
        assert.equal(result.ok, false);
        assert.equal(result.authFailure, true);
        const msg = result.error;
        assert.match(msg, /HTTP 403/);
        assert.match(msg, /repo_access_token/);
        assert.match(msg, /required: pullrequest/);
        assert.match(msg, /granted: repository:write/);
        assert.match(msg, /X-OAuth-Scopes: repository:write/);
        assert.ok(!/API token is missing/.test(msg), msg);
        assert.ok(!msg.includes('should-never-be-quoted'), 'a set-cookie header value is never quoted');
    });
});

describe('recorded api_token 403', () => {
    test('names api_token and the missing scope', async () => {
        const { result } = await raise({ recording: API_TOKEN_403, store: ['bitbucket_api_token'] });
        const msg = result.error;
        assert.match(msg, /X-Credential-Type api_token/);
        assert.match(msg, /missing a required scope/);
        assert.match(msg, /required: write:pullrequest:bitbucket/);
        assert.ok(!/repo_access_token/.test(msg), msg);
    });
});

describe('remedy follows the credential store', () => {
    const remedyOf = (msg) => msg.slice(msg.indexOf('Fix: '));

    test('bitbucket_api_token stored: the re-provision command leads, and nothing says to create a token', async () => {
        const { result } = await raise({ recording: REPO_ACCESS_TOKEN_403, store: ['other', 'bitbucket_api_token'] });
        const msg = result.error;
        assert.ok(msg.includes('Fix: '), msg);
        const remedy = remedyOf(msg);
        assert.ok(
            remedy.startsWith("Fix: re-provision member 'bb-dev' from the stored bitbucket_api_token: provision_vcs_auth member_name=bb-dev provider=bitbucket workspace=acme api_token={{secret.bitbucket_api_token}}"),
            remedy,
        );
        assert.ok(!/create/i.test(remedy), `the remedy must not tell the operator to create a token: ${remedy}`);
        assert.ok(!msg.includes(BitbucketVCS.authRemedy.hint), 'the generic create-a-token remedy is replaced, not appended');
        assert.ok(!/\{\{secure\./.test(msg), 'only the {{secret.NAME}} spelling');
    });

    test('bitbucket_api_token absent: the create-token guidance appears, still led by the actionable line', async () => {
        const { result } = await raise({ recording: REPO_ACCESS_TOKEN_403, store: ['other'] });
        const remedy = remedyOf(result.error);
        assert.ok(remedy.startsWith('Fix: the credential store has no bitbucket_api_token entry; store an Atlassian API token'), remedy);
        assert.match(remedy, /provision_vcs_auth member_name=bb-dev provider=bitbucket workspace=acme api_token=\{\{secret\.bitbucket_api_token\}\}/);
        assert.match(remedy, /an operator creates an Atlassian API token at https:\/\/id\.atlassian\.com/);
    });

    test('the generic authRemedy hint leads with its actionable line too', () => {
        assert.ok(BitbucketVCS.authRemedy.hint.startsWith('Fix: store an Atlassian API token with credential_store_set name=bitbucket_api_token, then run provision_vcs_auth'), BitbucketVCS.authRemedy.hint);
    });
});

describe('httpFailureHint contract', () => {
    test('a plain-status call still works and words an unknown credential type, not an API token', () => {
        const hint = BitbucketVCS.httpFailureHint(403);
        assert.equal(typeof hint, 'string');
        assert.match(hint, /type unknown/);
        assert.match(hint, /missing a required scope/);
        assert.ok(!/API token is missing/.test(hint), hint);
        assert.match(BitbucketVCS.httpFailureHint(410), /app passwords have been retired/);
        assert.equal(BitbucketVCS.httpFailureHint(500), '');
        assert.equal(BitbucketVCS.httpFailureHint(401), '', 'legacy shape keeps its old 401 answer');
    });

    test('the ctx call returns { hint, remedy }; nothing to say -> both empty', () => {
        assert.deepEqual(BitbucketVCS.httpFailureHint({ status: 500, headers: {} }), { hint: '', remedy: '' });
        const r = BitbucketVCS.httpFailureHint({ status: 404, headers: { 'x-credential-type': 'repo_access_token' }, repo: 'acme/widgets', availableSecrets: ['bitbucket_api_token'], memberName: 'm' });
        assert.match(r.hint, /cannot see repository acme\/widgets \(HTTP 404\)/);
        assert.match(r.remedy, /^Fix: re-provision member 'm'/);
    });

    test('header and body values are quoted as ASCII only', () => {
        const r = BitbucketVCS.httpFailureHint({ status: 403, headers: { 'X-Credential-Type': 'api\u2014token' }, body: { error: { detail: { required: ['pull\u00e9request'] } } } });
        assert.ok([...r.hint].every((ch) => ch.charCodeAt(0) < 128), r.hint);
    });
});

describe('command builders capture response headers on every member shell', () => {
    const TOKEN = SENTINEL;
    const coords = { provider: 'bitbucket', repoRef: { workspace: 'acme', repo: 'widgets' }, token: TOKEN };
    const targets = [
        { label: 'posix', os: 'linux', shell: '', curl: /^curl -sS -X / },
        { label: 'windows powershell', os: 'windows', shell: 'powershell5', curl: /^curl\.exe -sS -X / },
        { label: 'windows gitbash', os: 'windows', shell: 'gitbash', curl: /^curl\.exe -sS -X / },
    ];
    for (const t of targets) {
        test(`${t.label}: create/find/update carry -D - and the -w status line; logSafeCommand holds no token`, () => {
            const built = [
                buildCreatePrCommand({ ...coords, base: 'main', head: 'feat/x', title: "it's a PR", body: 'b', os: t.os, shell: t.shell }),
                buildFindPrCommand({ ...coords, base: 'main', head: 'feat/x', os: t.os, shell: t.shell }),
                buildUpdatePrCommand({ ...coords, pull_request_id: 7, title: 't', body: 'b', os: t.os, shell: t.shell }),
            ];
            for (const b of built) {
                assert.match(b.command, t.curl);
                assert.ok(/ -D - /.test(b.command), `no -D - in: ${b.command}`);
                assert.ok(b.command.includes("-w '\n%{http_code}'"), b.command);
                assert.ok(b.command.includes(TOKEN), 'the dispatched command carries the token');
                assert.ok(!b.logSafeCommand.includes(TOKEN), `token in logSafeCommand: ${b.logSafeCommand}`);
                assert.ok(!JSON.stringify({ ...b, command: undefined }).includes(TOKEN), 'token only in command');
            }
            const quote = t.shell === 'powershell5' ? /'it''s a PR'|it''s/ : /it'\\''s/;
            assert.match(built[0].command, quote, 'the shell dialect still picks the quoting');
        });
    }
});

describe('no secret in any new log line', () => {
    test('the sentinel token never reaches a log line or the returned message', async () => {
        for (const recording of [REPO_ACCESS_TOKEN_403, API_TOKEN_403]) {
            for (const store of [['bitbucket_api_token'], []]) {
                const { result, logs, state } = await raise({ recording, store });
                assert.ok(state.dispatched.some((c) => c.includes(SENTINEL)), 'the fake really substituted the token');
                for (const line of [...logs, result.error]) {
                    assert.ok(!line.includes(SENTINEL), `sentinel leaked: ${line}`);
                }
            }
        }
    });
});
