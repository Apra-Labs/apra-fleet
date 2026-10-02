import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
    createMemberInitProbe,
    CODE_INDEX_FIRST_TICK_BOUND_MS,
    formatMemberInitLine,
} from '../fleet-sprint/member-init-probe.mjs';

// =============================================================================
// Per-member sprint-init probe, unit level: fakes for the orchestrator
// callTool (member_detail only), the member session (memberCall / listTools),
// the member command channel (fleetApi.executeCommand) and an injectable
// clock. The runner-level wiring is covered by
// mock-sprint-member-init-probe.test.mjs.
// =============================================================================

const ALL_TOOLS = { tools: [{ name: 'kb_query' }, { name: 'kb_stats' }, { name: 'code_query' }, { name: 'code_reindex' }, { name: 'version' }] };

function uuid(name) {
    return `0b9d3a1e-5f2c-4c6e-9a7b-${Buffer.from(name).toString('hex').padEnd(12, '0').slice(0, 12)}`;
}

/**
 * Build a fully observable fake fleet. Every channel records its calls into
 * one ordered `events` list so the step order can be asserted.
 */
function fakeFleet(spec = {}) {
    const {
        type = 'remote',
        provider = 'claude',
        fleetMcp = { state: 'available', checkedAt: 'x' },
        serverState = 'running',
        tools = ALL_TOOLS,
        stats = { totals: { by_confidence: { CONFIRMED: 4 } } },
        reindex = { outcome: 'started', pid: 1, lastLine: 'x', lockHeld: true, logPath: 'l', indexedCommit: null },
        status = () => ({ ready: true }),
        unresolved = [],
        fail = {},
    } = spec;
    const events = [];
    const orchestratorCalls = [];
    const memberCalls = [];
    let t = 0;
    const clock = { now: () => t, sleep: async (ms) => { events.push(`sleep:${ms}`); t += ms; } };
    const callTool = async (name, args) => {
        orchestratorCalls.push({ name, args });
        events.push(args && args.refresh ? `orch:${name}:refresh` : `orch:${name}`);
        if (name !== 'member_detail') throw new Error(`unexpected orchestrator tool ${name}`);
        if (unresolved.includes(args.member_name)) return { content: [{ text: JSON.stringify({ vcsProvider: 'github' }) }] };
        if (fail.memberDetailRefresh && args.refresh) throw new Error('refresh exploded');
        const body = { id: uuid(args.member_name), type, llmProvider: provider, folder: `/w/${args.member_name}` };
        if (args.refresh) body.fleetMcp = typeof fleetMcp === 'function' ? fleetMcp(args.member_name) : fleetMcp;
        return { content: [{ text: JSON.stringify(body) }] };
    };
    const memberCall = async (member, tool, args) => {
        memberCalls.push({ member: member.name, id: member.id, tool, args });
        events.push(`member:${tool}`);
        if (fail[tool]) throw fail[tool];
        if (tool === 'kb_stats') return { content: [{ type: 'text', text: JSON.stringify(stats) }] };
        if (tool === 'code_reindex') return { content: [{ type: 'text', text: JSON.stringify(reindex) }] };
        if (tool === 'code_status') return { content: [{ type: 'text', text: JSON.stringify(status(clock.now())) }] };
        throw new Error(`unexpected member tool ${tool}`);
    };
    const listTools = async (member) => {
        memberCalls.push({ member: member.name, id: member.id, tool: 'tools/list' });
        events.push('member:tools/list');
        if (fail.listTools) throw fail.listTools;
        return tools;
    };
    const commands = [];
    const fleetApi = {
        executeCommand: async ({ member_id, command }) => {
            commands.push({ member_id, command });
            if (/apra-fleet status/.test(command)) {
                events.push('cmd:status');
                if (fail.status) return { isError: true, content: [{ type: 'text', text: 'apra-fleet: command not found' }] };
                return { content: [{ type: 'text', text: `apra-fleet status\n  State:    ${serverState}\n` }] };
            }
            if (/apra-fleet start/.test(command)) {
                events.push('cmd:start');
                if (fail.start) return { isError: true, content: [{ type: 'text', text: 'Server did not start in time' }] };
                return { content: [{ type: 'text', text: 'Server started at http://x pid=1' }] };
            }
            throw new Error(`unexpected command ${command}`);
        },
    };
    const logs = [];
    const make = (members, extra = {}) => createMemberInitProbe({
        members, callTool, memberCall, listTools, fleetApi,
        resolveTarget: async () => ({ os: 'linux', shell: 'bash' }),
        now: clock.now, sleep: clock.sleep, log: (l) => logs.push(l), ...extra,
    });
    return { make, events, orchestratorCalls, memberCalls, commands, logs, clock };
}

test('remote member: start-if-down, MEMBER tools/list, fleetMcp refresh, CONFIRMED count, code_reindex -- in that order', async () => {
    const f = fakeFleet({ serverState: 'stopped', reindex: { outcome: 'starting', firstTick: false }, status: (now) => (now >= 4000 ? { ready: false, analyze: { phase: 'running', lineCount: 3 } } : { ready: false, analyze: null }) });
    const [rec] = await f.make(['m1']).probeAll();
    assert.deepEqual(f.events, [
        'orch:member_detail',
        'cmd:status',
        'cmd:start',
        'member:tools/list',
        'orch:member_detail:refresh',
        'member:kb_stats',
        'member:code_reindex',
        'sleep:2000', 'member:code_status',
        'sleep:2000', 'member:code_status',
    ]);
    assert.equal(rec.server, 'started');
    assert.equal(rec.verified, true);
    assert.equal(rec.reason, null);
    assert.equal(rec.fix, null);
    assert.equal(rec.kbTools, true);
    assert.equal(rec.codeTools, true);
    assert.equal(rec.confirmedCount, 4);
    assert.equal(rec.codeIndex, 'ok');
    assert.deepEqual(rec.steps, ['resolve', 'server', 'tools', 'fleetMcp', 'count', 'code']);
    // The start-if-down commands carry no shell-level expansion.
    for (const c of f.commands) assert.doesNotMatch(c.command, /\$|~\/|`/);
});

test('a running remote server is not restarted; a local member skips the server step entirely', async () => {
    const remote = fakeFleet({ serverState: 'running' });
    const [r] = await remote.make(['m1']).probeAll();
    assert.equal(r.server, 'up');
    assert.deepEqual(remote.events.filter((e) => e.startsWith('cmd:')), ['cmd:status']);

    const local = fakeFleet({ type: 'local' });
    const [l] = await local.make(['m1']).probeAll();
    assert.equal(l.server, 'skipped');
    assert.deepEqual(local.commands, [], 'a local member shares the orchestrator server: no command is issued');
    assert.equal(l.verified, true);
});

test('the 30 s bound: a code_status that never ticks ends in a recorded timeout (fake clock), not a hang', async () => {
    const f = fakeFleet({ reindex: { outcome: 'starting', firstTick: false }, status: () => ({ ready: false, readiness: 'building', analyze: null }) });
    const [rec] = await f.make(['m1']).probeAll();
    assert.equal(rec.codeIndex, 'timeout');
    assert.equal(rec.codeIndexReason, 'code-index-timeout');
    assert.ok(f.clock.now() <= CODE_INDEX_FIRST_TICK_BOUND_MS, `waited ${f.clock.now()} ms, more than the bound`);
    assert.ok(f.clock.now() >= CODE_INDEX_FIRST_TICK_BOUND_MS - 2000, `gave up early at ${f.clock.now()} ms`);
    const polls = f.events.filter((e) => e === 'member:code_status').length;
    assert.ok(polls >= 10 && polls <= 15, `expected a bounded number of polls, got ${polls}`);
    const p = rec.problems.find((x) => x.step === 'code');
    assert.ok(p && p.fix, 'the timeout carries a one-line fix');
    // Not fatal and not gating: the member is still verified.
    assert.equal(rec.verified, true);
});

test('the fleetMcp status is refreshed (recorded server-side) through member_detail refresh:true, after the tools/list check', async () => {
    const f = fakeFleet({ fleetMcp: { state: 'available', checkedAt: 'now' } });
    const [rec] = await f.make(['m1']).probeAll();
    const refreshes = f.orchestratorCalls.filter((c) => c.name === 'member_detail' && c.args.refresh === true);
    assert.equal(refreshes.length, 1);
    assert.deepEqual(refreshes[0].args, { member_name: 'm1', format: 'json', refresh: true });
    assert.ok(f.events.indexOf('orch:member_detail:refresh') > f.events.indexOf('member:tools/list'));
    assert.deepEqual(rec.fleetMcp, { state: 'available', reason: null });
});

test('missing per-folder MCP entry -> unverified (mcp-entry-missing) even though the member session lists kb_* and code_*', async () => {
    const f = fakeFleet({ fleetMcp: { state: 'unavailable', reason: 'mcp-entry-missing', detail: 'no per-folder apra-fleet MCP entry', checkedAt: 'x' } });
    const [rec] = await f.make(['m1']).probeAll();
    assert.equal(rec.kbTools, true);
    assert.equal(rec.codeTools, true);
    assert.equal(rec.verified, false);
    assert.equal(rec.reason, 'mcp-entry-missing');
    assert.match(rec.fix, /\?member=<uuid>/);
});

test('an MCP entry lacking ?member=<uuid> (server reports mcp-entry-missing pointing elsewhere) -> unverified', async () => {
    const f = fakeFleet({ fleetMcp: { state: 'unavailable', reason: 'mcp-entry-missing', detail: 'per-folder apra-fleet entry points at http://h/mcp, not ?member=abc', checkedAt: 'x' } });
    const [rec] = await f.make(['m1']).probeAll();
    assert.equal(rec.verified, false);
    assert.equal(rec.reason, 'mcp-entry-missing');
    assert.match(rec.problems.find((p) => p.reason === 'mcp-entry-missing').detail, /not \?member=/);
});

test('opencode -> unverified no-per-tool-deny although its member session lists the tools and its entry carries ?member=<uuid>', async () => {
    // The server records opencode as available (its opencode.json entry ends with ?member=<uuid>).
    const f = fakeFleet({ provider: 'opencode', fleetMcp: { state: 'available', checkedAt: 'x' } });
    const [rec] = await f.make(['oc']).probeAll();
    assert.equal(rec.kbTools, true);
    assert.equal(rec.codeTools, true);
    assert.deepEqual(rec.fleetMcp, { state: 'available', reason: null });
    assert.equal(rec.verified, false);
    assert.equal(rec.reason, 'no-per-tool-deny');
    assert.ok(rec.fix && !rec.fix.includes('\n'));
});

test('agy -> unverified no-per-project-mcp', async () => {
    const f = fakeFleet({ provider: 'agy', fleetMcp: { state: 'unavailable', reason: 'no-per-project-mcp', unverified: true, checkedAt: 'x' } });
    const [rec] = await f.make(['ag']).probeAll();
    assert.equal(rec.verified, false);
    assert.equal(rec.reason, 'no-per-project-mcp');
    assert.ok(rec.fix);
});

test('code intelligence "disabled" is recorded unavailable, never ok', async () => {
    const disabled = Object.assign(new Error('E-CODE-INTEL-DISABLED: code intelligence is disabled (provider none)'), { code: 'E-TOOL' });
    const f = fakeFleet({ fail: { code_reindex: disabled } });
    const [rec] = await f.make(['m1']).probeAll();
    assert.equal(rec.codeIndex, 'unavailable');
    assert.notEqual(rec.codeIndex, 'ok');
    assert.equal(rec.codeIndexReason, 'code-intel-disabled');

    const g = fakeFleet({ reindex: { outcome: 'not-started', reason: 'provider-not-supported', provider: 'codebase-memory', indexedCommit: null } });
    const [r2] = await g.make(['m1']).probeAll();
    assert.equal(r2.codeIndex, 'unavailable');
});

test('a member failing every check: records for ALL members, no throw, reason + one-line fix on every unverified record', async () => {
    const boom = new Error('member unreachable');
    const f = fakeFleet({
        unresolved: ['ghost'],
        fail: { status: true, listTools: boom, memberDetailRefresh: true, kb_stats: boom, code_reindex: boom },
    });
    const recs = await f.make(['bad', 'ghost', 'bad2']).probeAll();
    assert.deepEqual(recs.map((r) => r.member), ['bad', 'ghost', 'bad2']);
    for (const r of recs) {
        assert.equal(r.verified, false);
        assert.equal(typeof r.reason, 'string');
        assert.equal(typeof r.fix, 'string');
        assert.ok(r.fix.length > 0 && !r.fix.includes('\n'));
        for (const p of r.problems) assert.ok(p.reason && p.fix, JSON.stringify(p));
    }
    const bad = recs[0];
    assert.equal(bad.reason, 'server-status-failed');
    assert.deepEqual(bad.problems.map((p) => p.step), ['server', 'tools', 'fleetMcp', 'count', 'code']);
    assert.equal(bad.codeIndex, 'failed');
    assert.equal(recs[1].reason, 'member-unresolved');
    // One WARN line per member, naming reason and fix.
    assert.equal(f.logs.length, 3);
    for (const [i, r] of recs.entries()) {
        assert.equal(f.logs[i], `[member-init] WARN member '${r.member}': unverified -- reason: ${r.reason}; fix: ${r.fix}`);
    }
});

test('transport: no kb_* or code_* call ever reaches the orchestrator callTool; all of them arrive on memberCall', async () => {
    const f = fakeFleet({ reindex: { outcome: 'starting', firstTick: false }, status: () => ({ ready: true }) });
    await f.make(['m1', 'm2']).probeAll();
    assert.ok(f.orchestratorCalls.length > 0);
    for (const c of f.orchestratorCalls) {
        assert.doesNotMatch(c.name, /^(kb_|code_)/, `orchestrator session called ${c.name}`);
        assert.equal(c.name, 'member_detail');
    }
    const memberTools = f.memberCalls.map((c) => c.tool);
    assert.ok(memberTools.includes('kb_stats'));
    assert.ok(memberTools.includes('code_reindex'));
    assert.ok(memberTools.includes('code_status'));
    for (const c of f.memberCalls) assert.equal(c.id, uuid(c.member), 'kb/code calls run AS the probed member');
});

test('the kb_maintainer selection is consumed, not re-made', async () => {
    let calls = 0;
    const selector = {
        repoOf: (m) => (m === 'm1' ? 'github.com/o/r' : null),
        maintainerForMember: (m) => { calls++; return m === 'm1' ? { member: 'keeper', rule: 'role-less' } : null; },
        selectAll: () => { throw new Error('the probe must never re-select'); },
    };
    const f = fakeFleet();
    const [rec] = await f.make(['m1'], { kbMaintainers: () => selector }).probeAll();
    assert.equal(rec.repo, 'github.com/o/r');
    assert.equal(rec.maintainer, 'keeper');
    assert.equal(calls, 1);
    assert.match(formatMemberInitLine(rec), /^\[member-init\] OK member 'm1': verified .*kb_maintainer: 'keeper'$/);
});
