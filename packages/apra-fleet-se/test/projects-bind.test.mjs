import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

import { isNodeSqliteAvailable, openStore } from '../src/projects/store/db.mjs';
import { createProject } from '../src/projects/store/projects.mjs';
import { getMemberGit, listMemberGit, upsertMemberGit } from '../src/projects/store/member-git.mjs';
import { OWNER_PACKAGE, BEADS_DIR_ENV } from '../src/projects/projects.mjs';
import { createSupervisor } from '../src/supervisor/server.mjs';
import { registerProjectRoutes } from '../src/projects/routes/projects.mjs';

// =============================================================================
// apra-fleet-vcnl.1.2 -- bind/unbind/refresh/overview coverage over an
// in-memory store, driven through the SAME supervisor.handleRequest harness
// projects-routes.test.mjs uses (mockReq/mockRes, no real HTTP listener).
//
// The fake client below is a small in-process member registry, not a stub
// per outcome (unlike projects-routes.test.mjs's `stubClient`): bindMember/
// unbindMember/refreshMember/buildOverview all read the registry back via
// listMembers() between steps, so the fake has to behave like the real
// server across a whole request, not just answer one call in isolation.
// Every branch it can take (set/clear/held/not-found for member_owner, an
// env-write failure for update_member, checkout/no_checkout/failed for
// member_git_status) is modelled on the real tool's own structuredContent
// shape (src/tools/member-owner.ts, src/tools/member-git-status.ts) so a
// test asserting on `outcome`/`warnings` here is asserting something the
// real fleet server could actually produce.
// =============================================================================

const HAS_SQLITE = isNodeSqliteAvailable();
const skip = HAS_SQLITE ? false : 'node:sqlite is unavailable on this Node runtime';

/** @type {Array<{close: () => void}>} */
const openStores = [];
after(() => {
    for (const s of openStores) {
        try { s.close(); } catch { /* best-effort */ }
    }
});

// -- mockReq/mockRes/payloadOf -- mirrors projects-routes.test.mjs's own copies --

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

// -- the fake fleet client: a small in-process member registry --------------

/**
 * @param {object} [overrides] Registry-record defaults (type, host, folder, env, ...).
 * @returns {{name:string,type:string,host:string,folder:string,env:object,owner:object|null,unreservable:boolean,vcsTokenExpiresAt:string|null,held:boolean,envWriteFails:boolean}}
 */
function memberRecord(name, overrides = {}) {
    return {
        name,
        type: 'remote',
        host: '10.0.0.1:22',
        folder: `/home/${name}/repo`,
        env: {},
        owner: null,
        unreservable: false,
        vcsTokenExpiresAt: null,
        held: false,
        envWriteFails: false,
        ...overrides,
    };
}

function makeClient() {
    const registry = new Map();
    const gitStatusResponders = new Map();
    const ownerResponders = new Map();
    const calls = { memberOwner: [], updateMember: [], memberGitStatus: [], executeCommand: [], listMembers: 0 };

    return {
        registry,
        calls,
        addMember(name, overrides = {}) {
            registry.set(name, memberRecord(name, overrides));
        },
        removeMember(name) { registry.delete(name); },
        /** @param {string} name @param {object | (() => object)} responderOrValue A raw member_git_status result, or a function producing one (called fresh each probe). */
        setGitStatus(name, responderOrValue) {
            gitStatusResponders.set(name, typeof responderOrValue === 'function' ? responderOrValue : () => responderOrValue);
        },
        /**
         * Force the NEXT (and every subsequent, until cleared) member_owner
         * call for `name` to answer with an arbitrary raw result, bypassing
         * the registry-driven set/clear/held/not-found branching below. Used
         * to reach outcomes (`invalid_input`, `failed`, a `clear` answering
         * `member_not_found` while the member IS still registered) that the
         * registry model above has no state for -- see apra-fleet-vcnl.10.
         * @param {string} name @param {object | (() => object)} responderOrValue
         */
        setOwnerResult(name, responderOrValue) {
            ownerResponders.set(name, typeof responderOrValue === 'function' ? responderOrValue : () => responderOrValue);
        },
        async listMembers() {
            calls.listMembers += 1;
            const members = [...registry.values()].map(({ held, envWriteFails, ...rest }) => ({
                ...rest,
                env: { ...rest.env },
            }));
            return { content: [{ type: 'text', text: JSON.stringify({ members }) }] };
        },
        async memberOwner({ member_name, action, package: pkg, ref }) {
            calls.memberOwner.push({ member_name, action, package: pkg, ref });
            const override = ownerResponders.get(member_name);
            if (override) return override();
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
            if (rec && rec.envWriteFails) {
                return { content: [{ type: 'text', text: '[-] Member was NOT updated (simulated failure).' }] };
            }
            if (rec) rec.env = { ...env };
            return { content: [{ type: 'text', text: '[OK] Member updated.' }] };
        },
        async memberGitStatus({ member_name, folder }) {
            calls.memberGitStatus.push({ member_name, folder });
            const responder = gitStatusResponders.get(member_name);
            if (!responder) {
                return { content: [{ type: 'text', text: '[-] no responder configured' }], structuredContent: { outcome: 'failed', error: 'no responder configured for this test' } };
            }
            return responder();
        },
        async executeCommand(opts) {
            calls.executeCommand.push(opts);
            return { isError: false, content: [{ type: 'text', text: '' }], structuredContent: { exitCode: 0, stdout: '', stderr: '' } };
        },
    };
}

// -- member_git_status fixtures, matching src/tools/member-git-status.ts's shape --

function checkoutStatus(overrides = {}) {
    const path = overrides.path ?? '/home/x/repo';
    return {
        content: [{ type: 'text', text: '[OK] checkout' }],
        structuredContent: {
            outcome: 'checkout',
            ok: true,
            memberId: null,
            memberName: null,
            folder: path,
            checkout: {
                path,
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

function failedStatus(error = 'boom') {
    return {
        content: [{ type: 'text', text: `[-] ${error}` }],
        structuredContent: { outcome: 'failed', ok: false, memberId: null, memberName: null, folder: null, checkout: null, error },
    };
}

// -- per-test harness ---------------------------------------------------------

function setup({ projectId = 'proj-1', backlogMember = 'alice', beadsDir = '/repo/proj-1/.beads' } = {}) {
    const store = openStore({ file: ':memory:' });
    openStores.push(store);
    const db = store.db;
    const project = createProject(db, {
        id: projectId,
        name: 'Project One',
        backlogMember,
        beads: { kind: 'clone', dir: beadsDir },
        operator: 'akhil',
    });
    const client = makeClient();
    const supervisor = createSupervisor();
    registerProjectRoutes(supervisor, { store, client });
    return { store, db, client, supervisor, project };
}

// =============================================================================
// 1. bind writes owner + env + cache
// =============================================================================
describe('1. bind writes owner + env + cache', { skip }, () => {
    test('memberOwner set, updateMember merges BEADS_DIR into existing env, member_git row has the probed fields', async () => {
        const { db, client, supervisor, project } = setup();
        client.addMember('bob', { env: { EXISTING_KEY: 'v' } });
        client.setGitStatus('bob', () => checkoutStatus({
            path: '/home/bob/repo', branch: 'main', upstream: 'origin/main', dirty: false,
            originSlug: 'github.com/acme/repo', originUrl: 'https://github.com/acme/repo.git',
        }));

        const res = mockRes();
        await supervisor.handleRequest(mockReq('POST', '/api/projects/proj-1/members', { member: 'bob' }), res);
        assert.equal(res.statusCode, 200);

        assert.equal(client.calls.memberOwner.length, 1);
        assert.deepEqual(client.calls.memberOwner[0], { member_name: 'bob', action: 'set', package: OWNER_PACKAGE, ref: 'proj-1' });

        assert.equal(client.calls.updateMember.length, 1);
        assert.deepEqual(client.calls.updateMember[0].env, { EXISTING_KEY: 'v', [BEADS_DIR_ENV]: project.beads.dir });

        const payload = payloadOf(res);
        assert.equal(payload.originSlug, 'github.com/acme/repo');
        assert.equal(payload.branch, 'main');
        assert.equal(payload.upstream, 'origin/main');
        assert.equal(payload.dirty, false);
        assert.ok(typeof payload.probedAt === 'string' && payload.probedAt.length > 0);

        const row = getMemberGit(db, 'proj-1', 'bob');
        assert.equal(row.originSlug, 'github.com/acme/repo');
        assert.equal(row.branch, 'main');
    });
});

// =============================================================================
// 2. explicit beadsDir override
// =============================================================================
describe('2. explicit beadsDir overrides project.beads.dir', { skip }, () => {
    test('the env write uses the request beadsDir, not the project default', async () => {
        const { client, supervisor } = setup();
        client.addMember('carl');
        client.setGitStatus('carl', () => noCheckoutStatus('/home/carl/repo'));

        const res = mockRes();
        await supervisor.handleRequest(mockReq('POST', '/api/projects/proj-1/members', { member: 'carl', beadsDir: '/custom/beads/dir' }), res);
        assert.equal(res.statusCode, 200);

        assert.equal(client.calls.updateMember[0].env[BEADS_DIR_ENV], '/custom/beads/dir');
        assert.equal(client.registry.get('carl').env[BEADS_DIR_ENV], '/custom/beads/dir');
    });
});

// =============================================================================
// 3. member_held -> 409, no updateMember call, no row
// =============================================================================
describe('3. member_held refuses the bind', { skip }, () => {
    test('409 member-held; updateMember never called; no member_git row written', async () => {
        const { db, client, supervisor } = setup();
        client.addMember('held-bob', { held: true });

        const res = mockRes();
        await supervisor.handleRequest(mockReq('POST', '/api/projects/proj-1/members', { member: 'held-bob' }), res);
        assert.equal(res.statusCode, 409);
        assert.equal(payloadOf(res).error, 'member-held');

        assert.equal(client.calls.updateMember.length, 0);
        assert.equal(getMemberGit(db, 'proj-1', 'held-bob'), null);
    });
});

// =============================================================================
// 4. member owned by another project -> 409, memberOwner never called
// =============================================================================
describe('4. member owned by another project refuses the bind before any memberOwner call', { skip }, () => {
    test('409 member-owned-elsewhere; memberOwner never called', async () => {
        const { client, supervisor } = setup();
        client.addMember('taken', { owner: { package: OWNER_PACKAGE, ref: 'other-project' } });

        const res = mockRes();
        await supervisor.handleRequest(mockReq('POST', '/api/projects/proj-1/members', { member: 'taken' }), res);
        assert.equal(res.statusCode, 409);
        assert.equal(payloadOf(res).error, 'member-owned-elsewhere');
        assert.equal(client.calls.memberOwner.length, 0);
    });
});

// =============================================================================
// 5. updateMember rejection -> bind still 200, warning recorded, row written
// =============================================================================
describe('5. an update_member rejection degrades to a warning, not a failed bind', { skip }, () => {
    test('200 with warnings containing env-write-failed; the row is still written', async () => {
        const { db, client, supervisor } = setup();
        client.addMember('flaky', { envWriteFails: true });
        client.setGitStatus('flaky', () => noCheckoutStatus('/home/flaky/repo'));

        const res = mockRes();
        await supervisor.handleRequest(mockReq('POST', '/api/projects/proj-1/members', { member: 'flaky' }), res);
        assert.equal(res.statusCode, 200);
        const payload = payloadOf(res);
        assert.ok(payload.warnings.includes('env-write-failed'), `expected env-write-failed in ${JSON.stringify(payload.warnings)}`);

        assert.ok(getMemberGit(db, 'proj-1', 'flaky') !== null);
    });
});

// =============================================================================
// 6. memberGitStatus no_checkout -> null checkout columns; appears in noCheckout
// =============================================================================
describe('6. a no_checkout probe result caches null checkout columns and lands in noCheckout', { skip }, () => {
    test('bind 200 with null originSlug/branch; overview groups it under noCheckout', async () => {
        const { client, supervisor } = setup();
        client.addMember('nogit');
        client.setGitStatus('nogit', () => noCheckoutStatus('/home/nogit/repo'));

        const bindRes = mockRes();
        await supervisor.handleRequest(mockReq('POST', '/api/projects/proj-1/members', { member: 'nogit' }), bindRes);
        assert.equal(bindRes.statusCode, 200);
        const bound = payloadOf(bindRes);
        assert.equal(bound.originSlug, null);
        assert.equal(bound.branch, null);

        const overviewRes = mockRes();
        await supervisor.handleRequest(mockReq('GET', '/api/projects/proj-1/overview'), overviewRes);
        assert.equal(overviewRes.statusCode, 200);
        const overview = payloadOf(overviewRes);
        assert.ok(overview.noCheckout.some((m) => m.name === 'nogit'), `expected 'nogit' in noCheckout: ${JSON.stringify(overview.noCheckout)}`);
    });
});

// =============================================================================
// 7. re-bind is idempotent
// =============================================================================
describe('7. re-binding the same member is idempotent', { skip }, () => {
    test('200 both times, exactly one member_git row, owner set again with the same ref', async () => {
        const { db, client, supervisor } = setup();
        client.addMember('again');
        client.setGitStatus('again', () => checkoutStatus({ path: '/home/again/repo', originSlug: 'github.com/acme/again' }));

        const first = mockRes();
        await supervisor.handleRequest(mockReq('POST', '/api/projects/proj-1/members', { member: 'again' }), first);
        assert.equal(first.statusCode, 200);

        const second = mockRes();
        await supervisor.handleRequest(mockReq('POST', '/api/projects/proj-1/members', { member: 'again' }), second);
        assert.equal(second.statusCode, 200);

        assert.equal(client.calls.memberOwner.length, 2);
        for (const call of client.calls.memberOwner) {
            assert.deepEqual(call, { member_name: 'again', action: 'set', package: OWNER_PACKAGE, ref: 'proj-1' });
        }

        const rows = listMemberGit(db, 'proj-1').filter((r) => r.member === 'again');
        assert.equal(rows.length, 1, 'a re-bind must upsert, never duplicate, the member_git row');
    });
});

// =============================================================================
// 8. unbind
// =============================================================================
describe('8. unbind', { skip }, () => {
    test('memberOwner clear called, BEADS_DIR removed while other env keys are kept, row deleted', async () => {
        const { db, client, supervisor } = setup();
        client.addMember('leaving', { env: { OTHER: 'v' } });
        client.setGitStatus('leaving', () => noCheckoutStatus('/home/leaving/repo'));

        await supervisor.handleRequest(mockReq('POST', '/api/projects/proj-1/members', { member: 'leaving' }), mockRes());
        assert.deepEqual(client.registry.get('leaving').env, { OTHER: 'v', [BEADS_DIR_ENV]: '/repo/proj-1/.beads' });

        const res = mockRes();
        await supervisor.handleRequest(mockReq('DELETE', '/api/projects/proj-1/members/leaving'), res);
        assert.equal(res.statusCode, 200);
        assert.deepEqual(payloadOf(res), { unbound: true, warnings: [] });

        const clearCalls = client.calls.memberOwner.filter((c) => c.action === 'clear' && c.member_name === 'leaving');
        assert.equal(clearCalls.length, 1);
        assert.deepEqual(client.registry.get('leaving').env, { OTHER: 'v' });

        assert.equal(getMemberGit(db, 'proj-1', 'leaving'), null);
    });

    test('unbind of an unbound member 404s', async () => {
        const { supervisor } = setup();
        const res = mockRes();
        await supervisor.handleRequest(mockReq('DELETE', '/api/projects/proj-1/members/never-bound'), res);
        assert.equal(res.statusCode, 404);
        assert.equal(payloadOf(res).error, 'member-not-bound');
    });

    test('member_held on clear -> 409, and the row is kept', async () => {
        const { db, client, supervisor } = setup();
        client.addMember('stuck');
        client.setGitStatus('stuck', () => noCheckoutStatus('/home/stuck/repo'));
        await supervisor.handleRequest(mockReq('POST', '/api/projects/proj-1/members', { member: 'stuck' }), mockRes());
        assert.ok(getMemberGit(db, 'proj-1', 'stuck') !== null);

        client.registry.get('stuck').held = true;
        const res = mockRes();
        await supervisor.handleRequest(mockReq('DELETE', '/api/projects/proj-1/members/stuck'), res);
        assert.equal(res.statusCode, 409);
        assert.equal(payloadOf(res).error, 'member-held');

        assert.ok(getMemberGit(db, 'proj-1', 'stuck') !== null, 'a refused unbind must leave the cached row untouched');
    });
});

// =============================================================================
// 9. GET /api/projects/:id/overview
// =============================================================================
describe('9. overview grouping, 404, and a fault-tolerant ?refresh=1', { skip }, () => {
    test('two groups + noCheckout, backlog member always present, deterministic ordering', async () => {
        const { client, supervisor } = setup({ backlogMember: 'alice' });
        client.addMember('bob');
        client.addMember('carol');
        client.addMember('dave');
        client.setGitStatus('bob', () => checkoutStatus({ path: '/home/bob/repo', originSlug: 'github.com/acme/shared' }));
        client.setGitStatus('carol', () => checkoutStatus({ path: '/home/carol/repo', originSlug: 'github.com/acme/shared' }));
        client.setGitStatus('dave', () => noCheckoutStatus('/home/dave/repo'));

        for (const member of ['bob', 'carol', 'dave']) {
            await supervisor.handleRequest(mockReq('POST', '/api/projects/proj-1/members', { member }), mockRes());
        }

        const res = mockRes();
        await supervisor.handleRequest(mockReq('GET', '/api/projects/proj-1/overview'), res);
        assert.equal(res.statusCode, 200);
        const overview = payloadOf(res);

        assert.equal(overview.backlogMember, 'alice');
        assert.equal(overview.groups.length, 1);
        assert.equal(overview.groups[0].originSlug, 'github.com/acme/shared');
        assert.deepEqual(overview.groups[0].members.map((m) => m.name), ['bob', 'carol']);

        const noCheckoutNames = overview.noCheckout.map((m) => m.name);
        assert.deepEqual(noCheckoutNames, ['alice', 'dave'], 'the never-bound backlog member and the no-checkout member, sorted by name');
    });

    test('an unknown project 404s', async () => {
        const { supervisor } = setup();
        const res = mockRes();
        await supervisor.handleRequest(mockReq('GET', '/api/projects/does-not-exist/overview'), res);
        assert.equal(res.statusCode, 404);
    });

    test('?refresh=1 re-probes every bound member; one probe failure does not abort the rest', async () => {
        const { client, supervisor } = setup({ backlogMember: 'alice' });
        client.addMember('bob');
        client.addMember('carol');
        client.setGitStatus('bob', () => checkoutStatus({ path: '/home/bob/repo', originSlug: 'github.com/acme/shared' }));
        client.setGitStatus('carol', () => checkoutStatus({ path: '/home/carol/repo', originSlug: 'github.com/acme/shared' }));

        for (const member of ['bob', 'carol']) {
            await supervisor.handleRequest(mockReq('POST', '/api/projects/proj-1/members', { member }), mockRes());
        }
        const probesBefore = client.calls.memberGitStatus.length;

        // bob's NEXT probe now fails; carol keeps succeeding.
        client.setGitStatus('bob', () => failedStatus('transport unreachable'));

        const res = mockRes();
        await supervisor.handleRequest(mockReq('GET', '/api/projects/proj-1/overview?refresh=1'), res);
        assert.equal(res.statusCode, 200, 'one member probe failing must not fail the whole overview request');

        assert.equal(client.calls.memberGitStatus.length - probesBefore, 2, 'refresh probes every bound member exactly once');

        const overview = payloadOf(res);
        assert.equal(overview.groups.length, 1);
        assert.deepEqual(overview.groups[0].members.map((m) => m.name), ['carol'], 'bob dropped out of the group once its cached checkout went null');

        const bobEntry = overview.noCheckout.find((m) => m.name === 'bob');
        assert.ok(bobEntry, 'bob now has no cached checkout and must appear in noCheckout');
        assert.ok(bobEntry.warnings.includes('probe-failed'), `expected probe-failed in ${JSON.stringify(bobEntry.warnings)}`);
    });
});

// =============================================================================
// 10. a client missing memberOwner -> 501 on the bind route
// =============================================================================
describe('10. a client lacking memberOwner refuses the bind route with 501', { skip }, () => {
    test('501 client-missing-method naming memberOwner', async () => {
        const { store, client } = setup();
        delete client.memberOwner;
        const supervisor = createSupervisor();
        registerProjectRoutes(supervisor, { store, client });

        const res = mockRes();
        await supervisor.handleRequest(mockReq('POST', '/api/projects/proj-1/members', { member: 'anyone' }), res);
        assert.equal(res.statusCode, 501);
        assert.deepEqual(payloadOf(res), { error: 'client-missing-method', method: 'memberOwner' });
    });

    // The rest of this case ("projects-routes.test.mjs still passes unchanged") is
    // satisfied structurally: this file makes no edit to that one, and both run
    // together under the same bounded `npm test` invocation.
});

// =============================================================================
// 11. OWNER_PACKAGE drift guard (apra-fleet-vcnl.13)
// =============================================================================
describe('11. OWNER_PACKAGE stays aligned with the workflow-package id', () => {
    test('OWNER_PACKAGE equals the name declared in workflow.json', () => {
        const workflow = JSON.parse(fs.readFileSync(new URL('../workflow.json', import.meta.url), 'utf8'));
        assert.equal(
            OWNER_PACKAGE,
            workflow.name,
            `OWNER_PACKAGE ('${OWNER_PACKAGE}') has drifted from the name packages/apra-fleet-se/workflow.json declares ('${workflow.name}') -- reconcile the OWNER_PACKAGE constant in src/projects/projects.mjs (see apra-fleet-vcnl.13)`,
        );
    });
});

// =============================================================================
// 12. POST /:id/members/:member/refresh -- happy path (apra-fleet-vcnl.10)
// =============================================================================
describe('12. POST refresh: happy path re-probes and updates the cached row', { skip }, () => {
    test('2xx, probedAt advances past a seeded stale value, and a changed branch/dirty value is persisted', async () => {
        const { db, client, supervisor } = setup();
        client.addMember('ed');
        client.setGitStatus('ed', () => checkoutStatus({
            path: '/home/ed/repo', branch: 'main', dirty: false, originSlug: 'github.com/acme/repo',
        }));
        await supervisor.handleRequest(mockReq('POST', '/api/projects/proj-1/members', { member: 'ed' }), mockRes());
        const bound = getMemberGit(db, 'proj-1', 'ed');
        assert.equal(bound.branch, 'main');
        assert.equal(bound.dirty, false);

        // Force the cached probedAt into the past so refresh's advance is an
        // observable inequality, rather than comparing two ISO timestamps
        // taken microseconds apart in the same test run.
        const STALE = '2020-01-01T00:00:00.000Z';
        upsertMemberGit(db, { ...bound, probedAt: STALE });

        client.setGitStatus('ed', () => checkoutStatus({
            path: '/home/ed/repo', branch: 'feature-x', dirty: true, originSlug: 'github.com/acme/repo',
        }));

        const res = mockRes();
        await supervisor.handleRequest(mockReq('POST', '/api/projects/proj-1/members/ed/refresh'), res);
        assert.equal(res.statusCode, 200);
        const payload = payloadOf(res);
        assert.notEqual(payload.probedAt, STALE, 'probedAt must advance past the seeded stale value');
        assert.equal(payload.branch, 'feature-x');
        assert.equal(payload.dirty, true);

        const row = getMemberGit(db, 'proj-1', 'ed');
        assert.equal(row.branch, 'feature-x');
        assert.equal(row.dirty, true);
        assert.notEqual(row.probedAt, STALE);
    });
});

// =============================================================================
// 13. POST refresh -- 501 guard (apra-fleet-vcnl.10)
// =============================================================================
describe('13. POST refresh: 501 guard when the client lacks memberGitStatus', { skip }, () => {
    test('501 client-missing-method; the member_git row is unchanged', async () => {
        const { store, db, client, supervisor } = setup();
        client.addMember('finn');
        client.setGitStatus('finn', () => checkoutStatus({ path: '/home/finn/repo', branch: 'main' }));
        await supervisor.handleRequest(mockReq('POST', '/api/projects/proj-1/members', { member: 'finn' }), mockRes());
        const before = getMemberGit(db, 'proj-1', 'finn');

        delete client.memberGitStatus;
        const noProbeSupervisor = createSupervisor();
        registerProjectRoutes(noProbeSupervisor, { store, client });

        const res = mockRes();
        await noProbeSupervisor.handleRequest(mockReq('POST', '/api/projects/proj-1/members/finn/refresh'), res);
        assert.equal(res.statusCode, 501);
        assert.deepEqual(payloadOf(res), { error: 'client-missing-method', method: 'memberGitStatus' });

        assert.deepEqual(getMemberGit(db, 'proj-1', 'finn'), before, 'a 501-guarded refresh must not touch the cached row');
    });
});

// =============================================================================
// 14. POST refresh -- member not bound (apra-fleet-vcnl.10)
// =============================================================================
describe('14. POST refresh: member not bound to this project', { skip }, () => {
    test('404 member-not-bound; no member_git row is created', async () => {
        const { db, client, supervisor } = setup();
        client.addMember('greta');

        const res = mockRes();
        await supervisor.handleRequest(mockReq('POST', '/api/projects/proj-1/members/greta/refresh'), res);
        assert.equal(res.statusCode, 404);
        assert.equal(payloadOf(res).error, 'member-not-bound');
        assert.equal(getMemberGit(db, 'proj-1', 'greta'), null);
    });
});

// =============================================================================
// 15. assertOwnerApplied fallthrough on bind (apra-fleet-vcnl.10)
// =============================================================================
describe('15. bind 502s on a member_owner outcome assertOwnerApplied does not recognize', { skip }, () => {
    test('outcome invalid_input -> 502 member-owner-failed; no half-applied member_git row', async () => {
        const { db, client, supervisor } = setup();
        client.addMember('hank');
        client.setOwnerResult('hank', () => ({
            content: [{ type: 'text', text: '[-] invalid input' }],
            structuredContent: { outcome: 'invalid_input', action: 'set' },
        }));

        const res = mockRes();
        await supervisor.handleRequest(mockReq('POST', '/api/projects/proj-1/members', { member: 'hank' }), res);
        assert.equal(res.statusCode, 502);
        assert.equal(payloadOf(res).error, 'member-owner-failed');
        assert.equal(getMemberGit(db, 'proj-1', 'hank'), null, 'a 502 bind must leave no member_git row');
    });

    test('outcome failed -> 502 member-owner-failed; no half-applied member_git row', async () => {
        const { db, client, supervisor } = setup();
        client.addMember('iris');
        client.setOwnerResult('iris', () => ({
            content: [{ type: 'text', text: '[-] failed' }],
            structuredContent: { outcome: 'failed', action: 'set' },
        }));

        const res = mockRes();
        await supervisor.handleRequest(mockReq('POST', '/api/projects/proj-1/members', { member: 'iris' }), res);
        assert.equal(res.statusCode, 502);
        assert.equal(payloadOf(res).error, 'member-owner-failed');
        assert.equal(getMemberGit(db, 'proj-1', 'iris'), null, 'a 502 bind must leave no member_git row');
    });
});

// =============================================================================
// 16. unbind when member_owner answers member_not_found on clear (apra-fleet-vcnl.10)
// =============================================================================
describe('16. unbind still succeeds when member_owner reports member_not_found on clear', { skip }, () => {
    test('2xx, the member_git row IS deleted, and the response carries owner-clear-member-missing', async () => {
        const { db, client, supervisor } = setup();
        client.addMember('jill');
        client.setGitStatus('jill', () => noCheckoutStatus('/home/jill/repo'));
        await supervisor.handleRequest(mockReq('POST', '/api/projects/proj-1/members', { member: 'jill' }), mockRes());
        assert.ok(getMemberGit(db, 'proj-1', 'jill') !== null);

        client.setOwnerResult('jill', () => ({
            content: [{ type: 'text', text: '[-] member not found' }],
            structuredContent: { outcome: 'member_not_found', action: 'clear' },
        }));

        const res = mockRes();
        await supervisor.handleRequest(mockReq('DELETE', '/api/projects/proj-1/members/jill'), res);
        assert.equal(res.statusCode, 200);
        const payload = payloadOf(res);
        assert.ok(
            payload.warnings.includes('owner-clear-member-missing'),
            `expected owner-clear-member-missing in ${JSON.stringify(payload.warnings)}`,
        );

        assert.equal(getMemberGit(db, 'proj-1', 'jill'), null, 'unbind must still delete the cached row');
    });
});
