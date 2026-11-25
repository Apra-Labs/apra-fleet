import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';

import { runPublishPrPhase } from '../fleet-sprint/phases/publish-pr.mjs';
import { finalizeAbort } from '../fleet-sprint/runner.js';
import { raiseVcsPrForMember } from '../fleet-sprint/vcs-auth.mjs';
import { SprintPlanRejectedError } from '../fleet-sprint/errors.mjs';
import { createStagedFileRecorder, TEST_MEMBER_FOLDER } from './helpers/vcs-payload-test.mjs';

// =============================================================================
// Publishing (Publish PR) or aborting ([ABORTED] PR) a sprint must leave the
// operator's own credentials alone on every provider:
//   - Azure DevOps and Bitbucket (credential the fleet cannot mint): ZERO
//     provision_vcs_auth calls on a local AND a remote member, including
//     after an auth-classified HTTP 401 on create;
//   - GitHub App (re-mintable): the just-in-time push+pr provision still
//     happens, exactly once per PR call;
//   - a pre-seeded operator helper file and a differently-labelled
//     credential file in the (temp) HOME are byte-identical after publish
//     and after abort, and the (temp) global git config gains no
//     credential.<host>.helper key.
//
// The stubbed provision_vcs_auth DOES what a server-side provision on a local
// member can do -- rewrite the label's helper file in HOME, remove a
// differently-labelled one, and register a host-scope helper in the global
// git config -- so any provision call from the PR path shows up as a changed
// file, not just as a call count. HOME, USERPROFILE and GIT_CONFIG_GLOBAL
// point at a fresh temp directory for every test; real credentials are never
// read or written.
//
// ASCII only.
// =============================================================================

const REMOTES = {
    github: 'https://github.com/acme/widgets.git',
    bitbucket: 'https://bitbucket.org/acme/widgets.git',
    'azure-devops': 'https://dev.azure.com/acme/proj/_git/widgets',
};
const HOSTS = { github: 'github.com', bitbucket: 'bitbucket.org', 'azure-devops': 'dev.azure.com' };
const CREATED = {
    github: { number: 42, html_url: 'https://github.com/acme/widgets/pull/42' },
    bitbucket: { id: 9, links: { html: { href: 'https://bitbucket.org/acme/widgets/pull-requests/9' } } },
    'azure-devops': { pullRequestId: 7 },
};
const PR_URLS = {
    github: 'https://github.com/acme/widgets/pull/42',
    bitbucket: 'https://bitbucket.org/acme/widgets/pull-requests/9',
    'azure-devops': 'https://dev.azure.com/acme/proj/_git/widgets/pullrequest/7',
};

const saved = {};
let home;
let gitConfig;
let operatorHelper;
let otherLabel;

function sha(file) {
    return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

function gitGlobal(args) {
    try {
        return execFileSync('git', ['config', '--global', ...args], {
            encoding: 'utf8', env: { ...process.env, HOME: home, USERPROFILE: home, GIT_CONFIG_GLOBAL: gitConfig },
        });
    } catch (err) {
        if (err && err.status === 1) return ''; // no matching key
        throw err;
    }
}

function helperKeys() {
    return gitGlobal(['--get-regexp', '^credential\\..*\\.helper$']).trim();
}

function snapshot() {
    return { operator: sha(operatorHelper), other: sha(otherLabel), config: sha(gitConfig), keys: helperKeys() };
}

beforeEach(() => {
    for (const k of ['HOME', 'USERPROFILE', 'GIT_CONFIG_GLOBAL']) saved[k] = process.env[k];
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'pr-path-no-reprov-'));
    gitConfig = path.join(home, '.gitconfig');
    process.env.HOME = home;
    process.env.USERPROFILE = home;
    process.env.GIT_CONFIG_GLOBAL = gitConfig;
    fs.writeFileSync(gitConfig, '[user]\n\tname = Operator\n');
    // The operator's own helper (same label the fleet uses) and an
    // org-scoped credential stored under a different label.
    operatorHelper = path.join(home, '.fleet-git-credential-azure-devops');
    otherLabel = path.join(home, '.fleet-git-credential-ado-org-scoped');
    fs.writeFileSync(operatorHelper, '#!/bin/sh\necho username=operator\necho password=OPERATOR-OWN-PAT\n', { mode: 0o700 });
    fs.writeFileSync(otherLabel, '#!/bin/sh\necho username=operator\necho password=ORG-SCOPED-PAT\n', { mode: 0o700 });
});

afterEach(() => {
    for (const [k, v] of Object.entries(saved)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
    }
    fs.rmSync(home, { recursive: true, force: true });
});

/**
 * REST-level fake of one provider behind vcs_credential_exec, plus a
 * provision_vcs_auth stub that rewrites credentials in the temp HOME the way
 * a host-scope provision on a local member would.
 */
function fakeFleet(provider, { memberType = 'local', createStatuses = [201] } = {}) {
    const staged = createStagedFileRecorder();
    const state = { provision: [], creates: 0 };
    const respond = (status, body) => ({
        content: [{ text: '' }],
        structuredContent: { ok: true, reason: 'ok', exitCode: 0, stdout: `${JSON.stringify(body)}\n${status}`, stderr: '' },
    });
    state.exec = (cmd) => {
        const method = /^curl(?:\.exe)? -sS -X (\w+)/.exec(cmd)[1];
        if (method === 'POST' && !/comments|threads/.test(cmd)) {
            const status = createStatuses[Math.min(state.creates, createStatuses.length - 1)];
            state.creates++;
            if (status === 401) return respond(401, { message: 'Bad credentials', error: { message: 'Unauthorized' } });
            return respond(201, CREATED[provider]);
        }
        if (method === 'GET') return respond(200, provider === 'github' ? [] : provider === 'bitbucket' ? { values: [] } : { value: [] });
        throw new Error(`fake ${provider}: unexpected ${cmd}`);
    };
    state.callTool = async (name, args) => {
        if (name === 'member_detail') {
            return { content: [{ text: JSON.stringify({ vcsProvider: provider, os: 'linux', shell: '', folder: TEST_MEMBER_FOLDER, type: memberType }) }] };
        }
        if (name === 'send_files') return staged.record(args);
        if (name === 'credential_store_list') {
            return { content: [{ text: JSON.stringify([{ name: 'azdevops_pat' }, { name: 'bitbucket_api_token' }]) }] };
        }
        if (name === 'provision_vcs_auth') {
            state.provision.push(args);
            // What a host-scope provision on a local member can do.
            const label = args.label || args.provider;
            fs.writeFileSync(path.join(home, `.fleet-git-credential-${label}`), '#!/bin/sh\necho password=FLEET-REDEPLOYED\n');
            fs.rmSync(otherLabel, { force: true });
            fs.writeFileSync(otherLabel, '');
            gitGlobal([`credential.https://${HOSTS[provider]}.helper`, `!${path.join(home, `.fleet-git-credential-${label}`)}`]);
            return { content: [{ text: 'ok' }], structuredContent: { ok: true, expiresAt: null } };
        }
        if (name === 'vcs_credential_exec') return state.exec(args.command);
        throw new Error(`unexpected tool ${name}`);
    };
    state.command = async (cmd, opts = {}) => {
        const out = (output) => (opts.failSoft ? { ok: true, output, error: null } : output);
        if (/^git remote get-url origin\b/.test(cmd)) return out(REMOTES[provider]);
        if (/^git rev-list --count\b/.test(cmd)) return out('2');
        if (/^git push\b/.test(cmd)) return out('To mock-remote');
        return out('');
    };
    return state;
}

async function publish(fake) {
    const logs = [];
    const result = await runPublishPrPhase({
        phase: () => {},
        log: (m) => logs.push(m),
        command: fake.command,
        args: { callTool: fake.callTool, run_id: 'run-1' },
        validated: { branch: 'feat/x', baseBranch: 'main', goal: 'Ship X', runId: 'run-1' },
        targetIssues: [],
        backlogMember: 'pub',
        finalCycleLabel: '1',
        gitSync: { pushGitAfter: async () => {}, syncBeadsAfter: async () => {} },
        getMemberForRole: () => 'pub',
        finalVerdictResult: { verdict: 'PASS', notes: 'All acceptance criteria met.' },
    });
    return { result, logs };
}

async function abort(fake) {
    const logs = [];
    const result = await finalizeAbort({
        error: new SprintPlanRejectedError('Plan rejected after 3 rounds', { notes: null }),
        branch: 'feat/x', baseBranch: 'main', member: 'pub', command: fake.command,
        log: (m) => logs.push(m), callTool: fake.callTool, runId: 'run-abort',
    });
    return { result, logs };
}

function assertUntouched(before, what) {
    const now = snapshot();
    assert.equal(now.operator, before.operator, `${what}: the operator's own helper file changed`);
    assert.equal(now.other, before.other, `${what}: the differently-labelled credential file changed`);
    assert.equal(now.config, before.config, `${what}: the global git config changed`);
    assert.equal(now.keys, before.keys, `${what}: a credential.<host>.helper key was added: ${now.keys}`);
    assert.ok(!/credential\.https:\/\/(dev\.azure\.com|bitbucket\.org)\.helper/.test(now.keys), `${what}: a host-scope helper key is registered: ${now.keys}`);
}

for (const provider of ['azure-devops', 'bitbucket']) {
    for (const memberType of ['local', 'remote']) {
        describe(`${provider}, ${memberType} member: the PR path never provisions`, () => {
            test('Publish PR opens the PR with zero provision_vcs_auth calls and leaves every credential byte-identical', async () => {
                const snap = snapshot();
                const fake = fakeFleet(provider, { memberType });
                const { result, logs } = await publish(fake);
                assertUntouched(snap, 'after publish');
                assert.deepEqual(fake.provision, [], `no provision_vcs_auth call: ${JSON.stringify(fake.provision)}`);
                assert.equal(result.pushed, true);
                assert.ok(!result.prSkipped, JSON.stringify(result));
                assert.ok(logs.some((l) => l.includes(`opened PR URL for member 'pub': ${PR_URLS[provider]}`)), logs.join('\n'));
            });

            test('[ABORTED] PR opens with zero provision_vcs_auth calls and leaves every credential byte-identical', async () => {
                const snap = snapshot();
                const fake = fakeFleet(provider, { memberType });
                const { result } = await abort(fake);
                assertUntouched(snap, 'after abort');
                assert.deepEqual(fake.provision, [], `no provision_vcs_auth call: ${JSON.stringify(fake.provision)}`);
                assert.equal(result.reason, 'aborted-pr-created');
                assert.equal(result.prUrl, PR_URLS[provider]);
            });

            test('an auth-classified HTTP 401 on create is reported, not healed by a provision call', async () => {
                const snap = snapshot();
                const fake = fakeFleet(provider, { memberType, createStatuses: [401, 201] });
                const res = await raiseVcsPrForMember({
                    fleetApi: apiFor(fake), command: fake.command, member: 'pub', base: 'main', head: 'feat/x',
                    title: 't', body: 'b', logPrefix: '[Publish PR]', remoteUrlOverride: REMOTES[provider],
                });
                assert.equal(res.ok, false);
                assert.equal(res.authFailure, true);
                assert.match(res.error, /401/);
                assert.deepEqual(fake.provision, [], `no self-heal provision after a 401: ${JSON.stringify(fake.provision)}`);
                assert.equal(fake.creates, 1, 'no retry with the same credential');

                const pub = fakeFleet(provider, { memberType, createStatuses: [401] });
                const { result } = await publish(pub);
                assert.deepEqual(pub.provision, []);
                assert.equal(result.prSkipped && result.prSkipped.reason, 'auth-failure');

                const ab = fakeFleet(provider, { memberType, createStatuses: [401] });
                const aborted = await abort(ab);
                assert.deepEqual(ab.provision, []);
                assert.equal(aborted.result.reason, 'pr-auth-failed');
                assertUntouched(snap, 'after a 401');
            });
        });
    }
}

/** The ApraFleet-shaped methods raiseVcsPrForMember reads, over callTool. */
function apiFor(fake) {
    const call = (name) => (args) => fake.callTool(name, args);
    return {
        memberDetail: call('member_detail'),
        provisionVcsAuth: call('provision_vcs_auth'),
        credentialStoreList: call('credential_store_list'),
        sendFiles: call('send_files'),
        vcsCredentialExec: call('vcs_credential_exec'),
    };
}

describe('github (GitHub App, re-mintable): the just-in-time push+pr provision is unchanged', () => {
    test('Publish PR provisions push+pr exactly once before the create', async () => {
        const fake = fakeFleet('github');
        const { logs } = await publish(fake);
        assert.equal(fake.provision.length, 1, JSON.stringify(fake.provision));
        assert.equal(fake.provision[0].git_access, 'push+pr');
        assert.equal(fake.provision[0].provider, 'github');
        assert.ok(logs.some((l) => l.includes(`opened PR URL for member 'pub': ${PR_URLS.github}`)), logs.join('\n'));
    });

    test('[ABORTED] PR provisions push+pr exactly once before the create', async () => {
        const fake = fakeFleet('github');
        const { result } = await abort(fake);
        assert.equal(fake.provision.length, 1, JSON.stringify(fake.provision));
        assert.equal(fake.provision[0].git_access, 'push+pr');
        assert.equal(result.reason, 'aborted-pr-created');
    });

    test('a 401 on create still re-provisions once and retries (self-heal unchanged)', async () => {
        const fake = fakeFleet('github', { createStatuses: [401, 201] });
        const res = await raiseVcsPrForMember({
            fleetApi: apiFor(fake), command: fake.command, member: 'pub', base: 'main', head: 'feat/x',
            title: 't', body: 'b', logPrefix: '[Publish PR]', remoteUrlOverride: REMOTES.github,
        });
        assert.equal(res.ok, true);
        assert.equal(fake.provision.length, 2);
        assert.ok(fake.provision.every((a) => a.git_access === 'push+pr'));
    });
});
