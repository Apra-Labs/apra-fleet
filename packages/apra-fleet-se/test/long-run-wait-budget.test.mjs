// Role wait guidance and the engine inactivity budget agree.
//
// The roles that wait on long-running commands are told an engine-stated wait
// limit in their dispatched prompt, derived from the SAME timeout_s the
// dispatch carries (fleet-sprint/long-run-wait.mjs). These tests pin:
//   - the prompt actually dispatched (recorded agent() call through the real
//     dispatchRole engine) states a wait limit strictly below that dispatch's
//     timeout_s, for the default run and for a small dispatch_timeout_s;
//   - the role .md files carry no fixed short polling cadence;
//   - the helper stays below its input and never above the host per-call cap;
//   - the default run's inactivity budget (timeout_s) is unchanged.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { driveEngineDispatch } from './helpers/dispatch-role-harness.mjs';
import { resolveDispatchInactivityTimeoutS } from '../fleet-sprint/runner.js';
import { validateArgs } from '../fleet-sprint/sprint-args.mjs';
import {
    resolveLongRunWaitS,
    longRunWaitNotice,
    HOST_TOOL_CALL_CAP_S,
    LONG_RUN_WAIT_AGENT_TYPES,
} from '../fleet-sprint/long-run-wait.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const AGENTS_DIR = path.join(__dirname, '..', 'apra-pm', 'agents');

// The default dispatch_timeout_s, read from the real arg validator rather
// than re-typed, so a changed default changes these expectations with it.
const DEFAULT_DISPATCH_TIMEOUT_S = validateArgs({
    target_issues: ['x-1'], members: ['m'], branch: 'feat/x', base_branch: 'main',
}).dispatchTimeoutS;

/** The run budgets the runner hands ctx.budgets for a given dispatch_timeout_s. */
function runBudgets(dispatchTimeoutS) {
    return {
        DISPATCH_TIMEOUT_S: dispatchTimeoutS,
        DISPATCH_INACTIVITY_TIMEOUT_S: resolveDispatchInactivityTimeoutS(dispatchTimeoutS),
        INTEG_MAX_TOTAL_S: dispatchTimeoutS * 2,
        REGRESSION_TEST_MAX_TOTAL_S: dispatchTimeoutS * 3,
    };
}

function statedWaitS(prompt) {
    const m = /Wait limit: (\d+) seconds/.exec(prompt);
    return m ? Number(m[1]) : null;
}

function statedBudgetS(prompt) {
    const m = /Inactivity budget for this dispatch: (\d+) seconds/.exec(prompt);
    return m ? Number(m[1]) : null;
}

describe('dispatched prompt states a wait limit strictly below its timeout_s', () => {
    const scenarios = [
        { name: 'default dispatch_timeout_s', dispatchTimeoutS: DEFAULT_DISPATCH_TIMEOUT_S },
        { name: 'small dispatch_timeout_s=300 (inactivity budget clamped down)', dispatchTimeoutS: 300 },
    ];
    for (const role of ['doer', 'reviewer', 'integ-test-runner']) {
        for (const scenario of scenarios) {
            test(`${role}: ${scenario.name}`, async () => {
                const budgets = runBudgets(scenario.dispatchTimeoutS);
                const { dispatch, opts } = await driveEngineDispatch(role, 'main', { ctx: { budgets } });
                assert.ok(dispatch, 'the engine made a dispatch');
                const timeoutS = dispatch.options.timeout_s;
                assert.equal(timeoutS, budgets.DISPATCH_INACTIVITY_TIMEOUT_S, 'timeout_s is the run inactivity budget');
                const waitS = statedWaitS(dispatch.prompt);
                assert.notEqual(waitS, null, `the dispatched ${role} prompt states a wait limit:\n${dispatch.prompt}`);
                assert.ok(waitS > 0, 'the stated wait limit is positive');
                assert.ok(waitS < timeoutS, `stated wait limit ${waitS}s must be strictly below timeout_s ${timeoutS}s`);
                assert.ok(waitS <= HOST_TOOL_CALL_CAP_S, `stated wait limit ${waitS}s must not exceed the host per-call cap`);
                assert.equal(statedBudgetS(dispatch.prompt), timeoutS, 'the stated inactivity budget is the one the dispatch carries');
                assert.equal(waitS, resolveLongRunWaitS(timeoutS), 'the stated limit comes from the shared helper');
                assert.ok(dispatch.prompt.includes(opts.prompt), 'the caller prompt is still delivered in full');
            });
        }
    }

    test('a role without the wait guidance (planner) gets no wait-limit block', async () => {
        const { dispatch } = await driveEngineDispatch('planner', 'main', { ctx: { budgets: runBudgets(DEFAULT_DISPATCH_TIMEOUT_S) } });
        assert.equal(statedWaitS(dispatch.prompt), null);
    });
});

describe('default run: the inactivity budget passed as timeout_s is unchanged', () => {
    test('default dispatch_timeout_s 9000 clamps to an 1800s inactivity budget', () => {
        assert.equal(DEFAULT_DISPATCH_TIMEOUT_S, 9000);
        assert.equal(resolveDispatchInactivityTimeoutS(DEFAULT_DISPATCH_TIMEOUT_S), 1800);
    });

    test('the doer dispatch of a default run carries timeout_s 1800', async () => {
        const { dispatch } = await driveEngineDispatch('doer', 'main', { ctx: { budgets: runBudgets(DEFAULT_DISPATCH_TIMEOUT_S) } });
        assert.equal(dispatch.options.timeout_s, 1800);
        assert.equal(statedWaitS(dispatch.prompt), 600);
    });
});

describe('resolveLongRunWaitS', () => {
    const budgets = [1, 2, 3, 59, 60, 61, 120, 300, 599, 1199, 1200, 1201, 1800, 3600, 9000, 86_400, 1_000_000];
    for (const b of budgets) {
        test(`budget ${b}s -> a whole-second limit below the budget and within the host cap`, () => {
            const w = resolveLongRunWaitS(b);
            assert.ok(Number.isInteger(w), `${w} is a whole number of seconds`);
            assert.ok(w >= 0);
            assert.ok(w < b, `${w} < ${b}`);
            assert.ok(w <= HOST_TOOL_CALL_CAP_S, `${w} <= ${HOST_TOOL_CALL_CAP_S}`);
        });
    }

    test('the host cap is 10 minutes', () => {
        assert.equal(HOST_TOOL_CALL_CAP_S, 600);
    });

    test('rejects a non-positive or non-finite budget', () => {
        for (const bad of [0, -1, Number.NaN, Number.POSITIVE_INFINITY, '1800', undefined, null]) {
            assert.throws(() => resolveLongRunWaitS(bad), RangeError);
        }
    });

    test('no notice when the budget is too small to allow a 1s wait', () => {
        assert.equal(longRunWaitNotice(1), null);
        assert.match(longRunWaitNotice(2), /Wait limit: 1 seconds/);
    });

    test('the personas told the limit include doer, reviewer and integ-test-runner', () => {
        for (const role of ['doer', 'reviewer', 'integ-test-runner']) {
            assert.ok(LONG_RUN_WAIT_AGENT_TYPES.includes(role), role);
        }
    });
});

describe('role prompts carry no fixed short polling cadence', () => {
    const files = fs.readdirSync(AGENTS_DIR).filter((f) => f.endsWith('.md'));

    test('the agents directory has role prompts to check', () => {
        assert.ok(files.includes('doer.md') && files.includes('reviewer.md') && files.includes('integ-test-runner.md'));
    });

    const CADENCE = [
        /once a minute/i,
        /every\s+(?:~|about\s+|roughly\s+)?\d+\s+minutes?/i,
        /at least every\s+~?\d+/i,
        /every\s+(?:~|about\s+)?(?:a|one|two)\s+minutes?/i,
    ];
    for (const file of files) {
        test(`${file} states no short fixed polling cadence`, () => {
            const text = fs.readFileSync(path.join(AGENTS_DIR, file), 'utf8').replace(/\s+/g, ' ');
            for (const re of CADENCE) {
                assert.doesNotMatch(text, re, `${file} must not require a fixed short check cadence`);
            }
        });
    }

    for (const agentType of LONG_RUN_WAIT_AGENT_TYPES) {
        test(`${agentType}.md refers to the engine-stated wait limit`, () => {
            const text = fs.readFileSync(path.join(AGENTS_DIR, `${agentType}.md`), 'utf8').replace(/\s+/g, ' ');
            assert.match(text, /engine-stated wait limit/);
        });
    }
});
