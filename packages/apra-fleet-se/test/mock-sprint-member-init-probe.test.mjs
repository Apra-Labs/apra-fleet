import fs from 'node:fs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runDevelopLoopScenario, withScenarioMarkers, defaultMockCallTool } from './helpers/mock-sprint-harness.mjs';
import { scaledTimeout } from './helpers/scaled-timeout.mjs';
import { MEMBER_INIT_STATE_NAMESPACE } from '../fleet-sprint/member-init-probe.mjs';

// =============================================================================
// The per-member sprint-init probe through the REAL runner.js wiring.
//
// The single member is REMOTE and fails EVERY check: `apra-fleet status` on
// it errors, its member session's --list-tools and every `apra-fleet call`
// it runs fail, and member_detail refresh:true reports its fleetMcp
// unavailable (mcp-entry-missing). Asserted:
//   - the sprint still runs and reaches dispatch (never blocking);
//   - the init log carries one WARN line for the member with its reason and
//     one-line fix;
//   - the per-member record reaches the published viewer state;
//   - the probe ran (member_detail refresh:true, the status command) after
//     kb_maintainer selection and before the first dispatch;
//   - transport: no kb_* / code_* tool was called on the orchestrator's own
//     callTool; every kb/code call arrived on the member (apra-fleet call).
// Reverting the probe wiring in runner.js removes the WARN line, the
// published records and the refresh call, so this test fails.
// =============================================================================

const MEMBER_ID = '5d6e7f80-1a2b-4c3d-8e9f-a0b1c2d3e4f5';

test('mock sprint: a member failing every init check still reaches dispatch, with a WARN reason/fix line and published records', { timeout: scaledTimeout(180000) }, async () => {
    await withScenarioMarkers('member init probe never blocks', async () => {
        const orchestratorCalls = [];
        const memberToolCalls = [];
        const statusCommands = [];
        const order = [];
        const makeCallTool = (executeCommand) => {
            const base = defaultMockCallTool({ executeCommand });
            return async (name, args) => {
                orchestratorCalls.push(name);
                if (name === 'member_detail') {
                    if (args && args.refresh === true) order.push('probe-refresh');
                    const body = { vcsProvider: 'github', id: MEMBER_ID, type: 'remote', os: 'linux', llmProvider: 'claude', folder: '/srv/mock-member/widget' };
                    if (args && args.refresh === true) {
                        body.fleetMcp = { state: 'unavailable', reason: 'mcp-entry-missing', detail: 'no per-folder apra-fleet MCP entry for the work folder; run compose_permissions', checkedAt: '2026-10-02T00:00:00.000Z' };
                    }
                    return { content: [{ text: JSON.stringify(body) }] };
                }
                if (name === 'send_files') {
                    for (const p of args.local_paths || []) fs.readFileSync(p, 'utf8');
                    return { content: [{ type: 'text', text: 'sent' }] };
                }
                if (name === 'execute_command' && typeof args.command === 'string') {
                    if (args.command.includes('apra-fleet status') || args.command.includes('apra-fleet start')) {
                        statusCommands.push(args.command);
                        order.push('probe-status');
                        return { isError: true, content: [{ type: 'text', text: 'apra-fleet: command not found' }] };
                    }
                    if (args.command.includes('apra-fleet call')) {
                        const m = /apra-fleet call --member (\S+) (?:(\w+) --args-file|--list-tools)/.exec(args.command);
                        const tool = m ? (m[2] || 'tools/list') : '?';
                        memberToolCalls.push(tool);
                        if (tool === 'kb_stats' && !order.includes('probe-refresh')) order.push('selection-kb_stats');
                        // dispatch-accounting reads session_stats AS the member right
                        // before every member dispatch: the dispatch marker.
                        if (tool === 'session_stats') order.push('dispatch');
                        return { content: [{ type: 'text', text: JSON.stringify({ error: { code: 'E-CONNECT', message: 'member session unavailable' } }) }] };
                    }
                }
                return base(name, args);
            };
        };

        const run = await runDevelopLoopScenario('memberinitprobe', {
            members: ['local'],
            taskSpecs: [{ title: 'Task: exercise the sprint-init member probe' }],
            maxCycles: 1,
            callToolFactory: makeCallTool,
        });

        assert.equal(run.error, null, `the sprint must proceed despite every init check failing: ${run.error && run.error.message}`);
        assert.ok(run.dispatched.length > 0, 'the sprint reaches dispatch');

        // One WARN line for the member, with its reason and one-line fix.
        const warn = run.logs.filter((l) => /^\[member-init\] WARN member 'local'/.test(l));
        assert.equal(warn.length, 1, JSON.stringify(run.logs.filter((l) => l.startsWith('[member-init]'))));
        assert.match(warn[0], /unverified -- reason: [a-z-]+; fix: \S.*$/);
        assert.match(warn[0], /reason: server-status-failed;/);

        // The per-member record reaches the viewer state.
        const published = run.states.filter((s) => s && s.namespace === MEMBER_INIT_STATE_NAMESPACE);
        assert.equal(published.length, 1, 'records are published once at init');
        const [rec] = published[0].data.members;
        assert.equal(rec.member, 'local');
        assert.equal(rec.verified, false);
        assert.equal(rec.reason, 'server-status-failed');
        assert.ok(rec.fix);
        assert.deepEqual(rec.fleetMcp, { state: 'unavailable', reason: 'mcp-entry-missing' });
        assert.ok(rec.problems.some((p) => p.reason === 'mcp-entry-missing'), JSON.stringify(rec.problems));

        // Ran once, after kb_maintainer selection (its kb_stats availability
        // probe) and before the first dispatch.
        assert.equal(order.filter((e) => e === 'probe-refresh').length, 1, JSON.stringify(order));
        assert.ok(statusCommands.length >= 1, 'the remote start-if-down status command ran');
        const selection = order.indexOf('selection-kb_stats');
        const probeStart = order.indexOf('probe-status');
        const probeEnd = order.indexOf('probe-refresh');
        const firstDispatch = order.indexOf('dispatch');
        assert.ok(selection !== -1 && selection < probeStart, `probe must follow kb_maintainer selection: ${JSON.stringify(order)}`);
        assert.ok(firstDispatch !== -1 && probeEnd < firstDispatch, `probe must precede the first dispatch: ${JSON.stringify(order)}`);

        // Transport: kb_*/code_* only ever reach the member.
        assert.deepEqual(orchestratorCalls.filter((n) => /^(kb_|code_)/.test(n)), [], 'no kb_*/code_* call on the orchestrator callTool');
        for (const t of ['tools/list', 'kb_stats', 'code_reindex']) {
            assert.ok(memberToolCalls.includes(t), `${t} must arrive on the member session; saw ${JSON.stringify(memberToolCalls)}`);
        }
    });
});
