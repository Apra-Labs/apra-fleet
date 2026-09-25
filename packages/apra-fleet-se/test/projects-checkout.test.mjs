import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'url';

import { isNodeSqliteAvailable, openStore } from '../src/projects/store/db.mjs';
import { createProject } from '../src/projects/store/projects.mjs';
import { getMemberGit } from '../src/projects/store/member-git.mjs';
import { OWNER_PACKAGE, BEADS_DIR_ENV } from '../src/projects/projects.mjs';
import { suggestCheckoutName, originSlugFromUrl } from '../src/projects/checkout.mjs';
import { createSupervisor } from '../src/supervisor/server.mjs';
import { registerProjectRoutes } from '../src/projects/routes/projects.mjs';
import { findShellCommandViolations, checkShellCommandPath, formatShellCommandViolation } from '../fleet-sprint/shell-command-guard.mjs';

// =============================================================================
// apra-fleet-vcnl.2.2 -- coverage for src/projects/checkout.mjs's
// suggestCheckoutName() (DQ-16) and addCheckout() (the five-step A10 flow),
// driven through the SAME supervisor.handleRequest harness projects-bind.
// test.mjs uses (mockReq/mockRes, no real HTTP listener), plus direct unit
// tests of the pure naming function.
//
// The fake client models a small shared filesystem: `clonedAt` tracks "what
// origin is checked out at this absolute path", keyed by path alone (not by
// member name) -- the clone step's `git clone` runs ON the sibling machine,
// and the newly REGISTERED member is a distinct registry entry pointing at
// the SAME host/folder, so a later self-probe (member_git_status with no
// explicit folder, resolved against the member's own registered work_folder)
// must see the same on-disk state the clone step just created. This mirrors
// how member_git_status/execute_command behave against one physical machine
// shared by two registry entries.
//
// registerMember is called with an `owner` field (checkout.mjs's own
// registerStep sets it), but the fake deliberately does NOT copy it onto the
// registry record -- only member_owner (called by ../projects.mjs's
// bindMember, via checkout.mjs's bindStep) actually flips a record's `owner`
// as far as listMembers reports it. Without this, bindStep's "already bound"
// check would see the just-registered member as already owned and skip step
// 4 on every fresh run, contradicting the fresh-run case's requirement that
// bind reports 'done'.
// =============================================================================

const HAS_SQLITE = isNodeSqliteAvailable();
const skip = HAS_SQLITE ? false : 'node:sqlite is unavailable on this Node runtime';

const CHECKOUT_SRC_PATH = path.join(
    path.dirname(fileURLToPath(import.meta.url)),
    '../src/projects/checkout.mjs',
);

/**
 * The AUTHORITATIVE originSlugFromUrl. member_git_status computes the slug
 * server-side with this copy; ../src/projects/checkout.mjs only mirrors it so
 * the clone step's idempotency probe can compare like with like. See section
 * 11's drift guard.
 */
const PROBE_SRC_PATH = path.join(
    path.dirname(fileURLToPath(import.meta.url)),
    '../../../src/services/git-status-probe.ts',
);

/** @type {Array<{close: () => void}>} */
const openStores = [];
after(() => {
    for (const s of openStores) {
        try { s.close(); } catch { /* best-effort */ }
    }
});

/** Every member-bound command string recorded by any fake client across every case below. */
const ALL_RECORDED_COMMANDS = [];

// -- mockReq/mockRes/payloadOf -- mirrors projects-bind.test.mjs's own copies --

function mockReq(method, url, body) {
    const chunks = body !== undefined ? [Buffer.from(JSON.stringify(body))] : [];
    return {
        method,
        url,
        on(event, cb) {
            if (event === 'data') { for (const c of chunks) cb(c); }
            if (event === 'end') { cb(); }
            return this;
        },
    };
}
function mockRes() {
    return {
        statusCode: undefined,
        body: undefined,
        headersSent: false,
        writeHead(status) { this.statusCode = status; this.headersSent = true; },
        end(body) { this.body = body; },
    };
}
const payloadOf = (res) => JSON.parse(res.body);

// -- member_git_status fixtures, matching src/tools/member-git-status.ts's shape --

function checkoutStatus(overrides = {}) {
    const checkoutPath = overrides.path ?? '/home/x/repo';
    return {
        content: [{ type: 'text', text: '[OK] checkout' }],
        structuredContent: {
            outcome: 'checkout',
            ok: true,
            memberId: null,
            memberName: null,
            folder: checkoutPath,
            checkout: {
                path: checkoutPath,
                branch: overrides.branch ?? 'main',
                detached: false,
                head: 'deadbeef',
                upstream: overrides.upstream ?? 'origin/main',
                ahead: overrides.ahead ?? 0,
                behind: overrides.behind ?? 0,
                dirty: overrides.dirty ?? false,
                dirtyFiles: overrides.dirtyFiles ?? [],
                worktrees: overrides.worktrees ?? [],
                originUrl: overrides.originUrl ?? 'https://github.com/acme/repo.git',
                originSlug: overrides.originSlug ?? 'github.com/acme/repo',
                playbooks: overrides.playbooks ?? [],
                bibleCommit: overrides.bibleCommit ?? null,
            },
            error: null,
        },
    };
}

function noCheckoutStatus(folder = '/home/x/repo') {
    return {
        content: [{ type: 'text', text: '[OK] no checkout' }],
        structuredContent: { outcome: 'no_checkout', ok: true, memberId: null, memberName: null, folder, checkout: null, error: null },
    };
}

function execResult(stdout = '') {
    return { isError: false, content: [{ type: 'text', text: stdout }], structuredContent: { exitCode: 0, stdout, stderr: '' } };
}

/** Splits a member-bound command string into quoted-or-bare tokens (mirrors quoteArg's own quoting). */
function tokenize(command) {
    const re = /"([^"]*)"|(\S+)/g;
    const tokens = [];
    let m;
    while ((m = re.exec(command)) !== null) tokens.push(m[1] !== undefined ? m[1] : m[2]);
    return tokens;
}

// -- the fake fleet client ----------------------------------------------------

function memberRecord(name, overrides = {}) {
    return {
        name,
        type: 'remote',
        host: '10.0.0.1:22',
        folder: `/home/${name}/repo`,
        env: {},
        owner: null,
        ssh_auth: 'key',
        llmProvider: 'anthropic',
        shell: 'bash',
        vcsTokenExpiresAt: null,
        held: false,
        ...overrides,
    };
}

function makeClient() {
    const registry = new Map();
    /** path -> { originUrl, originSlug } : what is checked out at this absolute path, machine-wide. */
    const clonedAt = new Map();
    /** member name -> () => raw member_git_status result, overriding the clonedAt-derived default. */
    const gitOverrides = new Map();
    /** member name -> the beads sync.remote currently configured there. */
    const beadsRemoteByMember = new Map();
    const calls = {
        listMembers: 0,
        memberDetail: [],
        memberGitStatus: [],
        executeCommand: [],
        registerMember: [],
        memberOwner: [],
        updateMember: [],
        provisionVcsAuth: [],
        provisionLlmAuth: [],
        composePermissions: [],
    };

    return {
        registry,
        clonedAt,
        calls,
        addMember(name, overrides = {}) { registry.set(name, memberRecord(name, overrides)); },
        setGitOverride(name, responderOrValue) {
            gitOverrides.set(name, typeof responderOrValue === 'function' ? responderOrValue : () => responderOrValue);
        },

        async listMembers() {
            calls.listMembers += 1;
            // sshPassword (a test-only field some cases attach to a sibling record
            // to prove it never leaks) is stripped here too, same as `held`: a
            // real list_members response would never carry a raw secret.
            const members = [...registry.values()].map(({ held, sshPassword, ...rest }) => ({
                ...rest,
                env: { ...rest.env },
            }));
            return { content: [{ type: 'text', text: JSON.stringify({ members }) }] };
        },

        async memberDetail({ member_name }) {
            calls.memberDetail.push({ member_name });
            const rec = registry.get(member_name);
            const body = {
                connectivity: { keyPath: (rec && rec.keyPath) || null },
                vcsProvider: (rec && rec.vcsProvider) || null,
            };
            return { content: [{ type: 'text', text: JSON.stringify(body) }] };
        },

        async memberGitStatus({ member_name, folder }) {
            calls.memberGitStatus.push({ member_name, folder });
            const override = gitOverrides.get(member_name);
            if (override) return override();
            const rec = registry.get(member_name);
            const effectiveFolder = folder ?? (rec && rec.folder);
            if (effectiveFolder && clonedAt.has(effectiveFolder)) {
                const { originUrl, originSlug } = clonedAt.get(effectiveFolder);
                return checkoutStatus({ path: effectiveFolder, originUrl, originSlug, dirty: false });
            }
            return noCheckoutStatus(effectiveFolder || '/unknown');
        },

        async executeCommand({ member_name, command }) {
            calls.executeCommand.push({ member_name, command });
            ALL_RECORDED_COMMANDS.push(command);
            const tokens = tokenize(command);
            if (tokens[0] === 'git' && tokens[1] === 'clone') {
                const originUrl = tokens[2];
                const dir = tokens[3];
                clonedAt.set(dir, { originUrl, originSlug: originSlugFromUrl(originUrl) });
                return execResult();
            }
            if (tokens.includes('config') && tokens.includes('get')) {
                return execResult(beadsRemoteByMember.get(member_name) ?? '');
            }
            if (tokens.includes('config') && tokens.includes('set')) {
                beadsRemoteByMember.set(member_name, tokens[tokens.length - 1]);
                return execResult();
            }
            return execResult();
        },

        async registerMember(input) {
            calls.registerMember.push(input);
            const host = (input.host && input.port) ? `${input.host}:${input.port}` : undefined;
            registry.set(input.friendly_name, memberRecord(input.friendly_name, {
                type: input.member_type,
                host,
                folder: input.work_folder,
                env: { ...(input.env || {}) },
                owner: null, // see module header: registerMember's own `owner` field is deliberately NOT applied here
                ssh_auth: input.auth_type,
                llmProvider: input.llm_provider,
                shell: input.shell,
                vcsProvider: input.vcs_provider,
            }));
            return { content: [{ type: 'text', text: '[OK] registered' }] };
        },

        async memberOwner({ member_name, action, package: pkg, ref }) {
            calls.memberOwner.push({ member_name, action, package: pkg, ref });
            const rec = registry.get(member_name);
            if (!rec) {
                return { content: [{ type: 'text', text: '[-] member not found' }], structuredContent: { outcome: 'member_not_found', action } };
            }
            if (rec.held) {
                return { content: [{ type: 'text', text: '[-] held' }], structuredContent: { outcome: 'member_held', action } };
            }
            if (action === 'set') {
                rec.owner = { package: pkg, ref };
                return { content: [{ type: 'text', text: '[OK] set' }], structuredContent: { outcome: 'set', action, owner: rec.owner } };
            }
            rec.owner = null;
            return { content: [{ type: 'text', text: '[OK] cleared' }], structuredContent: { outcome: 'cleared', action, owner: null } };
        },

        async updateMember({ member_name, env }) {
            calls.updateMember.push({ member_name, env });
            const rec = registry.get(member_name);
            if (rec) rec.env = { ...env };
            return { content: [{ type: 'text', text: '[OK] Member updated.' }] };
        },

        async provisionVcsAuth({ member_name }) {
            calls.provisionVcsAuth.push({ member_name });
            return { content: [{ type: 'text', text: '[OK] vcs auth provisioned' }], structuredContent: { ok: true } };
        },
        async provisionLlmAuth({ member_name }) {
            calls.provisionLlmAuth.push({ member_name });
            return { content: [{ type: 'text', text: '[OK] llm auth provisioned' }], structuredContent: { ok: true } };
        },
        async composePermissions({ member_name }) {
            calls.composePermissions.push({ member_name });
            return { content: [{ type: 'text', text: '[OK] permissions composed' }] };
        },
    };
}

// -- per-test harness ---------------------------------------------------------

function setup({ projectId = 'proj-1', backlogMember = 'alice', beadsDir = '/repo/proj-1/.beads', beadsRemote = null } = {}) {
    const store = openStore({ file: ':memory:' });
    openStores.push(store);
    const db = store.db;
    const project = createProject(db, {
        id: projectId,
        name: 'Project One',
        backlogMember,
        beads: { kind: 'clone', dir: beadsDir, remote: beadsRemote },
        operator: 'akhil',
    });
    const client = makeClient();
    const supervisor = createSupervisor();
    registerProjectRoutes(supervisor, { store, client });
    return { store, db, client, supervisor, project };
}

async function postCheckout(supervisor, projectId, body) {
    const res = mockRes();
    await supervisor.handleRequest(mockReq('POST', `/api/projects/${projectId}/checkouts`, body), res);
    return res;
}

// =============================================================================
// 1. suggestCheckoutName (DQ-16)
// =============================================================================
describe('1. suggestCheckoutName', () => {
    test("'shop' + sibling 'shop-lin1' + origin 'github.com/acme/shop-api.git' -> 'shop-lin1-shop-api'", () => {
        const name = suggestCheckoutName({
            projectId: 'shop',
            machineMember: 'shop-lin1',
            originSlug: originSlugFromUrl('https://github.com/acme/shop-api.git'),
        });
        assert.equal(name, 'shop-lin1-shop-api');
    });

    test('role hint is appended', () => {
        const name = suggestCheckoutName({
            projectId: 'shop',
            machineMember: 'shop-lin1',
            originSlug: originSlugFromUrl('https://github.com/acme/shop-api.git'),
            roleHint: 'worker',
        });
        assert.equal(name, 'shop-lin1-shop-api-worker');
    });

    test('unsafe characters are normalised in every component', () => {
        const name = suggestCheckoutName({
            projectId: 'Shop!!',
            machineMember: 'Shop!!-LIN #1',
            originSlug: 'GitHub.com/Acme/Shop_API',
            roleHint: 'QA Box',
        });
        assert.equal(name, 'shop-lin-1-shop-api-qa-box');
    });
});

// =============================================================================
// 2. fresh run: clone, register, beads-bootstrap, bind all 'done', in order
// =============================================================================
describe('2. a fresh run does all four core steps, in order', { skip }, () => {
    test('registerMember called with work_folder/owner/env.BEADS_DIR; member_git row exists afterwards', async () => {
        const { db, client, supervisor, project } = setup({ beadsRemote: 'https://dolt.example.com/proj-1-beads' });
        client.addMember('proj-1-lin1', { type: 'remote', host: '10.0.0.1:22', ssh_auth: 'key' });

        const res = await postCheckout(supervisor, 'proj-1', {
            siblingMember: 'proj-1-lin1',
            originUrl: 'https://github.com/acme/shop-api.git',
            checkoutDir: '/home/proj-1-lin1/shop-api',
        });
        assert.equal(res.statusCode, 200, JSON.stringify(payloadOf(res)));
        const payload = payloadOf(res);

        assert.deepEqual(
            payload.steps.map((s) => s.step),
            ['clone', 'register', 'beads-bootstrap', 'bind', 'provision-vcs-auth', 'provision-llm-auth', 'compose-permissions'],
        );
        const byStep = Object.fromEntries(payload.steps.map((s) => [s.step, s.status]));
        assert.equal(byStep.clone, 'done');
        assert.equal(byStep.register, 'done');
        assert.equal(byStep['beads-bootstrap'], 'done');
        assert.equal(byStep.bind, 'done');

        assert.equal(client.calls.registerMember.length, 1);
        const registerCall = client.calls.registerMember[0];
        assert.equal(registerCall.work_folder, '/home/proj-1-lin1/shop-api');
        assert.deepEqual(registerCall.owner, { package: OWNER_PACKAGE, ref: 'proj-1' });
        assert.equal(registerCall.env[BEADS_DIR_ENV], project.beads.dir);

        const row = getMemberGit(db, 'proj-1', payload.name);
        assert.ok(row, 'the new checkout member must have a member_git row after bind');
    });
});

// =============================================================================
// 3. idempotency (A10): a second identical run is a total no-op
// =============================================================================
describe('3. A10: a second identical run reports every step skipped with zero mutating calls', { skip }, () => {
    test('no git clone, no registerMember, no bootstrap, no memberOwner call on the second run', async () => {
        const { client, supervisor } = setup({ beadsRemote: 'https://dolt.example.com/proj-1-beads' });
        client.addMember('proj-1-lin1', { type: 'remote', host: '10.0.0.1:22', ssh_auth: 'key' });
        const body = {
            siblingMember: 'proj-1-lin1',
            originUrl: 'https://github.com/acme/shop-api.git',
            checkoutDir: '/home/proj-1-lin1/shop-api',
        };

        const first = await postCheckout(supervisor, 'proj-1', body);
        assert.equal(first.statusCode, 200, JSON.stringify(payloadOf(first)));

        const registerCallsBefore = client.calls.registerMember.length;
        const memberOwnerCallsBefore = client.calls.memberOwner.length;
        const updateMemberCallsBefore = client.calls.updateMember.length;
        const executeCommandCallsBefore = client.calls.executeCommand.length;

        const second = await postCheckout(supervisor, 'proj-1', body);
        assert.equal(second.statusCode, 200, JSON.stringify(payloadOf(second)));
        const payload = payloadOf(second);
        for (const step of payload.steps) {
            assert.equal(step.status, 'skipped', `expected step '${step.step}' to be 'skipped' on the second run, got '${step.status}': ${JSON.stringify(step)}`);
        }

        assert.equal(client.calls.registerMember.length, registerCallsBefore, 'no registerMember call on the second run');
        assert.equal(client.calls.memberOwner.length, memberOwnerCallsBefore, 'no memberOwner call on the second run');
        assert.equal(client.calls.updateMember.length, updateMemberCallsBefore, 'no updateMember call on the second run');
        const newCommands = client.calls.executeCommand.slice(executeCommandCallsBefore).map((c) => c.command);
        assert.ok(!newCommands.some((cmd) => cmd.startsWith('git clone ')), 'no git clone on the second run');
        assert.ok(!newCommands.some((cmd) => cmd.includes('bootstrap')), 'no bd bootstrap on the second run');
    });
});

// =============================================================================
// 4. a dirty or foreign-origin checkout at checkoutDir refuses the clone step
// =============================================================================
describe('4. a dirty or foreign-origin checkout at checkoutDir refuses the clone step', { skip }, () => {
    test('a dirty checkout -> failed checkout-dir-conflict, later steps not-run, no mutating call, 422', async () => {
        const { client, supervisor } = setup();
        client.addMember('proj-1-lin1', { type: 'remote' });
        client.setGitOverride('proj-1-lin1', () => checkoutStatus({ path: '/home/proj-1-lin1/shop-api', dirty: true }));

        const res = await postCheckout(supervisor, 'proj-1', {
            siblingMember: 'proj-1-lin1',
            originUrl: 'https://github.com/acme/shop-api.git',
            checkoutDir: '/home/proj-1-lin1/shop-api',
        });
        assert.equal(res.statusCode, 422);
        const payload = payloadOf(res);
        assert.equal(payload.steps[0].step, 'clone');
        assert.equal(payload.steps[0].status, 'failed');
        assert.ok(payload.steps[0].detail.startsWith('checkout-dir-conflict'), payload.steps[0].detail);
        for (const step of payload.steps.slice(1)) {
            assert.equal(step.status, 'not-run', JSON.stringify(step));
        }
        assert.equal(client.calls.registerMember.length, 0);
        assert.equal(client.calls.executeCommand.length, 0, 'a refused clone step must never run a command');
    });

    test('a foreign-origin checkout at checkoutDir also refuses', async () => {
        const { client, supervisor } = setup();
        client.addMember('proj-1-lin1', { type: 'remote' });
        client.setGitOverride('proj-1-lin1', () => checkoutStatus({
            path: '/home/proj-1-lin1/shop-api', dirty: false, originSlug: 'github.com/other/unrelated',
        }));

        const res = await postCheckout(supervisor, 'proj-1', {
            siblingMember: 'proj-1-lin1',
            originUrl: 'https://github.com/acme/shop-api.git',
            checkoutDir: '/home/proj-1-lin1/shop-api',
        });
        assert.equal(res.statusCode, 422);
        const clone = payloadOf(res).steps[0];
        assert.equal(clone.status, 'failed');
        assert.ok(clone.detail.startsWith('checkout-dir-conflict'), clone.detail);
    });
});

// =============================================================================
// 5. a name already taken at a different host/folder refuses the register step
// =============================================================================
describe('5. a name already taken at a different host/folder refuses the register step', { skip }, () => {
    test("register 'failed' name-taken", async () => {
        const { client, supervisor } = setup();
        client.addMember('proj-1-lin1', { type: 'remote', host: '10.0.0.1:22' });
        client.addMember('clash', { type: 'remote', host: '9.9.9.9:22', folder: '/somewhere/else' });

        const res = await postCheckout(supervisor, 'proj-1', {
            siblingMember: 'proj-1-lin1',
            originUrl: 'https://github.com/acme/shop-api.git',
            checkoutDir: '/home/proj-1-lin1/shop-api',
            name: 'clash',
        });
        assert.equal(res.statusCode, 422);
        const registerStep = payloadOf(res).steps.find((s) => s.step === 'register');
        assert.equal(registerStep.status, 'failed');
        assert.ok(registerStep.detail.startsWith('name-taken'), registerStep.detail);
        assert.equal(client.calls.registerMember.length, 0);
    });
});

// =============================================================================
// 6. sibling password auth refuses the register step, and the password never leaks
// =============================================================================
describe('6. a sibling using SSH password auth refuses the register step, and the password never leaks', { skip }, () => {
    test("register 'failed' sibling-password-auth-unsupported; the secret never appears in any recorded call", async () => {
        const { client, supervisor } = setup();
        const secret = 'super-secret-hunter2';
        client.addMember('proj-1-lin1', { type: 'remote', ssh_auth: 'password', sshPassword: secret });

        const res = await postCheckout(supervisor, 'proj-1', {
            siblingMember: 'proj-1-lin1',
            originUrl: 'https://github.com/acme/shop-api.git',
            checkoutDir: '/home/proj-1-lin1/shop-api',
        });
        assert.equal(res.statusCode, 422);
        const registerStep = payloadOf(res).steps.find((s) => s.step === 'register');
        assert.equal(registerStep.status, 'failed');
        assert.equal(registerStep.detail, 'sibling-password-auth-unsupported');

        assert.ok(!JSON.stringify(client.calls).includes(secret), 'the sibling password must never appear in any recorded client call');
    });
});

// =============================================================================
// 7. an unsafe checkoutDir 400s before any client call
// =============================================================================
describe('7. an unsafe checkoutDir 400s before any client call', { skip }, () => {
    const cases = [
        ['a relative path', 'relative/dir'],
        ['a leading tilde', '~/x'],
        ['an embedded $', '/home/$USER/repo'],
    ];
    for (const [label, checkoutDir] of cases) {
        test(`${label} -> 400, zero client calls`, async () => {
            const { client, supervisor } = setup();
            client.addMember('proj-1-lin1', { type: 'remote' });

            const res = await postCheckout(supervisor, 'proj-1', {
                siblingMember: 'proj-1-lin1',
                originUrl: 'https://github.com/acme/shop-api.git',
                checkoutDir,
            });
            assert.equal(res.statusCode, 400, JSON.stringify(payloadOf(res)));
            assert.equal(client.calls.listMembers, 0, 'no listMembers call before checkoutDir is validated');
            assert.equal(client.calls.executeCommand.length, 0);
            assert.equal(client.calls.registerMember.length, 0);
        });
    }
});

// =============================================================================
// 8. no-shell-expansion guard
// =============================================================================
describe('8. no-shell-expansion guard over every recorded command string', () => {
    test('every command string recorded above passes findShellCommandViolations', { skip }, () => {
        assert.ok(ALL_RECORDED_COMMANDS.length > 0, 'expected at least one execute_command call to have been recorded by earlier cases');
        for (const command of ALL_RECORDED_COMMANDS) {
            const violations = findShellCommandViolations(command);
            assert.deepEqual(violations, [], `command string leaks shell expansion: ${JSON.stringify(command)}`);
        }
    });

    test('checkShellCommandPath reports zero violations for src/projects/checkout.mjs', () => {
        const { violations } = checkShellCommandPath(CHECKOUT_SRC_PATH);
        assert.deepEqual(
            violations.map(formatShellCommandViolation),
            [],
            'checkout.mjs must build no member-bound command string that relies on shell-level expansion',
        );
    });
});

// =============================================================================
// 9. optional step-5 provisioning runs only when requested
// =============================================================================
describe('9. optional provisioning steps run only when requested', { skip }, () => {
    test('provisionVcsAuth is called only when provisionVcs is requested; the others stay skipped', async () => {
        const { client, supervisor } = setup();
        client.addMember('proj-1-lin1', { type: 'remote' });

        const res = await postCheckout(supervisor, 'proj-1', {
            siblingMember: 'proj-1-lin1',
            originUrl: 'https://github.com/acme/shop-api.git',
            checkoutDir: '/home/proj-1-lin1/shop-api',
            provisionVcs: true,
        });
        assert.equal(res.statusCode, 200, JSON.stringify(payloadOf(res)));
        const byStep = Object.fromEntries(payloadOf(res).steps.map((s) => [s.step, s.status]));
        assert.equal(byStep['provision-vcs-auth'], 'done');
        assert.equal(byStep['provision-llm-auth'], 'skipped');
        assert.equal(byStep['compose-permissions'], 'skipped');

        assert.equal(client.calls.provisionVcsAuth.length, 1);
        assert.equal(client.calls.provisionLlmAuth.length, 0);
        assert.equal(client.calls.composePermissions.length, 0);
    });

    test('composePermissions is called only when requested, as its own step', async () => {
        const { client, supervisor } = setup();
        client.addMember('proj-1-lin2', { type: 'remote' });

        const res = await postCheckout(supervisor, 'proj-1', {
            siblingMember: 'proj-1-lin2',
            originUrl: 'https://github.com/acme/other.git',
            checkoutDir: '/home/proj-1-lin2/other',
            composePermissions: true,
        });
        assert.equal(res.statusCode, 200, JSON.stringify(payloadOf(res)));
        const byStep = Object.fromEntries(payloadOf(res).steps.map((s) => [s.step, s.status]));
        assert.equal(byStep['compose-permissions'], 'done');
        assert.equal(byStep['provision-vcs-auth'], 'skipped');
        assert.equal(byStep['provision-llm-auth'], 'skipped');

        assert.equal(client.calls.composePermissions.length, 1);
    });
});

// =============================================================================
// 10. provision-vcs-auth / provision-llm-auth idempotency probes (apra-fleet-vcnl.5)
// =============================================================================
describe('10. optional step-5 provisioning idempotency probes', { skip }, () => {
    test('provisionVcsAuth is skipped when the member already carries a non-expired vcsTokenExpiresAt', async () => {
        const { client, supervisor } = setup();
        client.addMember('proj-1-lin4', { type: 'remote' });
        const futureIso = new Date(Date.now() + 3600_000).toISOString();
        const checkoutDir = '/home/proj-1-lin4/shop-api';
        const originUrl = 'https://github.com/acme/shop-api.git';
        client.addMember('checkout-member-1', {
            type: 'remote',
            host: '10.0.0.1:22',
            folder: checkoutDir,
            vcsTokenExpiresAt: futureIso,
            owner: { package: OWNER_PACKAGE, ref: 'proj-1' },
            env: { [BEADS_DIR_ENV]: '/repo/proj-1/.beads' },
        });
        client.clonedAt.set(checkoutDir, { originUrl, originSlug: originSlugFromUrl(originUrl) });

        const res = await postCheckout(supervisor, 'proj-1', {
            siblingMember: 'proj-1-lin4',
            originUrl,
            checkoutDir,
            name: 'checkout-member-1',
            provisionVcs: true,
        });
        assert.equal(res.statusCode, 200, JSON.stringify(payloadOf(res)));
        const byStep = Object.fromEntries(payloadOf(res).steps.map((s) => [s.step, s.status]));
        assert.equal(byStep['clone'], 'skipped');
        assert.equal(byStep['register'], 'skipped');
        assert.equal(byStep['bind'], 'skipped');
        assert.equal(byStep['provision-vcs-auth'], 'skipped');
        assert.equal(client.calls.provisionVcsAuth.length, 0, 'the probe must avoid the mutating provisionVcsAuth call entirely');
    });

    test('provisionVcsAuth still runs when vcsTokenExpiresAt is in the past', async () => {
        const { client, supervisor } = setup();
        client.addMember('proj-1-lin5', { type: 'remote' });
        const pastIso = new Date(Date.now() - 3600_000).toISOString();
        const checkoutDir = '/home/proj-1-lin5/shop-api';
        const originUrl = 'https://github.com/acme/shop-api.git';
        client.addMember('checkout-member-2', {
            type: 'remote',
            host: '10.0.0.1:22',
            folder: checkoutDir,
            vcsTokenExpiresAt: pastIso,
            owner: { package: OWNER_PACKAGE, ref: 'proj-1' },
            env: { [BEADS_DIR_ENV]: '/repo/proj-1/.beads' },
        });
        client.clonedAt.set(checkoutDir, { originUrl, originSlug: originSlugFromUrl(originUrl) });

        const res = await postCheckout(supervisor, 'proj-1', {
            siblingMember: 'proj-1-lin5',
            originUrl,
            checkoutDir,
            name: 'checkout-member-2',
            provisionVcs: true,
        });
        assert.equal(res.statusCode, 200, JSON.stringify(payloadOf(res)));
        const byStep = Object.fromEntries(payloadOf(res).steps.map((s) => [s.step, s.status]));
        assert.equal(byStep['provision-vcs-auth'], 'done');
        assert.equal(client.calls.provisionVcsAuth.length, 1);
    });

    test('provisionLlmAuth is skipped when the member already reports an authenticated llm_auth status', async () => {
        const { client, supervisor } = setup();
        client.addMember('proj-1-lin6', { type: 'remote' });
        const checkoutDir = '/home/proj-1-lin6/shop-api';
        const originUrl = 'https://github.com/acme/shop-api.git';
        client.addMember('checkout-member-3', {
            type: 'remote',
            host: '10.0.0.1:22',
            folder: checkoutDir,
            llm_auth: 'oauth',
            owner: { package: OWNER_PACKAGE, ref: 'proj-1' },
            env: { [BEADS_DIR_ENV]: '/repo/proj-1/.beads' },
        });
        client.clonedAt.set(checkoutDir, { originUrl, originSlug: originSlugFromUrl(originUrl) });

        const res = await postCheckout(supervisor, 'proj-1', {
            siblingMember: 'proj-1-lin6',
            originUrl,
            checkoutDir,
            name: 'checkout-member-3',
            provisionLlm: true,
        });
        assert.equal(res.statusCode, 200, JSON.stringify(payloadOf(res)));
        const byStep = Object.fromEntries(payloadOf(res).steps.map((s) => [s.step, s.status]));
        assert.equal(byStep['provision-llm-auth'], 'skipped');
        assert.equal(client.calls.provisionLlmAuth.length, 0, 'the probe must avoid the mutating provisionLlmAuth call entirely');
    });

    test("provisionLlmAuth still runs when llm_auth is 'none'", async () => {
        const { client, supervisor } = setup();
        client.addMember('proj-1-lin7', { type: 'remote' });
        const checkoutDir = '/home/proj-1-lin7/shop-api';
        const originUrl = 'https://github.com/acme/shop-api.git';
        client.addMember('checkout-member-4', {
            type: 'remote',
            host: '10.0.0.1:22',
            folder: checkoutDir,
            llm_auth: 'none',
            owner: { package: OWNER_PACKAGE, ref: 'proj-1' },
            env: { [BEADS_DIR_ENV]: '/repo/proj-1/.beads' },
        });
        client.clonedAt.set(checkoutDir, { originUrl, originSlug: originSlugFromUrl(originUrl) });

        const res = await postCheckout(supervisor, 'proj-1', {
            siblingMember: 'proj-1-lin7',
            originUrl,
            checkoutDir,
            name: 'checkout-member-4',
            provisionLlm: true,
        });
        assert.equal(res.statusCode, 200, JSON.stringify(payloadOf(res)));
        const byStep = Object.fromEntries(payloadOf(res).steps.map((s) => [s.step, s.status]));
        assert.equal(byStep['provision-llm-auth'], 'done');
        assert.equal(client.calls.provisionLlmAuth.length, 1);
    });
});

// =============================================================================
// 11. originSlugFromUrl: URL shapes, and the git-status-probe.ts drift guard
// =============================================================================
//
// WHY THIS SECTION EXISTS
// ------------------------
// ../src/projects/checkout.mjs's originSlugFromUrl (plus its normaliseHostPath
// and basenameSlug helpers) is a hand-kept copy of the SAME three functions in
// src/services/git-status-probe.ts. The two packages have no compile-time
// link, so nothing but a comment stops them drifting -- and the clone step's
// idempotency probe compares this copy's output against the slug
// member_git_status computed server-side with the OTHER copy. A silent drift
// therefore makes addCheckout either re-clone over an existing checkout or
// refuse a matching one.
//
// Two layers here:
//   a) SLUG_FIXTURES pins the URL shapes the copy must handle, asserted
//      against the se implementation imported directly at the top of this
//      file (the branches the flow tests never reach: scp-like host:path, a
//      scheme URL carrying BOTH userinfo and an explicit port, a bare path, a
//      Windows drive letter, a trailing .git / trailing slash, mixed case).
//   b) the drift guard compares the extracted SOURCE TEXT of the three
//      functions in both files, after stripping TypeScript annotations and
//      normalising whitespace -- so a change to either copy that the fixture
//      table happens not to distinguish still fails loudly.
// =============================================================================

/**
 * [remote url -> expected slug]. Shared by the se assertions below; the same
 * shapes are what src/services/git-status-probe.ts's copy must keep producing.
 */
const SLUG_FIXTURES = [
    ['scp-like host:path', 'github.com:acme/shop-api.git', 'github.com/acme/shop-api'],
    ['scp-like with user@', 'git@github.com:Apra-Labs/apra-fleet.git', 'github.com/apra-labs/apra-fleet'],
    ['scheme URL with userinfo AND an explicit port', 'ssh://git@github.com:22/Apra-Labs/apra-fleet', 'github.com/apra-labs/apra-fleet'],
    ['a bare local path', '/srv/git/shop-api', 'shop-api'],
    // A Windows drive letter is NOT an scp host: the scp branch requires a
    // host of two or more characters precisely so "C:\repos\x" falls through
    // to the basename branch instead of becoming host "c" with path "\repos\x".
    ['a Windows drive letter', 'C:\\repos\\x', 'x'],
    ['a trailing .git', 'https://github.com/acme/shop-api.git', 'github.com/acme/shop-api'],
    ['a trailing slash', 'https://github.com/acme/shop-api/', 'github.com/acme/shop-api'],
    ['a mixed-case host and path', 'HTTPS://GitHub.COM/Acme/Shop-API.git', 'github.com/acme/shop-api'],
    ['a hostless file:// URL', 'file:///srv/git/shop-api.git', 'shop-api'],
    ['an empty remote', '', null],
    ['a whitespace-only remote', '   ', null],
    ['an absent remote (null)', null, null],
    ['an absent remote (undefined)', undefined, null],
];

describe('11a. originSlugFromUrl URL shapes', () => {
    for (const [label, url, expected] of SLUG_FIXTURES) {
        test(`${label}: ${JSON.stringify(url)} -> ${JSON.stringify(expected)}`, () => {
            assert.equal(originSlugFromUrl(url), expected);
        });
    }
});

// -- the drift guard ----------------------------------------------------------

/** The three functions that must stay identical across the two copies. */
const MIRRORED_FUNCTIONS = ['originSlugFromUrl', 'normaliseHostPath', 'basenameSlug'];

/**
 * The source text of `function <name>(...) { ... }` in `src`, from the
 * `function` keyword (or its `export` prefix) through the body's closing
 * brace.
 *
 * Brace matching here is deliberately naive -- it does not track strings,
 * regex literals or comments. That is safe for exactly these three functions
 * because every brace inside them is balanced (`{2,}` in a regex quantifier,
 * `${...}` in a template literal), and a future edit that broke that
 * assumption would surface as a loud extraction failure below rather than a
 * silent pass.
 */
function extractFunctionSource(src, name) {
    const signatureRe = new RegExp(`(?:export\\s+)?function\\s+${name}\\s*\\(`);
    const match = signatureRe.exec(src);
    if (!match) return null;

    const start = match.index;
    const parenOpen = src.indexOf('(', start);
    let depth = 0;
    let parenClose = -1;
    for (let i = parenOpen; i < src.length; i++) {
        if (src[i] === '(') depth += 1;
        else if (src[i] === ')') {
            depth -= 1;
            if (depth === 0) { parenClose = i; break; }
        }
    }
    if (parenClose === -1) return null;

    const braceOpen = src.indexOf('{', parenClose);
    if (braceOpen === -1) return null;
    depth = 0;
    for (let i = braceOpen; i < src.length; i++) {
        if (src[i] === '{') depth += 1;
        else if (src[i] === '}') {
            depth -= 1;
            if (depth === 0) return src.slice(start, i + 1);
        }
    }
    return null;
}

/**
 * Reduce one extracted function to a comparable form: full-line comments
 * dropped, the signature rewritten without its TypeScript type annotations
 * (and without an `export` keyword one copy has and the other does not), and
 * every whitespace run in the body collapsed to a single space so a 2-space
 * vs 4-space indent is not a difference.
 *
 * Collapsing whitespace inside the body would corrupt a string literal that
 * contained meaningful spaces; none of these three functions has one, and a
 * future edit that added one would show up as a drift failure to be resolved
 * here rather than as a silent mismatch.
 */
function normaliseImplementation(source) {
    const withoutComments = source
        .split('\n')
        .filter((line) => !line.trim().startsWith('//'))
        .join('\n');

    const braceOpen = withoutComments.indexOf('{');
    const signature = withoutComments.slice(0, braceOpen);
    const body = withoutComments.slice(braceOpen);

    const name = /function\s+([A-Za-z0-9_$]+)\s*\(/.exec(signature)[1];
    const params = signature
        .slice(signature.indexOf('(') + 1, signature.lastIndexOf(')'))
        .split(',')
        .map((param) => param.split(':')[0].trim())
        .filter((param) => param.length > 0);

    return `function ${name}(${params.join(', ')}) ${body.replace(/\s+/g, ' ').trim()}`;
}

describe('11b. originSlugFromUrl drift guard against src/services/git-status-probe.ts', () => {
    test('both copies still exist where the guard expects them', () => {
        assert.ok(
            fs.existsSync(PROBE_SRC_PATH),
            `the authoritative copy is missing: expected src/services/git-status-probe.ts at ${PROBE_SRC_PATH}. `
            + 'If it moved, re-point this guard -- do not delete it: packages/apra-fleet-se/src/projects/checkout.mjs '
            + 'mirrors that file and has no compile-time link to it.',
        );
        assert.ok(fs.existsSync(CHECKOUT_SRC_PATH), `missing ${CHECKOUT_SRC_PATH}`);
    });

    test('originSlugFromUrl, normaliseHostPath and basenameSlug are byte-identical modulo types and whitespace', () => {
        const probeSrc = fs.readFileSync(PROBE_SRC_PATH, 'utf8');
        const checkoutSrc = fs.readFileSync(CHECKOUT_SRC_PATH, 'utf8');

        for (const name of MIRRORED_FUNCTIONS) {
            const authoritative = extractFunctionSource(probeSrc, name);
            const mirror = extractFunctionSource(checkoutSrc, name);

            assert.ok(
                authoritative,
                `could not extract '${name}' from src/services/git-status-probe.ts (AUTHORITATIVE) -- `
                + 'the drift guard in packages/apra-fleet-se/test/projects-checkout.test.mjs cannot compare what it '
                + 'cannot find; fix the extraction or the function name, never delete the guard.',
            );
            assert.ok(
                mirror,
                `could not extract '${name}' from packages/apra-fleet-se/src/projects/checkout.mjs (the MIRROR) -- `
                + 'the drift guard cannot compare what it cannot find; fix the extraction or the function name, '
                + 'never delete the guard.',
            );

            assert.equal(
                normaliseImplementation(mirror),
                normaliseImplementation(authoritative),
                `originSlugFromUrl DRIFT in '${name}':\n`
                + '  AUTHORITATIVE: src/services/git-status-probe.ts (member_git_status computes the slug with this copy)\n'
                + '  MIRROR:        packages/apra-fleet-se/src/projects/checkout.mjs (must be updated to match)\n'
                + "The clone step's idempotency probe compares the mirror's slug against the authoritative one, so a "
                + 'drift makes addCheckout re-clone over an existing checkout or refuse a matching one. Copy the '
                + 'authoritative implementation across (adjusting only the TypeScript annotations and indentation).',
            );
        }
    });
});
