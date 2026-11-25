import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { FleetWorkflow, AgentDispatchError } from '../src/workflow/index.mjs';

// execute_prompt's early rejections (secret token, bad argument combo, bad
// substitutions, provider none, missing agent file, interactive failure)
// return structuredContent {isError:true, reason}. A schemaless agent() call
// must fail on that typed signal alone. The stub content text below is
// deliberately arbitrary so detection cannot be relying on the guard message.

const REASONS = [
    'secret_in_prompt',
    'invalid_arguments',
    'substitution_failed',
    'provider_none',
    'agent_file_not_found',
    'interactive_failed',
];

describe('schemaless agent() fails on typed early-rejection reasons', () => {
    for (const reason of REASONS) {
        test(`reason ${reason}: throws AgentDispatchError and activity:end has success:false`, async () => {
            const wf = new FleetWorkflow({
                async executePrompt() {
                    return {
                        content: [{ text: 'opaque text 7d41 unrelated to any guard message' }],
                        structuredContent: { isError: true, reason, dispatched: false },
                    };
                },
            });
            const ends = [];
            wf.on('activity:end', (e) => ends.push(e));

            await assert.rejects(
                () => wf.agent('do the thing', { member_name: 'fleet-mock', schema: null, busyWaitMs: 0 }),
                (err) => {
                    assert.ok(err instanceof AgentDispatchError);
                    assert.equal(err.details.reason, reason);
                    assert.equal(err.details.dispatched, false);
                    return true;
                },
            );
            assert.equal(ends.length, 1);
            assert.equal(ends[0].success, false);
        });
    }
});

// Output-shape pin: the real handler must still emit each typed reason inside
// a structuredContent literal (a regression to a bare string return drops it).
describe('execute_prompt early-rejection output-shape pin', () => {
    const __dirname = path.dirname(fileURLToPath(import.meta.url));
    const dist = path.join(__dirname, '../../../dist/tools/execute-prompt.js');

    for (const reason of REASONS) {
        test(`dist/tools/execute-prompt.js emits structuredContent reason ${reason}`, () => {
            const src = fs.readFileSync(dist, 'utf8');
            const re = new RegExp(`structuredContent:\\s*\\{\\s*isError:\\s*true,\\s*reason:\\s*'${reason}'`);
            assert.ok(re.test(src), `no structuredContent {isError:true, reason:'${reason}'} in dist (stale build? run npm run build)`);
        });
    }
});
