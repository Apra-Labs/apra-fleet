import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

// =============================================================================
// sprint-doctor consult layer (design: fleet-sprint/docs/escalate-to-llm-
// design.md sections 2.2 "Inputs" and 6 "Failure modes of sprint-doctor
// itself, and its own circuit-breakers").
//
// This proves the consult CANNOT grow unbounded, CANNOT loop, and CANNOT make
// an outcome worse than the status quo:
//
//   1. an oversized log tail is truncated to the cap and the assembled input
//      still validates against the input schema;
//   2. secret-token-shaped strings in a log tail are redacted before assembly;
//   3. the dispatch options carry no tools and the premium tier;
//   4. a probes response earns exactly one probe round and one re-dispatch;
//      a second probes response is rejected and the consult fails closed;
//   5. a schema-invalid verdict (post repair-loop) returns null without
//      throwing, so the caller's behaviour is unchanged;
//   6. the per-sprint consult cap and the no-repeat-(bead, action) rule both
//      hold.
//
// Entirely offline: a fake dispatch function is injected as `agent`, never a
// live member and never a network call. No src/tools/* MCP schema is touched
// by this file.
// =============================================================================

const {
    buildConsultInput,
    runConsult,
    createConsultLimiter,
    applyNoRepeatRule,
    DEFAULT_CONSULT_LIMITS,
} = await import('../fleet-sprint/doctor-consult.mjs');
const { validateSprintDoctorInput } = await import('../fleet-sprint/contracts.mjs');

// -----------------------------------------------------------------------------
// Fixture builders
// -----------------------------------------------------------------------------

function baseParts(over = {}) {
    return {
        branch: 'feat/sprint-doctor-consult-test',
        trigger: { id: 'T1', evidenceRows: [{ ok: false, member: 'member-a' }] },
        triggeringBeadIds: ['bd-1'],
        logTails: { sprintLog: 'a short sprint log tail' },
        ...over,
    };
}

/** A schema-valid verdict carrying an action (no probes). */
function actionVerdict(over = {}) {
    return {
        classification: 'ENVIRONMENT',
        confidence: 'high',
        evidence: ['at least one evidence bullet'],
        matchedRegistryEntry: null,
        notes: 'notes',
        action: { kind: 'retry_different_member', member: 'member-b', reason: 'discriminating probe' },
        ...over,
    };
}

/** A schema-valid verdict carrying a probes request (no action). */
function probesVerdict(over = {}) {
    return {
        classification: 'UNCLEAR',
        confidence: 'low',
        evidence: ['not enough evidence yet'],
        matchedRegistryEntry: null,
        notes: 'notes',
        probes: ['bd_show'],
        ...over,
    };
}

/** A queue-driven fake agent(): returns the next queued response, recording every call's opts. */
function queuedAgent(responses) {
    const queue = [...responses];
    const calls = [];
    const fn = async (prompt, opts) => {
        calls.push({ prompt, opts });
        if (queue.length === 0) throw new Error('queuedAgent: exhausted -- no more responses queued');
        const next = queue.shift();
        if (next instanceof Error) throw next;
        return next;
    };
    fn.calls = calls;
    return fn;
}

// -----------------------------------------------------------------------------
// 1. Oversized log tails are truncated to the cap, and the assembled input
//    still validates against the input schema.
// -----------------------------------------------------------------------------
describe('bounded input assembly: oversized log tails are truncated, not dropped', () => {
    test('a sprintLog tail bigger than the cap is truncated, reported as truncated, and the input still validates', () => {
        const cap = 1024;
        const big = 'x'.repeat(cap * 5);
        const input = buildConsultInput(baseParts({ logTails: { sprintLog: big } }), { logTailBytes: cap });

        assert.equal(input.logTails.sprintLogTruncated, true);
        assert.equal(input.logTails.sprintLogOriginalBytes, cap * 5);
        assert.match(input.logTails.sprintLog, /\[truncated: \d+ of \d+ bytes omitted/);

        const check = validateSprintDoctorInput(input);
        assert.equal(check.valid, true, JSON.stringify(check.errors));
    });

    test('a memberDispatchOutput tail bigger than the cap is truncated the same way and the input still validates', () => {
        const cap = 512;
        const big = 'y'.repeat(cap * 4);
        const input = buildConsultInput(
            baseParts({ logTails: { sprintLog: 'short', memberDispatchOutput: big } }),
            { logTailBytes: cap },
        );

        assert.equal(input.logTails.memberDispatchOutputTruncated, true);
        assert.equal(input.logTails.memberDispatchOutputOriginalBytes, cap * 4);

        const check = validateSprintDoctorInput(input);
        assert.equal(check.valid, true, JSON.stringify(check.errors));
    });

    test('a tail UNDER the cap is left untouched (truncation is conditional, not unconditional)', () => {
        const input = buildConsultInput(baseParts({ logTails: { sprintLog: 'tiny' } }), { logTailBytes: 1024 });
        assert.equal(input.logTails.sprintLogTruncated, false);
        assert.match(input.logTails.sprintLog, /tiny/);
        assert.ok(!/\[truncated:/.test(input.logTails.sprintLog));
    });
});

// -----------------------------------------------------------------------------
// 2. Secrets/token-shaped strings in the log tail are redacted before
//    assembly.
// -----------------------------------------------------------------------------
describe('bounded input assembly: secret-token-shaped strings are redacted before assembly', () => {
    test('a {{secret.NAME}} reference in the sprint log tail is redacted (braces stripped) before it reaches the assembled input', () => {
        const input = buildConsultInput(
            baseParts({ logTails: { sprintLog: 'build failed while using {{secret.DEPLOY_TOKEN}} to authenticate' } }),
        );
        assert.ok(!input.logTails.sprintLog.includes('{{secret.DEPLOY_TOKEN}}'), 'the braced secret token must not reach the assembled input');
        assert.match(input.logTails.sprintLog, /secret\.DEPLOY_TOKEN/, 'the name should still read, unbraced');
        assert.match(input.logTails.sprintLog, /redacted/i);
    });

    test('the deprecated {{secure.NAME}} spelling is redacted identically', () => {
        const input = buildConsultInput(
            baseParts({ logTails: { sprintLog: 'legacy token {{secure.LEGACY_KEY}} used here' } }),
        );
        assert.ok(!input.logTails.sprintLog.includes('{{secure.LEGACY_KEY}}'));
        assert.match(input.logTails.sprintLog, /secure\.LEGACY_KEY/);
    });

    test('the memberDispatchOutput tail is redacted the same way as the sprint log tail', () => {
        const input = buildConsultInput(
            baseParts({ logTails: { sprintLog: 'x', memberDispatchOutput: 'leaked {{secret.API_KEY}} in member output' } }),
        );
        assert.ok(!input.logTails.memberDispatchOutput.includes('{{secret.API_KEY}}'));
        assert.match(input.logTails.memberDispatchOutput, /secret\.API_KEY/);
    });

    test('a log tail with no secret-token shape is left unredacted (no false positive marker)', () => {
        const input = buildConsultInput(baseParts({ logTails: { sprintLog: 'a perfectly ordinary failure, no tokens here' } }));
        assert.ok(!/redacted/i.test(input.logTails.sprintLog));
    });
});

// -----------------------------------------------------------------------------
// 3. The dispatch options carry no tools and tier premium.
// -----------------------------------------------------------------------------
describe('runConsult: the single dispatch is zero-tool and premium-tier', () => {
    test('agent() is invoked with allowed_tools: [] and model: "premium"', async () => {
        const agent = queuedAgent([actionVerdict()]);
        const input = buildConsultInput(baseParts());

        const verdict = await runConsult({ agent, member: 'member-a', log: () => {} }, input);

        assert.ok(verdict, 'expected a verdict back');
        assert.equal(agent.calls.length, 1);
        const opts = agent.calls[0].opts;
        assert.deepEqual(opts.allowed_tools, []);
        assert.equal(opts.model, 'premium');
        assert.equal(opts.resume, false, 'a consult must never resume a prior session');
        assert.equal(opts.max_turns, DEFAULT_CONSULT_LIMITS.maxTurns);
    });
});

// -----------------------------------------------------------------------------
// 4. A probes response leads to exactly one probe round and one re-dispatch;
//    a second probes response is rejected and the consult fails closed.
// -----------------------------------------------------------------------------
describe('runConsult: exactly one probe round, then a mandatory action', () => {
    test('a probes response is followed by exactly one re-dispatch that carries the probe results, and returns the eventual action verdict', async () => {
        const agent = queuedAgent([probesVerdict(), actionVerdict()]);
        const command = async () => 'bd show output';
        const input = buildConsultInput(baseParts());

        const verdict = await runConsult(
            { agent, command, member: 'member-a', orchestratorMember: 'orchestrator-member', log: () => {} },
            input,
        );

        assert.ok(verdict, 'expected the eventual action verdict, not null');
        assert.equal(verdict.action.kind, 'retry_different_member');
        assert.equal(agent.calls.length, 2, 'exactly one probe round means exactly two dispatches: the probe ask, then the re-dispatch');
        assert.match(agent.calls[1].opts.label, /after probe round/);
        assert.match(agent.calls[1].prompt, /Probe results/);
        assert.match(agent.calls[1].prompt, /second and FINAL dispatch/);
    });

    test('a second probes response (round two) is refused outright: the consult fails closed and returns null', async () => {
        const agent = queuedAgent([probesVerdict(), probesVerdict()]);
        const command = async () => 'bd show output';
        const logs = [];
        const input = buildConsultInput(baseParts());

        const verdict = await runConsult(
            { agent, command, member: 'member-a', orchestratorMember: 'orchestrator-member', log: (m) => logs.push(m) },
            input,
        );

        assert.equal(verdict, null, 'a second probes response must never be honoured');
        assert.equal(agent.calls.length, 2, 'the round-two probes response must not earn a third dispatch');
        assert.ok(logs.some((m) => /second probes response/.test(m)), 'the fail-closed path must be logged');
    });

    test('an action verdict on the FIRST dispatch never triggers any probe round at all', async () => {
        const agent = queuedAgent([actionVerdict()]);
        const input = buildConsultInput(baseParts());

        const verdict = await runConsult({ agent, member: 'member-a', log: () => {} }, input);

        assert.ok(verdict);
        assert.equal(agent.calls.length, 1, 'no probe round means no second dispatch');
    });
});

// -----------------------------------------------------------------------------
// 5. A schema-invalid verdict after the repair loop returns null without
//    throwing; the caller's behaviour is unchanged.
// -----------------------------------------------------------------------------
describe('runConsult: every failure is additive -- logs and returns null, never throws', () => {
    test('a schema-invalid verdict (neither action nor probes) returns null without throwing', async () => {
        const agent = queuedAgent([{
            classification: 'ENVIRONMENT',
            confidence: 'high',
            evidence: ['e'],
            matchedRegistryEntry: null,
            notes: 'n',
            // no action, no probes: out of contract
        }]);
        const input = buildConsultInput(baseParts());

        await assert.doesNotReject(async () => {
            const verdict = await runConsult({ agent, member: 'member-a', log: () => {} }, input);
            assert.equal(verdict, null);
        });
    });

    test('a schema-invalid verdict (both action and probes present) returns null without throwing', async () => {
        const agent = queuedAgent([actionVerdict({ probes: ['bd_show'] })]);
        const input = buildConsultInput(baseParts());

        const verdict = await runConsult({ agent, member: 'member-a', log: () => {} }, input);
        assert.equal(verdict, null);
    });

    test('a dispatch error from agent() returns null without throwing (the caller must never catch)', async () => {
        const agent = queuedAgent([new Error('transport gone')]);
        const input = buildConsultInput(baseParts());

        await assert.doesNotReject(async () => {
            const verdict = await runConsult({ agent, member: 'member-a', log: () => {} }, input);
            assert.equal(verdict, null);
        });
    });

    test('a missing dispatch verb (no agent()) returns null without throwing -- the pre-doctor path', async () => {
        const input = buildConsultInput(baseParts());
        const verdict = await runConsult({ member: 'member-a', log: () => {} }, input);
        assert.equal(verdict, null);
    });

    test('a missing member returns null without throwing -- there is nothing to dispatch on', async () => {
        const agent = queuedAgent([actionVerdict()]);
        const input = buildConsultInput(baseParts());
        const verdict = await runConsult({ agent, log: () => {} }, input);
        assert.equal(verdict, null);
        assert.equal(agent.calls.length, 0, 'no dispatch may be attempted with no member to dispatch on');
    });

    test('an input that fails its own pre-flight schema check is never dispatched at all', async () => {
        const agent = queuedAgent([actionVerdict()]);
        // triggeringBeadIds is required and minItems 1 -- an empty array fails preflight.
        const badInput = { ...buildConsultInput(baseParts()), triggeringBeadIds: [] };
        const verdict = await runConsult({ agent, member: 'member-a', log: () => {} }, badInput);
        assert.equal(verdict, null);
        assert.equal(agent.calls.length, 0, 'a pre-flight-invalid input must cost no premium dispatch');
    });
});

// -----------------------------------------------------------------------------
// 6. The per-sprint consult cap and the no-repeat-(bead, action) rule both
//    hold.
// -----------------------------------------------------------------------------
describe('createConsultLimiter: the per-sprint and per-class circuit breakers', () => {
    test('the per-sprint consult cap refuses once exhausted', () => {
        const limiter = createConsultLimiter({ maxConsults: 2, maxPerClass: 10 });

        assert.equal(limiter.check().allowed, true);
        limiter.noteConsult();
        assert.equal(limiter.check().allowed, true);
        limiter.noteConsult();

        const blocked = limiter.check();
        assert.equal(blocked.allowed, false);
        assert.match(blocked.reason, /per-sprint consult cap \(2\) reached/);
        assert.equal(limiter.count(), 2);
    });

    test('the per-error-class cap refuses further consults for that class while leaving other classes open', () => {
        const limiter = createConsultLimiter({ maxConsults: 100, maxPerClass: 2 });

        limiter.noteConsult('class-a');
        limiter.noteConsult('class-a');
        const blockedA = limiter.check('class-a');
        assert.equal(blockedA.allowed, false);
        assert.match(blockedA.reason, /error class "class-a" has already been consulted 2 time\(s\)/);

        const allowedB = limiter.check('class-b');
        assert.equal(allowedB.allowed, true, 'a different error class must not be affected by class-a\'s cap');
    });
});

describe('applyNoRepeatRule: a (beadId, action.kind) pair may be prescribed at most once', () => {
    test('the first prescription of an action for a bead is recorded and returned unchanged', () => {
        const limiter = createConsultLimiter();
        const verdict = actionVerdict({ action: { kind: 'retry_same', reason: 'first try' } });

        const result = applyNoRepeatRule(verdict, ['bd-1'], limiter);

        assert.equal(result.overridden, false);
        assert.equal(result.verdict.action.kind, 'retry_same');
        assert.equal(limiter.hasPrescribed('bd-1', 'retry_same'), true);
    });

    test('a SECOND prescription of the same (bead, kind) pair is overridden to defer_bead by the engine, not the model', () => {
        const limiter = createConsultLimiter();
        const first = actionVerdict({ action: { kind: 'retry_same', reason: 'first try' } });
        applyNoRepeatRule(first, ['bd-1'], limiter);

        const second = actionVerdict({ action: { kind: 'retry_same', reason: 'same remedy, tried again' } });
        const result = applyNoRepeatRule(second, ['bd-1'], limiter);

        assert.equal(result.overridden, true);
        assert.equal(result.verdict.action.kind, 'defer_bead');
        assert.equal(result.verdict.action.overriddenFrom, 'retry_same');
        assert.deepEqual(result.verdict.action.beadIds, ['bd-1']);
        assert.match(result.reason, /already prescribed this sprint/);
    });

    test('the override is non-mutating: the original verdict object is left untouched', () => {
        const limiter = createConsultLimiter();
        const original = actionVerdict({ action: { kind: 'retry_same', reason: 'r' } });
        applyNoRepeatRule(original, ['bd-1'], limiter);

        const secondOriginal = actionVerdict({ action: { kind: 'retry_same', reason: 'r2' } });
        applyNoRepeatRule(secondOriginal, ['bd-1'], limiter);

        assert.equal(secondOriginal.action.kind, 'retry_same', 'the input verdict object itself must never be mutated');
    });

    test('a different bead is unaffected by another bead\'s repeated action -- the rule is scoped per (bead, kind)', () => {
        const limiter = createConsultLimiter();
        applyNoRepeatRule(actionVerdict({ action: { kind: 'retry_same', reason: 'r' } }), ['bd-1'], limiter);

        const result = applyNoRepeatRule(
            actionVerdict({ action: { kind: 'retry_same', reason: 'r' } }),
            ['bd-2'],
            limiter,
        );
        assert.equal(result.overridden, false);
        assert.equal(result.verdict.action.kind, 'retry_same');
    });
});
