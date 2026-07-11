import { test, describe } from 'node:test';
import assert from 'node:assert';
import { FleetWorkflow, WorkflowError, AgentOutputError } from '../src/workflow/index.mjs';

// Unit tests for robust structured-output extraction + bounded schema-repair
// loop (apra-fleet-unw.8, findings F5). Covers:
//   1. Balanced-bracket extraction picks the schema-valid candidate out of a
//      reply containing two JSON blocks plus prose (the old greedy regex
//      /\{[\s\S]*\}|\[[\s\S]*\]/ would have grabbed from the first `{` to the
//      last `}` across both blocks and failed to parse).
//   2. A repair re-ask succeeds after exactly one invalid reply, with
//      exactly 2 executePrompt calls observed.
//   3. Persistent garbage across all repair attempts throws AgentOutputError
//      (instanceof check) with `.details` carrying ajv errors, and every
//      attempt is visible as its own activity event.
//   4. The repair re-ask prompt is self-contained and resume stays false by
//      default on every dispatch, including repairs.

const KNOWN_MEMBER = 'fleet-dev';
const SCHEMA = {
    type: 'object',
    required: ['value'],
    properties: { value: { type: 'string' } }
};

function createMockFleetApi(executePromptImpl) {
    return {
        async executePrompt(payload) {
            return executePromptImpl(payload);
        },
        async executeCommand(payload) {
            return { content: [{ text: payload.command }], isError: false };
        }
    };
}

describe('apra-fleet-unw.8: robust JSON extraction (greedy-regex failure mode is dead)', () => {
    test('a reply with two JSON objects plus prose yields the schema-valid one', async () => {
        let calls = 0;
        const reply =
            'Here is some context first: {"value": 123} (that one is not valid per the schema)\n\n' +
            'After more thinking, here is the actual answer:\n' +
            '{"value": "the-real-answer"}\n\n' +
            'Trailing prose that also happens to contain a brace: } oops.';

        const wf = new FleetWorkflow(createMockFleetApi(async (payload) => {
            calls++;
            return { content: [{ text: reply }], usage: { total_tokens: 10 } };
        }));

        const result = await wf.agent('give me json', { member_name: KNOWN_MEMBER, schema: SCHEMA });

        assert.deepStrictEqual(result, { value: 'the-real-answer' });
        // The old greedy regex would have matched from the first `{` to the
        // very last `}` in the whole reply (spanning both objects and the
        // trailing prose) and thrown a JSON.parse error instead of resolving.
        assert.strictEqual(calls, 1, 'a schema-valid candidate on the first reply must not trigger a repair dispatch');
    });

    test('a fenced ```json block is preferred over a balanced-scan candidate', async () => {
        const reply =
            'Sure, here you go:\n' +
            '```json\n{"value": "fenced-answer"}\n```\n' +
            'Also, unrelated bracketed prose: [not json really { broken';

        const wf = new FleetWorkflow(createMockFleetApi(async () => ({
            content: [{ text: reply }], usage: { total_tokens: 10 }
        })));

        const result = await wf.agent('give me json', { member_name: KNOWN_MEMBER, schema: SCHEMA });
        assert.deepStrictEqual(result, { value: 'fenced-answer' });
    });
});

describe('apra-fleet-unw.8: bounded schema-repair loop', () => {
    test('invalid JSON once then valid JSON on repair succeeds with exactly 2 executePrompt calls', async () => {
        let calls = 0;
        const wf = new FleetWorkflow(createMockFleetApi(async (payload) => {
            calls++;
            if (calls === 1) {
                return { content: [{ text: 'not json at all {{{' }], usage: { total_tokens: 5 } };
            }
            return { content: [{ text: JSON.stringify({ value: 'fixed-on-repair' }) }], usage: { total_tokens: 5 } };
        }));

        const activityEvents = [];
        wf.on('activity:end', (meta) => { if (meta.type === 'agent') activityEvents.push(meta); });

        const result = await wf.agent('give me json', { member_name: KNOWN_MEMBER, schema: SCHEMA });

        assert.deepStrictEqual(result, { value: 'fixed-on-repair' });
        assert.strictEqual(calls, 2, 'expected exactly 2 executePrompt calls: 1 original + 1 successful repair');
        assert.strictEqual(activityEvents.length, 2, 'each attempt (failed original + successful repair) must emit its own activity:end');
        assert.strictEqual(activityEvents[0].success, false);
        assert.strictEqual(activityEvents[0].repairAttempt, 0);
        assert.strictEqual(activityEvents[1].success, true);
        assert.strictEqual(activityEvents[1].repairAttempt, 1);
    });

    test('the repair re-ask prompt is self-contained: includes original prompt, invalid output, and errors, without relying on resume:true', async () => {
        let calls = 0;
        const capturedPayloads = [];
        const wf = new FleetWorkflow(createMockFleetApi(async (payload) => {
            calls++;
            capturedPayloads.push(payload);
            if (calls === 1) {
                return { content: [{ text: 'garbage {{{' }], usage: { total_tokens: 5 } };
            }
            return { content: [{ text: JSON.stringify({ value: 'ok' }) }], usage: { total_tokens: 5 } };
        }));

        await wf.agent('ORIGINAL_PROMPT_MARKER', { member_name: KNOWN_MEMBER, schema: SCHEMA });

        assert.strictEqual(capturedPayloads.length, 2);
        // Every dispatch, including the repair, defaults resume to false --
        // the repair prompt does not lean on session continuity.
        assert.strictEqual(capturedPayloads[0].resume, false);
        assert.strictEqual(capturedPayloads[1].resume, false);

        const repairPrompt = capturedPayloads[1].prompt;
        assert.ok(repairPrompt.includes('ORIGINAL_PROMPT_MARKER'), 'repair prompt must embed the original prompt');
        assert.ok(repairPrompt.includes('garbage {{{'), 'repair prompt must embed the previous invalid output');
        assert.ok(/error/i.test(repairPrompt), 'repair prompt must embed the validation/parse errors');
    });

    test('persistent garbage across all repair attempts throws AgentOutputError with ajv/parse errors in .details, one activity event per attempt', async () => {
        let calls = 0;
        const wf = new FleetWorkflow(createMockFleetApi(async () => {
            calls++;
            return { content: [{ text: 'still garbage {{{' }], usage: { total_tokens: 5 } };
        }));

        const activityEvents = [];
        wf.on('activity:end', (meta) => { if (meta.type === 'agent') activityEvents.push(meta); });

        await assert.rejects(
            () => wf.agent('give me json', { member_name: KNOWN_MEMBER, schema: SCHEMA }),
            (err) => {
                assert.ok(err instanceof AgentOutputError);
                assert.ok(err instanceof WorkflowError);
                assert.strictEqual(err.code, 'AGENT_OUTPUT_INVALID');
                assert.ok(err.details, 'expected .details to be populated');
                assert.ok(err.details.errorsText && err.details.errorsText.length > 0, 'expected .details.errorsText to carry parse/ajv error text');
                return true;
            }
        );

        // Default schemaRetries is 2 -> 1 original + 2 repairs = 3 total dispatches.
        assert.strictEqual(calls, 3);
        assert.strictEqual(activityEvents.length, 3, 'each of the 3 attempts must be visible as its own activity event');
        activityEvents.forEach((meta, idx) => {
            assert.strictEqual(meta.success, false);
            assert.strictEqual(meta.repairAttempt, idx);
        });
        // Every activity event must have a distinct id so the journal/dashboard
        // render them as separate steps rather than collapsing into one.
        const ids = new Set(activityEvents.map((m) => m.id));
        assert.strictEqual(ids.size, 3);
    });

    test('schemaRetries is configurable via AgentOptions', async () => {
        let calls = 0;
        const wf = new FleetWorkflow(createMockFleetApi(async () => {
            calls++;
            return { content: [{ text: 'garbage {{{' }], usage: { total_tokens: 5 } };
        }));

        await assert.rejects(
            () => wf.agent('give me json', { member_name: KNOWN_MEMBER, schema: SCHEMA, schemaRetries: 0 }),
            AgentOutputError
        );
        assert.strictEqual(calls, 1, 'schemaRetries: 0 must mean no repair dispatches at all');
    });

    test('schema-valid JSON on the first attempt never triggers a repair dispatch', async () => {
        let calls = 0;
        const wf = new FleetWorkflow(createMockFleetApi(async () => {
            calls++;
            return { content: [{ text: JSON.stringify({ value: 'first-try' }) }], usage: { total_tokens: 5 } };
        }));

        const result = await wf.agent('give me json', { member_name: KNOWN_MEMBER, schema: SCHEMA });
        assert.deepStrictEqual(result, { value: 'first-try' });
        assert.strictEqual(calls, 1);
    });

    test('cost/budget accounting is per-attempt: repair dispatches are debited too, not skipped or double-counted', async () => {
        let calls = 0;
        const wf = new FleetWorkflow(createMockFleetApi(async () => {
            calls++;
            if (calls === 1) {
                return { content: [{ text: 'garbage {{{' }], usage: { prompt_tokens: 1000, completion_tokens: 500, total_tokens: 1500 } };
            }
            return { content: [{ text: JSON.stringify({ value: 'ok' }) }], usage: { prompt_tokens: 1000, completion_tokens: 500, total_tokens: 1500 } };
        }));

        assert.strictEqual(wf.budget.spent(), 0);
        await wf.agent('give me json', { member_name: KNOWN_MEMBER, schema: SCHEMA, model: 'gpt-4o' });

        // gpt-4o: 1000 prompt * $5/1M + 500 completion * $15/1M = 0.0125 per dispatch.
        // Two dispatches happened (1 failed original + 1 successful repair).
        assert.ok(Math.abs(wf.budget.spent() - 0.025) < 1e-9, `expected cost from exactly 2 dispatches, got ${wf.budget.spent()}`);
    });
});
