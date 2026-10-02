import fs from 'node:fs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runDevelopLoopScenario, withScenarioMarkers, defaultMockCallTool } from './helpers/mock-sprint-harness.mjs';
import { scaledTimeout } from './helpers/scaled-timeout.mjs';
import { DISPATCH_TOOL_CALLS_STATE_NAMESPACE } from '../fleet-sprint/dispatch-accounting.mjs';

// =============================================================================
// Production wiring of per-dispatch kb_*/code_* accounting, through the REAL
// runner.js agent() wrapper and its memberCall construction site.
//
// The member is REMOTE, so the production memberCall adapter runs
// `apra-fleet call --member <id> session_stats` on the member through
// execute_command (observable on the mocked callTool). The fake member server
// answers every session_stats read with counters that grow by (kb +3, code +1)
// per read pair, so each dispatch's before/after delta is exactly (3, 1).
//
// Asserted: session_stats is NEVER called through the orchestrator's own FULL
// session (callTool('session_stats')); it is read before and after every
// member dispatch through memberCall; the per-dispatch records reach the
// viewer's publishState namespace; and the harvester's sprint summary shows
// the counts per member per dispatch.
// =============================================================================

test('mock sprint: session_stats snapshots around each dispatch, read via memberCall, reach the summary and the viewer', { timeout: scaledTimeout(180000) }, async () => {
    await withScenarioMarkers('dispatch tool-call accounting', async () => {
        const MEMBER_ID = '7c1e2d3f-4a5b-4c6d-8e9f-0a1b2c3d4e5f';
        const SINCE = '2026-10-01T00:00:00.000Z';
        const orchestratorStatsCalls = [];
        const memberStatsReads = [];
        let reads = 0;
        const deliveredArgs = [];
        const makeCallTool = (executeCommand) => {
            const base = defaultMockCallTool({ executeCommand });
            return async (name, args) => {
                if (name === 'member_detail') {
                    return { content: [{ text: JSON.stringify({ vcsProvider: 'github', id: MEMBER_ID, type: 'remote', os: 'linux', folder: '/srv/mock-member/widget' }) }] };
                }
                if (name === 'session_stats') {
                    orchestratorStatsCalls.push(args);
                    return { content: [{ text: JSON.stringify({ member_id: MEMBER_ID, since: SINCE, kb: 999, code: 999, total: 1998, tools: {} }) }] };
                }
                if (name === 'send_files') {
                    for (const p of args.local_paths || []) deliveredArgs.push(JSON.parse(fs.readFileSync(p, 'utf8')));
                    return { content: [{ type: 'text', text: 'sent' }] };
                }
                if (name === 'execute_command' && typeof args.command === 'string' && args.command.includes('apra-fleet call')) {
                    const m = /apra-fleet call --member (\S+) (\w+) --args-file/.exec(args.command);
                    const tool = m && m[2];
                    if (tool === 'session_stats') {
                        memberStatsReads.push({ member: m[1], args: deliveredArgs[deliveredArgs.length - 1] });
                        // Reads come in before/after pairs: pair n reads (3n, n) then (3n+3, n+1).
                        const pair = Math.floor(reads / 2);
                        const isAfter = reads % 2 === 1;
                        reads++;
                        const kb = 3 * pair + (isAfter ? 3 : 0);
                        const code = pair + (isAfter ? 1 : 0);
                        const result = { content: [{ type: 'text', text: JSON.stringify({ member_id: MEMBER_ID, since: SINCE, kb, code, total: kb + code, tools: {} }) }] };
                        return { content: [{ type: 'text', text: JSON.stringify(result) }] };
                    }
                    const body = tool === 'kb_session_prime' ? { top_entries: [] }
                        : tool === 'kb_list' ? { results: [] }
                            : tool === 'kb_query' ? { l1_results: [], related_claims: [] }
                                : {};
                    return { content: [{ type: 'text', text: JSON.stringify(body) }] };
                }
                return base(name, args);
            };
        };

        const run = await runDevelopLoopScenario('dispatchtoolcalls', {
            members: ['local'],
            taskSpecs: [{ title: 'Task: exercise per-dispatch tool-call accounting' }],
            maxCycles: 1,
            callToolFactory: makeCallTool,
        });

        assert.equal(run.error, null, `the sprint run must complete: ${run.error && run.error.message}`);

        assert.deepEqual(orchestratorStatsCalls, [], 'session_stats must never be read through the orchestrator FULL session');
        assert.ok(memberStatsReads.length >= 2, `expected before/after session_stats reads, got ${memberStatsReads.length}`);
        assert.equal(memberStatsReads.length % 2, 0, 'reads come in before/after pairs');
        for (const r of memberStatsReads) assert.equal(r.member, MEMBER_ID, 'session_stats is read AS the dispatched member');

        const published = run.states.filter((s) => s && s.namespace === DISPATCH_TOOL_CALLS_STATE_NAMESPACE);
        assert.ok(published.length > 0, `dispatch tool-call records must be published to the viewer; saw namespaces ${JSON.stringify([...new Set(run.states.map((s) => s && s.namespace))])}`);
        const last = published[published.length - 1].data.dispatches;
        assert.equal(last.length, memberStatsReads.length / 2, 'one record per member dispatch');
        for (const rec of last) {
            assert.equal(rec.kb, 3);
            assert.equal(rec.code, 1);
        }

        const harvester = run.dispatched.find((d) => d && d.agent === 'harvester');
        assert.ok(harvester, 'the sprint reaches the harvester dispatch');
        assert.match(harvester.prompt, /## KB and code tool calls per member per dispatch/);
        assert.match(harvester.prompt, /Dispatch 1: \S+ on member '[^']+'[^\n]* -- kb_\* calls: 3, code_\* calls: 1\./);
    });
});
