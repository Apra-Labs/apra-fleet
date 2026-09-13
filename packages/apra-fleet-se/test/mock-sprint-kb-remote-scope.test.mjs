import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runDevelopLoopScenario, withScenarioMarkers, defaultMockCallTool } from './helpers/mock-sprint-harness.mjs';
import { scaledTimeout } from './helpers/scaled-timeout.mjs';

// =============================================================================
// The production wiring for remote-member KB scoping, through the REAL runner.js
// call sites rather than a directly-constructed client.
//
// runner-kb-priming.test.mjs covers createKbPrimingClient and createKbWorkClient
// in isolation: given a URL, they scope their calls. What it cannot cover is the
// one line that connects them -- createKbWorkClient's `remoteUrlFor` injection
// at the runSprintCycle construction site. Delete that line and every isolated
// test above still passes while every kb_* call a real sprint makes goes back to
// being unscoped, which is exactly the class of "wired in tests, dead in
// production" defect this fix exists to remove (the engine's kb_promotions field
// was structurally empty for the same reason, apra-fleet-0ef).
//
// The observable is a kb_query issued during a normal develop-loop dispatch
// (runner.js's per-dispatch relevantKnowledge call): it must carry the
// repo_remote_url that member_detail reported for that member's work folder.
// =============================================================================

// apra-fleet-d6fq.2: base=180000 is the pre-existing standalone-calibrated
// budget, not a guess -- apra-fleet-cnmj's real-bd carry-over report shows
// this file only exceeds 180000ms under the default 8-way concurrent suite
// (file elapsed 223s while running alongside up to 7 sibling files), and the
// same failure family is recorded elsewhere (apra-fleet-5ey2) as passing
// when its file is rerun standalone with no contention. scaledTimeout() keeps
// this budget unscaled at concurrency<=1 and multiplies it (3x = 540000ms)
// under the real 8-way suite, which apra-fleet-d6fq.1 makes non-inert.
test('mock sprint: a kb_* call made during a dispatch carries the member repo URL member_detail reported', { timeout: scaledTimeout(180000) }, async () => {
    await withScenarioMarkers('kb remote scope threading', async () => {
        const REMOTE_URL = 'https://github.com/acme/widget.git';
        const WORK_FOLDER = '/srv/mock-member/widget';
        const kbCalls = [];
        const base = defaultMockCallTool();
        const callTool = async (name, args) => {
            if (name === 'member_detail') {
                return { content: [{ text: JSON.stringify({ vcsProvider: 'github', folder: WORK_FOLDER, repo_remote_url: REMOTE_URL }) }] };
            }
            if (typeof name === 'string' && name.startsWith('kb_')) {
                kbCalls.push({ name, args });
                if (name === 'kb_session_prime') return { top_entries: [] };
                if (name === 'kb_list') return { results: [] };
                if (name === 'kb_query') return { content: [{ text: JSON.stringify({ l1_results: [], related_claims: [] }) }] };
                return {};
            }
            return base(name, args);
        };

        await runDevelopLoopScenario('kbremotescope', {
            members: ['local'],
            taskSpecs: [{ title: 'Task: exercise KB remote scoping through a real dispatch' }],
            maxCycles: 1,
            callTool,
        });

        const queries = kbCalls.filter((c) => c.name === 'kb_query');
        assert.ok(queries.length > 0, 'the develop loop must issue a per-dispatch kb_query for this test to mean anything');
        for (const q of queries) {
            assert.equal(q.args.repo_path, WORK_FOLDER);
            assert.equal(q.args.repo_remote_url, REMOTE_URL,
                'without the remoteUrlFor injection at the createKbWorkClient site, every sprint kb_* call is unscoped again');
        }
    });
});
