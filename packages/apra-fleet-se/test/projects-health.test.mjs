import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'url';

import { isNodeSqliteAvailable, openStore } from '../src/projects/store/db.mjs';
import { createProject } from '../src/projects/store/projects.mjs';
import { upsertMemberGit } from '../src/projects/store/member-git.mjs';
import {
    doltDataReachable,
    backlogCloneStatus,
    groupHasCodeMember,
    bibleInSync,
    beadsDirSyncRemote,
    memberDirty,
    vcsExpiry,
    staleProbe,
    runHealth,
    KB_CANONICAL_PATH,
} from '../src/projects/health.mjs';
import { createSupervisor } from '../src/supervisor/server.mjs';
import { registerProjectRoutes } from '../src/projects/routes/projects.mjs';
import { findShellCommandViolations, checkShellCommandPath, formatShellCommandViolation } from '../fleet-sprint/shell-command-guard.mjs';

// =============================================================================
// apra-fleet-vcnl.3.2 -- coverage for src/projects/health.mjs's eight checks,
// their runHealth aggregate, and src/projects/routes/git.mjs's health + git
// drawer routes.
//
// Sections 1-8 (one per check) call each exported check function DIRECTLY
// with plain fixture objects -- these are the "deliberately near-pure"
// functions health.mjs's own header describes, so no store/client/HTTP
// harness is needed for them, and they run unconditionally (no sqlite gate).
//
// Sections 9-12 need the full harness (in-memory supervisor.sqlite + a fake
// fleet client + the supervisor.handleRequest route table, mirroring
// projects-bind.test.mjs and projects-checkout.test.mjs) because runHealth
// and the git drawer both do real I/O against `db`/`client`.
// =============================================================================

const HAS_SQLITE = isNodeSqliteAvailable();
const skip = HAS_SQLITE ? false : 'node:sqlite is unavailable on this Node runtime';

const HEALTH_SRC_PATH = path.join(
    path.dirname(fileURLToPath(import.meta.url)),
    '../src/projects/health.mjs',
);

/** @type {Array<{close: () => void}>} */
const openStores = [];
after(() => {
    for (const s of openStores) {
        try { s.close(); } catch { /* best-effort */ }
    }
});

/** Every member-bound command string recorded by any fake client in sections 9-11. */
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

// =============================================================================
// 1. doltDataReachable
// =============================================================================
describe('1. doltDataReachable', () => {
    test('WARN: no beads.remote configured', () => {
        const check = doltDataReachable({ project: { beads: { remote: null } }, probeResult: null });
        assert.equal(check.level, 'WARN');
        assert.equal(check.scope, 'project');
        assert.match(check.message, /no beads remote/);
    });

    test('OK: the probe succeeds', () => {
        const check = doltDataReachable({
            project: { beads: { remote: 'https://dolt.example.com/proj-1' } },
            probeResult: { ok: true },
        });
        assert.equal(check.level, 'OK');
        assert.match(check.message, /https:\/\/dolt\.example\.com\/proj-1/);
    });

    test('FAIL: the probe fails, carrying its own error text', () => {
        const check = doltDataReachable({
            project: { beads: { remote: 'https://dolt.example.com/proj-1' } },
            probeResult: { ok: false, error: 'connection refused' },
        });
        assert.equal(check.level, 'FAIL');
        assert.match(check.message, /https:\/\/dolt\.example\.com\/proj-1/);
        assert.match(check.message, /connection refused/);
    });
});

// =============================================================================
// 2. backlogCloneStatus
// =============================================================================
describe('2. backlogCloneStatus', () => {
    test('OK: a clean bd dolt status names the backlog member', () => {
        const check = backlogCloneStatus({ project: { backlogMember: 'alice' }, execResult: { ok: true } });
        assert.equal(check.level, 'OK');
        assert.equal(check.scope, 'project');
        assert.match(check.message, /alice/);
    });

    test('WARN: a non-zero bd dolt status carries the output tail', () => {
        const check = backlogCloneStatus({
            project: { backlogMember: 'alice' },
            execResult: { ok: false, stdout: '', detail: 'exited 1\nmodified: some/file.js' },
        });
        assert.equal(check.level, 'WARN');
        assert.match(check.message, /alice/);
        assert.match(check.message, /modified: some\/file\.js/);
    });
});

// =============================================================================
// 3. groupHasCodeMember
// =============================================================================
describe('3. groupHasCodeMember', () => {
    test('OK: a non-backlog, non-unreservable member is a code member', () => {
        const group = {
            originSlug: 'github.com/acme/shared',
            members: [
                { name: 'alice', record: null },
                { name: 'worker1', record: { unreservable: false } },
            ],
        };
        const check = groupHasCodeMember({ group, backlogMember: 'alice' });
        assert.equal(check.level, 'OK');
        assert.equal(check.scope, 'group:github.com/acme/shared');
        assert.match(check.message, /github\.com\/acme\/shared/);
        assert.match(check.message, /worker1/);
    });

    test('WARN: only the backlog member and/or unreservable members are present', () => {
        const group = {
            originSlug: 'github.com/acme/shared',
            members: [
                { name: 'alice', record: null },
                { name: 'frozen1', record: { unreservable: true } },
            ],
        };
        const check = groupHasCodeMember({ group, backlogMember: 'alice' });
        assert.equal(check.level, 'WARN');
        assert.match(check.message, /github\.com\/acme\/shared/);
    });
});

// =============================================================================
// 4. bibleInSync
// =============================================================================
describe('4. bibleInSync', () => {
    test('OK: a single-member group trivially passes', () => {
        const group = { originSlug: 'github.com/acme/shared', members: [{ name: 'alice', row: { bibleCommit: 'abc' } }] };
        const check = bibleInSync({ group });
        assert.equal(check.level, 'OK');
        assert.match(check.message, /single member/);
    });

    test('OK: multiple members with the same bible commit and no dirty export', () => {
        const group = {
            originSlug: 'github.com/acme/shared',
            members: [
                { name: 'alice', row: { bibleCommit: 'abc', statusJson: null } },
                { name: 'bob', row: { bibleCommit: 'abc', statusJson: null } },
            ],
        };
        const check = bibleInSync({ group });
        assert.equal(check.level, 'OK');
        assert.match(check.message, /alice/);
        assert.match(check.message, /bob/);
    });

    test('WARN: differing bible commits across members', () => {
        const group = {
            originSlug: 'github.com/acme/shared',
            members: [
                { name: 'alice', row: { bibleCommit: 'aaa', statusJson: null } },
                { name: 'bob', row: { bibleCommit: 'bbb', statusJson: null } },
            ],
        };
        const check = bibleInSync({ group });
        assert.equal(check.level, 'WARN');
        assert.match(check.message, /differing bible commits/);
        assert.match(check.message, /alice/);
        assert.match(check.message, /bob/);
    });

    test(`WARN: ${KB_CANONICAL_PATH} is locally dirty on one member`, () => {
        const group = {
            originSlug: 'github.com/acme/shared',
            members: [
                { name: 'alice', row: { bibleCommit: 'abc', statusJson: { checkout: { dirtyFiles: [{ code: 'M', path: KB_CANONICAL_PATH }] } } } },
                { name: 'bob', row: { bibleCommit: 'abc', statusJson: null } },
            ],
        };
        const check = bibleInSync({ group });
        assert.equal(check.level, 'WARN');
        assert.match(check.message, new RegExp(KB_CANONICAL_PATH.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
        assert.match(check.message, /alice/);
    });
});

// =============================================================================
// 5. beadsDirSyncRemote
// =============================================================================
describe('5. beadsDirSyncRemote', () => {
    test('null: no expectedRemote means nothing to check', () => {
        const check = beadsDirSyncRemote({ member: 'alice', beadsDir: '/repo/.beads', execResult: { ok: true, stdout: '' }, expectedRemote: null });
        assert.equal(check, null);
    });

    test('WARN: the member has no BEADS_DIR configured', () => {
        const check = beadsDirSyncRemote({ member: 'alice', beadsDir: null, execResult: null, expectedRemote: 'https://dolt.example.com/proj-1' });
        assert.equal(check.level, 'WARN');
        assert.equal(check.scope, 'member:alice');
        assert.match(check.message, /alice/);
        assert.match(check.message, /no BEADS_DIR/);
    });

    test('FAIL: the sync.remote probe itself failed', () => {
        const check = beadsDirSyncRemote({
            member: 'alice', beadsDir: '/repo/.beads', execResult: { ok: false, detail: 'transport unreachable' },
            expectedRemote: 'https://dolt.example.com/proj-1',
        });
        assert.equal(check.level, 'FAIL');
        assert.match(check.message, /alice/);
        assert.match(check.message, /probe failed/);
        assert.match(check.message, /transport unreachable/);
    });

    test('FAIL: sync.remote does not match the project remote', () => {
        const check = beadsDirSyncRemote({
            member: 'alice', beadsDir: '/repo/.beads', execResult: { ok: true, stdout: 'https://dolt.example.com/other-project\n' },
            expectedRemote: 'https://dolt.example.com/proj-1',
        });
        assert.equal(check.level, 'FAIL');
        assert.match(check.message, /alice/);
        assert.match(check.message, /https:\/\/dolt\.example\.com\/other-project/);
        assert.match(check.message, /https:\/\/dolt\.example\.com\/proj-1/);
    });

    test('OK: sync.remote matches the project remote', () => {
        const check = beadsDirSyncRemote({
            member: 'alice', beadsDir: '/repo/.beads', execResult: { ok: true, stdout: 'https://dolt.example.com/proj-1\n' },
            expectedRemote: 'https://dolt.example.com/proj-1',
        });
        assert.equal(check.level, 'OK');
        assert.match(check.message, /alice/);
    });
});

// =============================================================================
// 6. memberDirty
// =============================================================================
describe('6. memberDirty', () => {
    test('null: a clean (or never-probed) member contributes no check', () => {
        assert.equal(memberDirty({ member: 'alice', row: null }), null);
        assert.equal(memberDirty({ member: 'alice', row: { dirty: false } }), null);
    });

    test('WARN: an uncommitted checkout names the member', () => {
        const check = memberDirty({ member: 'alice', row: { dirty: true } });
        assert.equal(check.level, 'WARN');
        assert.equal(check.scope, 'member:alice');
        assert.match(check.message, /alice/);
    });
});

// =============================================================================
// 7. vcsExpiry
// =============================================================================
describe('7. vcsExpiry', () => {
    const now = new Date('2024-06-15T00:00:00.000Z');

    test('null: a member with no VCS token is not reported', () => {
        assert.equal(vcsExpiry({ member: 'alice', vcsTokenExpiresAt: null, now }), null);
        assert.equal(vcsExpiry({ member: 'alice', vcsTokenExpiresAt: undefined, now }), null);
    });

    test('FAIL: an already-expired token', () => {
        const expiresAt = new Date(now.getTime() - 60 * 60 * 1000).toISOString();
        const check = vcsExpiry({ member: 'alice', vcsTokenExpiresAt: expiresAt, now });
        assert.equal(check.level, 'FAIL');
        assert.match(check.message, /alice/);
        assert.match(check.message, /expired/);
    });

    test('WARN: a token expiring within the 7-day window', () => {
        const expiresAt = new Date(now.getTime() + 3 * 24 * 60 * 60 * 1000).toISOString();
        const check = vcsExpiry({ member: 'alice', vcsTokenExpiresAt: expiresAt, now });
        assert.equal(check.level, 'WARN');
        assert.match(check.message, /alice/);
        assert.match(check.message, /3 day/);
    });

    test('OK: a token valid well beyond the warn window', () => {
        const expiresAt = new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000).toISOString();
        const check = vcsExpiry({ member: 'alice', vcsTokenExpiresAt: expiresAt, now });
        assert.equal(check.level, 'OK');
        assert.match(check.message, /alice/);
    });
});

// =============================================================================
// 8. staleProbe
// =============================================================================
describe('8. staleProbe', () => {
    const now = new Date('2024-06-15T00:00:00.000Z');

    test('null: a fresh probe contributes no check', () => {
        const probedAt = new Date(now.getTime() - 60 * 60 * 1000).toISOString();
        assert.equal(staleProbe({ member: 'alice', probedAt, now }), null);
    });

    test('WARN: never probed at all', () => {
        const check = staleProbe({ member: 'alice', probedAt: null, now });
        assert.equal(check.level, 'WARN');
        assert.equal(check.scope, 'member:alice');
        assert.match(check.message, /alice/);
        assert.match(check.message, /never probed/);
    });

    test('WARN: a cached probe older than 24h', () => {
        const probedAt = new Date(now.getTime() - 48 * 60 * 60 * 1000).toISOString();
        const check = staleProbe({ member: 'alice', probedAt, now });
        assert.equal(check.level, 'WARN');
        assert.match(check.message, /alice/);
        assert.match(check.message, /48h ago/);
    });
});

// =============================================================================
// The full harness for sections 9-11: an in-memory store + a fake fleet
// client, driven through supervisor.handleRequest (mirrors projects-bind.
// test.mjs / projects-checkout.test.mjs).
// =============================================================================

function memberRecord(name, overrides = {}) {
    return {
        name,
        type: 'remote',
        folder: `/home/${name}/repo`,
        env: {},
        unreservable: false,
        vcsProvider: null,
        vcsTokenExpiresAt: null,
        ...overrides,
    };
}

function execOk(stdout = '') {
    return { isError: false, content: [{ type: 'text', text: stdout }], structuredContent: { exitCode: 0, stdout, stderr: '' } };
}
function execNonZero(text = 'non-zero exit') {
    return { isError: false, content: [{ type: 'text', text }], structuredContent: { exitCode: 1, stdout: text, stderr: '' } };
}

/**
 * Splits a member-bound command string into UNQUOTED tokens, the way a POSIX
 * shell would (same copy as projects-checkout.test.mjs's): quoted runs
 * concatenate with adjacent bare text, and the `'\''` break-out quoteArg
 * emits for an embedded apostrophe resolves back to one `'`.
 *
 * quoteArg now quotes EVERY interpolated value (see checkout.mjs's module
 * header), so the old `"..."|\S+` regex no longer recovered a path.
 */
function tokenize(command) {
    const tokens = [];
    let i = 0;
    while (i < command.length) {
        while (i < command.length && /\s/.test(command[i])) i += 1;
        if (i >= command.length) break;
        let token = '';
        while (i < command.length && !/\s/.test(command[i])) {
            const ch = command[i];
            if (ch === "'" || ch === '"') {
                i += 1;
                while (i < command.length && command[i] !== ch) { token += command[i]; i += 1; }
                i += 1;
            } else if (ch === '\\' && command[i + 1] === "'") {
                token += "'";
                i += 2;
            } else {
                token += ch;
                i += 1;
            }
        }
        tokens.push(token);
    }
    return tokens;
}

function makeClient() {
    const registry = new Map();
    const calls = { listMembers: 0, executeCommand: [], memberDetail: [], memberGitStatus: [] };
    let lsRemoteResponder = () => execOk();
    const doltStatusResponders = new Map();
    const syncRemoteValues = new Map();
    const gitStatusResponders = new Map();
    const throwers = new Set();

    return {
        registry,
        calls,
        addMember(name, overrides = {}) { registry.set(name, memberRecord(name, overrides)); },
        setLsRemote(responderOrOk) {
            lsRemoteResponder = typeof responderOrOk === 'function'
                ? responderOrOk
                : () => (responderOrOk ? execOk() : execNonZero('ls-remote failed'));
        },
        setDoltStatus(member, responderOrOk) {
            doltStatusResponders.set(member, typeof responderOrOk === 'function'
                ? responderOrOk
                : () => (responderOrOk ? execOk() : execNonZero('dolt status dirty')));
        },
        setSyncRemote(member, value) { syncRemoteValues.set(member, value); },
        setGitStatusResult(member, responderOrValue) {
            gitStatusResponders.set(member, typeof responderOrValue === 'function' ? responderOrValue : () => responderOrValue);
        },
        throwOnDoltStatus(member) { throwers.add(`dolt-status:${member}`); },
        throwOnSyncRemote(member) { throwers.add(`sync-remote:${member}`); },
        throwOnLsRemote() { throwers.add('ls-remote'); },

        async listMembers() {
            calls.listMembers += 1;
            const members = [...registry.values()].map((rest) => ({ ...rest, env: { ...rest.env } }));
            return { content: [{ type: 'text', text: JSON.stringify({ members }) }] };
        },

        async memberDetail({ member_name }) {
            calls.memberDetail.push({ member_name });
            const rec = registry.get(member_name);
            const body = {
                type: (rec && rec.type) || null,
                folder: (rec && rec.folder) || null,
                vcsProvider: (rec && rec.vcsProvider) || null,
                vcsTokenExpiresAt: (rec && rec.vcsTokenExpiresAt) || null,
            };
            return { content: [{ type: 'text', text: JSON.stringify(body) }] };
        },

        async memberGitStatus({ member_name }) {
            calls.memberGitStatus.push({ member_name });
            const responder = gitStatusResponders.get(member_name);
            if (!responder) {
                return { content: [{ type: 'text', text: '[-] no responder configured' }], structuredContent: { outcome: 'failed', error: 'no responder configured for this test' } };
            }
            return responder();
        },

        async executeCommand({ member_name, command }) {
            calls.executeCommand.push({ member_name, command });
            ALL_RECORDED_COMMANDS.push(command);
            const tokens = tokenize(command);
            if (tokens[0] === 'git' && tokens[1] === 'ls-remote') {
                if (throwers.has('ls-remote')) throw new Error('transport failure: ls-remote');
                return lsRemoteResponder();
            }
            if (tokens.includes('dolt') && tokens.includes('status')) {
                if (throwers.has(`dolt-status:${member_name}`)) throw new Error(`transport failure: dolt status on ${member_name}`);
                const responder = doltStatusResponders.get(member_name) ?? (() => execOk());
                return responder();
            }
            if (tokens.includes('config') && tokens.includes('get')) {
                if (throwers.has(`sync-remote:${member_name}`)) throw new Error(`transport failure: config get on ${member_name}`);
                return execOk(syncRemoteValues.get(member_name) ?? '');
            }
            return execOk();
        },
    };
}

function seedMemberGit(db, projectId, member, opts = {}) {
    if (opts.noCheckout) {
        return upsertMemberGit(db, {
            projectId,
            member,
            originSlug: null,
            originUrl: null,
            checkoutPath: null,
            branch: null,
            upstream: null,
            dirty: false,
            worktrees: null,
            playbooks: null,
            bibleCommit: null,
            statusJson: { outcome: 'no_checkout', checkout: null },
            probedAt: opts.probedAt ?? new Date().toISOString(),
        });
    }
    const {
        originSlug = 'github.com/acme/repo',
        originUrl = 'https://github.com/acme/repo.git',
        checkoutPath = `/home/${member}/repo`,
        branch = 'main',
        upstream = 'origin/main',
        dirty = false,
        ahead = 0,
        behind = 0,
        dirtyFiles = [],
        worktrees = [],
        playbooks = [],
        bibleCommit = null,
        probedAt = new Date().toISOString(),
    } = opts;
    return upsertMemberGit(db, {
        projectId,
        member,
        originSlug,
        originUrl,
        checkoutPath,
        branch,
        upstream,
        dirty,
        worktrees,
        playbooks,
        bibleCommit,
        statusJson: {
            outcome: 'checkout',
            checkout: { path: checkoutPath, branch, upstream, ahead, behind, dirty, dirtyFiles, worktrees, originUrl, originSlug, playbooks, bibleCommit },
        },
        probedAt,
    });
}

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

// =============================================================================
// 9. runHealth: worst computation and per-check fault isolation
// =============================================================================
describe('9. runHealth computes worst correctly and isolates a failing command', { skip }, () => {
    test('a FAIL from doltDataReachable outranks a WARN from a dirty member', async () => {
        const { db, client } = setup({ backlogMember: 'alice', beadsRemote: 'https://dolt.example.com/proj-1' });
        client.addMember('alice');
        client.addMember('bob');
        client.setLsRemote(false);
        seedMemberGit(db, 'proj-1', 'bob', { dirty: true });

        const result = await runHealth({ db, client }, 'proj-1');
        assert.equal(result.worst, 'FAIL');

        const dolt = result.checks.find((c) => c.id === 'doltDataReachable');
        assert.equal(dolt.level, 'FAIL');
        const dirty = result.checks.find((c) => c.id === 'memberDirty' && c.scope === 'member:bob');
        assert.equal(dirty.level, 'WARN');
    });

    test('a thrown executeCommand degrades only backlogCloneStatus, never the whole response', async () => {
        const { db, client } = setup({ backlogMember: 'alice', beadsRemote: null });
        client.addMember('alice');
        client.throwOnDoltStatus('alice');

        const result = await runHealth({ db, client }, 'proj-1');
        const clone = result.checks.find((c) => c.id === 'backlogCloneStatus');
        assert.equal(clone.level, 'WARN');
        assert.match(clone.message, /alice/);
        assert.match(clone.message, /transport failure: dolt status on alice/);

        // doltDataReachable did not need executeCommand at all here (no beads
        // remote configured) and must still report cleanly alongside the WARN.
        const dolt = result.checks.find((c) => c.id === 'doltDataReachable');
        assert.equal(dolt.level, 'WARN');
        assert.match(dolt.message, /no beads remote/);
    });
});

// =============================================================================
// 10. GET /api/projects/:id/health
// =============================================================================
describe('10. GET /api/projects/:id/health', { skip }, () => {
    test('200 with a checks array and a worst level', async () => {
        const { client, supervisor } = setup({ backlogMember: 'alice' });
        client.addMember('alice');

        const res = mockRes();
        await supervisor.handleRequest(mockReq('GET', '/api/projects/proj-1/health'), res);
        assert.equal(res.statusCode, 200, JSON.stringify(payloadOf(res)));
        const payload = payloadOf(res);
        assert.equal(payload.project.id, 'proj-1');
        assert.ok(Array.isArray(payload.checks));
        assert.ok(['OK', 'WARN', 'FAIL'].includes(payload.worst));
    });

    test('404 on an unknown project', async () => {
        const { supervisor } = setup();
        const res = mockRes();
        await supervisor.handleRequest(mockReq('GET', '/api/projects/does-not-exist/health'), res);
        assert.equal(res.statusCode, 404);
    });
});

// =============================================================================
// 11. GET /api/projects/:id/members/:member/git -- the S10 / W3 drawer
// =============================================================================
describe('11. the git drawer, with and without a checkout', { skip }, () => {
    test('a member with a checkout returns the full W3 fields', async () => {
        const { db, client, supervisor } = setup();
        client.addMember('bob', { folder: '/home/bob/repo', type: 'remote', vcsProvider: 'github', vcsTokenExpiresAt: '2030-01-01T00:00:00.000Z' });
        client.addMember('carol', { folder: '/home/carol/repo', type: 'remote' });
        client.addMember('other-owner', { folder: '/home/other/worktree' });

        seedMemberGit(db, 'proj-1', 'bob', {
            originSlug: 'github.com/acme/shared',
            originUrl: 'https://github.com/acme/shared.git',
            branch: 'main',
            upstream: 'origin/main',
            dirty: true,
            ahead: 2,
            behind: 1,
            dirtyFiles: [
                { code: 'M', path: 'src/index.js' },
                { code: '??', path: 'newfile.txt' },
                { code: 'UU', path: 'conflict.txt' },
                { code: 'M', path: KB_CANONICAL_PATH },
            ],
            worktrees: [
                { path: '/home/bob/repo', branch: 'main', head: 'deadbeef', detached: false },
                { path: '/home/other/worktree', branch: 'feature-x', head: 'cafebabe', detached: false },
            ],
            playbooks: ['playbook-a.md', 'playbook-b.md'],
            bibleCommit: 'deadbeef',
        });
        seedMemberGit(db, 'proj-1', 'carol', { originSlug: 'github.com/acme/shared', originUrl: 'https://github.com/acme/shared.git' });

        const res = mockRes();
        await supervisor.handleRequest(mockReq('GET', '/api/projects/proj-1/members/bob/git'), res);
        assert.equal(res.statusCode, 200, JSON.stringify(payloadOf(res)));
        const payload = payloadOf(res);

        assert.equal(payload.member, 'bob');
        assert.equal(payload.where, 'remote');
        assert.equal(payload.originUrl, 'https://github.com/acme/shared.git');
        assert.equal(payload.originSlug, 'github.com/acme/shared');
        assert.equal(payload.group, 'github.com/acme/shared');
        assert.equal(payload.matchesGroup, true);
        assert.equal(payload.branch, 'main');
        assert.equal(payload.upstream, 'origin/main');
        assert.equal(payload.ahead, 2);
        assert.equal(payload.behind, 1);
        assert.equal(payload.dirty, true);
        assert.deepEqual(payload.dirtyCounts, { modified: 2, untracked: 1, unmerged: 1 });
        assert.deepEqual(payload.playbooks, ['playbook-a.md', 'playbook-b.md']);
        assert.equal(payload.worktrees.length, 2);
        assert.equal(payload.worktrees[0].registeredAs, 'bob');
        assert.equal(payload.worktrees[1].registeredAs, 'other-owner');
        assert.deepEqual(payload.bible, { commit: 'deadbeef', dirty: true });
        assert.deepEqual(payload.vcs, { provider: 'github', expiresAt: '2030-01-01T00:00:00.000Z' });
    });

    test('a member with no checkout returns checkout null and only the vcs line', async () => {
        const { db, client, supervisor } = setup();
        client.addMember('dave', { folder: '/home/dave/repo', type: 'local', vcsProvider: null, vcsTokenExpiresAt: null });
        seedMemberGit(db, 'proj-1', 'dave', { noCheckout: true });

        const res = mockRes();
        await supervisor.handleRequest(mockReq('GET', '/api/projects/proj-1/members/dave/git'), res);
        assert.equal(res.statusCode, 200, JSON.stringify(payloadOf(res)));
        assert.deepEqual(payloadOf(res), {
            member: 'dave',
            where: 'local',
            checkout: null,
            message: 'no git checkout',
            workFolder: '/home/dave/repo',
            vcs: { provider: null, expiresAt: null },
        });
    });

    test('an unbound member 404s', async () => {
        const { supervisor } = setup();
        const res = mockRes();
        await supervisor.handleRequest(mockReq('GET', '/api/projects/proj-1/members/never-bound/git'), res);
        assert.equal(res.statusCode, 404);
        assert.equal(payloadOf(res).error, 'member-not-bound');
    });

    test('?refresh=1 calls memberGitStatus exactly once and updates probedAt', async () => {
        const { db, client, supervisor } = setup();
        client.addMember('erin', { folder: '/home/erin/repo' });
        const before = seedMemberGit(db, 'proj-1', 'erin', { probedAt: '2020-01-01T00:00:00.000Z' });
        client.setGitStatusResult('erin', () => ({
            content: [{ type: 'text', text: '[OK] checkout' }],
            structuredContent: {
                outcome: 'checkout',
                ok: true,
                memberId: null,
                memberName: null,
                folder: '/home/erin/repo',
                checkout: {
                    path: '/home/erin/repo', branch: 'main', detached: false, head: 'abc123',
                    upstream: 'origin/main', ahead: 0, behind: 0, dirty: false, dirtyFiles: [],
                    worktrees: [], originUrl: 'https://github.com/acme/repo.git',
                    originSlug: 'github.com/acme/repo', playbooks: [], bibleCommit: null,
                },
                error: null,
            },
        }));

        const res = mockRes();
        await supervisor.handleRequest(mockReq('GET', '/api/projects/proj-1/members/erin/git?refresh=1'), res);
        assert.equal(res.statusCode, 200, JSON.stringify(payloadOf(res)));
        assert.equal(client.calls.memberGitStatus.length, 1);
        const payload = payloadOf(res);
        assert.notEqual(payload.probedAt, before.probedAt);
    });
});

// =============================================================================
// 12. no-shell-expansion guard
// =============================================================================
describe('12. no-shell-expansion guard over every recorded command string', () => {
    test('every command string recorded above passes findShellCommandViolations', { skip }, () => {
        assert.ok(ALL_RECORDED_COMMANDS.length > 0, 'expected at least one execute_command call to have been recorded by earlier cases');
        for (const command of ALL_RECORDED_COMMANDS) {
            const violations = findShellCommandViolations(command);
            assert.deepEqual(violations, [], `command string leaks shell expansion: ${JSON.stringify(command)}`);
        }
    });

    test('checkShellCommandPath reports zero violations for src/projects/health.mjs', () => {
        const { violations } = checkShellCommandPath(HEALTH_SRC_PATH);
        assert.deepEqual(
            violations.map(formatShellCommandViolation),
            [],
            'health.mjs must build no member-bound command string that relies on shell-level expansion',
        );
    });
});

// =============================================================================
// 13. quoteArg hardening: unsafe beads dirs are screened BEFORE interpolation,
//     and quoting branches on the member's registered shell
// =============================================================================
//
// Paired verification for the quoteArg/validation hardening. health.mjs
// interpolates two values it never used to validate at all -- the project's
// configured `beads.dir` and the member's own `BEADS_DIR` env entry. Both are
// now screened first: an unsafe value becomes that check's own FAIL, naming
// the problem, and NO command is sent to the member. What survives the screen
// is then quoted for the TARGET member's shell, POSIX or PowerShell.
//
// Every emitted command string here is asserted exactly and run through
// findShellCommandViolations.
// =============================================================================

const BEADS_DIR_KEY = 'BEADS_DIR';
const HEALTH_BACKTICK = String.fromCharCode(0x60);

/** The exact message checkout.mjs's shellMetaCharError emits -- duplicated so the assertion is a real pin. */
function healthMetaCharDetail(field, ch) {
    return `'${field}' must not contain the shell metacharacter ${JSON.stringify(ch)} `
        + '-- resolve or remove it in JavaScript before sending a literal value to a member';
}

describe('13a. an unsafe project.beads.dir sends no probe and FAILs the check', { skip }, () => {
    const cases = [
        ['a semicolon', '/repo/proj-1/.beads;id', ';'],
        ['a backtick', `/repo/proj-1/.beads${HEALTH_BACKTICK}id${HEALTH_BACKTICK}`, HEALTH_BACKTICK],
        ['a dollar-paren substitution', '/repo/proj-1/.beads$(id)', '$'],
        ['a newline', '/repo/proj-1/.beads\nid', '\n'],
    ];

    for (const [label, beadsDir, offender] of cases) {
        test(`${label} -> backlogCloneStatus FAIL naming the problem, zero dolt status calls`, async () => {
            const { db, client } = setup({ backlogMember: 'alice', beadsDir });
            client.addMember('alice');

            const { checks } = await runHealth({ db, client }, 'proj-1');
            const check = checks.find((c) => c.id === 'backlogCloneStatus');

            assert.equal(check.level, 'FAIL');
            assert.equal(check.scope, 'project');
            assert.equal(
                check.message,
                `no bd dolt status probe sent to alice: ${healthMetaCharDetail('project.beads.dir', offender)}`,
            );
            assert.deepEqual(
                client.calls.executeCommand.filter((c) => c.command.includes('dolt status')),
                [],
                'an unsafe beads dir must never reach the member as a command',
            );
        });
    }
});

describe("13b. an unsafe member BEADS_DIR sends no probe and FAILs that member's check", { skip }, () => {
    const cases = [
        ['a semicolon', '/repo/proj-1/.beads;id', ';'],
        ['a pipe', '/repo/proj-1/.beads|id', '|'],
        ['a dollar-paren substitution', '/repo/proj-1/.beads$(id)', '$'],
        ['a tilde', '~/proj-1/.beads', '~'],
    ];

    for (const [label, envDir, offender] of cases) {
        test(`${label} -> beadsDirSyncRemote FAIL naming the problem, zero calls to that member`, async () => {
            const { db, client } = setup({ backlogMember: 'alice', beadsRemote: 'https://dolt.example.com/proj-1' });
            client.addMember('alice');
            client.addMember('worker1', { env: { [BEADS_DIR_KEY]: envDir } });
            seedMemberGit(db, 'proj-1', 'worker1');

            const { checks } = await runHealth({ db, client }, 'proj-1');
            const check = checks.find((c) => c.id === 'beadsDirSyncRemote' && c.scope === 'member:worker1');

            assert.equal(check.level, 'FAIL');
            assert.equal(
                check.message,
                `worker1: no sync.remote probe sent: ${healthMetaCharDetail(`${BEADS_DIR_KEY} on worker1`, offender)}`,
            );
            assert.deepEqual(
                client.calls.executeCommand.filter((c) => c.member_name === 'worker1'),
                [],
                'an unsafe BEADS_DIR must never reach the member as a command',
            );
        });
    }
});

describe('13c. a safe beads dir is quoted for the TARGET member shell', { skip }, () => {
    const beadsDir = "/repo/o'brien/.beads";

    test('POSIX backlog member: the apostrophe is broken out as the POSIX escape', async () => {
        const { db, client } = setup({ backlogMember: 'alice', beadsDir });
        client.addMember('alice', { os: 'linux' });

        const { checks } = await runHealth({ db, client }, 'proj-1');
        assert.equal(checks.find((c) => c.id === 'backlogCloneStatus').level, 'OK');

        const commands = client.calls.executeCommand.map((c) => c.command);
        assert.deepEqual(commands, ["bd -C '/repo/o'\\''brien/.beads' dolt status"]);
        for (const command of commands) {
            assert.deepEqual(findShellCommandViolations(command), [], `command leaks shell expansion: ${JSON.stringify(command)}`);
        }
    });

    test('PowerShell backlog member: the apostrophe is doubled, never backslash-escaped', async () => {
        const { db, client } = setup({ backlogMember: 'alice', beadsDir });
        client.addMember('alice', { os: 'windows', shell: 'pwsh7' });

        const { checks } = await runHealth({ db, client }, 'proj-1');
        assert.equal(checks.find((c) => c.id === 'backlogCloneStatus').level, 'OK');

        const commands = client.calls.executeCommand.map((c) => c.command);
        assert.deepEqual(commands, ["bd -C '/repo/o''brien/.beads' dolt status"]);
        for (const command of commands) {
            assert.ok(!command.includes('\\"'), `PowerShell member must never see the POSIX escape: ${JSON.stringify(command)}`);
            assert.deepEqual(findShellCommandViolations(command), [], `command leaks shell expansion: ${JSON.stringify(command)}`);
        }
    });

    test('a Windows member registered as gitbash still gets POSIX quoting', async () => {
        const { db, client } = setup({ backlogMember: 'alice', beadsDir });
        client.addMember('alice', { os: 'windows', shell: 'gitbash' });

        await runHealth({ db, client }, 'proj-1');
        assert.deepEqual(
            client.calls.executeCommand.map((c) => c.command),
            ["bd -C '/repo/o'\\''brien/.beads' dolt status"],
        );
    });
});

describe("13d. a member's own BEADS_DIR is quoted for that member, not for the backlog member", { skip }, () => {
    test('the sync.remote probe quotes the member BEADS_DIR PowerShell-style for a PowerShell member', async () => {
        const { db, client } = setup({ backlogMember: 'alice', beadsRemote: 'https://dolt.example.com/proj-1' });
        client.addMember('alice', { os: 'linux' });
        client.addMember('worker1', { os: 'windows', shell: 'pwsh7', env: { [BEADS_DIR_KEY]: "C:\\repo\\o'brien\\.beads" } });
        client.setSyncRemote('worker1', 'https://dolt.example.com/proj-1');
        seedMemberGit(db, 'proj-1', 'worker1');

        const { checks } = await runHealth({ db, client }, 'proj-1');
        assert.equal(checks.find((c) => c.id === 'beadsDirSyncRemote' && c.scope === 'member:worker1').level, 'OK');

        const workerCommands = client.calls.executeCommand.filter((c) => c.member_name === 'worker1').map((c) => c.command);
        assert.deepEqual(workerCommands, ["bd -C 'C:\\repo\\o''brien\\.beads' config get sync.remote"]);
        for (const command of workerCommands) {
            assert.ok(!command.includes('\\"'), `PowerShell member must never see the POSIX escape: ${JSON.stringify(command)}`);
            assert.deepEqual(findShellCommandViolations(command), [], `command leaks shell expansion: ${JSON.stringify(command)}`);
        }
    });
});

describe('13e. the two checks report a configError directly, without any exec input', () => {
    test('backlogCloneStatus: configError outranks a missing execResult', () => {
        const check = backlogCloneStatus({
            project: { backlogMember: 'alice' },
            execResult: null,
            configError: "'project.beads.dir' must not contain the shell metacharacter \";\"",
        });
        assert.equal(check.level, 'FAIL');
        assert.equal(check.scope, 'project');
        assert.match(check.message, /alice/);
        assert.match(check.message, /project\.beads\.dir/);
    });

    test('beadsDirSyncRemote: configError outranks a missing execResult, but a missing BEADS_DIR still WARNs first', () => {
        const configError = "'BEADS_DIR on worker1' must not contain the shell metacharacter \";\"";
        const failed = beadsDirSyncRemote({
            member: 'worker1',
            beadsDir: '/repo/x;id',
            execResult: null,
            expectedRemote: 'https://dolt.example.com/proj-1',
            configError,
        });
        assert.equal(failed.level, 'FAIL');
        assert.equal(failed.scope, 'member:worker1');
        assert.match(failed.message, /BEADS_DIR on worker1/);

        const noDir = beadsDirSyncRemote({
            member: 'worker1',
            beadsDir: null,
            execResult: null,
            expectedRemote: 'https://dolt.example.com/proj-1',
            configError: null,
        });
        assert.equal(noDir.level, 'WARN');
        assert.match(noDir.message, /no BEADS_DIR configured/);
    });
});
