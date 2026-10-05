// Supervisor backlog-member ensure (src/supervisor/backlog-member.mjs):
// adopt, register, idempotent restart, name sanitization, wrong-kind
// refusal (also through serveMain -> exitCode 1), degraded mode with a
// scheduler-driven retry, and the listFleetMembers unavailable marker.
// Every fleet collaborator is a fake -- no live fleet server is touched.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
    ensureBacklogMember, sanitizeBacklogMemberName, BacklogMemberRefusedError,
    normalizeProjectFolder, sameProjectFolder,
} from '../src/supervisor/backlog-member.mjs';
import {
    listFleetMembers, markFleetMembersUnavailable, fleetMembersUnavailableReason,
} from '../src/supervisor/fleet-members.mjs';
import { createSprintController, ApiError } from '../src/supervisor/api.mjs';
import { serveMain } from '../bin/serve.mjs';

const quiet = { log() {}, warn() {}, error() {} };

/**
 * A stateful fake fleet: register/update mutate the member list the next
 * listMembers() returns, so consecutive ensure runs see each other's effects.
 */
function fakeFleet(initial = [], { up = true } = {}) {
    const state = { members: initial.map((m) => ({ ...m })), up, registers: [], updates: [] };
    return {
        state,
        listMembers: async () => (state.up
            ? { members: state.members.map((m) => ({ ...m })) }
            : markFleetMembersUnavailable({ members: [] }, 'no reachable fleet HTTP singleton (test)')),
        registerMember: async (options) => {
            if (!state.up) return { ok: false, unavailable: true, error: 'fleet down' };
            state.registers.push(options);
            state.members.push({
                name: options.friendly_name, type: options.member_type, folder: options.work_folder,
                llmProvider: options.llm_provider, unreservable: options.unreservable, tags: options.tags,
            });
            return { ok: true, output: 'registered' };
        },
        updateMember: async (options) => {
            if (!state.up) return { ok: false, unavailable: true, error: 'fleet down' };
            state.updates.push(options);
            const m = state.members.find((x) => x.name === options.member_name);
            if (options.tags) m.tags = options.tags;
            if (options.unreservable !== undefined) m.unreservable = options.unreservable;
            return { ok: true, output: 'updated' };
        },
    };
}

function fakeScheduler() {
    const pending = [];
    return {
        pending,
        setTimeout(fn, ms) { const t = { fn, ms, cleared: false }; pending.push(t); return t; },
        clearTimeout(t) { if (t) t.cleared = true; },
        async fire() {
            const live = pending.filter((t) => !t.cleared);
            pending.length = 0;
            for (const t of live) await t.fn();
            return live.length;
        },
    };
}

function ensure(fleet, opts = {}) {
    return ensureBacklogMember({
        listMembers: fleet.listMembers, registerMember: fleet.registerMember, updateMember: fleet.updateMember,
        logger: quiet, platform: 'linux', ...opts,
    });
}

describe('ensureBacklogMember: register and idempotent restart', () => {
    test('no member at X -> exactly one register_member with the sanitized name, llm none, unreservable, [backlog]', async () => {
        const fleet = fakeFleet([{ name: 'toy-doer', type: 'local', folder: '/work/other', llmProvider: 'claude', tags: null }]);
        const h = await ensure(fleet, { beadsDir: '/work/my-repo' });
        assert.equal(fleet.state.registers.length, 1);
        assert.deepEqual(fleet.state.registers[0], {
            friendly_name: 'backlog-myRepo', member_type: 'local', work_folder: '/work/my-repo',
            llm_provider: 'none', unreservable: true, tags: ['backlog'],
        });
        assert.equal(h.get().status, 'ready');
        assert.equal(h.get().member.name, 'backlog-myRepo');
        assert.equal(fleet.state.updates.length, 0);
    });

    test('restart: two consecutive ensure runs against a stateful fleet produce exactly one registered backlog member', async () => {
        const fleet = fakeFleet();
        await ensure(fleet, { beadsDir: '/work/proj' });
        const second = await ensure(fleet, { beadsDir: '/work/proj/' });
        assert.equal(fleet.state.registers.length, 1);
        assert.equal(fleet.state.updates.length, 0);
        assert.equal(fleet.state.members.filter((m) => m.tags && m.tags.includes('backlog')).length, 1);
        assert.equal(second.get().member.name, 'backlog-proj');
    });
});

describe('ensureBacklogMember: adoption', () => {
    const variants = [
        ['exact folder', '/srv/repo', 'linux'],
        ['trailing slash on the member folder', '/srv/repo/', 'linux'],
        ['.beads-suffixed member folder', '/srv/repo/.beads', 'linux'],
        ['.beads-suffixed and slash-terminated', '/srv/repo/.beads/', 'linux'],
    ];
    for (const [label, memberFolder, platform] of variants) {
        test(`adopts an existing LLM-less local member (${label}): name kept, tags preserved plus backlog, no register`, async () => {
            const fleet = fakeFleet([{ name: 'keeper', type: 'local', folder: memberFolder, llmProvider: 'none', unreservable: true, tags: ['ci', 'shared'] }]);
            const h = await ensure(fleet, { beadsDir: '/srv/repo', platform });
            assert.equal(fleet.state.registers.length, 0);
            assert.deepEqual(fleet.state.updates, [{ member_name: 'keeper', tags: ['ci', 'shared', 'backlog'] }]);
            assert.equal(h.get().member.name, 'keeper');
            assert.equal(h.get().status, 'ready');
        });
    }

    test('beadsDir given as the .beads dir itself still matches the member at the project folder', async () => {
        const fleet = fakeFleet([{ name: 'keeper', type: 'local', folder: '/srv/repo', llmProvider: 'none', unreservable: true, tags: ['backlog'] }]);
        const h = await ensure(fleet, { beadsDir: '/srv/repo/.beads' });
        assert.equal(fleet.state.registers.length, 0);
        assert.equal(fleet.state.updates.length, 0, 'an already-correct member needs no update');
        assert.equal(h.get().member.name, 'keeper');
    });

    test('win32: a different-case (and MSYS-style) folder is adopted', async () => {
        const fleet = fakeFleet([{ name: 'WinKeeper', type: 'local', folder: 'C:\\Users\\Dev\\Repo\\', llmProvider: 'none', unreservable: true, tags: null }]);
        const h = await ensure(fleet, { beadsDir: '/c/users/dev/repo', platform: 'win32' });
        assert.equal(fleet.state.registers.length, 0);
        assert.deepEqual(fleet.state.updates, [{ member_name: 'WinKeeper', tags: ['backlog'] }]);
        assert.equal(h.get().member.name, 'WinKeeper');
    });

    test('linux: a different-case folder is NOT matched (a new backlog member is registered instead)', async () => {
        const fleet = fakeFleet([{ name: 'other', type: 'local', folder: '/srv/Repo', llmProvider: 'none', unreservable: true, tags: ['x'] }]);
        await ensure(fleet, { beadsDir: '/srv/repo', platform: 'linux' });
        assert.equal(fleet.state.updates.length, 0);
        assert.equal(fleet.state.registers.length, 1);
        assert.equal(fleet.state.registers[0].friendly_name, 'backlog-repo');
    });

    test('a REMOTE member whose folder text matches is never adopted', async () => {
        const fleet = fakeFleet([{ name: 'far', type: 'remote', folder: '/srv/repo', llmProvider: 'claude', tags: null }]);
        await ensure(fleet, { beadsDir: '/srv/repo' });
        assert.equal(fleet.state.registers.length, 1);
    });

    test('a partially-correct LLM-less member (missing unreservable AND backlog tag) is fixed via update, no refusal', async () => {
        const fleet = fakeFleet([{ name: 'half', type: 'local', folder: '/srv/repo', llmProvider: 'none', unreservable: false, tags: ['ops'] }]);
        const h = await ensure(fleet, { beadsDir: '/srv/repo' });
        assert.deepEqual(fleet.state.updates, [{ member_name: 'half', tags: ['ops', 'backlog'], unreservable: true }]);
        assert.equal(fleet.state.registers.length, 0);
        assert.equal(h.get().status, 'ready');
        assert.equal(h.get().member.unreservable, true);
    });

    test('a member tagged backlog but not unreservable gets only unreservable set (tags untouched)', async () => {
        const fleet = fakeFleet([{ name: 'tagged', type: 'local', folder: '/srv/repo', llmProvider: 'none', tags: ['backlog'] }]);
        await ensure(fleet, { beadsDir: '/srv/repo' });
        assert.deepEqual(fleet.state.updates, [{ member_name: 'tagged', unreservable: true }]);
    });
});

describe('sanitizeBacklogMemberName', () => {
    const table = [
        ['my-repo_v2 (copy)', 'backlog-myRepoV2Copy'],
        ['apra-fleet', 'backlog-apraFleet'],
        ['toy repo', 'backlog-toyRepo'],
        ['MyRepo', 'backlog-myrepo'],
        ['..hidden--name..', 'backlog-hiddenName'],
        ['caf\u00e9 \u00fcber-repo', 'backlog-cafBerRepo'],
        ['\u0440\u0435\u043f\u043e-2', 'backlog-2'],
    ];
    for (const [input, expected] of table) {
        test(`${JSON.stringify(input)} -> ${expected}`, () => {
            const name = sanitizeBacklogMemberName(input);
            assert.equal(name, expected);
            assert.match(name.slice('backlog-'.length), /^[A-Za-z0-9]+$/);
        });
    }

    for (const empty of ['', '---', '\u0440\u0435\u043f\u043e', ' _ ']) {
        test(`empty-after-sanitize ${JSON.stringify(empty)} is refused with a named error`, () => {
            assert.throws(() => sanitizeBacklogMemberName(empty), (err) => err instanceof BacklogMemberRefusedError
                && err.code === 'BACKLOG_MEMBER_NAME_EMPTY');
        });
    }

    test('ensure refuses (does not silently rename) when the folder name sanitizes to empty', async () => {
        const fleet = fakeFleet();
        await assert.rejects(ensure(fleet, { beadsDir: '/srv/\u0440\u0435\u043f\u043e' }),
            (err) => err instanceof BacklogMemberRefusedError && err.code === 'BACKLOG_MEMBER_NAME_EMPTY');
        assert.equal(fleet.state.registers.length, 0);
    });

    test('ensure refuses when the derived name is taken by a member for a different folder', async () => {
        const fleet = fakeFleet([{ name: 'backlog-repo', type: 'local', folder: '/elsewhere/repo', llmProvider: 'none', tags: ['backlog'] }]);
        await assert.rejects(ensure(fleet, { beadsDir: '/srv/repo' }),
            (err) => err instanceof BacklogMemberRefusedError && err.code === 'BACKLOG_MEMBER_NAME_TAKEN'
                && /backlog-repo/.test(err.message));
        assert.equal(fleet.state.registers.length, 0);
    });
});

describe('ensureBacklogMember: an LLM member shares the folder', () => {
    function capturingLogger() {
        const lines = [];
        return { lines, logger: { log: (...a) => lines.push(a.join(' ')), warn() {}, error() {} } };
    }

    test('an LLM member at X is left alone and an LLM-less backlog member is registered next to it (no refusal)', async () => {
        const fleet = fakeFleet([{ name: 'toy-doer', type: 'local', folder: '/srv/repo', llmProvider: 'claude', tags: null }]);
        const { lines, logger } = capturingLogger();
        const h = await ensure(fleet, { beadsDir: '/srv/repo', logger });
        assert.equal(h.get().status, 'ready');
        assert.equal(h.get().member.name, 'backlog-repo');
        assert.deepEqual(fleet.state.registers.map((r) => [r.friendly_name, r.work_folder, r.llm_provider, r.unreservable, r.tags]),
            [['backlog-repo', '/srv/repo', 'none', true, ['backlog']]]);
        assert.equal(fleet.state.updates.length, 0, 'the LLM member is never updated');
        assert.ok(lines.some((l) => /'toy-doer'/.test(l) && /LLM-less/.test(l)), JSON.stringify(lines));
    });

    test('a member with no llmProvider field is treated as an LLM member (list_members defaults it to claude)', async () => {
        const fleet = fakeFleet([{ name: 'legacy', type: 'local', folder: '/srv/repo', tags: null }]);
        const h = await ensure(fleet, { beadsDir: '/srv/repo' });
        assert.equal(h.get().member.name, 'backlog-repo');
        assert.equal(fleet.state.registers.length, 1);
    });

    test('restart with the LLM member and the registered sibling both at X adopts the sibling (no second register)', async () => {
        const fleet = fakeFleet([{ name: 'toy-doer', type: 'local', folder: '/srv/repo', llmProvider: 'claude', tags: null }]);
        await ensure(fleet, { beadsDir: '/srv/repo' });
        const h = await ensure(fleet, { beadsDir: '/srv/repo' });
        assert.equal(h.get().member.name, 'backlog-repo');
        assert.equal(fleet.state.registers.length, 1, 'idempotent across restarts');
        assert.equal(fleet.state.updates.length, 0);
    });
});

describe('ensureBacklogMember: refusals', () => {
    test('through the serve startup path a refusal (derived name taken by another folder) yields exitCode 1 before any port is bound', async () => {
        const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'backlog-member-serve-')));
        const project = path.join(tmp, 'proj');
        fs.mkdirSync(path.join(project, '.beads'), { recursive: true });
        // A project .beads is only discovered when it holds bd init's
        // metadata.json (isProjectBeadsDir), so the fixture must carry one.
        fs.writeFileSync(path.join(project, '.beads', 'metadata.json'), '{}');
        const prevCwd = process.cwd();
        const prevDataDir = process.env.FLEET_SE_DATA_DIR;
        process.env.FLEET_SE_DATA_DIR = path.join(tmp, 'se-data');
        const fleet = fakeFleet([{ name: 'backlog-proj', type: 'local', folder: path.join(tmp, 'elsewhere', 'proj'), llmProvider: 'none', tags: ['backlog'] }]);
        const seen = [];
        const errors = [];
        const origErr = console.error;
        const origWarn = console.warn;
        const origLog = console.log;
        console.error = (...a) => errors.push(a.join(' '));
        console.warn = () => {};
        console.log = () => {};
        try {
            const { exitCode } = await serveMain(['--port', '1', '--beads-dir', project], {
                ensureBacklogMember: ({ beadsDir }) => {
                    seen.push(beadsDir);
                    return ensureBacklogMember({ beadsDir, ...fleet, logger: quiet });
                },
            });
            assert.equal(exitCode, 1);
            assert.deepEqual(seen, [project]);
            assert.ok(errors.some((e) => /refusing to start/.test(e) && /backlog-proj/.test(e) && /already exists/.test(e)), JSON.stringify(errors));
        } finally {
            console.error = origErr;
            console.warn = origWarn;
            console.log = origLog;
            process.chdir(prevCwd);
            if (prevDataDir === undefined) delete process.env.FLEET_SE_DATA_DIR; else process.env.FLEET_SE_DATA_DIR = prevDataDir;
            // Best-effort temp cleanup: on Windows the startup beads-identity
            // probe's bd child can still hold the project dir for a moment
            // (EBUSY); a leftover temp dir must not fail the assertions above.
            try {
                fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
            } catch { /* leftover temp dir; harmless */ }
        }
    });

    test('a refusal found by a background retry cannot exit: the state stays degraded with that reason and retrying stops', async () => {
        const fleet = fakeFleet([], { up: false });
        const scheduler = fakeScheduler();
        const h = await ensure(fleet, { beadsDir: '/srv/repo', scheduler });
        assert.equal(h.get().status, 'degraded');
        fleet.state.up = true;
        fleet.state.members.push({ name: 'backlog-repo', type: 'local', folder: '/elsewhere/repo', llmProvider: 'none', tags: ['backlog'] });
        assert.equal(await scheduler.fire(), 1);
        assert.equal(h.get().status, 'degraded');
        assert.match(h.get().reason, /backlog-repo/);
        assert.equal(scheduler.pending.length, 0, 'no further retry is scheduled after a refusal');
    });
});

describe('ensureBacklogMember: degraded mode', () => {
    function readyLedger() {
        const claims = [];
        return {
            claims,
            list: () => [],
            get: () => undefined,
            claim: async (id, r) => { claims.push(id); return r; },
            getScopeFreshness: () => null,
        };
    }

    test('fleet unavailable -> degraded with a reason; launch 503s with it; the scheduler retry flips to ready and a launch then succeeds', async () => {
        const fleet = fakeFleet([], { up: false });
        const scheduler = fakeScheduler();
        const h = await ensure(fleet, { beadsDir: '/srv/repo', scheduler, retryIntervalMs: 5000 });
        const st = h.get();
        assert.equal(st.status, 'degraded');
        assert.equal(st.member, null);
        assert.match(st.reason, /fleet member list unavailable/);
        assert.equal(scheduler.pending.length, 1);
        assert.equal(scheduler.pending[0].ms, 5000);

        const spawned = [];
        const controller = createSprintController({
            ledger: readyLedger(),
            spawner: { spawnSprint: async (o) => { spawned.push(o); return { pid: 1, port: 2 }; } },
            listMembers: fleet.listMembers,
            backlogMember: h,
            getBuildVersion: () => null,
        });
        const body = { issue: 'demo-1', branch: 'feat/x', base: 'main', members: ['doer-a'] };
        await assert.rejects(controller.launch(body), (err) => err instanceof ApiError && err.status === 503
            && err.message.includes(st.reason));
        assert.equal(spawned.length, 0);

        fleet.state.up = true;
        assert.equal(await scheduler.fire(), 1);
        assert.equal(h.get().status, 'ready');
        assert.equal(h.get().member.name, 'backlog-repo');
        assert.equal(fleet.state.registers.length, 1);

        const out = await controller.launch(body);
        assert.ok(out.sprintId);
        assert.equal(spawned.length, 1);
        assert.deepEqual(spawned[0].roleMap, { backlog: ['backlog-repo'] });
        assert.equal(scheduler.pending.length, 0, 'no retry is scheduled once ready');
    });

    test('a listMembers() that throws is also degraded (not a crash)', async () => {
        const h = await ensureBacklogMember({
            beadsDir: '/srv/repo', logger: quiet, platform: 'linux', scheduler: fakeScheduler(),
            listMembers: async () => { throw new Error('boom'); },
            registerMember: async () => ({ ok: true }), updateMember: async () => ({ ok: true }),
        });
        assert.equal(h.get().status, 'degraded');
        assert.match(h.get().reason, /boom/);
    });

    test('no .beads discovered -> degraded with a reason naming --beads-dir, and no retry (only a restart can fix it)', async () => {
        const fleet = fakeFleet();
        const scheduler = fakeScheduler();
        const h = await ensure(fleet, { beadsDir: null, scheduler });
        assert.equal(h.get().status, 'degraded');
        assert.match(h.get().reason, /--beads-dir/);
        assert.equal(scheduler.pending.length, 0);
        assert.equal(fleet.state.registers.length, 0);
    });

    test('stop() cancels a pending retry; the real-timer default is unref\'d so it never holds the process open', async () => {
        const fleet = fakeFleet([], { up: false });
        const scheduler = fakeScheduler();
        const h = await ensure(fleet, { beadsDir: '/srv/repo', scheduler });
        assert.equal(scheduler.pending.length, 1);
        const t = scheduler.pending[0];
        h.stop();
        assert.equal(t.cleared, true);

        const real = await ensure(fakeFleet([], { up: false }), { beadsDir: '/srv/repo', retryIntervalMs: 3_600_000 });
        assert.equal(real.get().status, 'degraded');
        real.stop();
    });
});

describe('path helpers', () => {
    test('normalizeProjectFolder strips trailing separators and a trailing .beads segment', () => {
        assert.equal(normalizeProjectFolder('/a/b/', 'linux'), '/a/b');
        assert.equal(normalizeProjectFolder('/a/b/.beads', 'linux'), '/a/b');
        assert.equal(normalizeProjectFolder('/', 'linux'), '/');
        assert.equal(normalizeProjectFolder('/c/x/y', 'win32'), 'C:\\x\\y');
    });
    test('sameProjectFolder is case-insensitive on win32 only', () => {
        assert.equal(sameProjectFolder('C:\\A\\B', 'c:\\a\\b\\', 'win32'), true);
        assert.equal(sameProjectFolder('/A/B', '/a/b', 'linux'), false);
        assert.equal(sameProjectFolder('/a/b', '/a/b/', 'darwin'), true);
    });
});

describe('listFleetMembers keeps its never-throw { members: [] } contract and adds a distinguishable marker', () => {
    test('a failing connection still resolves to exactly { members: [] }, with the unavailable reason readable', async () => {
        const result = await listFleetMembers({
            resolveConnection: async () => { throw new Error('nope'); },
            logger: quiet,
        });
        assert.deepEqual(result, { members: [] });
        assert.deepEqual(Object.keys(result), ['members']);
        assert.equal(JSON.stringify(result), '{"members":[]}');
        assert.match(fleetMembersUnavailableReason(result), /nope/);
    });
    test('a non-http connection is unavailable too; a genuinely empty list is not', async () => {
        const result = await listFleetMembers({ resolveConnection: async () => ({ mode: 'stdio', reason: 'no singleton' }), logger: quiet });
        assert.deepEqual(result, { members: [] });
        assert.match(fleetMembersUnavailableReason(result), /no singleton/);
        assert.equal(fleetMembersUnavailableReason({ members: [] }), null);
        assert.equal(fleetMembersUnavailableReason(undefined), null);
    });
});
