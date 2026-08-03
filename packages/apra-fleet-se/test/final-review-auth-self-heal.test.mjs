import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runDevelopLoopScenario, withScenarioMarkers } from './helpers/mock-sprint-harness.mjs';

const check = (cond, msg) => assert.ok(cond, msg);

// =============================================================================
// apra-fleet-9ta.3 -- Final Review's LLM-auth self-heal used to fall through to
// a SECOND full Final Review dispatch even after a successful heal + retry,
// overwriting the healed verdict (a PASS could become a FAIL) and doubling
// cost on the sprint's most expensive dispatch. A throw from the heal-retry
// itself also escaped the catch entirely, aborting the whole sprint instead of
// degrading to the hardcoded FAIL fallback like every other Final Review
// failure mode. runner.js now short-circuits on a successful heal (keeping
// the healed verdict, never re-dispatching) and routes a heal-retry throw
// through the SAME FAIL-fallback ladder as an ordinary retry failure.
// =============================================================================

// Mocks provision_llm_auth as an unconditional success -- the real tool
// returns a skip marker ('⏭') for local members (only an interactive /login
// can fix those), but that judgment lives server-side in the tool response,
// not hardcoded in runner.js by member name; a test-injected callTool can
// return a real success response for any member to exercise the healed path.
const healingCallTool = async (name) => {
    if (name === 'provision_llm_auth') {
        return { content: [{ text: '✅ provisioned LLM credentials' }] };
    }
    // apra-fleet-647.1.2.1: provisionVcsAuthForMember (reached by this
    // scenario's own git push/PR steps, unrelated to the LLM-auth self-heal
    // under test here) resolves the member's provider via VCSModule.
    // resolveProvider(), a 'member_detail' call that requires a real JSON
    // body -- unlike the other tool names here, which none of runner.js's
    // VCS/coordination call sites JSON.parse().
    if (name === 'member_detail') {
        return { content: [{ text: JSON.stringify({ vcsProvider: 'github' }) }] };
    }
    return { content: [{ text: '' }] };
};

test('mock sprint: a successful Final Review LLM-auth self-heal short-circuits -- exactly two attempts, healed verdict preserved', async () => {
    await withScenarioMarkers('final review auth self-heal (success)', async () => {
        console.log('Running mock sprint scenario (Final Review auth failure + successful self-heal)...');
        let finalReviewCalls = 0;
        const sc = await runDevelopLoopScenario('finalreviewhealok', {
            members: ['local'],
            taskSpecs: [{ title: 'Task: Final Review auth self-heal success scenario work' }],
            maxCycles: 1,
            callTool: healingCallTool,
            finalReviewHandler: async () => {
                finalReviewCalls++;
                if (finalReviewCalls === 1) {
                    return {
                        content: [{ text: 'Authentication failed on "local". Run /login to refresh your credentials.' }],
                        structuredContent: { isError: true, reason: 'nonzero_exit' },
                    };
                }
                return {
                    content: [{ text: JSON.stringify({ verdict: 'PASS', notes: 'Healed and approved.' }) }],
                };
            },
        });

        check(!sc.error, `Expected the sprint to resolve (not abort) after a successful self-heal, got error: ${sc.error ? sc.error.constructor.name + ': ' + sc.error.message : 'none'}`);
        check(
            finalReviewCalls === 2,
            `Expected exactly 2 runFinalReviewAttempt invocations (original auth-failing attempt + one heal-retry), got ${finalReviewCalls}`
        );
        check(
            sc.result && sc.result.verdict === 'PASS' && sc.result.notes === 'Healed and approved.',
            `Expected the healed verdict to be preserved (not overwritten by a second dispatch), got: ${JSON.stringify(sc.result)}`
        );
        check(
            sc.result && sc.result.status === 'success',
            `Expected the sprint to succeed off the preserved healed PASS verdict, got: ${JSON.stringify(sc.result)}`
        );
        check(
            sc.logs.some((m) => m.includes('LLM auth self-heal succeeded -- retrying once')),
            `Expected the self-heal success log line, logs: ${JSON.stringify(sc.logs)}`
        );
        check(
            !sc.logs.some((m) => m.includes('Final Review: dispatch failed') && m.includes('Retrying once')),
            `Did NOT expect the generic retry-once ladder to also fire (that would mean a wasted SECOND-after-heal dispatch), logs: ${JSON.stringify(sc.logs)}`
        );
    });
});

test('mock sprint: a Final Review heal-retry that itself throws degrades to the FAIL fallback instead of aborting the sprint', async () => {
    await withScenarioMarkers('final review auth self-heal (heal-retry throws)', async () => {
        console.log('Running mock sprint scenario (Final Review auth failure, heal succeeds, but the heal-retry dispatch itself fails)...');
        let finalReviewCalls = 0;
        const sc = await runDevelopLoopScenario('finalrevhealretry2', {
            members: ['local'],
            taskSpecs: [{ title: 'Task: Final Review auth self-heal, heal-retry-fails scenario work' }],
            maxCycles: 1,
            callTool: healingCallTool,
            finalReviewHandler: async () => {
                finalReviewCalls++;
                if (finalReviewCalls === 1) {
                    return {
                        content: [{ text: 'Authentication failed on "local". Run /login to refresh your credentials.' }],
                        structuredContent: { isError: true, reason: 'nonzero_exit' },
                    };
                }
                // The heal succeeded (credentials re-provisioned), but this
                // retry dispatch fails for an unrelated, non-auth reason --
                // must degrade to FAIL, never escape uncaught.
                return {
                    content: [{ text: 'transport reset mid-dispatch' }],
                    structuredContent: { isError: true, reason: 'dispatch_failed' },
                };
            },
        });

        check(!sc.error, `Expected the sprint to resolve (never abort) even when the heal-retry itself fails, got error: ${sc.error ? sc.error.constructor.name + ': ' + sc.error.message : 'none'}`);
        check(
            finalReviewCalls === 2,
            `Expected exactly 2 runFinalReviewAttempt invocations (original auth-failing attempt + one heal-retry, no third dispatch), got ${finalReviewCalls}`
        );
        check(
            sc.result && sc.result.verdict === 'FAIL' && sc.result.status === 'failed',
            `Expected the hardcoded FAIL fallback (heal-retry failure degrades, does not abort), got: ${JSON.stringify(sc.result)}`
        );
        check(
            sc.logs.some((m) => m.includes('heal-retry agent dispatch failed') && m.includes('treating as FAIL')),
            `Expected a logged heal-retry-failure -> FAIL fallback message, logs: ${JSON.stringify(sc.logs)}`
        );
    });
});
