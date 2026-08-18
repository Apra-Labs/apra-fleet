import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runDevelopLoopScenario, withScenarioMarkers, defaultMockCallTool } from './helpers/mock-sprint-harness.mjs';

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

test('mock sprint: a kb_* call made during a dispatch carries the member repo URL member_detail reported', { timeout: 180000 }, async () => {
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
