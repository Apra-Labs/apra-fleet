import { test, describe } from 'node:test';
import assert from 'node:assert';

import { createMemberSessionGuard } from '../auto-sprint/runner.js';

// apra-fleet-eft.75.1: unit coverage for the pre-resume session guard.
//
// Root incident: the engine's resume of a presumed-dead/timed-out session
// re-dispatched to the same member WITHOUT first confirming the prior
// attempt's process had actually exited -- both stayed alive concurrently.
// The fix is `createMemberSessionGuard().killIfAlive(member)`, called and
// AWAITED at every resume call site (planner, plan-reviewer, doer's
// max-turns resume ladder, deployer, integ-test-runner, reviewer, harvester)
// immediately before the resume re-dispatch is fired. `killIfAlive` calls
// the fleet's own `stop_prompt` tool, which reuses the shared pid-liveness
// helpers to kill whatever process is still on record for that member.
//
// This file unit-tests `createMemberSessionGuard` in isolation (per its doc
// comment, it is injectable via `callTool` and requires no live fleet
// connection), and separately proves the call-site contract -- kill-before-
// dispatch ordering -- via a fake resume flow shaped like the doer's
// max-turns resume ladder in runner.js (~line 5649).

describe('createMemberSessionGuard (apra-fleet-eft.75.1)', () => {
    test('killIfAlive calls stop_prompt with the given member_name', async () => {
        const calls = [];
        const guard = createMemberSessionGuard({
            callTool: async (name, args) => { calls.push({ name, args }); return '[OK] no live session for member "alice"'; },
        });
        await guard.killIfAlive('alice');
        assert.deepEqual(calls, [
            { name: 'stop_prompt', args: { member_name: 'alice' } },
        ]);
    });

    test('logs the stop_prompt result text (plain string result)', async () => {
        const logs = [];
        const guard = createMemberSessionGuard({
            callTool: async () => '[OK] killed stale process for member "alice"',
            log: (msg) => logs.push(msg),
        });
        await guard.killIfAlive('alice');
        assert.equal(logs.length, 1);
        assert.match(logs[0], /pre-resume stop_prompt for 'alice'/);
        assert.match(logs[0], /killed stale process/);
    });

    test('logs the stop_prompt result text (MCP content-array result shape)', async () => {
        const logs = [];
        const guard = createMemberSessionGuard({
            callTool: async () => ({ content: [{ type: 'text', text: '[OK] no live session for member "alice"' }] }),
            log: (msg) => logs.push(msg),
        });
        await guard.killIfAlive('alice');
        assert.equal(logs.length, 1);
        assert.match(logs[0], /pre-resume stop_prompt for 'alice'/);
        assert.match(logs[0], /no live session for member "alice"/);
    });

    test('best-effort: a rejected stop_prompt call is logged and swallowed, never thrown (resume still proceeds)', async () => {
        const logs = [];
        const guard = createMemberSessionGuard({
            callTool: async () => { throw new Error('transport down'); },
            log: (msg) => logs.push(msg),
        });
        await assert.doesNotReject(() => guard.killIfAlive('alice'));
        assert.equal(logs.length, 1);
        assert.match(logs[0], /pre-resume stop_prompt for 'alice' failed \(non-fatal; resume proceeds\)/);
        assert.match(logs[0], /transport down/);
    });

    test('is a no-op (never calls callTool, never throws) when callTool is not injected -- the direct runSprintCycle()/main() unit-test path', async () => {
        const guard = createMemberSessionGuard({});
        await assert.doesNotReject(() => guard.killIfAlive('alice'));
    });

    test('is a no-op (never calls callTool) when member is falsy', async () => {
        const calls = [];
        const guard = createMemberSessionGuard({
            callTool: async (name, args) => { calls.push({ name, args }); return '[OK]'; },
        });
        await guard.killIfAlive(undefined);
        await guard.killIfAlive('');
        assert.equal(calls.length, 0);
    });

    test('no behavior change when the prior process is genuinely gone: stop_prompt reporting nothing-to-kill still resolves cleanly and does not block the caller', async () => {
        const calls = [];
        const guard = createMemberSessionGuard({
            callTool: async (name, args) => { calls.push(args.member_name); return '[OK] no live session for member "alice"'; },
        });
        await guard.killIfAlive('alice');
        assert.deepEqual(calls, ['alice']);
    });
});

describe('resume ladder ordering (apra-fleet-eft.75.1 acceptance: kills-or-refuses BEFORE spawning the second session)', () => {
    // Shapes the doer max-turns resume ladder in runner.js (~line 5649):
    //   await memberSessionGuard.killIfAlive(doerMember);
    //   report = await dispatchDoerResume(currentMaxTurns);
    // i.e. the guard call is awaited to completion before the resume
    // dispatch is fired, so a still-alive prior process is killed (or the
    // kill attempt has at least been made) before the second session spawns.

    test('killIfAlive completes (including a slow stop_prompt) before the resume dispatch fires', async () => {
        const order = [];
        const guard = createMemberSessionGuard({
            callTool: async () => {
                order.push('stop_prompt-start');
                await new Promise((resolve) => setTimeout(resolve, 10));
                order.push('stop_prompt-end');
                return '[OK] killed stale process';
            },
        });

        async function fakeResumeCallSite(member) {
            await guard.killIfAlive(member);
            order.push('resume-dispatch');
        }

        await fakeResumeCallSite('doer-1');
        assert.deepEqual(order, ['stop_prompt-start', 'stop_prompt-end', 'resume-dispatch']);
    });

    test('a still-alive prior process reported by stop_prompt does not prevent the resume from proceeding (best-effort kill, not a hard gate)', async () => {
        const order = [];
        const guard = createMemberSessionGuard({
            callTool: async () => {
                order.push('stop_prompt: killed still-alive process');
                return '[OK] killed still-alive process for member "doer-1"';
            },
        });

        async function fakeResumeCallSite(member) {
            await guard.killIfAlive(member);
            order.push('resume-dispatch');
            return 'resume-report';
        }

        const report = await fakeResumeCallSite('doer-1');
        assert.equal(report, 'resume-report');
        assert.deepEqual(order, ['stop_prompt: killed still-alive process', 'resume-dispatch']);
    });

    test('a genuinely-gone prior process is a no-behavior-change no-op: resume still proceeds normally', async () => {
        const order = [];
        const guard = createMemberSessionGuard({
            callTool: async () => {
                order.push('stop_prompt: nothing to kill');
                return '[OK] no live session for member "doer-1"';
            },
        });

        async function fakeResumeCallSite(member) {
            await guard.killIfAlive(member);
            order.push('resume-dispatch');
            return 'resume-report';
        }

        const report = await fakeResumeCallSite('doer-1');
        assert.equal(report, 'resume-report');
        assert.deepEqual(order, ['stop_prompt: nothing to kill', 'resume-dispatch']);
    });
});
