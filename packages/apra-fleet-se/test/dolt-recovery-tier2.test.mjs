import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {
    recordWedgedState,
    buildDoltTier2RunbookPrompt,
    dispatchDoltTier2Escalation,
    escalateDoltConflict,
    recoverDoltConflict,
    DEFAULT_TIER2_RUNBOOK_PATH,
    DEFAULT_CLONE_PATH,
} from '../auto-sprint/dolt-recovery-tier2.mjs';

const check = (cond, msg) => assert.ok(cond, msg);

// =============================================================================
// apra-fleet-eft.9.6 -- Tier 2 escalation on gate failure or unrecognized
// scripted output.
//
// These tests confirm: (1) the runbook doc referenced by the escalation path
// actually exists in auto-sprint docs; (2) a Tier 2 dispatch always carries a
// recorded wedged state (clone path, conflict shape, last command output);
// (3) the full Path A -> Path B -> Tier 2 ladder escalates -- rather than
// silently proceeding or retrying unbounded -- when Path A's gate rejects
// AND Path B itself hits an unrecognized scripted-step output.
// =============================================================================

function makeAgentMock(impl) {
    const calls = [];
    const agent = async (prompt, opts = {}) => {
        calls.push({ prompt, opts });
        if (impl) return impl(prompt, opts);
        return { status: 'RESOLVED' };
    };
    return { agent, calls };
}

test('the Tier 2 runbook doc exists in auto-sprint docs and is referenced by the escalation prompt/module', () => {
    const repoRoot = path.resolve(import.meta.dirname, '..', '..', '..');
    const runbookAbsPath = path.join(repoRoot, DEFAULT_TIER2_RUNBOOK_PATH);
    check(fs.existsSync(runbookAbsPath), `runbook doc must exist at ${runbookAbsPath}`);

    const wedgedState = recordWedgedState({ member: 'm1', stage: 'path-b-exhausted', lastOutput: 'boom' });
    const prompt = buildDoltTier2RunbookPrompt({ member: 'm1', wedgedState });
    check(prompt.includes(DEFAULT_TIER2_RUNBOOK_PATH), 'escalation prompt must reference the runbook doc path');
    check(/^[\x00-\x7F]*$/.test(prompt), 'runbook prompt must be ASCII-only');
});

test('recordWedgedState: records clone path, conflict shape, and last command output, never partial', () => {
    const state = recordWedgedState({
        member: 'm1',
        clonePath: '.beads/embeddeddolt',
        conflictShape: { tables: ['issues'], passed: false },
        lastOutput: 'unexpected bootstrap failure text',
        stage: 'path-b-exhausted',
    });
    check(state.member === 'm1', 'member recorded');
    check(state.clonePath === '.beads/embeddeddolt', 'clone path recorded');
    check(state.conflictShape && state.conflictShape.tables[0] === 'issues', 'conflict shape recorded');
    check(state.lastOutput === 'unexpected bootstrap failure text', 'last output recorded');
    check(state.stage === 'path-b-exhausted', 'stage recorded');
    check(typeof state.recordedAt === 'string' && state.recordedAt.length > 0, 'recordedAt timestamp present');
});

test('recordWedgedState: defaults clonePath, conflictShape, and lastOutput rather than throwing on missing fields', () => {
    const state = recordWedgedState({ member: 'm1', stage: 'path-a-error' });
    check(state.clonePath === DEFAULT_CLONE_PATH, 'clonePath defaults');
    check(state.conflictShape === null, 'conflictShape defaults to null');
    check(state.lastOutput === '(no output captured)', 'lastOutput has a non-empty default');
});

test('recordWedgedState: requires member and stage', () => {
    assert.throws(() => recordWedgedState({ stage: 'x' }), /requires a member/, 'missing member throws');
    assert.throws(() => recordWedgedState({ member: 'm1' }), /requires a stage/, 'missing stage throws');
});

test('dispatchDoltTier2Escalation: throws a clear error when no agent() is injected', async () => {
    const wedgedState = recordWedgedState({ member: 'm1', stage: 'path-b-exhausted' });
    let err = null;
    try {
        await dispatchDoltTier2Escalation({ agent: undefined, member: 'm1', wedgedState });
    } catch (e) { err = e; }
    check(err instanceof Error && /requires an injected agent/.test(err.message), 'must fail loudly without an agent()');
});

test('dispatchDoltTier2Escalation: calls agent() exactly once with explicit member_name and the wedged-state-bearing prompt', async () => {
    const { agent, calls } = makeAgentMock();
    const wedgedState = recordWedgedState({
        member: 'm1', stage: 'path-b-exhausted', clonePath: '.beads/embeddeddolt',
        conflictShape: { tables: ['labels'] }, lastOutput: 'bootstrap: unknown failure',
    });
    await dispatchDoltTier2Escalation({ agent, member: 'm1', wedgedState });
    check(calls.length === 1, `expected exactly one agent() dispatch, saw ${calls.length}`);
    check(calls[0].opts.member_name === 'm1', 'Tier 2 dispatch must carry explicit member_name');
    check(calls[0].prompt.includes('bootstrap: unknown failure'), 'prompt must carry the last command output');
    check(calls[0].prompt.includes('.beads/embeddeddolt'), 'prompt must carry the clone path');
});

test('escalateDoltConflict: records wedged state and dispatches when an agent() is injected', async () => {
    const { agent, calls } = makeAgentMock();
    const result = await escalateDoltConflict({
        agent, member: 'm1', clonePath: '.beads/embeddeddolt',
        conflictShape: { tables: ['issues'], passed: false },
        lastOutput: 'unrecognized bootstrap output', stage: 'path-b-exhausted',
    });
    check(result.escalated === true, 'escalated flag set');
    check(result.dispatched === true, 'dispatched flag set when agent injected');
    check(result.wedgedState.lastOutput === 'unrecognized bootstrap output', 'wedged state carried through');
    check(calls.length === 1, 'agent dispatched exactly once');
});

test('escalateDoltConflict: still records (never drops) the wedged state when no agent() is injected', async () => {
    const result = await escalateDoltConflict({
        member: 'm1', clonePath: '.beads/embeddeddolt', lastOutput: 'unrecognized output', stage: 'path-b-exhausted',
    });
    check(result.escalated === true, 'escalated flag set even without an agent');
    check(result.dispatched === false, 'dispatched is false without an agent');
    check(result.wedgedState.lastOutput === 'unrecognized output', 'wedged state still recorded');
});

// --- The full ladder: recoverDoltConflict --------------------------------

test('recoverDoltConflict: Path A success never falls through to Path B or Tier 2', async () => {
    let pathBCalled = false;
    const { agent, calls: agentCalls } = makeAgentMock();
    const result = await recoverDoltConflict({
        member: 'm1',
        pathA: async () => ({ ok: true, proceeded: true, resolved: true }),
        pathB: async () => { pathBCalled = true; return { ok: true }; },
        agent,
    });
    check(result.ok === true && result.tier === 'path-a', 'resolved at Path A');
    check(pathBCalled === false, 'Path B never attempted when Path A succeeds');
    check(agentCalls.length === 0, 'Tier 2 never dispatched when Path A succeeds');
});

test('recoverDoltConflict: Path A gate rejection falls back to Path B, which then resolves it', async () => {
    const { agent, calls: agentCalls } = makeAgentMock();
    const result = await recoverDoltConflict({
        member: 'm1',
        pathA: async () => ({ ok: false, proceeded: false, resolved: false, gate: { passed: false, tables: ['labels'] }, reason: 'gate rejected' }),
        pathB: async () => ({ ok: true, recovered: true }),
        agent,
    });
    check(result.ok === true && result.tier === 'path-b', 'resolved at Path B after Path A gate rejection');
    check(agentCalls.length === 0, 'Tier 2 never dispatched when Path B succeeds');
});

test('recoverDoltConflict: Path A gate rejection + Path B throwing an UNRECOGNIZED output escalates to Tier 2 (never proceeds blind)', async () => {
    const { agent, calls: agentCalls } = makeAgentMock();
    const gate = { passed: false, passedTableGate: false, tables: ['labels'], totalConflicts: 1 };
    const result = await recoverDoltConflict({
        member: 'm1',
        clonePath: '.beads/embeddeddolt',
        pathA: async () => ({ ok: false, proceeded: false, resolved: false, gate, reason: 'conflicted table(s) [labels] not in allowlist' }),
        pathB: async () => { throw new Error('bootstrap failed: some totally unrecognized dolt output the ladder has never seen'); },
        agent,
    });

    check(result.ok === false, 'never reports success past an unrecognized failure');
    check(result.tier === 'tier-2', 'escalated to Tier 2');
    check(result.escalated === true, 'escalated flag set');
    check(agentCalls.length === 1, `Tier 2 agent dispatched exactly once, saw ${agentCalls.length}`);
    check(agentCalls[0].opts.member_name === 'm1', 'Tier 2 dispatch carries explicit member_name');
    check(agentCalls[0].prompt.includes('unrecognized dolt output'), 'Tier 2 prompt carries the unrecognized output text');
    check(result.escalation.wedgedState.conflictShape.tables[0] === 'labels', 'wedged state carries the conflict shape Path A computed');
    check(result.escalation.wedgedState.clonePath === '.beads/embeddeddolt', 'wedged state carries the clone path');
});

test('recoverDoltConflict: Path A throwing an operational error also falls back to Path B before any Tier 2 escalation', async () => {
    const { agent, calls: agentCalls } = makeAgentMock();
    const result = await recoverDoltConflict({
        member: 'm1',
        pathA: async () => { throw new Error('sql-server failed to start'); },
        pathB: async () => ({ ok: true, recovered: true }),
        agent,
    });
    check(result.ok === true && result.tier === 'path-b', 'Path B still attempted and resolves after a Path A operational throw');
    check(agentCalls.length === 0, 'no Tier 2 escalation needed once Path B resolves it');
});

test('recoverDoltConflict: both Path A and Path B throwing escalates to Tier 2 exactly once (no unbounded retry loop)', async () => {
    const { agent, calls: agentCalls } = makeAgentMock();
    const result = await recoverDoltConflict({
        member: 'm1',
        pathA: async () => { throw new Error('sql-server failed to start'); },
        pathB: async () => { throw new Error('unrecognized bd bootstrap failure'); },
        agent,
    });
    check(result.tier === 'tier-2', 'escalated to Tier 2');
    check(result.escalation.wedgedState.conflictShape === null, 'conflict shape is null when Path A never reached the gate');
    check(agentCalls.length === 1, `Tier 2 attempted exactly once, saw ${agentCalls.length}`);
});

test('recoverDoltConflict: omitting agent() entirely still records the escalation (never silently drops the wedged state)', async () => {
    const result = await recoverDoltConflict({
        member: 'm1',
        pathA: async () => ({ ok: false, proceeded: false, gate: { passed: false, tables: [] }, reason: 'no conflicted table' }),
        pathB: async () => { throw new Error('unrecognized failure'); },
        // no agent injected
    });
    check(result.tier === 'tier-2', 'still classified as a Tier 2 escalation');
    check(result.escalation.dispatched === false, 'not dispatched without an agent');
    check(result.escalation.escalated === true, 'still recorded as escalated');
});

test('recoverDoltConflict requires member, pathA, and pathB', async () => {
    await assert.rejects(() => recoverDoltConflict({ pathA: async () => ({}), pathB: async () => ({}) }), /requires a member/);
    await assert.rejects(() => recoverDoltConflict({ member: 'm1', pathB: async () => ({}) }), /requires an injected pathA/);
    await assert.rejects(() => recoverDoltConflict({ member: 'm1', pathA: async () => ({}) }), /requires an injected pathB/);
});
