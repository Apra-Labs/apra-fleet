import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createKbAuthKeeper, KB_AUTH_RESUME_NOTE, KB_AUTH_PUSH_RETRY_MS } from '../fleet-sprint/kb-auth-keeper.mjs';

// The KB auth keeper around a dispatch: the pre-dispatch push, the timer push
// while it runs, and the heal plus one resume when the agent's toolErrors show
// E-KB-HTTP-AUTH. The fleet server is a fake callTool; time and timers are
// driven by hand.

const REMOTE = 'https://kb.example.test';
const SECRET = 'kb-token';
const HOUR = 3600_000;
const T0 = Date.parse('2030-01-01T00:00:00Z');

const json = (body) => ({ content: [{ type: 'text', text: JSON.stringify(body) }] });

function fleet({ credential = { kind: 'live', url: REMOTE, secretName: SECRET }, types = {}, provisionAnswers = [] } = {}) {
    const calls = [];
    const clock = { now: T0 };
    let mint = 0;
    let lastExp = null;
    const callTool = async (name, args) => {
        calls.push({ name, args });
        if (name === 'fleet_status') return json({ members: [], ...(credential ? { kbHealth: { credential } } : { kbHealth: {} }) });
        if (name === 'member_detail') return json({ type: types[args.member_name] ?? 'remote' });
        if (name === 'provision_kb_auth') {
            const answer = provisionAnswers.length ? provisionAnswers.shift() : 'ok';
            if (answer === 'fail') {
                return { isError: true, content: [{ type: 'text', text: 'E-PROVISION-AUTH: mint-failed' }], structuredContent: { ok: false, code: 'E-PROVISION-AUTH', reason: 'mint-failed' } };
            }
            // 'same': the previous token again (a refresh that failed, or a static secret).
            if (answer !== 'same') { mint += 1; lastExp = clock.now + HOUR; }
            // A token living one hour, refresh due 6 minutes before it expires.
            const exp = lastExp;
            return {
                content: [{ type: 'text', text: '[OK]' }],
                structuredContent: { ok: true, expiresAt: new Date(exp).toISOString(), refreshAt: new Date(exp - 360_000).toISOString(), mint },
            };
        }
        throw new Error(`unexpected tool ${name}`);
    };
    const provisions = () => calls.filter((c) => c.name === 'provision_kb_auth');
    return { calls, callTool, clock, provisions };
}

function timers() {
    const pending = new Map();
    let next = 1;
    return {
        pending,
        setTimer: (fn, ms) => { const h = next++; pending.set(h, { fn, ms }); return h; },
        clearTimer: (h) => { pending.delete(h); },
        /** Fire the one pending timer, returning its delay. */
        async fireOnly() {
            assert.equal(pending.size, 1, `expected one pending timer, found ${pending.size}`);
            const [[h, t]] = [...pending];
            pending.delete(h);
            await t.fn();
            await new Promise((r) => setImmediate(r));
            return t.ms;
        },
    };
}

function keeperFor(f, tm = timers(), lines = []) {
    const keeper = createKbAuthKeeper({
        callTool: f.callTool, log: (l) => lines.push(l), now: () => f.clock.now, setTimer: tm.setTimer, clearTimer: tm.clearTimer,
    });
    return { keeper, tm, lines };
}

const authReport = (reason) => ({ available: true, sinceSeconds: 9, total: 1, entries: [{ tool: 'kb_query', code: 'E-KB-HTTP-AUTH', reason, origin: 'session' }] });

/** A fake agent(): records each call; `script[i]` decides what call i reports and returns. */
function agent(script = []) {
    const runs = [];
    const run = async (prompt, opts) => {
        const step = script[runs.length] ?? {};
        runs.push({ prompt, opts });
        if (step.toolErrors) opts.onToolErrors?.(step.toolErrors, { member: opts.member_name });
        if (step.sessionId) opts.onSessionId?.(step.sessionId, { member: opts.member_name });
        if (step.during) await step.during();
        if (step.throws) throw step.throws;
        return step.value ?? `value-${runs.length}`;
    };
    return { run, runs };
}

const dispatchOn = (keeper, member, a, prompt = 'do the task') => keeper.dispatch({ member, prompt, opts: { member_name: member, label: 'doer' }, run: a.run });

describe('KB auth keeper: dispatch start', () => {
    test('pushes when nothing is recorded, skips while the token is fresh, pushes again once the refresh time passed', async () => {
        const f = fleet();
        const { keeper } = keeperFor(f);
        await dispatchOn(keeper, 'm1', agent());
        assert.equal(f.provisions().length, 1);
        assert.deepEqual(f.provisions()[0].args, { member_name: 'm1', secret: SECRET, remote: REMOTE });
        f.clock.now += 30 * 60_000;
        await dispatchOn(keeper, 'm1', agent());
        assert.equal(f.provisions().length, 1, 'fresh token: no push');
        f.clock.now += 25 * 60_000; // 55 min after the push: past refreshAt (54 min)
        await dispatchOn(keeper, 'm1', agent());
        assert.equal(f.provisions().length, 2);
    });

    test('a KB that needs no keeping (literal token, sqlite) makes no provision call', async () => {
        for (const credential of [{ kind: 'literal', url: REMOTE }, null]) {
            const f = fleet({ credential });
            const { keeper, tm } = keeperFor(f);
            const a = agent([{ toolErrors: authReport('expired'), sessionId: 's1' }]);
            assert.equal(await dispatchOn(keeper, 'm1', a), 'value-1');
            assert.equal(f.provisions().length, 0);
            assert.equal(a.runs.length, 1);
            assert.equal(tm.pending.size, 0);
        }
    });

    test('a sprint restart (a new keeper) pushes again on the first dispatch', async () => {
        const f = fleet();
        await dispatchOn(keeperFor(f).keeper, 'm1', agent());
        await dispatchOn(keeperFor(f).keeper, 'm1', agent());
        assert.equal(f.provisions().length, 2);
    });
});

describe('KB auth keeper: timer during a dispatch', () => {
    test('fires at the refresh time, pushes, re-arms, and stops when the dispatch ends', async () => {
        const f = fleet();
        const tm = timers();
        const { keeper } = keeperFor(f, tm);
        let firstDelay;
        let secondDelay;
        const a = agent([{
            during: async () => {
                firstDelay = [...tm.pending.values()][0].ms;
                f.clock.now += firstDelay;
                await tm.fireOnly();
                secondDelay = [...tm.pending.values()][0].ms;
            },
        }]);
        await dispatchOn(keeper, 'm1', a);
        assert.equal(firstDelay, HOUR - 360_000);
        assert.equal(f.provisions().length, 2, 'dispatch start plus one timed push');
        assert.equal(secondDelay, HOUR - 360_000, 're-armed from the new token');
        assert.equal(tm.pending.size, 0, 'timer stopped when the dispatch ended');
    });

    test('a timed push that fails is logged and tried again later', async () => {
        const f = fleet({ provisionAnswers: ['ok', 'fail', 'ok'] });
        const tm = timers();
        const { keeper, lines } = keeperFor(f, tm);
        const delays = [];
        const a = agent([{
            during: async () => {
                f.clock.now += [...tm.pending.values()][0].ms;
                await tm.fireOnly();
                delays.push([...tm.pending.values()][0].ms);
                await tm.fireOnly();
            },
        }]);
        await dispatchOn(keeper, 'm1', a);
        assert.deepEqual(delays, [KB_AUTH_PUSH_RETRY_MS]);
        assert.equal(f.provisions().length, 3);
        assert.equal(lines.filter((l) => /failed: mint-failed/.test(l)).length, 1);
    });

    test('a timed push that brings no new token (same expiry) is logged once and tried again later', async () => {
        const f = fleet({ provisionAnswers: ['ok', 'same', 'same'] });
        const tm = timers();
        const { keeper, lines } = keeperFor(f, tm);
        const delays = [];
        const a = agent([{
            during: async () => {
                f.clock.now += [...tm.pending.values()][0].ms;
                await tm.fireOnly();
                delays.push([...tm.pending.values()][0].ms);
                await tm.fireOnly();
                delays.push([...tm.pending.values()][0].ms);
            },
        }]);
        await dispatchOn(keeper, 'm1', a);
        assert.deepEqual(delays, [KB_AUTH_PUSH_RETRY_MS, KB_AUTH_PUSH_RETRY_MS]);
        assert.equal(lines.filter((l) => /brought no new token/.test(l)).length, 1);
    });

    test('no timer when the dispatch-start push failed: the next dispatch start tries again', async () => {
        const f = fleet({ provisionAnswers: ['fail', 'ok'] });
        const tm = timers();
        const { keeper } = keeperFor(f, tm);
        await dispatchOn(keeper, 'm1', agent([{ during: async () => assert.equal(tm.pending.size, 0) }]));
        await dispatchOn(keeper, 'm1', agent());
        assert.equal(f.provisions().length, 2);
    });

    test('a rewritten member KB config is logged', async () => {
        const f = fleet();
        const base = f.callTool;
        f.callTool = async (name, args) => {
            const r = await base(name, args);
            if (name === 'provision_kb_auth') r.structuredContent.memberChange = { reason: 'kb-config-replaced-sqlite', detail: 'its KB used the local store' };
            return r;
        };
        const { keeper, lines } = keeperFor(f);
        await dispatchOn(keeper, 'm1', agent());
        assert.ok(lines.some((l) => l === "[kb-auth] member 'm1': its KB used the local store"), lines.join('\n'));
    });
});

describe('KB auth keeper: heal after E-KB-HTTP-AUTH', () => {
    test('remote member, rejected: provision with reason rejected, then the same session is resumed once', async () => {
        const f = fleet();
        const { keeper } = keeperFor(f);
        const a = agent([
            { toolErrors: authReport('rejected'), sessionId: 's1', value: 'first' },
            // The resume hits the error again: no second heal, no second resume.
            { toolErrors: authReport('rejected'), sessionId: 's1', value: 'resumed' },
        ]);
        assert.equal(await dispatchOn(keeper, 'm1', a), 'resumed');
        assert.equal(a.runs.length, 2);
        assert.equal(a.runs[1].prompt, KB_AUTH_RESUME_NOTE);
        assert.equal(a.runs[1].opts.resume, 's1');
        const p = f.provisions();
        assert.equal(p.length, 2, 'dispatch-start push and one heal');
        assert.equal(p[1].args.reason, 'rejected');
    });

    test('a provider with no session id gets the prompt again with the note, in a fresh session', async () => {
        const f = fleet();
        const { keeper } = keeperFor(f);
        const a = agent([{ toolErrors: authReport('expired') }, { value: 'again' }]);
        assert.equal(await dispatchOn(keeper, 'm1', a, 'the prompt'), 'again');
        assert.equal(a.runs[1].prompt, `the prompt\n\n${KB_AUTH_RESUME_NOTE}`);
        assert.equal(a.runs[1].opts.resume, false);
        assert.equal(f.provisions()[1].args.reason, undefined, 'expired is not a rejection');
    });

    test('a failed heal: no resume, and one error line per member per run', async () => {
        const f = fleet({ provisionAnswers: ['ok', 'fail', 'fail'] });
        const { keeper, lines } = keeperFor(f);
        f.clock.now = T0;
        const a1 = agent([{ toolErrors: authReport('expired'), sessionId: 's1', value: 'first' }]);
        assert.equal(await dispatchOn(keeper, 'm1', a1), 'first');
        const a2 = agent([{ toolErrors: authReport('expired'), sessionId: 's2', value: 'second' }]);
        assert.equal(await dispatchOn(keeper, 'm1', a2), 'second');
        assert.equal(a1.runs.length + a2.runs.length, 2, 'never resumed');
        assert.equal(lines.filter((l) => /ERROR: member 'm1'/.test(l)).length, 1);
    });

    test('local member: no push and no timer; the heal resolves without reason, then resumes', async () => {
        const f = fleet({ types: { loc: 'local' } });
        const tm = timers();
        const { keeper } = keeperFor(f, tm);
        const a = agent([
            { toolErrors: authReport('rejected'), sessionId: 's9', during: async () => assert.equal(tm.pending.size, 0) },
            { value: 'resumed' },
        ]);
        assert.equal(await dispatchOn(keeper, 'loc', a), 'resumed');
        const p = f.provisions();
        assert.equal(p.length, 1, 'only the heal');
        assert.deepEqual(p[0].args, { member_name: 'loc', secret: SECRET, remote: REMOTE });
        assert.equal(a.runs[1].opts.resume, 's9');
    });

    test('toolErrors unavailable: no heal, no resume', async () => {
        const f = fleet();
        const { keeper } = keeperFor(f);
        const a = agent([{ toolErrors: { available: false, sinceSeconds: 9, detail: 'older install' }, sessionId: 's1' }]);
        assert.equal(await dispatchOn(keeper, 'm1', a), 'value-1');
        assert.equal(a.runs.length, 1);
        assert.equal(f.provisions().length, 1, 'only the dispatch-start push');
    });

    test('a failed dispatch is healed but not resumed, and its error is rethrown', async () => {
        const f = fleet();
        const { keeper } = keeperFor(f);
        const boom = new Error('dispatch failed');
        const a = agent([{ toolErrors: authReport('expired'), throws: boom }]);
        await assert.rejects(() => dispatchOn(keeper, 'm1', a), (e) => e === boom);
        assert.equal(a.runs.length, 1);
        assert.equal(f.provisions().length, 2);
    });
});
