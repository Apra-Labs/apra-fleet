// Out-of-process harness for apra-fleet-workflow-hard-kill.test.mjs
// (apra-fleet-eft.2.4). NOT itself a *.test.mjs -- the test file spawns this
// as a real child process (via `node sigkill-harness.mjs`) so it can send it
// a genuine SIGKILL and observe the on-disk running/<sprintId>.json state
// left behind, something that cannot be simulated in-process (killing your
// own test runner's process would kill the assertions along with it).
//
// Config is passed entirely via environment variables (the harness itself
// takes no CLI args) so the parent test controls it via child_process.spawn's
// `env` option, matching the sprint-state layout's own env-driven
// configuration (APRA_FLEET_DATA_DIR, see src/viewer/sprint-state-paths.mjs).
//
// Required:
//   SPRINT_ID        - stable sprint id, used for running/<id>.json naming.
// Optional:
//   ITERATIONS        - number of sequential agent() calls (default 40).
//   AGENT_DELAY_MS     - real per-call delay in ms (default 250).
//   DEBOUNCE_MS        - debounced writer window in ms, 200-500 (default 200).
//
// On successful completion, exits 0 after the workflow's own 'end' handling
// (which synchronously moves running/<id>.json to old_sprints/<id>.json) has
// already run -- see src/viewer/index.mjs's workflow.on('end', ...) handler,
// which is entirely synchronous, so by the time engine.executeFile()'s
// returned promise settles the move has already happened.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { FleetWorkflow } from '../../src/workflow/index.mjs';
import { WorkflowEngine } from '../../src/workflow/engine.mjs';
import { createDashboardViewer } from '../../src/viewer/index.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const KNOWN_MEMBERS = new Set(['fleet-dev']);

function createDelayedFleetApi(delayMs) {
    return {
        async executePrompt(payload) {
            const memberKey = payload.member_name || payload.member_id;
            if (!KNOWN_MEMBERS.has(memberKey)) {
                return { content: [{ text: `Member "${memberKey}" not found.` }] };
            }
            await new Promise((resolve) => setTimeout(resolve, delayMs));
            return {
                content: [{ text: `echo: ${payload.prompt}` }],
                usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 }
            };
        },
        async executeCommand(payload) {
            return { content: [{ text: payload.command }], isError: false };
        }
    };
}

const sprintId = process.env.SPRINT_ID;
if (!sprintId) {
    console.error('[sigkill-harness] SPRINT_ID env var is required');
    process.exit(1);
}
const iterations = Number(process.env.ITERATIONS || 40);
const delayMs = Number(process.env.AGENT_DELAY_MS || 250);
const debounceMs = Number(process.env.DEBOUNCE_MS || 200);

const wf = new FleetWorkflow(createDelayedFleetApi(delayMs));
const engine = new WorkflowEngine(wf);
const server = createDashboardViewer(wf, {
    port: 0,
    name: 'SIGKILL Harness',
    sprintId,
    debounceMs,
    launchArgs: ['--sigkill-harness']
});

const fixturePath = path.join(__dirname, 'test-sigkill-long-running.mjs');

// Signal readiness to the parent test over stdout, once the server (and
// therefore the debounced writer + running/old_sprints wiring) is listening
// -- so the parent doesn't race the SIGKILL against the child not having
// started yet.
console.log(`[sigkill-harness] ready pid=${process.pid} sprintId=${sprintId}`);

engine.executeFile(fixturePath, { iterations })
    .then(() => {
        console.log('[sigkill-harness] completed normally');
        try { server.close(); } catch (e) { /* ignore */ }
        process.exit(0);
    })
    .catch((err) => {
        console.error('[sigkill-harness] failed:', err);
        try { server.close(); } catch (e) { /* ignore */ }
        process.exit(1);
    });
