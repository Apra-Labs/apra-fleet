import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { raiseVcsPrForMember } from '../fleet-sprint/vcs-auth.mjs';
import { createStagedFileRecorder, TEST_MEMBER_FOLDER } from './helpers/vcs-payload-test.mjs';

// =============================================================================
// PR response mapping: a 2xx create answer that does not identify a pull
// request is a failure on EVERY provider, never ok:true with prUrl null.
//   - 203 with an HTML sign-in page (what an unauthenticated request can get
//     back) -> ok:false, authFailure:true, reason pr-response-sign-in;
//   - 200/201 whose JSON lacks the PR id -> ok:false, typed reason
//     pr-response-unmapped;
//   - a normal 201 with an id -> ok:true, prUrl is the mapped URL;
//   - the logged line names the HTTP status and a body excerpt, and never a
//     secret value planted in the stubbed response.
//
// raiseVcsPrForMember runs for real against a stubbed vcs_credential_exec;
// stdout is "<body>\n<http status>" (curl -w trailer, parseVcsCurlOutput).
// ASCII only.
// =============================================================================

// Planted secrets: a token-shaped value, URL userinfo, and a long opaque run.
const SECRET_TOKEN = 'ghp_PlantedSecretValue0123456789abcdefABCD';
const SECRET_USERINFO = 'svcuser:PlantedPassw0rd';
const SECRET_OPAQUE = 'q7x2m9k4p1w8z3n6b5v0c7x2m9k4p1w8z3n6b5v0c7x2m9k4p1';
const SECRETS = [SECRET_TOKEN, 'PlantedPassw0rd', SECRET_OPAQUE];

const SIGN_IN_HTML = [
    '<!DOCTYPE html>',
    '<html><head><title>Azure DevOps Services | Sign In</title></head>',
    `<body><form id="loginForm" action="https://${SECRET_USERINFO}@login.example.invalid/_signin?realm=x&token=${SECRET_TOKEN}">`,
    `<input type="hidden" name="ctx" value="${SECRET_OPAQUE}">`,
    '<p>Sign in to continue to the requested resource.</p></form></body></html>',
].join('\n');

const PROVIDERS = {
    github: {
        remote: 'https://github.com/acme/widgets.git',
        created: { number: 42, html_url: 'https://github.com/acme/widgets/pull/42' },
        prUrl: 'https://github.com/acme/widgets/pull/42',
        noId: { html_url: 'https://github.com/acme/widgets/pull/42', state: 'open', note: `Bearer ${SECRET_OPAQUE}` },
    },
    bitbucket: {
        remote: 'https://bitbucket.org/acme/widgets.git',
        created: { id: 42, links: { html: { href: 'https://bitbucket.org/acme/widgets/pull-requests/42' } } },
        prUrl: 'https://bitbucket.org/acme/widgets/pull-requests/42',
        noId: { type: 'pullrequest', state: 'OPEN', links: {}, note: `token=${SECRET_TOKEN}` },
    },
    'azure-devops': {
        remote: 'https://dev.azure.com/acme/proj/_git/widgets',
        created: { pullRequestId: 22, status: 'active' },
        prUrl: 'https://dev.azure.com/acme/proj/_git/widgets/pullrequest/22',
        noId: { status: 'active', title: 'Sprint PR', note: SECRET_OPAQUE },
    },
};

function respond(status, bodyText) {
    return {
        content: [{ text: '' }],
        structuredContent: { ok: true, reason: 'ok', exitCode: 0, stdout: `${bodyText}\n${status}`, stderr: '' },
    };
}

function makeFleetApi(provider, answer) {
    const staged = createStagedFileRecorder();
    const calls = { provision: [], exec: [] };
    return {
        calls,
        async memberDetail() {
            return { content: [{ text: JSON.stringify({ folder: TEST_MEMBER_FOLDER, vcsProvider: provider, os: 'linux', shell: '' }) }] };
        },
        async provisionVcsAuth(args) {
            calls.provision.push(args);
            return { content: [{ text: 'ok' }], structuredContent: { ok: true, expiresAt: null } };
        },
        async credentialStoreList() {
            return { content: [{ text: JSON.stringify([{ name: 'azdevops_pat', scope: 'persistent' }]) }] };
        },
        sendFiles: staged.record,
        async vcsCredentialExec(args) {
            calls.exec.push(args);
            return answer(args, calls.exec.length);
        },
    };
}

async function raise(provider, answer) {
    const cfg = PROVIDERS[provider];
    const fleetApi = makeFleetApi(provider, answer);
    const logs = [];
    const command = async (cmd) => (cmd === 'git remote get-url origin'
        ? { ok: true, output: cfg.remote, error: null }
        : { ok: true, output: '', error: null });
    const res = await raiseVcsPrForMember({
        fleetApi, command, member: `pr-map-${provider}`, base: 'main', head: 'feat/x', title: 't', body: 'b',
        log: (m) => logs.push(m), logPrefix: '[Publish PR]', remoteUrlOverride: cfg.remote,
    });
    return { res, logs, fleetApi };
}

function assertNoSecretLogged(logs, res) {
    const all = `${logs.join('\n')}\n${res.error || ''}`;
    for (const s of SECRETS) assert.ok(!all.includes(s), `a planted secret reached the log/error: ${s}\n${all}`);
}

for (const provider of Object.keys(PROVIDERS)) {
    const cfg = PROVIDERS[provider];
    describe(`${provider}: create-pull-request response mapping`, () => {
        test('203 with an HTML sign-in page -> ok:false, authFailure:true, classified as sign-in', async () => {
            const { res, logs } = await raise(provider, () => respond(203, SIGN_IN_HTML));
            assert.equal(res.ok, false, 'a sign-in page is never a created PR');
            assert.equal(res.authFailure, true);
            assert.equal(res.reason, 'pr-response-sign-in');
            assert.equal(res.prUrl, null);
            assert.match(res.error, /HTTP 203/);
            assert.match(res.error, /sign-in/);
            const line = logs.find((l) => /HTTP 203/.test(l) && /Sign In/.test(l));
            assert.ok(line, `a log line names the status and a body excerpt:\n${logs.join('\n')}`);
            assert.ok(/[\x20-\x7e]*/.test(line) && !/[^\x20-\x7e]/.test(line), 'the logged line is ASCII');
            assert.ok(!logs.some((l) => /opened PR URL/.test(l)), 'no "opened PR URL" line for a sign-in page');
            assertNoSecretLogged(logs, res);
        });

        for (const status of [200, 201]) {
            test(`${status} whose JSON lacks a PR id -> ok:false with the typed unexpected-response reason`, async () => {
                const { res, logs } = await raise(provider, () => respond(status, JSON.stringify(cfg.noId)));
                assert.equal(res.ok, false, 'never ok:true with prUrl null');
                assert.equal(res.reason, 'pr-response-unmapped');
                assert.equal(res.authFailure, false);
                assert.equal(res.prUrl, null);
                assert.match(res.error, new RegExp(`HTTP ${status}`));
                const line = logs.find((l) => new RegExp(`HTTP ${status}`).test(l) && /pr-response-unmapped/.test(l));
                assert.ok(line, `a log line names the status:\n${logs.join('\n')}`);
                assert.ok(/: \{/.test(line), `the log line carries a body excerpt: ${line}`);
                assertNoSecretLogged(logs, res);
            });
        }

        test('a normal 201 with an id -> ok:true and prUrl is the mapped URL', async () => {
            const { res, logs } = await raise(provider, () => respond(201, JSON.stringify(cfg.created)));
            assert.equal(res.ok, true);
            assert.equal(res.prUrl, cfg.prUrl);
            assert.equal(res.authFailure, false);
            assert.ok(logs.some((l) => l.includes(`opened PR URL for member 'pr-map-${provider}': ${cfg.prUrl}`)), logs.join('\n'));
        });
    });
}

describe('update path: a 2xx HTML page on find is a failure, not an empty list', () => {
    test('azure-devops already-exists, then an HTML find answer -> the update is reported as failed, not "no open PR"', async () => {
        const cfg = PROVIDERS['azure-devops'];
        const fleetApi = makeFleetApi('azure-devops', (args, n) => (n === 1
            ? respond(409, JSON.stringify({ message: 'TF401179: An active pull request for the source and target branch already exists.' }))
            : respond(203, SIGN_IN_HTML)));
        const upLogs = [];
        const up = await raiseVcsPrForMember({
            fleetApi, command: async () => ({ ok: true, output: cfg.remote, error: null }), member: 'pr-map-ado-update',
            base: 'main', head: 'feat/x', title: 't', body: 'b', log: (m) => upLogs.push(m), logPrefix: '[Publish PR]',
            remoteUrlOverride: cfg.remote, updateExisting: () => ({ body: 'new' }),
        });
        assert.equal(up.updated, false);
        assert.match(up.updateError, /HTTP 203/);
        assert.match(up.updateError, /sign-in/);
        assert.ok(!/no open pull request found/.test(up.updateError), up.updateError);
        assertNoSecretLogged(upLogs, { error: up.updateError });
    });
});
