// The VCS credential health check (preflight) judges a credential by whether
// it WORKS, per channel, never by the shape of its username:
//   git channel -- git ls-remote origin through ONLY the fleet-labelled helper
//                  (host helper chain reset), non-interactive;
//   PR channel  -- the provider's REST probe through vcs_credential_exec.
// "No PR will be opened" is predicted only when the PR channel fails; a
// helper username other than the provider's preferred one is one WARN.
// Azure DevOps gets the same REST probe (a repository GET), so a missing or
// wrong PAT fails at Sprint Setup naming the secret.
//
// Drives createVcsAuthPreflightCallback with a stubbed fleet (callTool) and a
// stubbed member (command) that models the member's helper files: the
// labelled git probe answers only from the labelled helper the command names,
// while the host-chain probe answers from a host credential manager. One test
// runs real git against a temp HOME / GIT_CONFIG_GLOBAL to prove the built
// probe does not consult the host helper chain. No network; no file written
// outside a temp sandbox. ASCII only.
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createVcsAuthPreflightCallback, VCS_CREDENTIAL_PROBE_FAILED } from '../fleet-sprint/vcs-auth.mjs';
import { getSeCommands } from '../fleet-sprint/se-os-commands.mjs';

const SENTINEL = 'SENTINEL-by-function-token-7c2d';
const BQ = String.fromCharCode(96);
const BB_REMOTE = 'https://bitbucket.org/acme/widgets.git';
const ADO_REMOTE = 'https://dev.azure.com/example-org/Example%20Project/_git/example-repo';
const HOMES = { posix: '/home/dev', gitbash: 'C:/Users/dev', powershell: 'C:\\Users\\dev' };

const rest = (status, body = '{"values":[]}') => ({
    content: [{ text: '[OK]' }],
    structuredContent: { ok: true, reason: 'ok', exitCode: 0, stderr: '', stdout: `${body}\n${status}` },
});
const REST_200 = rest(200);
const REST_401 = rest(401, '');
const ADO_REPO_200 = rest(200, '{"id":"1f2e","name":"example-repo"}');
const ADO_SIGN_IN_203 = rest(203, '<!DOCTYPE html><html><head><title>Sign In</title></head><body>Sign in to your account</body></html>');
const NO_HELPER = { content: [{ text: '[FAIL]' }], structuredContent: { ok: false, reason: 'no_credential', exitCode: null, stdout: '', stderr: '' } };

const decodePs = (cmd) => {
    const m = /^powershell -EncodedCommand (\S+)$/.exec(cmd);
    return m ? Buffer.from(m[1], 'base64').toString('utf16le') : null;
};
/** The command text as the member shell reads it (PowerShell decoded). */
const plain = (cmd) => decodePs(cmd) ?? cmd;

/**
 * Stub fleet + member.
 *  helper    -- the labelled helper file on the member: null (absent) or
 *               { username, accepted } (accepted: does the git host take it).
 *  hostAnswers -- a host credential manager answers git for this host.
 */
function makeHarness({
    record,
    remote = BB_REMOTE,
    helper = { username: 'x-bitbucket-api-token-auth', accepted: true },
    hostAnswers = true,
    restQueue = [REST_200],
    store = ['bitbucket_api_token'],
    provisionResult = null,
    azdevopsPatSecretName,
    now,
}) {
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
            assert.ok(args.command.includes('{{vcs_token_inline}}'), args.command);
            if (!helper) return NO_HELPER;
            return queue.length > 1 ? queue.shift() : queue[0];
        }
        return { content: [{ text: '' }] };
    };
    const command = async (cmd) => {
        commands.push(cmd);
        const text = plain(cmd);
        if (cmd === 'git remote get-url origin') return { ok: true, output: remote, error: null };
        if (text.includes(`printf '%s' "$HOME"`) || text.includes('cygpath -m "$HOME"')) return { ok: true, output: record.shell === 'gitbash' ? HOMES.gitbash : HOMES.posix, error: null };
        if (text.includes('[Console]::Out.Write($env:USERPROFILE)')) return { ok: true, output: HOMES.powershell, error: null };
        if (text.includes('ls-remote origin HEAD')) {
            // Labelled probe: helper list reset, then only the named helper.
            if (text.includes('credential.helper=!')) {
                const ok = !!(helper && helper.accepted);
                return ok
                    ? { ok: true, output: 'abc\tHEAD', error: null }
                    : { ok: false, output: '', error: helper ? "remote: Invalid credentials\nfatal: Authentication failed for 'https://bitbucket.org/acme/widgets.git/'" : "fatal: could not read Username for 'https://bitbucket.org': terminal prompts disabled" };
            }
            // Host-chain probe: whatever helper the host has answers.
            return hostAnswers ? { ok: true, output: 'abc\tHEAD', error: null } : { ok: false, output: '', error: 'fatal: Authentication failed' };
        }
        if (text.includes('username=')) {
            if (!helper) return { ok: false, output: '', error: 'helper not found' };
            return { ok: true, output: `username=${helper.username}\npassword=${SENTINEL}`, error: null };
        }
        return { ok: true, output: '', error: null };
    };
    const logs = [];
    const ensure = createVcsAuthPreflightCallback({ callTool, command, log: (m) => logs.push(m), azdevopsPatSecretName, ...(now ? { now } : {}) });
    return { ensure, tools, commands, logs };
}

const BB_LOCAL = { type: 'local', os: 'linux', shell: '', vcsProvider: 'bitbucket' };
const ADO_LOCAL = { type: 'local', os: 'linux', shell: '', vcsProvider: 'azure-devops' };
const errorsOf = (logs) => logs.filter((l) => l.includes(VCS_CREDENTIAL_PROBE_FAILED));
const warnsOf = (logs) => logs.filter((l) => /preflight: WARN /.test(l));
const noPrOf = (logs) => logs.filter((l) => /No PR will be opened/.test(l));
const labelledProbes = (commands) => commands.filter((c) => plain(c).includes('ls-remote origin HEAD') && plain(c).includes('credential.helper=!'));
const assertNoSentinel = (logs) => {
    for (const l of logs) assert.ok(!l.includes(SENTINEL), `sentinel leaked: ${l}`);
};

describe('case 1: a fleet-written legacy helper with the account login as username, both channels working', () => {
    test('no ERROR, no No-PR prediction, no cached failed verdict, exactly one WARN naming the username', async () => {
        const h = makeHarness({ record: BB_LOCAL, helper: { username: 'jdoe-login', accepted: true } });
        for (let i = 0; i < 3; i += 1) await h.ensure('bb-local');
        assert.equal(errorsOf(h.logs).length, 0, h.logs.join('\n'));
        assert.equal(noPrOf(h.logs).length, 0, h.logs.join('\n'));
        assert.ok(h.logs.some((l) => /credential works; provision_vcs_auth skipped/.test(l)), h.logs.join('\n'));
        assert.ok(h.logs.some((l) => /already passed this run's probe/.test(l)), 'the cached verdict is ok, not failed');
        assert.ok(!h.logs.some((l) => /already failed/.test(l)), h.logs.join('\n'));
        const warns = warnsOf(h.logs);
        assert.equal(warns.length, 1, h.logs.join('\n'));
        assert.match(warns[0], /username line other than x-bitbucket-api-token-auth/);
        assert.match(warns[0], /re-provision/);
        assert.ok(!warns[0].includes('jdoe-login'), 'the username value is not printed');
        assert.ok(!h.logs.some((l) => /written by something other than provision_vcs_auth/.test(l)), h.logs.join('\n'));
        assert.equal(h.tools.filter((t) => t.name === 'provision_vcs_auth').length, 0);
        assertNoSentinel(h.logs);
    });
});

describe('case 2: a labelled helper whose email username git rejects', () => {
    test('git-channel ERROR; the PR channel is judged separately (REST ok -> no No-PR line)', async () => {
        const h = makeHarness({ record: BB_LOCAL, helper: { username: 'someone@example.com', accepted: false } });
        await h.ensure('bb-local');
        const errors = errorsOf(h.logs);
        assert.equal(errors.length, 1, h.logs.join('\n'));
        assert.match(errors[0], /failed the git ls-remote probe through only the fleet-written .* helper \(git through the host's own credential chain was not checked\)/);
        assert.ok(!/PR \(REST API\) channel/.test(errors[0]), errors[0]);
        assert.match(errors[0], /git ls-remote origin through only the fleet-written 'bitbucket' helper \(\/home\/dev\/\.fleet-git-credential-bitbucket\) failed: .*Authentication failed/);
        assert.equal(noPrOf(h.logs).length, 0, h.logs.join('\n'));
        assert.ok(!errors[0].includes('someone@example.com'), errors[0]);
        assert.ok(!errors[0].includes('written by something other than provision_vcs_auth'), errors[0]);
        assertNoSentinel(h.logs);
    });
});

describe('case 3: the REST probe fails', () => {
    test('the No-PR prediction is logged exactly once across several dispatches', async () => {
        const h = makeHarness({ record: BB_LOCAL, restQueue: [REST_401] });
        for (let i = 0; i < 4; i += 1) await h.ensure('bb-local');
        assert.equal(noPrOf(h.logs).length, 1, h.logs.join('\n'));
        const errors = errorsOf(h.logs);
        assert.equal(errors.length, 1);
        assert.match(errors[0], /failed the PR \(REST API\) channel check/);
        assert.match(errors[0], /refused by the REST probe with HTTP 401/);
        assert.equal(h.tools.filter((t) => t.name === 'vcs_credential_exec').length, 1, 'probed once per run');
    });
});

describe('case 4: a host credential manager answers git but the labelled helper is absent', () => {
    test('the labelled git probe fails (host chain not consulted) and the PR channel fails', async () => {
        const h = makeHarness({ record: BB_LOCAL, helper: null, hostAnswers: true });
        await h.ensure('bb-local');
        assert.ok(!h.commands.some((c) => plain(c).includes('ls-remote origin HEAD') && !plain(c).includes('credential.helper=!')), 'the host-chain probe is never run');
        const errors = errorsOf(h.logs);
        assert.equal(errors.length, 1, h.logs.join('\n'));
        assert.match(errors[0], /failed the git ls-remote probe .*and PR \(REST API\) probe/);
        assert.match(errors[0], /terminal prompts disabled/);
        assert.match(errors[0], /vcs_credential_exec reason: no_credential/);
        assert.equal(noPrOf(h.logs).length, 1);
    });

    describe('the built POSIX probe, run by real git, never reaches the host helper chain', { skip: process.platform === 'win32' }, () => {
        let sandbox;
        let env;
        before(() => {
            sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'by-function-'));
            const home = path.join(sandbox, 'home');
            fs.mkdirSync(home);
            const hostHelper = path.join(sandbox, 'host-helper.sh');
            fs.writeFileSync(hostHelper, '#!/bin/sh\necho username=host-user\necho password=HOST-SECRET\n');
            fs.chmodSync(hostHelper, 0o755);
            const gitconfig = path.join(sandbox, 'gitconfig');
            fs.writeFileSync(gitconfig, `[credential]\n\thelper = ${hostHelper}\n[credential "https://bitbucket.org"]\n\thelper = ${hostHelper}\n`);
            env = {
                PATH: process.env.PATH,
                HOME: home,
                USERPROFILE: home,
                GIT_CONFIG_GLOBAL: gitconfig,
                GIT_CONFIG_NOSYSTEM: '1',
                XDG_CONFIG_HOME: path.join(home, '.config'),
            };
        });
        after(() => {
            fs.rmSync(sandbox, { recursive: true, force: true });
        });

        // `git credential fill` exercises exactly the helper list the probe
        // sets up, without a network remote: same -c arguments, same env.
        const fill = (home) => {
            const built = getSeCommands({ os: 'linux' }).gitLsRemoteLabelledProbe('bitbucket', undefined, home);
            assert.ok(built.command.endsWith(' ls-remote origin HEAD'), built.command);
            const script = built.command.replace(/ ls-remote origin HEAD$/, ' credential fill');
            return spawnSync('/bin/sh', ['-c', script], { env, input: 'protocol=https\nhost=bitbucket.org\n\n', encoding: 'utf8' });
        };

        test('labelled helper absent: git fails non-interactively and the host helper never answers', () => {
            const res = fill(env.HOME);
            assert.notEqual(res.status, 0, res.stdout);
            assert.ok(!res.stdout.includes('HOST-SECRET'), res.stdout);
            assert.match(res.stderr, /terminal prompts disabled/);
            // Control: the same host chain DOES answer plain git.
            const control = execFileSync('git', ['credential', 'fill'], { env: { ...env, GIT_TERMINAL_PROMPT: '0' }, input: 'protocol=https\nhost=bitbucket.org\n\n', encoding: 'utf8' });
            assert.ok(control.includes('HOST-SECRET'), control);
        });

        test('labelled helper present: only the fleet helper answers', () => {
            const file = path.join(env.HOME, '.fleet-git-credential-bitbucket');
            fs.writeFileSync(file, '#!/bin/sh\necho username=x-bitbucket-api-token-auth\necho password=FLEET-SECRET\n');
            fs.chmodSync(file, 0o700);
            const res = fill(env.HOME);
            assert.equal(res.status, 0, res.stderr);
            assert.ok(res.stdout.includes('password=FLEET-SECRET'), res.stdout);
            assert.ok(!res.stdout.includes('HOST-SECRET'), res.stdout);
        });
    });
});

describe('case 5: Azure DevOps member -- the REST repository probe runs at Sprint Setup', () => {
    test('a working PAT passes both channels with a repository GET; no username judgement', async () => {
        const h = makeHarness({ record: ADO_LOCAL, remote: ADO_REMOTE, restQueue: [ADO_REPO_200], store: ['azdevops_pat'], helper: { username: '', accepted: true } });
        await h.ensure('ado');
        const execs = h.tools.filter((t) => t.name === 'vcs_credential_exec');
        assert.equal(execs.length, 1);
        assert.equal(execs[0].args.label, 'azure-devops');
        assert.match(execs[0].args.command, /GET -u ':\{\{vcs_token_inline\}\}' [\s\S]*\/_apis\/git\/repositories\/example-repo\?api-version=7\.1'$/);
        assert.equal(errorsOf(h.logs).length, 0, h.logs.join('\n'));
        assert.equal(warnsOf(h.logs).length, 0, h.logs.join('\n'));
    });

    test('a missing secret fails with a line naming the secret and the org', async () => {
        const h = makeHarness({ record: ADO_LOCAL, remote: ADO_REMOTE, helper: null, store: [] });
        await h.ensure('ado');
        const errors = errorsOf(h.logs);
        assert.equal(errors.length, 1, h.logs.join('\n'));
        assert.match(errors[0], /the credential store has no PAT secret named azdevops_pat/);
        assert.match(errors[0], /credential_store_set name=azdevops_pat/);
        assert.match(errors[0], /org_url=https:\/\/dev\.azure\.com\/example-org pat=\{\{secret\.azdevops_pat\}\}/);
    });

    test('a wrong PAT (HTTP 401) fails with a line naming the configured secret', async () => {
        const h = makeHarness({ record: ADO_LOCAL, remote: ADO_REMOTE, restQueue: [REST_401], store: ['team_ado_pat'], azdevopsPatSecretName: 'team_ado_pat', helper: { username: '', accepted: true } });
        await h.ensure('ado');
        const errors = errorsOf(h.logs);
        assert.equal(errors.length, 1, h.logs.join('\n'));
        assert.match(errors[0], /refused by the REST probe with HTTP 401/);
        assert.match(errors[0], /stored PAT secret team_ado_pat/);
        assert.match(errors[0], /No PR will be opened/);
    });

    test('a wrong PAT answered with HTTP 203 and an HTML sign-in body fails, never passes', async () => {
        const h = makeHarness({ record: ADO_LOCAL, remote: ADO_REMOTE, restQueue: [ADO_SIGN_IN_203], store: ['azdevops_pat'], helper: { username: '', accepted: true } });
        await h.ensure('ado');
        const errors = errorsOf(h.logs);
        assert.equal(errors.length, 1, h.logs.join('\n'));
        assert.match(errors[0], /HTTP 203: the answer is an HTML sign-in page/);
        assert.match(errors[0], /PAT secret azdevops_pat/);
        assert.ok(!h.logs.some((l) => /credential works/.test(l)), h.logs.join('\n'));
    });
});

describe('case 6: the skipped-after-probe line is logged once per run, not once per dispatch', () => {
    for (const [name, opts, re] of [
        ['failed probe', { restQueue: [REST_401] }, /credential probe already failed this run/],
        ['passed probe', {}, /already passed this run's probe/],
    ]) {
        test(`${name}: N=5 dispatches -> exactly one skipped line`, async () => {
            const h = makeHarness({ record: BB_LOCAL, ...opts });
            for (let i = 0; i < 5; i += 1) await h.ensure('bb-local');
            assert.equal(h.logs.filter((l) => re.test(l)).length, 1, h.logs.join('\n'));
            assert.equal(h.logs.filter((l) => /provision_vcs_auth skipped for member 'bb-local'/.test(l) && /this run/.test(l)).length, 1, h.logs.join('\n'));
        });
    }
});

describe('case 7: the git probe command is built per member OS and shell, with no shell expansion', () => {
    for (const [name, rec, home, suffix] of [
        ['posix', { ...BB_LOCAL, os: 'linux', shell: '' }, HOMES.posix, ''],
        ['gitbash', { ...BB_LOCAL, os: 'windows', shell: 'gitbash' }, HOMES.gitbash, '.bat'],
        ['powershell', { ...BB_LOCAL, os: 'windows', shell: 'powershell5' }, 'C:/Users/dev', '.bat'],
    ]) {
        test(`${name}: the recorded probe names only the labelled helper and has no $, ~/ or backtick`, async () => {
            const h = makeHarness({ record: rec });
            await h.ensure('m');
            const probes = labelledProbes(h.commands);
            assert.equal(probes.length, 1, h.commands.join('\n'));
            let text = plain(probes[0]);
            if (name === 'powershell') {
                assert.ok(probes[0].startsWith('powershell -EncodedCommand '), probes[0]);
                // The builder's own script, without the shared envelope.
                text = /try \{ ([\s\S]*); if \(\$LASTEXITCODE/.exec(text)[1];
            } else {
                assert.ok(!probes[0].startsWith('powershell'), probes[0]);
            }
            assert.ok(text.includes(`${home}/.fleet-git-credential-bitbucket${suffix}`), text);
            assert.ok(!text.includes('$'), text);
            assert.ok(!text.includes('~/'), text);
            assert.ok(!text.includes(BQ), text);
        });
    }
});

describe('regression: GitHub App members keep the expiry-based path', () => {
    test('an expiring GitHub App credential is provisioned on every call and never probed', async () => {
        const expiring = { content: [{ text: 'ok' }], structuredContent: { ok: true, reason: 'ok', expiresAt: new Date(Date.now() + 5 * 60 * 1000).toISOString() } };
        const h = makeHarness({
            record: { type: 'local', os: 'linux', shell: '', vcsProvider: 'github' },
            remote: 'https://github.com/acme/widgets.git',
            provisionResult: expiring,
        });
        await h.ensure('gh');
        await h.ensure('gh');
        assert.equal(h.tools.filter((t) => t.name === 'provision_vcs_auth').length, 2);
        assert.ok(!h.commands.some((c) => plain(c).includes('ls-remote')), h.commands.join('\n'));
        assert.equal(h.tools.filter((t) => t.name === 'vcs_credential_exec').length, 0);
    });
});
