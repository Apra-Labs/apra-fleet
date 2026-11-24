// The supervisor beads view runs the engine's bd/dolt version pin check on the
// backlog member BEFORE any D-pull: an off-pin bd (or dolt) means no
// `bd dolt pull`, no `bd list`, a recorded error, and a refused launch. A
// passing result is cached per member; a failure is re-probed every check.
//
// REAL createBeadsView + REAL verifyPinnedToolVersions + REAL doltPullBefore
// over a fake member command(); the launch case uses the real
// createLaunchScopeGuard / createSprintController from the supervisor. No
// real bd, no network, no install or home state touched.

import { describe, test, beforeEach, afterEach, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createBeadsView, BeadsViewUnavailableError } from '../src/supervisor/beads-view.mjs';
import { composeBeforeLaunch, createLaunchScopeGuard } from '../bin/serve.mjs';
import { createSprintController, ApiError } from '../src/supervisor/api.mjs';
import { createLedger } from '../src/supervisor/ledger.mjs';
import { clearLastSyncedTip, clearTipProbeFailures, invalidateSyncRemoteCache } from '../fleet-sprint/dolt-sync.mjs';
import { BEADS_VERSION, DOLT_VERSION, TOOL_VERSION_PROBES } from '../fleet-sprint/tool-version-pin.mjs';
import { TOOL_VERSION_FIX } from '../fleet-sprint/beads-identity-check.mjs';
import { offPinMinor } from './helpers/pinned-tool-versions.mjs';

const MEMBER = 'backlog-proj';
const SHA_A = 'a'.repeat(40);
const QUIET = { log() {}, warn() {}, error() {} };
const OFF_PIN_BD = offPinMinor(BEADS_VERSION);
const OFF_PIN_DOLT = offPinMinor(DOLT_VERSION);
const PINNED_MM = BEADS_VERSION.split('.').slice(0, 2).join('.');
const ROWS = [{ id: 'EPIC-1', status: 'open' }, { id: 'EPIC-1.1', status: 'open' }];

const tmpDirs = [];
after(() => { for (const d of tmpDirs) fs.rmSync(d, { recursive: true, force: true }); });
const reset = () => { clearLastSyncedTip(); clearTipProbeFailures(); invalidateSyncRemoteCache(); };
beforeEach(reset);
afterEach(reset);

/** Fake member: mutable version answers; records every command. */
function fakeMember({ bd = BEADS_VERSION, dolt = DOLT_VERSION } = {}) {
    const state = { bd, dolt, calls: [], pulls: 0 };
    async function command(cmd, opts = {}) {
        state.calls.push({ cmd, opts });
        if (cmd === TOOL_VERSION_PROBES.bd) {
            return state.bd === null ? { ok: false, error: 'bd: command not found' } : { ok: true, output: `bd version ${state.bd}\n` };
        }
        if (cmd === TOOL_VERSION_PROBES.dolt) {
            return state.dolt === null ? { ok: false, error: 'dolt: command not found' } : { ok: true, output: `dolt version ${String(state.dolt).replace(/^v/, '')}\n` };
        }
        if (cmd.startsWith('bd config get sync.remote')) return { ok: true, output: JSON.stringify({ key: 'sync.remote', value: 'git+https://example.test/o/b.git' }) };
        if (cmd.includes(' ls-remote ')) return { ok: true, output: `${SHA_A}\trefs/dolt/data\n` };
        if (cmd === 'bd dolt pull') { state.pulls += 1; return { ok: true, output: '' }; }
        return { ok: false, error: `unexpected command: ${cmd}` };
    }
    const ran = (cmd) => state.calls.filter((c) => c.cmd === cmd).length;
    return { state, command, ran };
}

const readyMember = (name = MEMBER) => ({ get: () => ({ member: { name }, status: 'ready', reason: null }) });

function makeView(member, extra = {}) {
    const list = { calls: 0 };
    const view = createBeadsView({
        backlogMember: readyMember(),
        command: member.command,
        repoRoot: os.tmpdir(),
        listAllBeads: async () => { list.calls += 1; return ROWS; },
        logger: QUIET,
        ...extra,
    });
    return { view, list };
}

function assertPinMessage(text, { tool, found }) {
    assert.ok(text.includes(`'${MEMBER}'`), `names the member: ${text}`);
    assert.ok(text.includes(`${tool} ${found}`), `names the found version: ${text}`);
    assert.ok(text.includes(`expected ${tool} ${tool === 'bd' ? PINNED_MM : DOLT_VERSION.replace(/^v/, '').split('.').slice(0, 2).join('.')}.x`), `names the expected version: ${text}`);
    assert.ok(text.includes(TOOL_VERSION_FIX), `carries the fix text: ${text}`);
}

describe('beads view version pin: off-pin bd', () => {
    test('A: refresh issues no bd dolt pull and no bd list, and lastError names member/found/expected/fix', async () => {
        const member = fakeMember({ bd: OFF_PIN_BD });
        let pullFakeCalls = 0;
        const { view, list } = makeView(member, { doltPullBefore: async () => { pullFakeCalls += 1; return {}; } });
        const snap = await view.refresh();
        assert.equal(member.ran('bd dolt pull'), 0);
        assert.equal(pullFakeCalls, 0, 'doltPullBefore never called');
        assert.equal(list.calls, 0, 'no bd list');
        assert.equal(snap.rows, null);
        assert.ok(snap.lastError, 'error recorded');
        assertPinMessage(snap.lastError.message, { tool: 'bd', found: OFF_PIN_BD });
        // The probe went through command() with member_name.
        const probe = member.state.calls.find((c) => c.cmd === TOOL_VERSION_PROBES.bd);
        assert.equal(probe.opts.member_name, MEMBER);
    });

    test('B: freshForLaunch rejects with BeadsViewUnavailableError carrying the pin text; the launch is refused with no pull', async () => {
        const member = fakeMember({ bd: OFF_PIN_BD });
        const { view, list } = makeView(member);
        const err = await view.freshForLaunch().then(() => assert.fail('expected rejection'), (e) => e);
        assert.ok(err instanceof BeadsViewUnavailableError);
        assert.equal(err.kind, 'error');
        assertPinMessage(err.reason, { tool: 'bd', found: OFF_PIN_BD });

        // Through the real launch path.
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pin-launch-'));
        tmpDirs.push(dir);
        const ledger = createLedger({ filePath: path.join(dir, 'ledger.json') });
        await ledger.start();
        const member2 = fakeMember({ bd: OFF_PIN_BD });
        const view2 = createBeadsView({ backlogMember: readyMember(), ledger, command: member2.command, repoRoot: dir, listAllBeads: async () => ROWS, logger: QUIET });
        const spawned = [];
        const scopeGuard = createLaunchScopeGuard({ ledger, beadsView: view2, launchFetchOpts: { retryDelayMs: 0 } });
        const controller = createSprintController({
            ledger,
            spawner: { spawnSprint: async (o) => { spawned.push(o); return { pid: 1, port: 2 }; } },
            listMembers: () => ({ members: [] }),
            getBacklog: () => ({ tasks: [] }),
            beforeLaunch: composeBeforeLaunch({ memberOverlapGuard: async () => {}, scopeGuard }),
        });
        const launchErr = await controller.launch({ issue: 'EPIC-1.1', members: ['alice'], branch: 'feat/x', base: 'main' }).then(() => assert.fail('expected refusal'), (e) => e);
        assert.ok(launchErr instanceof ApiError, String(launchErr));
        assert.equal(launchErr.status, 503);
        assertPinMessage(launchErr.message, { tool: 'bd', found: OFF_PIN_BD });
        assert.equal(spawned.length, 0, 'spawner not called');
        assert.equal(member2.ran('bd dolt pull'), 0, 'no pull on the launch path');
        assert.equal(list.calls, 0);
    });

    test('a bd that cannot be probed at all (transport failure) is a failure, never a pass', async () => {
        const member = fakeMember({ bd: null });
        const { view, list } = makeView(member);
        const snap = await view.refresh();
        assert.equal(member.ran('bd dolt pull'), 0);
        assert.equal(list.calls, 0);
        assert.ok(snap.lastError);
    });
});

describe('beads view version pin: pinned bd', () => {
    test('C: a pinned bd pulls and lists rows as before', async () => {
        const member = fakeMember();
        const { view, list } = makeView(member);
        const snap = await view.refresh();
        assert.equal(member.ran('bd dolt pull'), 1);
        assert.equal(list.calls, 1);
        assert.deepEqual(snap.rows, ROWS);
        assert.equal(snap.lastError, null);
    });

    test('a passing check is cached per member name, not re-probed on every refresh', async () => {
        const member = fakeMember();
        const { view } = makeView(member);
        await view.refresh();
        await view.refresh();
        assert.equal(member.ran(TOOL_VERSION_PROBES.bd), 1);
    });

    test('D: after an off-pin failure, answering the pinned version makes the next refresh pull and clear lastError', async () => {
        const member = fakeMember({ bd: OFF_PIN_BD });
        const { view, list } = makeView(member);
        const failed = await view.refresh();
        assert.ok(failed.lastError);
        assert.equal(member.ran('bd dolt pull'), 0);
        member.state.bd = BEADS_VERSION; // fixed on the member; no restart
        const ok = await view.refresh();
        assert.equal(member.ran('bd dolt pull'), 1);
        assert.equal(list.calls, 1);
        assert.equal(ok.lastError, null);
        assert.deepEqual(ok.rows, ROWS);
    });
});

describe('beads view version pin: dolt', () => {
    test('E: a dolt off the pinned major.minor blocks the pull', async () => {
        const member = fakeMember({ dolt: OFF_PIN_DOLT });
        const { view, list } = makeView(member);
        const snap = await view.refresh();
        assert.equal(member.ran('bd dolt pull'), 0);
        assert.equal(list.calls, 0);
        assert.ok(snap.lastError);
        assertPinMessage(snap.lastError.message, { tool: 'dolt', found: OFF_PIN_DOLT });
    });

    test('E: dolt absent does not block the pull', async () => {
        const member = fakeMember({ dolt: null });
        const { view, list } = makeView(member);
        const snap = await view.refresh();
        assert.equal(member.ran('bd dolt pull'), 1);
        assert.equal(list.calls, 1);
        assert.equal(snap.lastError, null);
    });
});
