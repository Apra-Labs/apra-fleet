import { test, describe } from 'node:test';
import assert from 'node:assert';
import path from 'path';
import { fileURLToPath } from 'url';
import { FleetWorkflow } from '../src/workflow/index.mjs';
import { WorkflowEngine } from '../src/workflow/engine.mjs';

// Regression tests for apra-fleet-unw.18 (F1): "The loader breaks its own
// examples". feedback.md's exact evidence was that WF/examples/03-transform-
// sequential.js:7 declares `export async function main()`, which used to
// survive (unstripped) into the old `new AsyncFunction(...)`-based loader
// body and blow up with a SyntaxError -- the engine could not run its own
// shipped example. apra-fleet-unw.7 replaced that loader with a real ES-
// module `import(pathToFileURL(...))`, which both fixes the `export` bug and
// keeps real stack traces/line numbers.
//
// The other workflow test files already exercise dozens of `export async
// function main()`-shaped fixtures end-to-end (test-runner.test.mjs,
// apra-fleet-workflow-journal.test.mjs, apra-fleet-workflow-concurrency.test.mjs,
// etc.), so the general "export-function scripts load and run" property is
// pervasively covered. This file instead targets the *exact* evidence cited
// in F1 -- the real, shipped examples/ scripts -- so the specific regression
// the finding names can never silently return.

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const examplePath = (name) => path.join(__dirname, '..', 'examples', name);

const KNOWN_MEMBERS = new Set(['apra-pm']);

function createMockFleetApi() {
    return {
        async executePrompt(payload) {
            const memberKey = payload.member_name || payload.member_id;
            if (!KNOWN_MEMBERS.has(memberKey)) {
                return { content: [{ text: `Member "${memberKey}" not found.` }] };
            }
            const usage = { prompt_tokens: 5, completion_tokens: 5, total_tokens: 10 };
            const prompt = payload.prompt || '';
            if (prompt.includes('write a single bash command')) {
                return { content: [{ text: JSON.stringify({ commandToRun: 'echo hi' }) }], usage };
            }
            if (prompt.includes('Say hello world')) {
                return { content: [{ text: JSON.stringify({ greeting: 'hi', message: 'hello world' }) }], usage };
            }
            return { content: [{ text: `Mock response to: ${prompt.slice(0, 60)}` }], usage };
        },
        async executeCommand(payload) {
            const memberKey = payload.member_name || payload.member_id;
            if (!KNOWN_MEMBERS.has(memberKey)) {
                return { content: [{ text: `Member "${memberKey}" not found.` }] };
            }
            return { content: [{ text: payload.command }], isError: false };
        }
    };
}

describe('F1: shipped export-function example scripts load and run under the real ES-module loader', () => {
    test('examples/01-hello-world.js (export const meta + export async function main) loads and runs to a success result', async () => {
        const wf = new FleetWorkflow(createMockFleetApi());
        const engine = new WorkflowEngine(wf);

        const result = await engine.executeFile(examplePath('01-hello-world.js'));

        assert.strictEqual(result.status, 'success');
        assert.deepStrictEqual(result.data, { greeting: 'hi', message: 'hello world' });
    });

    test('examples/03-transform-sequential.js -- the exact file/line F1 cites as breaking the old loader -- loads and runs without a SyntaxError', async () => {
        const wf = new FleetWorkflow(createMockFleetApi());
        const engine = new WorkflowEngine(wf);

        // Under the old `new AsyncFunction(...)`-based loader, importing
        // this file's `export async function main(context) { ... }` body
        // would throw a SyntaxError before a single line of the workflow
        // ever ran. `assert.doesNotReject` fails loudly (with that
        // SyntaxError) if the loader regresses.
        await assert.doesNotReject(() => engine.executeFile(examplePath('03-transform-sequential.js'), { member_name: 'apra-pm' }));
    });
});
