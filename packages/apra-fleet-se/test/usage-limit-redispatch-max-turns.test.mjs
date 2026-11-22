import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { AgentDispatchError } from '@apralabs/apra-fleet-workflow';
import { EXECUTE_PROMPT_MAX_TURNS } from '@apralabs/apra-fleet-client';

import { dispatchRole, secondaryMaxTurns } from '../fleet-sprint/dispatch-role.mjs';
import { ROLE_CALL_OPTS, createRecordingCtx } from './helpers/dispatch-role-harness.mjs';

// A usage-limit redispatch resumes the limited session through the role's
// max-turns secondary, whose raw budget (BASE * 2) exceeds what execute_prompt
// accepts. The transport below validates max_turns against the schema maximum
// (EXECUTE_PROMPT_MAX_TURNS, pinned to the real executePromptSchema by a root
// test) exactly as the server would, rejecting an over-limit call as a
// transport failure.

const SESSION = 'sess-limited-1';
const usageLimitError = () => new AgentDispatchError('hit your usage limit', {
    details: { reason: 'usage_limit', sessionId: SESSION },
});

function schemaValidatingTransport(entry) {
    const n = entry.options.max_turns;
    if (typeof n === 'number' && n > EXECUTE_PROMPT_MAX_TURNS) {
        return new AgentDispatchError(`Invalid arguments: max_turns ${n} > ${EXECUTE_PROMPT_MAX_TURNS}`, {
            details: { reason: 'transport_failure' },
        });
    }
    return { verdict: 'APPROVED', notes: 'resumed ok' };
}

describe('usage-limit redispatch max_turns', () => {
    test('the redispatch resumes the session at a schema-valid max_turns, with no transport_failure or synthesized verdict', async () => {
        const { ctx, rec } = createRecordingCtx({ responses: [usageLimitError(), schemaValidatingTransport] });
        ctx.onUsageLimit = async () => ({ resumed: true });
        const outcome = await dispatchRole(ctx, 'reviewer', { ...ROLE_CALL_OPTS.reviewer });

        assert.equal(rec.dispatches.length, 2);
        assert.equal(rec.dispatches[1].options.resume, SESSION);
        assert.ok(rec.dispatches[1].options.max_turns <= EXECUTE_PROMPT_MAX_TURNS, `sent ${rec.dispatches[1].options.max_turns}`);
        assert.equal(outcome.ok, true);
        assert.deepEqual(outcome.value, { verdict: 'APPROVED', notes: 'resumed ok' });
        assert.ok(!outcome.degraded, 'no synthesized/degraded result');
        assert.ok(!rec.logs.some((m) => /transport_failure/.test(m)), JSON.stringify(rec.logs));
    });

    test('the resume label shows the clamped value actually sent, not the unclamped double', async () => {
        const { ctx, rec } = createRecordingCtx({ responses: [usageLimitError(), schemaValidatingTransport] });
        ctx.onUsageLimit = async () => ({ resumed: true });
        await dispatchRole(ctx, 'reviewer', { ...ROLE_CALL_OPTS.reviewer, resumeLabel: `Review (resume, max_turns=${secondaryMaxTurns('reviewer')})` });
        const sent = rec.dispatches[1].options.max_turns;
        assert.equal(sent, EXECUTE_PROMPT_MAX_TURNS);
        assert.equal(rec.dispatches[1].options.label, `Review (resume, max_turns=${sent})`);
        assert.ok(!rec.dispatches[1].options.label.includes('1000'));
    });

    test('max_turns-exhaustion resume announces the value actually sent', async () => {
        const exhausted = new AgentDispatchError('spent', { details: { reason: 'max_turns_exhausted', sessionId: SESSION } });
        const { ctx, rec } = createRecordingCtx({ responses: [exhausted, schemaValidatingTransport] });
        await dispatchRole(ctx, 'reviewer', { ...ROLE_CALL_OPTS.reviewer });
        const sent = rec.dispatches[1].options.max_turns;
        assert.ok(rec.logs.some((m) => m.includes(`with max_turns=${sent}`)), JSON.stringify(rec.logs));
        assert.ok(!rec.logs.some((m) => m.includes('1000')));
    });
});
