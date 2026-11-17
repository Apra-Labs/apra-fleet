import fs from 'node:fs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runDevelopLoopScenario, withScenarioMarkers, defaultMockCallTool } from './helpers/mock-sprint-harness.mjs';
import { scaledTimeout } from './helpers/scaled-timeout.mjs';

// =============================================================================
// The production wiring for member KB scoping, through the REAL runner.js call
// sites rather than a directly-constructed client.
//
// runner-kb-priming.test.mjs covers createKbPrimingClient and createKbWorkClient
// in isolation: given a memberCall, they run every kb_* call as the member. What
// it cannot cover is the line that connects them -- the memberCall built at the
// runSprintCycle construction site. Delete it and every isolated test above
// still passes while a real sprint makes no member-scoped kb_* call at all,
// which is exactly the class of "wired in tests, dead in production" defect
// this guards against (the engine's kb_promotions field was structurally empty
// for the same reason, apra-fleet-0ef).
//
// The member is REMOTE, so the production memberCall adapter delivers the args
// with send_files and runs `apra-fleet call --member <id> <tool>` through
// execute_command -- both observable on the mocked callTool. The observable is
// a kb_query issued during a normal develop-loop dispatch (runner.js's
// per-dispatch relevantKnowledge call): it must run AS the member, and its
// args must carry no repo/scope argument (the member session is the scope).
// =============================================================================

// apra-fleet-d6fq.2: base=180000 is the pre-existing standalone-calibrated
// budget, not a guess -- apra-fleet-cnmj's real-bd carry-over report shows
// this file only exceeds 180000ms under the default 8-way concurrent suite
// (file elapsed 223s while running alongside up to 7 sibling files), and the
// same failure family is recorded elsewhere (apra-fleet-5ey2) as passing
// when its file is rerun standalone with no contention. Directly confirmed:
// `node scripts/run-tests.mjs real test/mock-sprint-kb-remote-scope.test.mjs`
// standalone -- pass=1 fail=0, duration 36222.8ms, comfortably under the
// 180000ms base. scaledTimeout() keeps this budget unscaled at
// concurrency<=1 and multiplies it (3x = 540000ms) under the real 8-way
// suite, which apra-fleet-d6fq.1 makes non-inert.
test('mock sprint: a kb_* call made during a dispatch runs as the member, with no scope argument', { timeout: scaledTimeout(180000) }, async () => {
    await withScenarioMarkers('kb member scope threading', async () => {
        const MEMBER_ID = '0b9d3a1e-5f2c-4c6e-9a7b-1c2d3e4f5a6b';
        const WORK_FOLDER = '/srv/mock-member/widget';
        const kbCalls = [];
        const deliveredArgs = [];
        const base = defaultMockCallTool();
        const callTool = async (name, args) => {
            if (name === 'member_detail') {
                return { content: [{ text: JSON.stringify({ vcsProvider: 'github', id: MEMBER_ID, type: 'remote', os: 'linux', folder: WORK_FOLDER }) }] };
            }
            if (typeof name === 'string' && name.startsWith('kb_')) {
                // A kb_* call through the orchestrator's own session would
                // resolve the fleet server's KB, not the member's.
                kbCalls.push({ name, args, via: 'orchestrator' });
                return {};
            }
            if (name === 'send_files') {
                for (const p of args.local_paths || []) deliveredArgs.push(JSON.parse(fs.readFileSync(p, 'utf8')));
                return { content: [{ type: 'text', text: 'sent' }] };
            }
            if (name === 'execute_command' && typeof args.command === 'string' && args.command.includes('apra-fleet call')) {
                const m = /apra-fleet call --member (\S+) (?:--kb-maintainer )?(\w+) --args-file/.exec(args.command);
                const tool = m && m[2];
                kbCalls.push({ name: tool, member: m && m[1], args: deliveredArgs[deliveredArgs.length - 1], via: 'member' });
                const body = tool === 'kb_session_prime' ? { top_entries: [] }
                    : tool === 'kb_list' ? { results: [] }
                        : tool === 'kb_query' ? { l1_results: [], related_claims: [] }
                            : {};
                return { content: [{ type: 'text', text: JSON.stringify(body) }] };
            }
            return base(name, args);
        };

        await runDevelopLoopScenario('kbremotescope', {
            members: ['local'],
            taskSpecs: [{ title: 'Task: exercise KB remote scoping through a real dispatch' }],
            maxCycles: 1,
            callTool,
        });

        assert.deepEqual(kbCalls.filter((c) => c.via === 'orchestrator').map((c) => c.name), [],
            'no kb_* call may go through the orchestrator session');
        const queries = kbCalls.filter((c) => c.name === 'kb_query');
        assert.ok(queries.length > 0, 'the develop loop must issue a per-dispatch kb_query for this test to mean anything');
        for (const q of queries) {
            assert.equal(q.member, MEMBER_ID, 'the kb_query must run as the dispatched member');
            for (const field of ['repo', 'repo_path', 'repo_remote_url']) {
                assert.equal(q.args[field], undefined, `kb_query must not carry ${field}`);
            }
        }
    });
});
