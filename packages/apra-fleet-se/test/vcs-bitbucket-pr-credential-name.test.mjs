import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { runPublishPrPhase } from '../fleet-sprint/phases/publish-pr.mjs';
import { finalizeAbort, validateArgs } from '../fleet-sprint/runner.js';
import { validateBitbucketPrCredential } from '../fleet-sprint/sprint-args.mjs';
import { SprintPlanRejectedError } from '../fleet-sprint/errors.mjs';
import { BitbucketVCS } from '../fleet-sprint/vcs-providers/bitbucket.mjs';
import { buildRunnerArgs } from '../bin/cli.mjs';
import { buildSprintArgv, createSpawner } from '../src/supervisor/spawner.mjs';
import { createSprintController, ApiError } from '../src/supervisor/api.mjs';
import { createLedger, LEDGER_FILENAME } from '../src/supervisor/ledger.mjs';
import { createHistory, HISTORY_FILENAME } from '../src/supervisor/history.mjs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

// =============================================================================
// Per-project Bitbucket PR credential: the sprint names a credential-store
// secret (bitbucket_secret_name, NAME only) and the Atlassian account email
// (bitbucket_email); the PR is raised with that stored token, resolved
// server-side by name (vcs_credential_exec `secret`), instead of whatever
// helper is deployed on the backlog member. Two projects -> two secrets on the
// same backlog member; a missing named secret -> PR skipped naming the secret
// and the command to store it; no option -> the deployed helper, as before.
//
// No network: a fake Bitbucket + fake credential store sit behind
// vcs_credential_exec. ASCII only.
// =============================================================================

const BB_ORIGIN = 'git@bitbucket.org:acme/widgets.git';
const EMAIL = 'owner@example.invalid';

function fakeFleet({ registeredAs = 'bitbucket', store = [], helper = 'credential_read_failed', postStatus = null, echoSecret = true } = {}) {
    const state = { execArgs: [], provisionCalls: [], prs: 0 };
    let lastSecret = null;
    const respond = (status, body) => ({ content: [{ text: '' }], structuredContent: { ok: true, reason: 'ok', exitCode: 0, stdout: `${JSON.stringify(body)}\n${status}`, stderr: '', credentialSecret: echoSecret ? lastSecret : null } });
    state.callTool = async (name, toolArgs) => {
        if (name === 'member_detail') {
            return { content: [{ text: JSON.stringify({ ...(registeredAs ? { vcsProvider: registeredAs } : {}), os: 'linux', shell: '' }) }] };
        }
        if (name === 'provision_vcs_auth') {
            state.provisionCalls.push(toolArgs);
            return { content: [{ text: '[FAIL] unexpected provision' }], structuredContent: { ok: false, reason: 'credential_assembly_failed' } };
        }
        if (name === 'credential_store_list') return { content: [{ text: JSON.stringify(store.map((n) => ({ name: n }))) }] };
        if (name === 'vcs_credential_exec') {
            state.execArgs.push(toolArgs);
            lastSecret = toolArgs.secret ?? null;
            if (toolArgs.secret !== undefined) {
                // Mirrors src/tools/vcs-credential-exec.ts's secret source.
                if (!store.includes(toolArgs.secret)) {
                    return { content: [{ text: `[FAIL] The credential store has no entry named '${toolArgs.secret}'. Store it first: credential_store_set name=${toolArgs.secret} persist=true network_policy=allow` }], structuredContent: { ok: false, reason: 'secret_not_found', exitCode: null, stdout: '', stderr: '', credentialSecret: toolArgs.secret } };
                }
            } else if (helper !== 'ok') {
                return { content: [{ text: `[FAIL] helper (${helper})` }], structuredContent: { ok: false, reason: helper, exitCode: null, stdout: '', stderr: '', credentialSecret: null } };
            }
            const method = /^curl -sS -X (\w+)/.exec(toolArgs.command)[1];
            if (method === 'POST') {
                if (postStatus) return respond(postStatus, { type: 'error', error: { message: `mock HTTP ${postStatus}` } });
                state.prs += 1;
                return respond(201, { id: state.prs, links: { html: { href: `https://bitbucket.org/acme/widgets/pull-requests/${state.prs}` } } });
            }
            if (method === 'GET') return respond(200, { values: [] });
            throw new Error(`unexpected method ${method}`);
        }
        throw new Error(`unexpected tool ${name}`);
    };
    return state;
}

const remoteCommand = async (cmd) => (cmd === 'git remote get-url origin'
    ? { ok: true, output: BB_ORIGIN, error: null }
    : { ok: true, output: '', error: null });

async function publish({ fleet, member, prCredentials, targetIssues = [], commands = [] }) {
    const logs = [];
    const result = await runPublishPrPhase({
        phase: () => {},
        log: (m) => logs.push(m),
        command: async (cmd, opts) => { commands.push(cmd); return remoteCommand(cmd, opts); },
        args: { callTool: fleet.callTool, run_id: 'run-x' },
        validated: { branch: 'feat/x', baseBranch: 'main', goal: 'Ship X', runId: 'run-x', prCredentials },
        targetIssues,
        backlogMember: member,
        finalCycleLabel: '1',
        gitSync: { pushGitAfter: async () => {}, syncBeadsAfter: async () => {} },
        getMemberForRole: () => member,
        finalVerdictResult: { verdict: 'PASS', notes: 'ok' },
    });
    return { result, logs };
}

const creds = (secretName) => validateArgs({
    target_issues: ['t-1'], members: ['solo'], branch: 'feat/x', base_branch: 'main',
    bitbucket_email: EMAIL, ...(secretName ? { bitbucket_secret_name: secretName } : {}),
}).prCredentials;

describe('sprint args: bitbucket_secret_name takes a credential-store NAME only', () => {
    test('two projects -> two PR credential maps; email alone defaults to bitbucket_api_token', () => {
        assert.deepEqual(creds('bitbucket_kumaakh'), { bitbucket: { secret: 'bitbucket_kumaakh', username: EMAIL } });
        assert.deepEqual(creds('bitbucket_work'), { bitbucket: { secret: 'bitbucket_work', username: EMAIL } });
        assert.deepEqual(creds(undefined), { bitbucket: { secret: 'bitbucket_api_token', username: EMAIL } });
        assert.equal(validateBitbucketPrCredential(undefined, undefined), undefined);
    });

    for (const [label, value] of [
        ['an Atlassian API token', 'ATATT3xFfGF0SENTINEL'],
        ['an app-password-shaped value', 'Ab1cD2eF3gH4iJ5kL6mN'],
        ['an email:token pair', 'me@x.io:SENTINEL'],
        ['a value with spaces', 'not a name'],
        ['a 65-char string', 'x'.repeat(65)],
    ]) {
        test(`rejects ${label} with a typed error that never echoes it`, () => {
            assert.throws(() => validateBitbucketPrCredential(value, EMAIL), (err) => {
                assert.match(err.message, /^\[Arg Contract\] Invalid bitbucket_secret_name \(value not shown\)/);
                assert.ok(!err.message.includes(value), 'the rejected value must not be echoed');
                return true;
            });
        });
    }

    test('a secret name without an email fails loudly at arg-contract time', () => {
        assert.throws(() => validateBitbucketPrCredential('bitbucket_kumaakh', undefined), /needs bitbucket_email/);
    });

    test('a malformed email is rejected without echoing it', () => {
        assert.throws(() => validateBitbucketPrCredential(undefined, 'user:SENTINEL'), (err) => {
            assert.ok(!err.message.includes('SENTINEL'));
            return /Invalid bitbucket_email/.test(err.message);
        });
    });

    test('CLI and supervisor forward both options verbatim (names only)', () => {
        const runnerArgs = buildRunnerArgs({ targetIssues: ['t-1'], members: ['a'], branch: 'feat/x', baseBranch: 'main', bitbucketSecretName: 'bitbucket_kumaakh', bitbucketEmail: EMAIL });
        assert.equal(runnerArgs.bitbucket_secret_name, 'bitbucket_kumaakh');
        assert.equal(runnerArgs.bitbucket_email, EMAIL);
        const plain = buildRunnerArgs({ targetIssues: ['t-1'], members: ['a'], branch: 'feat/x', baseBranch: 'main' });
        assert.ok(!('bitbucket_secret_name' in plain) && !('bitbucket_email' in plain));
        const argv = buildSprintArgv({ issue: 't-1', members: 'a', branch: 'feat/x', base: 'main', viewerPort: 9000, bitbucketSecretName: 'bitbucket_kumaakh', bitbucketEmail: EMAIL });
        assert.deepEqual(argv.slice(argv.indexOf('--bitbucket-secret-name'), argv.indexOf('--bitbucket-secret-name') + 2), ['--bitbucket-secret-name', 'bitbucket_kumaakh']);
        assert.deepEqual(argv.slice(argv.indexOf('--bitbucket-email'), argv.indexOf('--bitbucket-email') + 2), ['--bitbucket-email', EMAIL]);
    });
});

describe('Publish PR: the named credential is what the PR call uses', () => {
    test('two projects on ONE backlog member raise their PRs with two different secrets, no provisioning', async () => {
        const fleet = fakeFleet({ store: ['bitbucket_kumaakh', 'bitbucket_work'] });
        const a = await publish({ fleet, member: 'shared-backlog', prCredentials: creds('bitbucket_kumaakh') });
        const b = await publish({ fleet, member: 'shared-backlog', prCredentials: creds('bitbucket_work') });
        assert.deepEqual(a.result, { pushed: true });
        assert.deepEqual(b.result, { pushed: true });
        const posts = fleet.execArgs.filter((x) => / -X POST /.test(x.command));
        assert.deepEqual(posts.map((x) => x.secret), ['bitbucket_kumaakh', 'bitbucket_work']);
        for (const p of posts) {
            assert.equal(p.username, EMAIL);
            assert.ok(!('label' in p), 'a secret-sourced call must not name a helper label');
            assert.match(p.command, /\{\{vcs_token_inline\}\}/, 'the token stays a placeholder on the orchestrator side');
        }
        assert.equal(fleet.provisionCalls.length, 0);
        assert.ok(a.logs.some((m) => m.includes("credential-store entry 'bitbucket_kumaakh'")));
    });

    test('a GitHub-registered shared supervisor raises a Bitbucket PR with the named secret, nothing provisioned', async () => {
        const fleet = fakeFleet({ registeredAs: 'github', store: ['bitbucket_kumaakh'] });
        const { result } = await publish({ fleet, member: 'gh-supervisor', prCredentials: creds('bitbucket_kumaakh') });
        assert.deepEqual(result, { pushed: true });
        assert.equal(fleet.provisionCalls.length, 0);
        assert.equal(fleet.execArgs.find((x) => / -X POST /.test(x.command)).secret, 'bitbucket_kumaakh');
    });

    test('missing named secret -> PR skipped, message names the secret and the store command, targets stay open', async () => {
        const fleet = fakeFleet({ store: [] });
        const commands = [];
        const { result, logs } = await publish({ fleet, member: 'bb-missing', prCredentials: creds('bitbucket_kumaakh'), targetIssues: ['t-1'], commands });
        assert.deepEqual(result, { pushed: true });
        const skipped = logs.find((m) => m.startsWith('[Publish PR Skipped]'));
        assert.ok(skipped, `expected a [Publish PR Skipped] line, got:\n${logs.join('\n')}`);
        assert.match(skipped, /credential-store entry 'bitbucket_kumaakh'/);
        assert.match(skipped, /credential_store_set name=bitbucket_kumaakh persist=true network_policy=allow/);
        assert.deepEqual(commands.filter((c) => c.startsWith('bd close')), [], 'an explicit but broken choice keeps targets open');
    });

    test('a 401 on the named secret is reported once with its remedy -- no re-provision, no retry', async () => {
        const fleet = fakeFleet({ store: ['bitbucket_kumaakh'], postStatus: 401 });
        const { logs } = await publish({ fleet, member: 'bb-401', prCredentials: creds('bitbucket_kumaakh') });
        assert.equal(fleet.provisionCalls.length, 0);
        assert.equal(fleet.execArgs.filter((x) => / -X POST /.test(x.command)).length, 1);
        assert.ok(logs.some((m) => m.startsWith('[Publish PR Skipped]') && m.includes('credential_store_set name=bitbucket_kumaakh')));
    });

    test('a server that does not echo the secret name (predates `secret`) fails loudly, not silently', async () => {
        const fleet = fakeFleet({ store: ['bitbucket_kumaakh'], helper: 'ok', echoSecret: false });
        const commands = [];
        const { result, logs } = await publish({ fleet, member: 'bb-old-server', prCredentials: creds('bitbucket_kumaakh'), targetIssues: ['t-1'], commands });
        assert.deepEqual(result, { pushed: true });
        assert.ok(logs.some((m) => m.startsWith('[Publish PR Skipped]') && /did not confirm it used credential-store entry 'bitbucket_kumaakh'/.test(m)));
        assert.deepEqual(commands.filter((c) => c.startsWith('bd close')), []);
        // Caught by the read-only probe: no PR is ever created under the wrong account.
        assert.equal(fleet.prs, 0);
        assert.equal(fleet.execArgs.filter((x) => / -X POST /.test(x.command)).length, 0);
    });

    test('no option: the deployed helper (label bitbucket) is read exactly as before', async () => {
        const fleet = fakeFleet({ helper: 'ok' });
        const { result } = await publish({ fleet, member: 'bb-default' });
        assert.deepEqual(result, { pushed: true });
        const post = fleet.execArgs.find((x) => / -X POST /.test(x.command));
        assert.equal(post.label, 'bitbucket');
        assert.ok(!('secret' in post) && !('username' in post));
    });

    test('[ABORTED] PR uses the same named secret', async () => {
        const fleet = fakeFleet({ store: ['bitbucket_work'] });
        const command = async (cmd, opts = {}) => {
            const out = (output) => (opts.failSoft ? { ok: true, output, error: null } : output);
            if (/^git fetch origin\b/.test(cmd)) return out('');
            if (/^git rev-list --count\b/.test(cmd)) return out('2');
            if (/^git push\b/.test(cmd)) return out('To mock-remote');
            if (/^git remote get-url origin\b/.test(cmd)) return out(BB_ORIGIN);
            throw new Error(`unexpected command '${cmd}'`);
        };
        const result = await finalizeAbort({
            error: new SprintPlanRejectedError('Plan rejected after 3 rounds', { notes: null }),
            branch: 'feat/x', baseBranch: 'main', member: 'bb-abort', command,
            log: () => {}, callTool: fleet.callTool, runId: 'run-abort', prCredentials: creds('bitbucket_work'),
        });
        assert.match(String(result.prUrl), /pull-requests\/1$/);
        assert.equal(fleet.execArgs.find((x) => / -X POST /.test(x.command)).secret, 'bitbucket_work');
    });
});

describe('supervisor POST /api/sprints: bitbucketSecretName / bitbucketEmail', () => {
    async function makeController(captured) {
        const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'bbcred-api-'));
        const ledger = createLedger({ filePath: path.join(dir, LEDGER_FILENAME), now: () => '2026-10-01T00:00:00.000Z' });
        await ledger.start();
        const history = createHistory({ filePath: path.join(dir, HISTORY_FILENAME), now: () => '2026-10-01T00:00:00.000Z' });
        await history.start();
        let nextPid = 7100;
        const spawner = createSpawner({
            basePort: 9400,
            isPortAvailable: async () => true,
            dataDir: 'fake-data-dir',
            fs: { mkdirSync() {}, openSync() { return 3; }, closeSync() {} },
            spawn: (command, args) => {
                captured.push({ command, args });
                return { pid: nextPid++, once() { return this; }, unref() {} };
            },
        });
        const controller = createSprintController({ ledger, history, spawner, listMembers: () => ({ members: [] }), getBacklog: () => ({ tasks: [] }) });
        return { controller, dir };
    }
    const LAUNCH = { issue: 'PROJ-1', members: ['alice'], branch: 'feat/x', base: 'main' };

    test('the secret name and email reach the child argv; omitted, neither flag is sent', async () => {
        const captured = [];
        const { controller, dir } = await makeController(captured);
        await controller.launch({ ...LAUNCH, bitbucketSecretName: 'bitbucket_kumaakh', bitbucketEmail: EMAIL });
        await controller.launch({ ...LAUNCH, branch: 'feat/y', issue: 'PROJ-2', members: ['bob'] });
        const [withCred, without] = captured.map((c) => c.args);
        assert.equal(withCred[withCred.indexOf('--bitbucket-secret-name') + 1], 'bitbucket_kumaakh');
        assert.equal(withCred[withCred.indexOf('--bitbucket-email') + 1], EMAIL);
        assert.ok(!without.includes('--bitbucket-secret-name') && !without.includes('--bitbucket-email'));
        await fsp.rm(dir, { recursive: true, force: true });
    });

    test('a token-shaped bitbucketSecretName is a 400 that does not echo it, and spawns nothing', async () => {
        const captured = [];
        const { controller, dir } = await makeController(captured);
        const value = 'ATATT3xFfGF0SENTINEL';
        await assert.rejects(
            () => controller.launch({ ...LAUNCH, bitbucketSecretName: value, bitbucketEmail: EMAIL }),
            (err) => err instanceof ApiError && err.status === 400 && err.field === 'bitbucketSecretName' && !err.message.includes(value),
        );
        await assert.rejects(
            () => controller.launch({ ...LAUNCH, bitbucketSecretName: 'bitbucket_kumaakh' }),
            (err) => err instanceof ApiError && err.status === 400 && err.field === 'bitbucketEmail',
        );
        assert.equal(captured.length, 0);
        await fsp.rm(dir, { recursive: true, force: true });
    });
});

describe('push preflight hook names the configured secret', () => {
    const base = { member_name: 'm', provider: 'bitbucket', git_access: 'push' };
    const repoRef = { workspace: 'acme', repo: 'widgets' };
    test('configured name is the api_token placeholder and the missing-entry error names it', () => {
        const ok = BitbucketVCS.buildProvisionArgs({ base, repoRef, availableSecrets: ['bitbucket_kumaakh'], bitbucketSecretName: 'bitbucket_kumaakh' });
        assert.equal(ok.args.api_token, '{{secret.bitbucket_kumaakh}}');
        const missing = BitbucketVCS.buildProvisionArgs({ base, repoRef, availableSecrets: [], bitbucketSecretName: 'bitbucket_kumaakh' });
        assert.match(missing.error, /no entry named 'bitbucket_kumaakh'/);
        assert.match(missing.error, /credential_store_set name=bitbucket_kumaakh/);
    });
    test('default name is unchanged without the option', () => {
        const ok = BitbucketVCS.buildProvisionArgs({ base, repoRef, availableSecrets: ['bitbucket_api_token'] });
        assert.equal(ok.args.api_token, '{{secret.bitbucket_api_token}}');
    });
});
