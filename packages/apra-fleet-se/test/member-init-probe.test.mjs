import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
    createMemberInitProbe,
    CODE_INDEX_FIRST_TICK_BOUND_MS,
    formatMemberInitLine,
    MEMBER_INIT_FIXES,
    llmRoleMembersOf,
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
        fleetMcpFix = null,
        serverVersion = undefined,
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
        const memberProvider = typeof provider === 'function' ? provider(args.member_name) : provider;
        const body = { id: uuid(args.member_name), type, llmProvider: memberProvider, folder: `/w/${args.member_name}` };
        if (serverVersion !== undefined) body.server_version = serverVersion;
        if (args.refresh && fleetMcpFix) body.fleetMcpFix = fleetMcpFix;
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

test('role files hiding the member tools from --agent sessions (role-agents-hide-member-tools) -> unverified with its own fix, although the member session lists kb_* and code_*', async () => {
    const f = fakeFleet({ fleetMcp: { state: 'unavailable', reason: 'role-agents-hide-member-tools', detail: 'member role files differ from the canonical set: doer.md', checkedAt: 'x' } });
    const [rec] = await f.make(['m1']).probeAll();
    assert.equal(rec.kbTools, true);
    assert.equal(rec.codeTools, true);
    assert.equal(rec.verified, false);
    assert.equal(rec.reason, 'role-agents-hide-member-tools');
    assert.match(rec.fix, /--agent <role>/);
    assert.match(formatMemberInitLine(rec), /WARN member 'm1': unverified -- reason: role-agents-hide-member-tools/);
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

test('local claude member: verified on the server-side probe of the per-session config path -- no per-folder entry required, healed role files reported as detail, not as a failure', async () => {
    const f = fakeFleet({
        type: 'local',
        fleetMcp: { state: 'available', checkedAt: 'x', detail: 'rewrote role files that hid the member kb_*/code_* tools: doer.md' },
    });
    const [rec] = await f.make(['m1']).probeAll();
    assert.equal(rec.verified, true);
    assert.deepEqual(rec.problems, []);
    assert.equal(rec.server, 'skipped');
    assert.ok(f.orchestratorCalls.some((c) => c.args && c.args.refresh === true), 'the server-side probe (and its self-heal) runs through member_detail refresh:true');
    assert.match(f.logs[0], /OK member 'm1': verified/);
});

test('local claude member whose role files could not be healed -> unverified, and the fix names the rewrite that failed', async () => {
    const f = fakeFleet({ type: 'local', fleetMcp: { state: 'unavailable', reason: 'role-agents-hide-member-tools', checkedAt: 'x', detail: 'could not be rewritten' } });
    const [rec] = await f.make(['m1']).probeAll();
    assert.equal(rec.verified, false);
    assert.equal(rec.reason, 'role-agents-hide-member-tools');
    assert.match(rec.fix, /automatic rewrite failed/);
});


// ---- b4g.130: members that run no LLM role are neither probed nor counted ----

import { lowerQuality } from '../fleet-sprint/lower-quality.mjs';

const ROLE_MAP = { doer: ['worker'], reviewer: ['worker'], backlog: ['bl'] };

test('130 (a): a provider-none backlog-only member is not probed, logs no WARN, and is excluded from the lower-quality count', async () => {
    const f = fakeFleet({ provider: (n) => (n === 'bl' ? 'none' : 'claude') });
    const recs = await f.make(['worker', 'bl'], { roleMap: ROLE_MAP }).probeAll();
    assert.deepEqual(recs.map((r) => r.member), ['worker']);
    assert.ok(!f.orchestratorCalls.some((c) => c.args.member_name === 'bl'), 'no member_detail for the backlog member');
    assert.ok(!f.memberCalls.some((c) => c.member === 'bl'), 'no member-session call for the backlog member');
    assert.ok(!f.commands.some((c) => c.member_id === uuid('bl')), 'no command for the backlog member');
    assert.ok(!f.logs.some((l) => l.includes("'bl'")), `no log line for the backlog member: ${f.logs.join('|')}`);
    assert.ok(!f.logs.some((l) => /WARN/.test(l)));
    assert.equal(lowerQuality(recs).banner, null);
    assert.equal(lowerQuality(recs).total, 1);
});

test('130: llmRoleMembersOf keeps a backlog member that also holds another role, and every member when there is no role map', () => {
    assert.deepEqual(llmRoleMembersOf(['a', 'bl'], { doer: ['a'], backlog: ['bl'] }), ['a']);
    assert.deepEqual(llmRoleMembersOf(['a', 'bl'], { doer: ['a', 'bl'], backlog: ['bl'] }), ['a', 'bl']);
    assert.deepEqual(llmRoleMembersOf(['a', 'bl'], null), ['a', 'bl']);
    assert.deepEqual(llmRoleMembersOf(['a', 'b'], { backlog: ['b'] }), ['a']);
});

test('130 (b): an agy member that runs a role is still probed and counted with no-per-project-mcp', async () => {
    const f = fakeFleet({ provider: (n) => (n === 'agyw' ? 'agy' : 'claude') });
    const recs = await f.make(['agyw', 'bl'], { roleMap: { doer: ['agyw'], backlog: ['bl'] } }).probeAll();
    assert.equal(recs.length, 1);
    assert.equal(recs[0].reason, 'no-per-project-mcp');
    assert.equal(recs[0].fix, MEMBER_INIT_FIXES['no-per-project-mcp']);
    const lq = lowerQuality(recs);
    assert.equal(lq.unverified.length, 1);
    assert.match(lq.banner, /unavailable on 1 of 1 members/);
});

test('130 (c): a provider-none member that IS assigned an LLM role is not silently skipped: it counts with an accurate reason', async () => {
    const f = fakeFleet({ provider: 'none' });
    const recs = await f.make(['w'], { roleMap: { doer: ['w'], backlog: ['w'] } }).probeAll();
    assert.equal(recs.length, 1);
    assert.equal(recs[0].verified, false);
    assert.equal(recs[0].reason, 'no-llm-provider');
    assert.match(recs[0].fix, /provider none/);
    assert.equal(lowerQuality(recs).unverified.length, 1);
    assert.ok(f.logs.some((l) => /WARN member 'w'/.test(l)));
});

// ---- b4g.121: real cause and product action ----

test('121: no MEMBER_INIT_FIXES value is a bare "make X succeed" instruction', () => {
    for (const [k, v] of Object.entries(MEMBER_INIT_FIXES)) {
        assert.doesNotMatch(v, /^make '/, `${k}: ${v}`);
        assert.doesNotMatch(v, /^make\b[^:]*succeed/i, `${k}: ${v}`);
    }
});

test('121 cause: old apra-fleet without member mode (unknown option call) -> member-fleet-too-old naming update_member fleet_install auto and the version seen', async () => {
    const f = fakeFleet({
        fail: { listTools: new Error("Error: unknown option 'call'") },
        fleetMcp: { state: 'available', version: 'v0.1.9', checkedAt: 'x' },
    });
    const [rec] = await f.make(['m1']).probeAll();
    assert.equal(rec.verified, false);
    assert.equal(rec.reason, 'member-fleet-too-old');
    assert.match(rec.fix, /update_member/);
    assert.match(rec.fix, /fleet_install "auto"/);
    assert.match(rec.fix, /0\.1\.9/);
});

test('121 cause: install not fleet-owned -> the server reason full-install-running and its own remedy text are forwarded, not member-tools-failed', async () => {
    const remedy = 'The member apra-fleet install has no member-install marker; run update_member {member_id, fleet_install: "auto"}.';
    const f = fakeFleet({
        fail: { listTools: new Error("Error: unknown option 'call'") },
        fleetMcp: { state: 'unavailable', reason: 'full-install-running', detail: 'the apra-fleet 0.2.0 at /bin/apra-fleet has no member-install marker', checkedAt: 'x' },
        fleetMcpFix: remedy,
    });
    const [rec] = await f.make(['m1']).probeAll();
    assert.equal(rec.reason, 'full-install-running');
    assert.equal(rec.fix, remedy);
    assert.match(rec.problems.find((p) => p.reason === 'full-install-running').detail, /no member-install marker/);
    assert.notEqual(rec.reason, 'member-tools-failed');
});

test('121 cause: no installer for the os/arch -> unsupported-platform forwarded with the server remedy', async () => {
    const remedy = 'Install apra-fleet on the member by hand; no release asset exists for its OS/arch.';
    const f = fakeFleet({
        fail: { listTools: new Error("Error: unknown option 'call'") },
        fleetMcp: { state: 'unavailable', reason: 'unsupported-platform', detail: 'no release asset for freebsd/riscv64', checkedAt: 'x' },
        fleetMcpFix: remedy,
    });
    const [rec] = await f.make(['m1']).probeAll();
    assert.equal(rec.reason, 'unsupported-platform');
    assert.equal(rec.fix, remedy);
    assert.match(rec.problems.find((p) => p.reason === 'unsupported-platform').detail, /freebsd\/riscv64/);
});

test('121 cause: member session refused by the member server -> member-session-refused with its own fix', async () => {
    const f = fakeFleet({ fail: { listTools: new Error('server refused member 0b9d: not a registered member (HTTP 403)') } });
    const [rec] = await f.make(['m1']).probeAll();
    assert.equal(rec.reason, 'member-session-refused');
    assert.equal(rec.fix, MEMBER_INIT_FIXES['member-session-refused']);
    assert.match(rec.fix, /update_member/);
});

test('code step: npx/node missing on the service PATH is recorded with that cause, not the analyze-log fix', async () => {
    const cause = "npx was not found on the apra-fleet server's PATH (searched: /usr/bin). Install Node.js (which provides node and npx), then re-run 'apra-fleet install' to refresh the service PATH and restart the server.";
    const f = fakeFleet({ reindex: { outcome: 'not-started', reason: 'npx-not-found', detail: cause } });
    const [rec] = await f.make(['m1']).probeAll();
    assert.equal(rec.codeIndex, 'unavailable');
    assert.equal(rec.codeIndexReason, 'code-intel-npx-missing');
    const problem = rec.problems.find((p) => p.step === 'code');
    assert.ok(problem.detail.includes("npx was not found on the apra-fleet server's PATH"));
    assert.match(problem.fix, /service PATH/);
    assert.doesNotMatch(problem.fix, /analyze log/);

    // The same cause surfacing as a thrown per-call error is classified the same way.
    const g = fakeFleet({ fail: { code_reindex: new Error(cause) } });
    const [r2] = await g.make(['m1']).probeAll();
    assert.equal(r2.codeIndexReason, 'code-intel-npx-missing');
});

test('code_reindex rejected by an old gitnexus is reported with the version cause and the upgrade fix', async () => {
    const f = fakeFleet({ reindex: {
        outcome: 'not-started', reason: 'gitnexus-too-old', indexedCommit: null,
        detail: 'the installed gitnexus does not support --index-only (needs >= 1.6.5): upgrade gitnexus',
    } });
    const [rec] = await f.make(['m1']).probeAll();
    assert.equal(rec.codeIndex, 'failed');
    assert.equal(rec.codeIndexReason, 'code-index-gitnexus-too-old');
    const p = rec.problems.find((x) => x.step === 'code');
    assert.match(p.fix, /too old/);
    assert.match(p.fix, /upgrade gitnexus/);
    assert.match(p.fix, /clear the npx cache/);
    assert.notEqual(p.fix, 'code_reindex failed on the member; read its analyze log (code_status logPath) and rerun code_reindex');
    assert.match(formatMemberInitLine(rec), /code-index-gitnexus-too-old: .*upgrade gitnexus/);
});

test('a polled analyze that failed for the too-old cause gets the same cause', async () => {
    const f = fakeFleet({
        reindex: { outcome: 'starting', firstTick: false, pid: 1, note: 'n', logPath: 'l', indexedCommit: null },
        status: () => ({ ready: false, analyze: { phase: 'done', result: 'failed', failureCause: 'gitnexus-too-old', lastLine: "error: unknown option '--index-only'" } }),
    });
    const [rec] = await f.make(['m1']).probeAll();
    assert.equal(rec.codeIndexReason, 'code-index-gitnexus-too-old');
});

test('a work tree carrying a previously injected gitnexus block is warned about with file and fix; a clean one is not', async () => {
    const dirty = fakeFleet({ reindex: { outcome: 'started', pid: 1, lastLine: 'x', lockHeld: true, logPath: 'l', indexedCommit: null, injectedBlockFiles: ['CLAUDE.md'] } });
    const [rec] = await dirty.make(['m1']).probeAll();
    assert.equal(rec.warnings.length, 1);
    assert.match(rec.warnings[0], /CLAUDE\.md/);
    assert.match(rec.warnings[0], /remove the block/);
    assert.match(rec.warnings[0], /commit/);
    assert.match(formatMemberInitLine(rec), /WARN: CLAUDE\.md/);
    // a warning is not a gating failure
    assert.equal(rec.verified, true);

    const clean = fakeFleet({ reindex: { outcome: 'started', pid: 1, lastLine: 'x', lockHeld: true, logPath: 'l', indexedCommit: null, injectedBlockFiles: [] } });
    const [rec2] = await clean.make(['m1']).probeAll();
    assert.deepEqual(rec2.warnings, []);
    assert.doesNotMatch(formatMemberInitLine(rec2), /WARN: /);
});

// -----------------------------------------------------------------------------
// Install currency: a member install older than the orchestrator, or a remote
// kb_maintainer whose install lacks --kb-maintainer, is a NON-GATING
// member-fleet-outdated warning naming update_member fleet_install auto and
// both versions.
// -----------------------------------------------------------------------------

const RECORD_KEYS = ['member', 'memberId', 'type', 'provider', 'verified', 'server', 'fleetMcp', 'kbTools', 'codeTools',
    'confirmedCount', 'codeIndex', 'codeIndexReason', 'repo', 'maintainer', 'warnings', 'reason', 'fix', 'problems', 'steps'].sort();

/** The member maintains its own repository (it is the kb_maintainer). */
const selfMaintains = { repoOf: () => 'github.com/o/r', maintainerForMember: (name) => ({ member: name }) };

function capabilityFake(verdict) {
    const calls = [];
    return { calls, fn: async (member) => { calls.push(member.name); return verdict; } };
}

const outdated = (rec) => rec.problems.filter((p) => p.reason === 'member-fleet-outdated');

test('install currency: a member install older than the orchestrator gets a non-gating member-fleet-outdated warning naming the fix and both versions', async () => {
    const f = fakeFleet({ fleetMcp: { state: 'available', version: 'v0.4.3_abc' }, serverVersion: '0.4.4' });
    const [rec] = await f.make(['m1']).probeAll();
    const [p] = outdated(rec);
    assert.ok(p, JSON.stringify(rec.problems));
    assert.equal(p.step, 'install');
    assert.match(p.fix, /update_member with fleet_install "auto"/);
    assert.match(p.fix, /member version v0\.4\.3_abc/);
    assert.match(p.fix, /orchestrator version 0\.4\.4/);
    assert.ok(rec.warnings.some((w) => w.startsWith('member-fleet-outdated') && w.includes(p.fix)), JSON.stringify(rec.warnings));
    // Non-gating: the member stays verified and the stable record shape is kept.
    assert.equal(rec.verified, true);
    assert.equal(rec.reason, null);
    assert.equal(rec.fix, null);
    assert.deepEqual(Object.keys(rec).sort(), RECORD_KEYS);
    assert.ok(MEMBER_INIT_FIXES['member-fleet-outdated']);
    assert.match(f.logs[0], /OK member 'm1': verified .*WARN: member-fleet-outdated/);
});

test('install currency: a remote kb_maintainer at the SAME core version whose install lacks --kb-maintainer gets the same warning', async () => {
    const f = fakeFleet({ fleetMcp: { state: 'available', version: '0.4.4' }, serverVersion: '0.4.4' });
    const cap = capabilityFake('unsupported');
    const [rec] = await f.make(['m1'], { kbMaintainers: selfMaintains, kbMaintainerCapability: cap.fn }).probeAll();
    assert.deepEqual(cap.calls, ['m1']);
    const [p] = outdated(rec);
    assert.ok(p, JSON.stringify(rec.problems));
    assert.match(p.detail, /--kb-maintainer/);
    assert.match(p.fix, /update_member with fleet_install "auto".*member version 0\.4\.4, orchestrator version 0\.4\.4/);
    assert.equal(rec.verified, true);
    assert.equal(rec.reason, null);
    assert.deepEqual(Object.keys(rec).sort(), RECORD_KEYS);
});

test('install currency: an up-to-date (or newer) capable install gets no warning; a non-maintainer is not probed', async () => {
    for (const version of ['0.4.4', '0.4.5']) {
        const f = fakeFleet({ fleetMcp: { state: 'available', version }, serverVersion: '0.4.4' });
        const cap = capabilityFake('supported');
        const [rec] = await f.make(['m1'], { kbMaintainers: selfMaintains, kbMaintainerCapability: cap.fn }).probeAll();
        assert.deepEqual(outdated(rec), [], version);
        assert.deepEqual(rec.warnings, [], version);
        assert.equal(rec.verified, true);
    }
    const f = fakeFleet({ fleetMcp: { state: 'available', version: '0.4.4' }, serverVersion: '0.4.4' });
    const cap = capabilityFake('unsupported');
    const other = { repoOf: () => 'github.com/o/r', maintainerForMember: () => ({ member: 'someone-else' }) };
    const [rec] = await f.make(['m1'], { kbMaintainers: other, kbMaintainerCapability: cap.fn }).probeAll();
    assert.deepEqual(cap.calls, [], 'only a kb_maintainer is probed for the flag');
    assert.deepEqual(outdated(rec), []);
});

test('install currency: the warning never changes the first gating problem of an unverified member', async () => {
    const f = fakeFleet({ fleetMcp: { state: 'available', version: '0.4.3' }, serverVersion: '0.4.4', tools: { tools: [{ name: 'version' }] } });
    const [rec] = await f.make(['m1']).probeAll();
    assert.equal(rec.verified, false);
    assert.equal(rec.reason, 'member-tools-missing');
    assert.equal(outdated(rec).length, 1);
});

test('install currency: a local kb_maintainer is never probed for the CLI flag', async () => {
    const f = fakeFleet({ type: 'local', fleetMcp: { state: 'available', version: '0.4.4' }, serverVersion: '0.4.4' });
    const cap = capabilityFake('unsupported');
    const [rec] = await f.make(['m1'], { kbMaintainers: selfMaintains, kbMaintainerCapability: cap.fn }).probeAll();
    assert.deepEqual(cap.calls, []);
    assert.ok(!f.commands.some((c) => /call --help/.test(c.command)), 'no CLI capability probe command');
    assert.deepEqual(outdated(rec), []);
    assert.equal(rec.verified, true);
});
