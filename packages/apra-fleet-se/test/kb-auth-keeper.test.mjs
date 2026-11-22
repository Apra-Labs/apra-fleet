import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createKbAuthKeeper, readFleetKbConfig, KB_AUTH_RESUME_NOTE, KB_AUTH_PUSH_RETRY_MS, MAX_TIMER_MS } from '../fleet-sprint/kb-auth-keeper.mjs';

// The KB auth keeper around a dispatch: the pre-dispatch push, the timer push
// while it runs, and the heal plus one resume when the agent's toolErrors show
// E-KB-HTTP-AUTH. The fleet server is a fake callTool; time and timers are
// driven by hand.

const REMOTE = 'https://kb.example.test';
const SECRET = 'kb-token';
const HOUR = 3600_000;
const T0 = Date.parse('2030-01-01T00:00:00Z');

const json = (body) => ({ content: [{ type: 'text', text: JSON.stringify(body) }] });

/**
 * A fake orchestrator. credential stands for its KB config: {kind: 'live' |
 * 'secret', ...} is http with a token_ref (the live/static split is what
 * provision_kb_auth reports as secretKind), 'literal' a literal token, null none.
 */
function fleet({ credential = { kind: 'live', url: REMOTE, secretName: SECRET }, types = {}, provisionAnswers = [], lifetimeMs = HOUR } = {}) {
    const calls = [];
    const clock = { now: T0 };
    let mint = 0;
    let lastExp = null;
    const callTool = async (name, args) => {
        calls.push({ name, args });
        if (name === 'member_detail') return json({ type: types[args.member_name] ?? 'remote' });
        if (name === 'provision_kb_auth') {
            const answer = provisionAnswers.length ? provisionAnswers.shift() : 'ok';
            // 'fail', or a refusal reason such as 'member-kb-other-remote'.
            if (answer !== 'ok' && answer !== 'same') {
                const reason = answer === 'fail' ? 'mint-failed' : answer;
                return { isError: true, content: [{ type: 'text', text: `E-PROVISION-AUTH: ${reason}` }], structuredContent: { ok: false, code: 'E-PROVISION-AUTH', reason } };
            }
            // 'same': the previous token again (a refresh that failed, or a static secret).
            if (answer !== 'same') { mint += 1; lastExp = clock.now + lifetimeMs; }
            // Refresh due 6 minutes before the token expires.
            const exp = lastExp;
            return {
                content: [{ type: 'text', text: '[OK]' }],
                structuredContent: {
                    ok: true, expiresAt: new Date(exp).toISOString(), refreshAt: new Date(exp - 360_000).toISOString(), mint,
                    secretKind: credential && credential.kind === 'secret' ? 'static' : 'live',
                },
            };
        }
        throw new Error(`unexpected tool ${name}`);
    };
    const provisions = () => calls.filter((c) => c.name === 'provision_kb_auth');
    const readKbConfig = () => {
        if (!credential) return null;
        if (credential.kind === 'literal') return { provider: 'http', url: credential.url, token_encrypted: 'x' };
        return { provider: 'http', url: credential.url, token_ref: `{{secret.${credential.secretName}}}` };
    };
    return { calls, callTool, clock, provisions, readKbConfig };
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
        callTool: (n, a) => f.callTool(n, a), log: (l) => lines.push(l), now: () => f.clock.now, setTimer: tm.setTimer, clearTimer: tm.clearTimer,
        readKbConfig: () => f.readKbConfig(),
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
        // keep_member_kb: a remote member's own KB set-up is never rewired.
        assert.deepEqual(f.provisions()[0].args, { member_name: 'm1', secret: SECRET, remote: REMOTE, keep_member_kb: true });
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

    test('the heal and the resume renew the dispatch watchdog once; a dispatch with no KB auth error does not', async () => {
        const f = fleet();
        const { keeper } = keeperFor(f);
        let renews = 0;
        const lease = { renew: () => { renews += 1; return true; } };
        const plain = agent([{ value: 'fine' }]);
        await keeper.dispatch({ member: 'm1', prompt: 'p', opts: { member_name: 'm1', watchdogLease: lease }, run: plain.run });
        assert.equal(renews, 0);
        assert.equal(plain.runs[0].opts.watchdogLease, undefined, 'the lease is not a dispatch option');
        const a = agent([{ toolErrors: authReport('expired'), sessionId: 's1' }, { value: 'resumed' }]);
        await keeper.dispatch({ member: 'm1', prompt: 'p', opts: { member_name: 'm1', watchdogLease: lease }, run: a.run });
        assert.equal(renews, 1);
    });
});

describe('KB auth keeper: a member whose KB is set up for something else', () => {
    for (const [reason, why] of [['member-kb-other-remote', 'names another remote'], ['member-kb-local-store', 'uses its local store'], ['member-kb-other-token', 'names this remote with its own token source'], ['install-too-old', 'missing or too old'], ['not-member-install', 'full fleet install']]) {
        test(`${reason}: skipped for the run, with one log line naming why; no timer, no heal`, async () => {
            const f = fleet({ provisionAnswers: [reason] });
            const tm = timers();
            const { keeper, lines } = keeperFor(f, tm);
            const a1 = agent([{ toolErrors: authReport('rejected'), sessionId: 's1', during: async () => assert.equal(tm.pending.size, 0) }]);
            assert.equal(await dispatchOn(keeper, 'm1', a1), 'value-1');
            f.clock.now += 2 * HOUR;
            const a2 = agent([{ toolErrors: authReport('rejected'), sessionId: 's2' }]);
            await dispatchOn(keeper, 'm1', a2);
            assert.equal(f.provisions().length, 1, 'only the one refused push');
            assert.equal(f.provisions()[0].args.keep_member_kb, true);
            assert.equal(a1.runs.length + a2.runs.length, 2, 'never resumed');
            const skipLines = lines.filter((l) => l.includes("member 'm1' is not kept"));
            assert.equal(skipLines.length, 1);
            assert.ok(skipLines[0].includes(why), skipLines[0]);
        });
    }

    test('another member is still provisioned', async () => {
        const f = fleet({ provisionAnswers: ['member-kb-other-remote', 'ok'] });
        const { keeper } = keeperFor(f);
        await dispatchOn(keeper, 'm1', agent());
        await dispatchOn(keeper, 'm2', agent());
        assert.deepEqual(f.provisions().map((c) => c.args.member_name), ['m1', 'm2']);
    });
});

describe('KB auth keeper: a static secret with the same expiry', () => {
    test('stops pushing for the rest of the run, with one log line; no timer', async () => {
        const f = fleet({ credential: { kind: 'secret', url: REMOTE, secretName: SECRET }, provisionAnswers: ['ok', 'same'] });
        const tm = timers();
        const { keeper, lines } = keeperFor(f, tm);
        const a = agent([{
            during: async () => {
                f.clock.now += [...tm.pending.values()][0].ms;
                await tm.fireOnly();
                assert.equal(tm.pending.size, 0, 'not re-armed');
            },
        }]);
        await dispatchOn(keeper, 'm1', a);
        f.clock.now += 10 * 60_000;
        await dispatchOn(keeper, 'm1', agent());
        assert.equal(f.provisions().length, 2, 'no push at the next dispatch start');
        assert.equal(lines.filter((l) => l.includes("static secret 'kb-token'")).length, 1);
    });
});

describe('KB auth keeper: the KB config is read directly, once per run', () => {
    test('no fleet_status call, and one read for the whole run', async () => {
        const f = fleet();
        let reads = 0;
        const keeper = createKbAuthKeeper({ callTool: (n, a) => f.callTool(n, a), readKbConfig: () => { reads += 1; return f.readKbConfig(); } });
        await dispatchOn(keeper, 'm1', agent());
        await dispatchOn(keeper, 'm2', agent());
        assert.equal(reads, 1);
        assert.deepEqual([...new Set(f.calls.map((c) => c.name))].sort(), ['member_detail', 'provision_kb_auth']);
    });

    test('a config that cannot be read is logged once and not read again; nothing is called', async () => {
        const f = fleet();
        const lines = [];
        let reads = 0;
        const keeper = createKbAuthKeeper({ callTool: (n, a) => f.callTool(n, a), log: (l) => lines.push(l), readKbConfig: () => { reads += 1; throw new Error('EACCES'); } });
        for (let i = 0; i < 3; i += 1) await dispatchOn(keeper, 'm1', agent());
        assert.equal(reads, 1);
        assert.equal(f.calls.length, 0);
        assert.equal(lines.filter((l) => l.includes("could not read the orchestrator's KB config")).length, 1);
    });

    test('readFleetKbConfig reads <data dir>/knowledge/config.json, and null when there is none', () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kb-keeper-cfg-'));
        try {
            const env = { APRA_FLEET_DATA_DIR: dir };
            assert.equal(readFleetKbConfig(env), null);
            fs.mkdirSync(path.join(dir, 'knowledge'));
            fs.writeFileSync(path.join(dir, 'knowledge', 'config.json'), JSON.stringify({ provider: 'http', url: REMOTE, token_ref: '{{secret.x}}' }));
            assert.deepEqual(readFleetKbConfig(env), { provider: 'http', url: REMOTE, token_ref: '{{secret.x}}' });
        } finally {
            fs.rmSync(dir, { recursive: true, force: true });
        }
    });
});

describe('KB auth keeper: watchdog, resume failure, heal timer', () => {
    test('a dispatch the watchdog already abandoned is neither healed nor resumed when it settles', async () => {
        const f = fleet();
        const { keeper, lines } = keeperFor(f);
        const lease = { renew: () => false };
        const a = agent([{ toolErrors: authReport('rejected'), sessionId: 's1', value: 'late' }]);
        assert.equal(await keeper.dispatch({ member: 'm1', prompt: 'p', opts: { member_name: 'm1', watchdogLease: lease }, run: a.run }), 'late');
        assert.equal(a.runs.length, 1, 'no resume');
        assert.equal(f.provisions().filter((c) => c.args.reason === 'rejected').length, 0, 'no heal');
        assert.equal(lines.filter((l) => l.includes('already abandoned by the watchdog')).length, 1);
    });

    test('prepare() does the dispatch-start push before the race; dispatch() does not push again', async () => {
        const f = fleet({ provisionAnswers: ['fail'] });
        const { keeper } = keeperFor(f);
        const lease = {};
        await keeper.prepare({ member: 'm1', lease });
        assert.equal(f.provisions().length, 1);
        await keeper.dispatch({ member: 'm1', prompt: 'p', opts: { member_name: 'm1', watchdogLease: lease }, run: agent().run });
        assert.equal(f.provisions().length, 1, 'the failed push is not retried inside the race');
    });

    test('a resume that fails keeps the first answer, with one log line', async () => {
        const f = fleet();
        const { keeper, lines } = keeperFor(f);
        const gone = new Error('session_not_found');
        const a = agent([{ toolErrors: authReport('expired'), sessionId: 's1', value: 'usable' }, { throws: gone }]);
        assert.equal(await dispatchOn(keeper, 'm1', a), 'usable');
        assert.equal(a.runs.length, 2);
        assert.equal(lines.filter((l) => l.includes('keeping the dispatch\'s first answer')).length, 1);
    });

    test('a heal moves the running timer to the new token\'s refresh time', async () => {
        const f = fleet();
        const tm = timers();
        // Record when each timer was set, so its due time (set at + delay) is known.
        const set = tm.setTimer;
        tm.setTimer = (fn, ms) => { const h = set(fn, ms); tm.pending.get(h).at = f.clock.now; return h; };
        const { keeper, lines } = keeperFor(f, tm);
        let dueAfterHeal;
        const a = agent([
            { toolErrors: authReport('rejected'), sessionId: 's1', during: async () => { f.clock.now = T0 + 20 * 60_000; } },
            { during: async () => { dueAfterHeal = [...tm.pending.values()].map((t) => t.at + t.ms); } },
        ]);
        await dispatchOn(keeper, 'm1', a);
        // First token: refresh due at t=54 min. The heal at t=20 min brings one
        // expiring at t=80, refresh due at t=74: the timer follows it.
        assert.deepEqual(dueAfterHeal, [T0 + 74 * 60_000]);
        assert.equal(lines.filter((l) => l.includes('brought no new token')).length, 0);
    });

    test('a far expiry caps the timer delay, and an early wake-up only re-arms', async () => {
        const f = fleet({ lifetimeMs: 90 * 24 * HOUR });
        const tm = timers();
        const { keeper } = keeperFor(f, tm);
        const delays = [];
        const a = agent([{
            during: async () => {
                delays.push([...tm.pending.values()][0].ms);
                f.clock.now += MAX_TIMER_MS;
                await tm.fireOnly();
                delays.push([...tm.pending.values()][0].ms);
            },
        }]);
        await dispatchOn(keeper, 'm1', a);
        assert.equal(delays[0], MAX_TIMER_MS);
        assert.equal(f.provisions().length, 1, 'the early wake-up pushed nothing');
        assert.ok(delays[1] <= MAX_TIMER_MS && delays[1] > 0);
    });

    test('heals on one member are single-flight', async () => {
        const f = fleet();
        let release;
        const gate = new Promise((r) => { release = r; });
        const base = f.callTool;
        f.callTool = async (n, a) => { if (n === 'provision_kb_auth' && a.reason === 'rejected') await gate; return base(n, a); };
        const { keeper } = keeperFor(f);
        await dispatchOn(keeper, 'm1', agent());
        const one = dispatchOn(keeper, 'm1', agent([{ toolErrors: authReport('rejected'), sessionId: 's1' }]));
        const two = dispatchOn(keeper, 'm1', agent([{ toolErrors: authReport('rejected'), sessionId: 's2' }]));
        await new Promise((r) => setImmediate(r));
        release();
        await Promise.all([one, two]);
        assert.equal(f.provisions().filter((c) => c.args.reason === 'rejected').length, 1);
    });
});
