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
//   4. (apra-fleet-02s.3 + apra-fleet-dnri) The repair re-ask is
//      SELF-CONTAINED: it reattaches the original prompt plus the schema
//      instruction as reference alongside the validation/parse errors,
//      because a resumed session is not guaranteed to still hold them. The
//      reattachment is bounded: identical on every repair round, and it never
//      embeds the invalid output or the session transcript.
//      What the repair dispatch's `resume` value targets is deliberately NOT
//      asserted by these reattachment cases (apra-fleet-dnri.2); that
//      contract is owned separately (apra-fleet-dnri.4).

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

    test('a fenced non-JSON snippet plus valid JSON outside the fences falls through to the balanced scan on the first attempt (apra-fleet-unw2.15, N17)', async () => {
        let calls = 0;
        const reply =
            'Here is the shell command I used for context:\n' +
            '```\nnpm run build && npm test\n```\n\n' +
            'And here is the actual structured answer:\n' +
            '{"value": "outside-the-fence"}\n';

        const wf = new FleetWorkflow(createMockFleetApi(async () => {
            calls++;
            return { content: [{ text: reply }], usage: { total_tokens: 10 } };
        }));

        const result = await wf.agent('give me json', { member_name: KNOWN_MEMBER, schema: SCHEMA });

        assert.deepStrictEqual(result, { value: 'outside-the-fence' });
        assert.strictEqual(calls, 1, 'a fenced non-JSON snippet must not prevent falling through to valid JSON outside the fences, and must not consume a repair round');
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

    // apra-fleet-dnri: this test used to assert the OPPOSITE -- that the
    // repair prompt is a lean reminder which must NOT re-embed the original
    // prompt, because a resumed session was assumed to keep the original
    // prompt/schema available to the member. Observed live, that assumption
    // failed: a re-asked dispatch received only the validator errors, had no
    // task inputs at all, and correctly refused to guess. The re-ask is now
    // self-contained.
    // The repair dispatch's `resume` value is intentionally not asserted here
    // (apra-fleet-dnri.2 scope split); it is pinned by apra-fleet-dnri.4.
    test('the repair re-ask reattaches the original prompt + schema, bounded and identical every round', async () => {
        let calls = 0;
        const capturedPayloads = [];
        const wf = new FleetWorkflow(createMockFleetApi(async (payload) => {
            calls++;
            capturedPayloads.push(payload);
            if (calls <= 2) {
                return { content: [{ text: 'garbage {{{' }], usage: { total_tokens: 5 } };
            }
            return { content: [{ text: JSON.stringify({ value: 'ok' }) }], usage: { total_tokens: 5 } };
        }));

        await wf.agent('ORIGINAL_PROMPT_MARKER', { member_name: KNOWN_MEMBER, schema: SCHEMA });

        // 1 original + 2 repairs (default schemaRetries).
        assert.strictEqual(capturedPayloads.length, 3);
        // The initial dispatch stays self-contained/non-resumed by default.
        assert.strictEqual(capturedPayloads[0].resume, false);

        const repairPrompts = [capturedPayloads[1].prompt, capturedPayloads[2].prompt];
        for (const repairPrompt of repairPrompts) {
            assert.ok(repairPrompt.includes('ORIGINAL_PROMPT_MARKER'), 'repair prompt must reattach the original dispatch prompt unchanged');
            assert.ok(repairPrompt.includes(JSON.stringify(SCHEMA, null, 2)), 'repair prompt must state the expected JSON schema explicitly');
            assert.ok(/error/i.test(repairPrompt), 'repair prompt must still include the validation/parse errors');
        }

        // Bounded: the reattached block is byte-identical across rounds and
        // appears exactly once, i.e. repair 2 does not nest repair 1.
        const extractReference = (p) => p.slice(p.indexOf('--- BEGIN ORIGINAL REQUEST ---'), p.indexOf('--- END ORIGINAL REQUEST ---'));
        assert.ok(extractReference(repairPrompts[0]).includes('ORIGINAL_PROMPT_MARKER'));
        assert.strictEqual(extractReference(repairPrompts[0]), extractReference(repairPrompts[1]), 'the reattached portion must not grow or change between repair rounds');
        assert.strictEqual(repairPrompts[1].split('--- BEGIN ORIGINAL REQUEST ---').length - 1, 1, 'repair 2 must be built from the original prompt, not from repair 1');
        assert.strictEqual(repairPrompts[1].split('Your previous response could not be used.').length - 1, 1, 'repair 2 must not nest the previous repair prompt');
    });

    test('apra-fleet-02s.3: an explicit opts.resume is honored verbatim on the initial dispatch', async () => {
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

        await wf.agent('give me json', { member_name: KNOWN_MEMBER, schema: SCHEMA, resume: false });

        assert.strictEqual(capturedPayloads[0].resume, false, 'caller explicitly asked for resume:false on the initial dispatch');
        // The repair dispatch's own resume value is out of scope here
        // (apra-fleet-dnri.2); apra-fleet-dnri.4 owns that contract.
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
                return { content: [{ text: 'garbage {{{' }], usage: { input_tokens: 1000, output_tokens: 500, total_tokens: 1500 } };
            }
            return { content: [{ text: JSON.stringify({ value: 'ok' }) }], usage: { input_tokens: 1000, output_tokens: 500, total_tokens: 1500 } };
        }));

        assert.strictEqual(wf.budget.spent(), 0);
        await wf.agent('give me json', { member_name: KNOWN_MEMBER, schema: SCHEMA, model: 'gpt-4o' });

        // gpt-4o: 1000 prompt * $5/1M + 500 completion * $15/1M = 0.0125 per dispatch.
        // Two dispatches happened (1 failed original + 1 successful repair).
        assert.ok(Math.abs(wf.budget.spent() - 0.025) < 1e-9, `expected cost from exactly 2 dispatches, got ${wf.budget.spent()}`);
    });
});

// apra-fleet-dnri.2: engine-level regression for the reattachment contract.
// These drive FleetWorkflow.agent() end to end and assert on the payload that
// actually reaches executePrompt -- a string-level unit test on the
// buildRepairPrompt helper would not catch a regression in which prompt the
// engine feeds it, and the live failure was exactly that the member received
// a re-ask with no task inputs in it at all.
//
// Deliberately out of scope here: what the repair payload's `resume` value
// targets. That contract lives in apra-fleet-dnri.4; nothing below constrains
// `resume` on a repair dispatch.
describe('apra-fleet-dnri.2: the repair dispatch payload carries the original inputs and a schema reference', () => {
    // A schema whose required property name is distinctive enough that its
    // presence in the retry prompt can only come from the schema having been
    // reattached (a generic name like `value` could appear incidentally).
    const REVIEW_SCHEMA = {
        type: 'object',
        required: ['zzqx_verdict_marker'],
        properties: {
            zzqx_verdict_marker: { type: 'string' },
            zzqx_notes_marker: { type: 'string' }
        }
    };
    const validReply = () => JSON.stringify({ zzqx_verdict_marker: 'APPROVED' });

    test('the second dispatch payload contains the original prompt verbatim, a schema reference, and the validator errors', async () => {
        const payloads = [];
        let calls = 0;
        const wf = new FleetWorkflow(createMockFleetApi(async (payload) => {
            calls++;
            payloads.push(payload);
            if (calls === 1) {
                return { content: [{ text: 'sorry, no json here at all' }], usage: { total_tokens: 5 } };
            }
            return { content: [{ text: validReply() }], usage: { total_tokens: 5 } };
        }));

        const originalPrompt = 'Review the diff and answer with the required JSON.';
        await wf.agent(originalPrompt, { member_name: KNOWN_MEMBER, schema: REVIEW_SCHEMA });

        assert.strictEqual(payloads.length, 2, 'expected exactly 1 original dispatch + 1 repair dispatch');
        const retry = payloads[1].prompt;
        assert.ok(
            retry.includes(originalPrompt),
            'the repair dispatch dropped the ORIGINAL PROMPT TEXT -- the member is being asked to fix output for a request it can no longer see'
        );
        assert.ok(
            retry.includes('zzqx_verdict_marker'),
            'the repair dispatch dropped the SCHEMA REFERENCE -- no required property name from the schema survived into the retry prompt'
        );
        assert.ok(
            /error/i.test(retry),
            'the repair dispatch must still carry the validator error text alongside the reattached inputs'
        );
    });

    test('reviewer-style required inputs (base branch, branch, bead-id-shaped tokens) all survive into the retry prompt', async () => {
        // Invented fixture identifiers only -- never a real tracker id.
        const BASE_BRANCH = 'fixturemain';
        const BRANCH = 'feat/fixture-sprint-track';
        const ITEM_IDS = ['fixtureproj-abcd.1', 'fixtureproj-abcd.2'];
        const originalPrompt = [
            `Base branch: ${BASE_BRANCH}`,
            `Sprint branch: ${BRANCH}`,
            `Review the work items: ${ITEM_IDS.join(', ')}`,
            'Answer strictly as the required JSON.'
        ].join('\n');

        const payloads = [];
        let calls = 0;
        const wf = new FleetWorkflow(createMockFleetApi(async (payload) => {
            calls++;
            payloads.push(payload);
            if (calls === 1) {
                // The live failure shape: the member replied in prose because
                // the re-ask it got had no inputs to work from.
                return { content: [{ text: 'I do not have the branch or the work items, so I cannot answer.' }], usage: { total_tokens: 5 } };
            }
            return { content: [{ text: validReply() }], usage: { total_tokens: 5 } };
        }));

        await wf.agent(originalPrompt, { member_name: KNOWN_MEMBER, schema: REVIEW_SCHEMA });

        assert.strictEqual(payloads.length, 2);
        const retry = payloads[1].prompt;
        assert.ok(retry.includes(BASE_BRANCH), `the repair dispatch dropped the BASE BRANCH input (${BASE_BRANCH})`);
        assert.ok(retry.includes(BRANCH), `the repair dispatch dropped the SPRINT BRANCH input (${BRANCH})`);
        for (const id of ITEM_IDS) {
            assert.ok(retry.includes(id), `the repair dispatch dropped the WORK ITEM id input (${id})`);
        }
        assert.ok(retry.includes('zzqx_verdict_marker'), 'the repair dispatch dropped the SCHEMA REFERENCE');
    });

    test('a second repair round still carries the original inputs and schema, without compounding', async () => {
        const originalPrompt = 'Base branch: fixturemain\nAnswer strictly as the required JSON.';
        const payloads = [];
        let calls = 0;
        const wf = new FleetWorkflow(createMockFleetApi(async (payload) => {
            calls++;
            payloads.push(payload);
            if (calls <= 2) {
                return { content: [{ text: 'still not json' }], usage: { total_tokens: 5 } };
            }
            return { content: [{ text: validReply() }], usage: { total_tokens: 5 } };
        }));

        await wf.agent(originalPrompt, { member_name: KNOWN_MEMBER, schema: REVIEW_SCHEMA });

        assert.strictEqual(payloads.length, 3, 'expected 1 original + 2 repair dispatches');
        const round2 = payloads[2].prompt;
        assert.ok(round2.includes('fixturemain'), 'repair round 2 dropped the BASE BRANCH input');
        assert.ok(round2.includes('zzqx_verdict_marker'), 'repair round 2 dropped the SCHEMA REFERENCE');
        // Bounded: round 2 is re-derived from the ORIGINAL prompt, not nested
        // on top of round 1, so the reattached inputs appear exactly once and
        // the prompt does not compound across rounds.
        assert.strictEqual(
            round2.split(originalPrompt).length - 1,
            1,
            'the original inputs must appear exactly once in repair round 2 -- more than once means the retry prompt is compounding across rounds'
        );
        assert.strictEqual(
            round2.split('Your previous response could not be used.').length - 1,
            1,
            'repair round 2 must be built from the original prompt, not from repair round 1'
        );
        assert.ok(
            round2.length <= payloads[1].prompt.length + originalPrompt.length,
            `repair round 2 (${round2.length} chars) grew unboundedly over round 1 (${payloads[1].prompt.length} chars)`
        );
    });

    test('the no-schema path is untouched: non-JSON text returns as-is with exactly 1 dispatch', async () => {
        let calls = 0;
        const wf = new FleetWorkflow(createMockFleetApi(async () => {
            calls++;
            return { content: [{ text: 'just some prose, no json' }], usage: { total_tokens: 5 } };
        }));

        const result = await wf.agent('say something', { member_name: KNOWN_MEMBER });

        assert.strictEqual(result, 'just some prose, no json');
        assert.strictEqual(calls, 1, 'a call without a schema must never enter the repair loop');
    });
});
