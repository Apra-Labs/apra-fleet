import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { createVcsAuthPreflightCallback, VCS_CREDENTIAL_PROBE_FAILED } from '../fleet-sprint/vcs-auth.mjs';
import { getSeCommands } from '../fleet-sprint/se-os-commands.mjs';

// =============================================================================
// Bitbucket preflight probes the LABELLED PR credential, not only git.
//
// `git ls-remote origin` goes through the host's whole credential helper
// chain, so another helper can answer while the fleet's provider-labelled
// helper -- the one Publish PR reads through vcs_credential_exec -- is dead.
// The preflight therefore also runs the provider's REST probe through
// vcs_credential_exec under the provider label, and checks the helper's
// username= line (read member-side; the token line never leaves the member).
// Verdict ok only if all pass. Stubbed fleet + member; no network.
// ASCII only.
// =============================================================================

const SENTINEL = 'SENTINEL-labelled-token-41b7';
const BB_REMOTE = 'https://bitbucket.org/acme/widgets.git';

const rest = (status, { headers = [], body = '{"values":[]}' } = {}) => ({
    content: [{ text: '[OK]' }],
    structuredContent: {
        ok: true, reason: 'ok', exitCode: 0, stderr: '',
        stdout: (headers.length ? `${[`HTTP/2 ${status} `, ...headers, '', body].join('\r\n')}` : body) + `\n${status}`,
    },
});
const REST_200 = rest(200);
const REST_403_REPO_TOKEN = rest(403, {
    headers: ['x-credential-type: repo_access_token', 'x-oauth-scopes: repository:write'],
    body: '{"type":"error","error":{"message":"Your credentials lack one or more required privilege scopes.","detail":{"required":["pullrequest"],"granted":["repository:write"]}}}',
});
const REST_404 = rest(404, {
    headers: ['x-credential-type: repo_access_token'],
    body: '{"type":"error","error":{"message":"Repository not found"}}',
});

/**
 * Stub fleet + member. `restQueue` answers vcs_credential_exec in order
 * (last one repeats); `lsRemote`/`username` answer the member commands.
 */
function makeHarness({ record, restQueue = [REST_200], lsRemote = { ok: true, output: 'abc\tHEAD', error: null }, usernameOutput = 'username=x-bitbucket-api-token-auth', store = ['bitbucket_api_token'], provisionResult = null, remote = BB_REMOTE }) {
    const tools = [];
    const commands = [];
    const queue = [...restQueue];
    const callTool = async (name, args) => {
        tools.push({ name, args });
        if (name === 'member_detail') return { content: [{ text: JSON.stringify(record) }] };
        if (name === 'credential_store_list') return { content: [{ text: JSON.stringify(store.map((n) => ({ name: n }))) }] };
        if (name === 'provision_vcs_auth') {
            return provisionResult || { content: [{ text: '[OK] provisioned' }], structuredContent: { ok: true, reason: 'ok', expiresAt: null } };
        }
        if (name === 'vcs_credential_exec') {
            // The orchestrator hands over a placeholder, never a token.
            assert.ok(args.command.includes('{{vcs_token_inline}}'), args.command);
            assert.ok(!args.command.includes(SENTINEL), 'no token in the dispatched command');
            const next = queue.length > 1 ? queue.shift() : queue[0];
            return next;
        }
        return { content: [{ text: '' }] };
    };
    const command = async (cmd) => {
        commands.push(cmd);
        if (cmd === 'git remote get-url origin') return { ok: true, output: remote, error: null };
        if (cmd.includes('git ls-remote origin')) return lsRemote;
        if (cmd.includes("grep '^username='")) {
            // A member-side filter that let the token line through as well:
            // the orchestrator must still read ONLY the username= line.
            return { ok: true, output: `${usernameOutput}\npassword=${SENTINEL}`, error: null };
        }
        return { ok: true, output: '', error: null };
    };
    const logs = [];
    const ensure = createVcsAuthPreflightCallback({ callTool, command, log: (m) => logs.push(m) });
    return { ensure, tools, commands, logs };
}

const LOCAL = { type: 'local', os: 'linux', shell: '', vcsProvider: 'bitbucket' };
const REMOTE = { type: 'ssh', os: 'linux', shell: '', vcsProvider: 'bitbucket' };
const errorsOf = (logs) => logs.filter((l) => l.includes(VCS_CREDENTIAL_PROBE_FAILED));
const provisionsOf = (tools) => tools.filter((t) => t.name === 'provision_vcs_auth');
const assertNoSentinel = (logs) => {
    for (const l of logs) assert.ok(!l.includes(SENTINEL), `sentinel leaked: ${l}`);
};

describe('labelled credential REST probe (local member)', () => {
    test('git ls-remote passes via another helper, labelled REST probe 403 -> failed, one ERROR line, no provision', async () => {
        const h = makeHarness({ record: LOCAL, restQueue: [REST_403_REPO_TOKEN] });
        await h.ensure('bb-local');
        await h.ensure('bb-local');
        const errors = errorsOf(h.logs);
        assert.equal(errors.length, 1, h.logs.join('\n'));
        assert.match(errors[0], /local member 'bb-local' \(provider 'bitbucket'\)/);
        assert.match(errors[0], /refused by the REST probe with HTTP 403/);
        assert.match(errors[0], /repo_access_token/);
        assert.match(errors[0], /required: pullrequest; granted: repository:write/);
        assert.equal(provisionsOf(h.tools).length, 0, 'a local member is never provisioned');
        assert.ok(h.logs.some((l) => /credential probe already failed this run/.test(l)), 'the failed verdict is cached');
        const execs = h.tools.filter((t) => t.name === 'vcs_credential_exec');
        assert.equal(execs.length, 1, 'probed once per run');
        assert.equal(execs[0].args.label, 'bitbucket', 'the provider label Publish PR reads');
        assert.match(execs[0].args.command, /^curl -sS -X GET [\s\S]* -D - 'https:\/\/api\.bitbucket\.org\/2\.0\/repositories\/acme\/widgets\/pullrequests\?pagelen=1'$/);
    });

    test('labelled REST probe 404 -> failed', async () => {
        const h = makeHarness({ record: LOCAL, restQueue: [REST_404] });
        await h.ensure('bb-local');
        const errors = errorsOf(h.logs);
        assert.equal(errors.length, 1, h.logs.join('\n'));
        assert.match(errors[0], /HTTP 404/);
        assert.match(errors[0], /cannot see repository acme\/widgets/);
    });

    test('everything passes -> ok, no ERROR, no provision', async () => {
        const h = makeHarness({ record: LOCAL });
        await h.ensure('bb-local');
        assert.equal(errorsOf(h.logs).length, 0, h.logs.join('\n'));
        assert.equal(provisionsOf(h.tools).length, 0);
        assert.ok(h.logs.some((l) => /credential works; provision_vcs_auth skipped/.test(l)), h.logs.join('\n'));
    });

    test('the local ERROR line gives the exact provision command, names the host helper rewrite and says no PR this sprint', async () => {
        const h = makeHarness({ record: LOCAL, restQueue: [REST_403_REPO_TOKEN] });
        await h.ensure('bb-local');
        const line = errorsOf(h.logs)[0];
        assert.ok(line.includes('provision_vcs_auth member_name=bb-local provider=bitbucket workspace=acme api_token={{secret.bitbucket_api_token}}'), line);
        assert.match(line, /rewrites the host's global bitbucket\.org git credential helper/);
        assert.match(line, /No PR will be opened this sprint/);
        assert.ok(!/create/i.test(line.slice(line.indexOf('Fix: '))), 'token stored: never told to create one');
        assert.ok([...line].every((ch) => ch.charCodeAt(0) < 128), line);
    });
});

describe('labelled helper username line', () => {
    test('an unresolved {{secret.*}} username is a probe failure naming the placeholder; the token line is never printed', async () => {
        const h = makeHarness({ record: LOCAL, usernameOutput: 'username={{secret.e2e_bb_user}}' });
        await h.ensure('bb-local');
        const errors = errorsOf(h.logs);
        assert.equal(errors.length, 1, h.logs.join('\n'));
        assert.match(errors[0], /unresolved placeholder literal \{\{secret\.e2e_bb_user\}\}, not x-bitbucket-api-token-auth/);
        assertNoSentinel(h.logs);
    });

    test('any other username is a failure that does NOT print the value', async () => {
        const h = makeHarness({ record: LOCAL, usernameOutput: 'username=someone@example.com' });
        await h.ensure('bb-local');
        const line = errorsOf(h.logs)[0];
        assert.ok(line, h.logs.join('\n'));
        assert.match(line, /username line is not x-bitbucket-api-token-auth/);
        assert.ok(!line.includes('someone@example.com'), line);
        assertNoSentinel(h.logs);
    });

    test('no username= line at all is a failure', async () => {
        const h = makeHarness({ record: LOCAL, usernameOutput: '' });
        await h.ensure('bb-local');
        assert.match(errorsOf(h.logs)[0] || '', /printed no username= line/);
    });
});

describe('remote member: one provision, then the REST re-probe decides', () => {
    test('failing REST probe -> exactly one provision attempt, re-probe 200 -> ok', async () => {
        const h = makeHarness({ record: REMOTE, restQueue: [REST_403_REPO_TOKEN, REST_200] });
        await h.ensure('bb-remote');
        await h.ensure('bb-remote');
        assert.equal(provisionsOf(h.tools).length, 1);
        assert.equal(h.tools.filter((t) => t.name === 'vcs_credential_exec').length, 2, 'probe + one re-probe');
        assert.equal(errorsOf(h.logs).length, 0, h.logs.join('\n'));
        assert.ok(h.logs.some((l) => /provision_vcs_auth succeeded for member 'bb-remote' after its credential probe failed/.test(l)));
    });

    test('failing REST probe -> one provision, re-probe still 403 -> failed with the re-probe reason', async () => {
        const h = makeHarness({ record: REMOTE, restQueue: [REST_403_REPO_TOKEN, REST_403_REPO_TOKEN] });
        await h.ensure('bb-remote');
        await h.ensure('bb-remote');
        assert.equal(provisionsOf(h.tools).length, 1);
        const errors = errorsOf(h.logs);
        assert.equal(errors.length, 1, h.logs.join('\n'));
        assert.match(errors[0], /provision_vcs_auth ran once, but the re-probe still fails/);
        assert.match(errors[0], /No PR will be opened this sprint/);
    });
});

describe('other providers are unchanged', () => {
    test('a local Azure DevOps member is probed with git ls-remote only: no REST probe, no username read', async () => {
        const h = makeHarness({ record: { type: 'local', os: 'linux', shell: '', vcsProvider: 'azure-devops' } });
        await h.ensure('ado-local');
        assert.equal(h.tools.filter((t) => t.name === 'vcs_credential_exec').length, 0);
        assert.ok(!h.commands.some((c) => c.includes('username=')), h.commands.join('\n'));
        assert.equal(errorsOf(h.logs).length, 0);
    });
});

describe('cross-platform probe commands', () => {
    const decode = (cmd) => {
        const m = /^powershell -EncodedCommand (\S+)$/.exec(cmd);
        assert.ok(m, `expected an encoded PowerShell envelope, got: ${cmd}`);
        return Buffer.from(m[1], 'base64').toString('utf16le');
    };

    for (const t of [
        { label: 'windows powershell', record: { ...LOCAL, os: 'windows', shell: 'powershell5' }, curl: /^curl\.exe -sS -X GET -H 'Authorization: Bearer \{\{vcs_token_inline\}\}'/ },
        { label: 'windows gitbash', record: { ...LOCAL, os: 'windows', shell: 'gitbash' }, curl: /^curl\.exe -sS -X GET -H 'Authorization: Bearer \{\{vcs_token_inline\}\}'/ },
        { label: 'mac', record: { ...LOCAL, os: 'darwin', shell: '' }, curl: /^curl -sS -X GET -H 'Authorization: Bearer \{\{vcs_token_inline\}\}'/ },
    ]) {
        test(`${t.label}: the REST probe and the username read use the member's own dialect`, async () => {
            const h = makeHarness({ record: t.record });
            await h.ensure('m');
            const exec = h.tools.find((x) => x.name === 'vcs_credential_exec');
            assert.match(exec.args.command, t.curl);
            assert.match(exec.args.command, / -D - /);
        });
    }

    test('username-read builders: posix/gitbash grep, PowerShell Where-Object, never the token line', () => {
        const posix = getSeCommands({ os: 'linux' }).readCredentialHelperUsername('bitbucket');
        assert.equal(posix.command, `"$HOME/.fleet-git-credential-bitbucket" | grep '^username='`);
        const gitbash = getSeCommands({ os: 'windows', shell: 'gitbash' }).readCredentialHelperUsername('bitbucket');
        assert.equal(gitbash.command, `"$HOME/.fleet-git-credential-bitbucket.bat" | grep '^username='`);
        const ps = decode(getSeCommands({ os: 'windows', shell: 'powershell5' }).readCredentialHelperUsername('bitbucket').command);
        assert.ok(ps.includes(`& "$env:USERPROFILE\\.fleet-git-credential-bitbucket.bat" | Where-Object { $_ -like 'username=*' }`), ps);
        assert.throws(() => getSeCommands({ os: 'linux' }).readCredentialHelperUsername('a; rm -rf /'), /unsafe VCS credential label/);
    });
});

describe('no secret value in any log line', () => {
    test('sentinel token in the helper output never reaches a log line, across every failure shape', async () => {
        for (const opts of [
            { record: LOCAL, restQueue: [REST_403_REPO_TOKEN] },
            { record: LOCAL, usernameOutput: 'username={{secret.e2e_bb_user}}' },
            { record: REMOTE, restQueue: [REST_404, REST_404] },
            { record: LOCAL },
        ]) {
            const h = makeHarness(opts);
            await h.ensure('m');
            assertNoSentinel(h.logs);
        }
    });
});

describe('an unparsable origin carrying an embedded credential', () => {
    // git prints a credentialed origin verbatim; the probe reason quotes the
    // origin when no repository can be derived from it, so its userinfo must
    // be masked before it reaches the ERROR line.
    for (const remote of [
        `https://x-token-auth:${SENTINEL}@bitbucket.org/acme`,
        `https://user:${SENTINEL}@github.com/acme/widgets.git`,
    ]) {
        test(`the ERROR line quotes the origin with its userinfo masked (${remote.replace(SENTINEL, '<token>')})`, async () => {
            const h = makeHarness({ record: LOCAL, remote });
            await h.ensure('bb-local');
            const errors = errorsOf(h.logs);
            assert.equal(errors.length, 1, h.logs.join('\n'));
            assert.match(errors[0], /no bitbucket repository could be derived from the member's origin remote 'https:\/\/\*\*\*@/);
            assert.equal(h.tools.filter((t) => t.name === 'vcs_credential_exec').length, 0, 'no REST probe without a repository');
            assertNoSentinel(h.logs);
        });
    }
});
