import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createGitSync, createSyncBrackets } from '../fleet-sprint/git-sync.mjs';
import { createVcsAuthPreflightCallback } from '../fleet-sprint/vcs-auth.mjs';
import { preflightBeadsHealthGate, invalidateSyncRemoteCache, clearLastSyncedTip, clearTipProbeFailures } from '../fleet-sprint/dolt-sync.mjs';
import { DoltSyncError, UnpublishedSchemaMigrationsError } from '../fleet-sprint/errors.mjs';

// =============================================================================
// Three small contracts, all driven with a stubbed command()/callTool (no real
// bd or fleet server -- "recorded/stubbed command sequence" rather than a
// real-bd older-schema fixture, which the real-bd lane cannot produce cheaply):
//
//   A. every "needs a fresh VCS credential" preflight line (Plan-style
//      beads-only dispatch AND Develop-style code dispatch) is followed by
//      exactly one outcome line: provisioned / skipped(reason) / failed.
//   B. the backlog member's beads D-pull/D-push (createGitSync.syncBeadsBefore
//      / syncBeadsAfter / pushBeadsAfter, which bypass withGitSync) run
//      ensureVcsAuthFresh first and heal an auth failure via onAuthFailure.
//   C. preflightBeadsHealthGate publishes unpushed local schema migrations
//      ("local changes would be stomped by merge: events") and retries once,
//      or fails with a typed error naming the cause and the fix.
// =============================================================================

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OK = { ok: true, output: '', error: null };
const fail = (error) => ({ ok: false, output: '', error });

beforeEach(() => {
    invalidateSyncRemoteCache();
    clearLastSyncedTip();
    clearTipProbeFailures();
});

function makeCommandMock(script = {}) {
    const calls = [];
    const queues = new Map(Object.entries(script).map(([k, v]) => [k, [...v]]));
    const command = async (cmd, opts = {}) => {
        calls.push({ cmd, opts });
        for (const [key, queue] of queues) {
            if (cmd.includes(key)) return queue.length > 1 ? queue.shift() : queue[0];
        }
        if (cmd.includes('bd config get sync.remote')) return { ok: true, output: '{"value":"origin"}', error: null };
        return OK;
    };
    return { command, calls };
}

const MEMBER_DETAIL_GITHUB = { content: [{ text: JSON.stringify({ vcsProvider: 'github' }) }] };
const remoteCommand = async (cmd) => (cmd === 'git remote get-url origin'
    ? { ok: true, output: 'https://github.com/acme/widgets.git', error: null }
    : OK);
const expiryIn = (ms) => new Date(Date.now() + ms).toISOString();
const provisioned = (expiresAt) => ({ content: [{ text: 'ok' }], structuredContent: { ok: true, reason: 'ok', expiresAt } });

function makeSync({ callTool, withEnsure = true } = {}) {
    const logs = [];
    const log = (m) => logs.push(m);
    const { command, calls } = makeCommandMock();
    const ensureVcsAuthFresh = createVcsAuthPreflightCallback({ callTool, command: remoteCommand, log });
    const gitSync = createGitSync({
        brackets: createSyncBrackets({ setPauseGuard: () => {} }),
        command, log, branch: 'b', baseBranch: 'main', args: {},
        agent: async () => ({}), doltPushMutex: undefined, sprintId: 's',
        onAuthFailure: undefined, resolveMemberProvider: undefined,
        ensureVcsAuthFresh: withEnsure ? ensureVcsAuthFresh : undefined,
        syncMemberBefore: async () => {}, syncMemberAfter: async () => {},
        syncMemberAfterOrdered: async () => {}, isNoMutationDispatchFailure: () => false,
    });
    return { gitSync, logs, calls };
}

const needsIdx = (logs) => logs.map((l, i) => (/needs a fresh VCS credential/.test(l) ? i : -1)).filter((i) => i >= 0);
const OUTCOME = /provision_vcs_auth (succeeded|skipped|failed) for member/;
/** Lines after the "needs" line at `i` (up to the next "needs" line) that are outcome lines. */
const outcomesAfter = (logs, i) => {
    const next = needsIdx(logs).find((n) => n > i) ?? logs.length;
    return logs.slice(i + 1, next).filter((l) => OUTCOME.test(l));
};

describe('A. needsVcsAuth preflight always states an outcome', () => {
    const dispatches = [
        ['Plan-style (beads-only)', false, true],
        ['Develop-style (code)', true, true],
    ];
    for (const [label, pushCode, pushBeads] of dispatches) {
        test(`${label}: provisions on first call, then skips with the cached-fresh reason`, async () => {
            const provisionCalls = [];
            const callTool = async (name, a) => {
                if (name === 'member_detail') return MEMBER_DETAIL_GITHUB;
                provisionCalls.push(a);
                return provisioned(expiryIn(60 * 60 * 1000));
            };
            const { gitSync, logs } = makeSync({ callTool });
            await gitSync.withGitSync('m1', pushCode, async () => 'r', { pushBeads });
            await gitSync.withGitSync('m1', pushCode, async () => 'r', { pushBeads });
            assert.equal(provisionCalls.length, 1, 'provision_vcs_auth called exactly once');
            const needs = needsIdx(logs);
            assert.equal(needs.length, 2);
            const first = outcomesAfter(logs, needs[0]);
            const second = outcomesAfter(logs, needs[1]);
            assert.equal(first.length, 1, `exactly one outcome after first needs line: ${JSON.stringify(first)}`);
            assert.match(first[0], /succeeded/);
            assert.equal(second.length, 1, `exactly one outcome after second needs line: ${JSON.stringify(second)}`);
            assert.match(second[0], /skipped.*cached credential fresh until/);
        });
    }

    test('PAT/no-expiry: second call skips and says PAT mode', async () => {
        const callTool = async (name) => (name === 'member_detail' ? MEMBER_DETAIL_GITHUB : provisioned(null));
        const { gitSync, logs } = makeSync({ callTool });
        await gitSync.withGitSync('m1', true, async () => 'r');
        await gitSync.withGitSync('m1', true, async () => 'r');
        const needs = needsIdx(logs);
        assert.match(outcomesAfter(logs, needs[1])[0], /skipped.*PAT mode/);
        assert.equal(outcomesAfter(logs, needs[1]).length, 1);
    });

    test('provision failure: one failed outcome line with the error, dispatch still runs', async () => {
        const callTool = async (name) => {
            if (name === 'member_detail') return MEMBER_DETAIL_GITHUB;
            throw new Error('fleet server unreachable (injected)');
        };
        const { gitSync, logs } = makeSync({ callTool });
        let ran = false;
        await gitSync.withGitSync('m1', true, async () => { ran = true; });
        assert.ok(ran);
        const out = outcomesAfter(logs, needsIdx(logs)[0]);
        assert.equal(out.length, 1);
        assert.match(out[0], /failed.*fleet server unreachable/);
    });

    test('no-callTool wiring: runner.js fallback logs a skip reason instead of returning silently', () => {
        const src = fs.readFileSync(path.join(__dirname, '../fleet-sprint/runner.js'), 'utf8');
        assert.match(src, /provision_vcs_auth skipped for member '\$\{member\}': no callTool wired/);
    });
});

describe('B. backlog member beads sync refreshes its credential', () => {
    test('ensureVcsAuthFresh precedes the readiness-gate D-pull (first beads sync of the sprint)', async () => {
        const order = [];
        const { command } = makeCommandMock();
        const tracked = async (cmd, o) => { order.push(`cmd:${cmd}`); return command(cmd, o); };
        const gitSync = createGitSync({
            brackets: createSyncBrackets({ setPauseGuard: () => {} }),
            command: tracked, log: () => {}, branch: 'b', args: {}, doltPushMutex: undefined, sprintId: 's',
            ensureVcsAuthFresh: async (m) => { order.push(`ensure:${m}`); },
        });
        await gitSync.syncBeadsBefore('backlog', { readinessGate: true });
        assert.equal(order[0], 'ensure:backlog');
        assert.ok(order.some((c) => c.startsWith('cmd:') && c.includes('bd dolt pull')));
    });

    test('expired-token D-push is classified auth, provisions, retries once, no DEGRADED record', async () => {
        const AUTH = 'Error 1105: could not read Username for \'https://github.com\': terminal prompts disabled';
        const { command, calls } = makeCommandMock({ 'bd dolt push': [fail(AUTH), OK] });
        let healed = 0;
        const onAuthFailure = async () => { healed += 1; };
        const gitSync = createGitSync({
            brackets: createSyncBrackets({ setPauseGuard: () => {} }),
            command, log: () => {}, branch: 'b', args: {}, doltPushMutex: undefined, sprintId: 's',
            onAuthFailure, ensureVcsAuthFresh: async () => {},
        });
        const res = await gitSync.syncBeadsAfter('backlog', { pushBeads: true });
        assert.equal(healed, 1, 'onAuthFailure heal ran once');
        assert.equal(calls.filter((c) => c.cmd.includes('bd dolt push')).length, 2, 'one retry');
        assert.ok(!res || !res.degraded, `not degraded: ${JSON.stringify(res)}`);
    });

    test('while fresh, repeated backlog syncs make no extra provision_vcs_auth calls', async () => {
        let provisions = 0;
        const callTool = async (name) => {
            if (name === 'member_detail') return MEMBER_DETAIL_GITHUB;
            provisions += 1;
            return provisioned(expiryIn(60 * 60 * 1000));
        };
        const { gitSync } = makeSync({ callTool });
        await gitSync.syncBeadsBefore('backlog', { readinessGate: true });
        await gitSync.syncBeadsBefore('backlog', { fatal: true });
        await gitSync.syncBeadsAfter('backlog', { pushBeads: true });
        await gitSync.pushBeadsAfter('backlog', { pushBeads: true });
        assert.equal(provisions, 1);
    });
});

describe('C. migrated-but-unpushed beads clone at the preflight D-pull', () => {
    const STOMPED = 'Error: merge origin/main: Error 1105: error: local changes would be stomped by merge: events';

    test('stomped-by-merge on first pull -> one push under the mutex, second pull, gate passes', async () => {
        const { command, calls } = makeCommandMock({ 'bd dolt pull': [fail(STOMPED), OK], 'bd dolt push': [OK] });
        const mutexEvents = [];
        const mutex = {
            acquire: async () => { mutexEvents.push('acquire'); return { token: 't' }; },
            release: async () => { mutexEvents.push('release'); },
        };
        const res = await preflightBeadsHealthGate('backlog', { command, mutex, sprintId: 's', remoteTipFingerprint: false });
        assert.equal(res.ok, true);
        const seq = calls.map((c) => c.cmd).filter((c) => /bd dolt (pull|push)/.test(c));
        assert.deepEqual(seq.map((c) => c.match(/bd dolt (pull|push)/)[1]), ['pull', 'push', 'pull']);
        assert.ok(mutexEvents.includes('acquire') && mutexEvents.includes('release'), 'publish took the push mutex');
    });

    test('push fails -> UnpublishedSchemaMigrationsError naming cause and fix, not a bare D-pull message', async () => {
        const { command } = makeCommandMock({
            'bd dolt pull': [fail(STOMPED)],
            'bd dolt push': [fail('Error 1105: could not read Username for \'https://github.com\': terminal prompts disabled')],
        });
        await assert.rejects(
            () => preflightBeadsHealthGate('backlog', { command, remoteTipFingerprint: false }),
            (err) => {
                assert.ok(err instanceof UnpublishedSchemaMigrationsError, String(err));
                assert.ok(err instanceof DoltSyncError);
                assert.match(err.message, /unpublished local schema migrations/);
                assert.match(err.message, /bd dolt push/);
                assert.match(err.message, /provision_vcs_auth/);
                return true;
            },
        );
    });

    test('other D-pull failures keep their handling (no publish attempted)', async () => {
        const { command, calls } = makeCommandMock({ 'bd dolt pull': [fail('Error 1105: some unrelated failure')] });
        await assert.rejects(
            () => preflightBeadsHealthGate('backlog', { command, remoteTipFingerprint: false, maxTransientRetries: 0 }),
            (err) => err instanceof DoltSyncError && !(err instanceof UnpublishedSchemaMigrationsError),
        );
        assert.equal(calls.filter((c) => c.cmd.includes('bd dolt push')).length, 0);
    });

    test('syncBeadsBefore readinessGate: auth precedes the first pull and a stomped pull is healed (3 ordering)', async () => {
        const order = [];
        const { command } = makeCommandMock({ 'bd dolt pull': [fail(STOMPED), OK] });
        const tracked = async (cmd, o) => { order.push(cmd.includes('bd dolt') ? cmd : null); return command(cmd, o); };
        const gitSync = createGitSync({
            brackets: createSyncBrackets({ setPauseGuard: () => {} }),
            command: tracked, log: () => {}, branch: 'b', args: {}, doltPushMutex: undefined, sprintId: 's',
            ensureVcsAuthFresh: async () => { order.push('ensure'); },
        });
        await gitSync.syncBeadsBefore('backlog', { readinessGate: true });
        const flat = order.filter(Boolean);
        assert.equal(flat[0], 'ensure');
        assert.ok(flat.filter((c) => c.includes('bd dolt push')).length === 1);
    });
});
