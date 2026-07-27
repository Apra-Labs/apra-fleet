// apra-fleet-eft.69.2: test coverage for the "no duplicate row" half of
// apra-fleet-eft.69's acceptance criteria, on the runner.js side.
//
// apra-fleet-eft.69 bug item 1: every agent dispatch (Reviewer, Planner,
// Plan Reviewer, Streak Assignment (both the initial dispatch and its
// semantic-repair re-ask), Doer, Deployer, Integ Test Runner, Final Verdict,
// Harvester) used to be followed by a raw `log(\`<Role>: ${JSON.stringify(...)}\`)`
// dump that re-printed the EXACT SAME content the dispatch's own generic
// AGENT activity row already carries as its `output` -- a duplicate row with
// no distinct purpose. apra-fleet-eft.69.1 removed every one of those dumps;
// this file protects that fix from silently regressing:
//   1. a static regression scan of runner.js confirming none of the 10
//      removed duplicate-dump call shapes have reappeared (with a mutation
//      self-check proving the scanner has teeth);
//   2. a real, end-to-end mock-sprint scenario that actually drives a
//      Streak Assignment dispatch (the fallback LLM path, per
//      mock-sprint-lane-metadata-grouping.test.mjs) and asserts the
//      workflow's own 'log' event stream never reproduces that dispatch's
//      raw JSON output -- i.e. the fix is verified live, not just by
//      grepping source.
//
// The viewer-side half of apra-fleet-eft.69.2 (no role/phase-name
// special-casing; Streak Assignment renders through the exact same generic
// path as any other agent dispatch) is covered separately in
// packages/apra-fleet-workflow/test/apra-fleet-workflow-viewer-generic-row-model.test.mjs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runDevelopLoopScenario, withScenarioMarkers } from './helpers/mock-sprint-harness.mjs';

const check = (cond, msg) => assert.ok(cond, msg);

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const RUNNER_PATH = path.join(__dirname, '..', 'fleet-sprint', 'runner.js');

// The exact 10 duplicate-dump call shapes apra-fleet-eft.69.1 removed (one
// per dispatch site named in its commit message). Each regex targets the
// PRECISE raw-JSON-dump form that was removed -- not the many legitimate,
// still-present diagnostic `log(\`<Role>: ...\`)` calls at those same sites
// (e.g. "Reviewer: schema-repair exhausted..."), which are a different
// string entirely and must keep passing.
const REMOVED_DUPLICATE_DUMPS = [
    { name: 'Reviewer', re: /log\(`Reviewer:\s*\$\{JSON\.stringify\(verdict\)\}`\)/ },
    { name: 'Planner', re: /log\(`Planner:\s*\$\{plannerRes\}`\)/ },
    { name: 'Plan Reviewer', re: /log\(`Plan Reviewer:\s*\$\{JSON\.stringify\(verdict\)\}`\)/ },
    { name: 'Streak Assignment', re: /log\(`Streak Assignment:\s*\$\{JSON\.stringify\(streakCandidate\)\}`\)/ },
    { name: 'Streak Assignment (semantic repair)', re: /log\(`Streak Assignment \(semantic repair\):\s*\$\{JSON\.stringify\(streakCandidate\)\}`\)/ },
    { name: 'Doer', re: /log\(`Doer \[[^`]*\}`\)/ },
    { name: 'Deployer', re: /log\(`Deployer:\s*\$\{JSON\.stringify\(deployResult\)\}`\)/ },
    { name: 'Integ Test Runner', re: /log\(`Integ Test Runner:\s*\$\{JSON\.stringify\(integResult\)\}`\)/ },
    { name: 'Final Verdict', re: /log\(`Final Verdict:\s*\$\{JSON\.stringify\(finalVerdictResult\)\}`\)/ },
    { name: 'Harvester', re: /log\(`Harvester:\s*\$\{JSON\.stringify\(harvesterResult\)\}`\)/ },
];

function scanForDuplicateDumps(source) {
    return REMOVED_DUPLICATE_DUMPS.filter((d) => d.re.test(source)).map((d) => d.name);
}

test('runner.js has no reintroduced raw-JSON duplicate-dump log() call at any of the 10 apra-fleet-eft.69.1 dispatch sites', () => {
    const source = fs.readFileSync(RUNNER_PATH, 'utf8');
    const hits = scanForDuplicateDumps(source);
    assert.deepStrictEqual(
        hits,
        [],
        `found reintroduced duplicate-dump log() call(s) for: ${hits.join(', ')} -- each dispatch's own AGENT activity row already carries this content as \`output\`; a duplicate log() line is the exact apra-fleet-eft.69 bug item 1 regression`
    );
});

test('scanner catches a seeded reintroduced duplicate-dump (mutation self-check)', () => {
    const source = fs.readFileSync(RUNNER_PATH, 'utf8');
    assert.deepStrictEqual(scanForDuplicateDumps(source), []);

    const seeded = `${source}\n    log(\`Streak Assignment: \${JSON.stringify(streakCandidate)}\`);\n`;
    const hits = scanForDuplicateDumps(seeded);
    assert.deepStrictEqual(
        hits,
        ['Streak Assignment'],
        `expected the scanner to catch a seeded reintroduced 'Streak Assignment' duplicate dump, got: ${JSON.stringify(hits)}`
    );
});

// =============================================================================
// End-to-end (mock-sprint): drives the REAL Streak Assignment fallback
// dispatch (no lane metadata -- same path exercised by
// mock-sprint-lane-metadata-grouping.test.mjs's "LLM fallback" scenario) and
// asserts the resulting log stream never reproduces that dispatch's raw
// JSON output. The mock's default Streak Assignment response is
// `{"streaks": [[id], ...]}` (see mock-sprint-harness.mjs); before
// apra-fleet-eft.69.1, runner.js additionally logged
// `Streak Assignment: {"streaks":...}` right after the dispatch -- a literal
// duplicate of the dispatch's own AGENT activity row. That log line is gone;
// this confirms it stays gone against the real dispatch path, not just via
// static source grep above.
// =============================================================================
test('mock sprint: a real Streak Assignment dispatch never logs a duplicate raw-JSON row', async () => {
    await withScenarioMarkers('Streak Assignment dispatch: no duplicate log row', async () => {
        console.log('Running mock sprint scenario (Streak Assignment dispatch must not duplicate-log its own output)...');
        const scenario = await runDevelopLoopScenario('streak-nodup-log', {
            members: ['local'],
            taskSpecs: [
                { title: 'Task: No metadata A' },
                { title: 'Task: No metadata B' },
            ],
            // No lane metadata stamped -- forces the runtime LLM Streak
            // Assignment fallback dispatch (see
            // mock-sprint-lane-metadata-grouping.test.mjs's identically-shaped
            // "no lane metadata" scenario). Approve immediately so this
            // completes in exactly one develop round.
            reviewerHandler: async () => ({
                content: [{ text: JSON.stringify({ verdict: 'APPROVED', notes: 'Approved.', reopenIds: [], newTasks: [] }) }]
            }),
        });
        check(!scenario.error, `Scenario should not error: ${scenario.error ? scenario.error.message : ''}`);
        check(scenario.result && scenario.result.status === 'success', `Expected a successful sprint: ${JSON.stringify(scenario.result)}`);

        // The Streak Assignment dispatch actually happened (fallback path,
        // no lane metadata present).
        const streakAssignmentDispatches = scenario.dispatched.filter((d) => d.prompt.includes('Ready bead ids:'));
        check(
            streakAssignmentDispatches.length === 1,
            `Expected exactly one Streak Assignment dispatch, got ${streakAssignmentDispatches.length}`
        );

        // No log line reproduces that dispatch's raw JSON output (the
        // streakAssignment schema's own `streaks` field name is a reliable,
        // narrow fingerprint for the removed duplicate-dump content -- no
        // other legitimate log line in this scenario has any reason to
        // mention it).
        const duplicateRows = scenario.logs.filter((m) => m.includes('"streaks"'));
        check(
            duplicateRows.length === 0,
            `Expected NO log line duplicating the Streak Assignment dispatch's raw JSON output, found: ${JSON.stringify(duplicateRows)}`
        );

        // Sanity: the (unrelated, still-present) diagnostic log lines around
        // this dispatch site are untouched by the fix.
        check(
            scenario.logs.some((m) => m === 'Streak grouping: no lane metadata on this round\'s ready beads -- falling back to LLM Streak Assignment dispatch (back-compat with pre-eft.76 plans).'),
            `Expected the (unrelated) LLM-fallback log line to still fire, got logs: ${JSON.stringify(scenario.logs.filter((m) => m.includes('Streak grouping')))}`
        );
    });
});
