import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
    TOKEN_MEMORY_RE,
    RETIRED_MEMORY_KEYS,
    SAFE_MEMORY_KEY_RE,
    BEADS_HYGIENE_WARNING_PREFIX,
    classifyMemory,
    sweepTokenMemories,
} from '../fleet-sprint/beads-memory-hygiene.mjs';

const TOKEN_POSITIVES = [
    'i9ag.14-final-review opus tokens: input=118000 output=8000',
    'apra-fleet-i9ag.19.45 doer sonnet tokens: input=95000 output=13000',
    'x standard tokens: input=~40000 output=6,500',
    'label model TOKENS: Input=1 Output=2',
    '  plan-round-2 planner opus tokens:input=12,000 output=~900  ',
];

const TOKEN_NEGATIVES = [
    '<label> [role] <model> tokens: input=<N> output=<N>',
    'Never store per-dispatch usage as a memory, e.g. "x opus tokens: input=<N> output=<N>".',
    'The doer used many tokens: input=95000 output=13000 during the long streak, which is expected.',
    'Scoping backlog work by assignee alone drops real work; see the groomer notes.',
    'opus tokens: input=100 output=200 extra',
    'tokens: input=100 output=200',
    'a b c d tokens: input=1 output=2',
];

test('TOKEN_MEMORY_RE matches whole token-usage records', () => {
    for (const v of TOKEN_POSITIVES) assert.ok(TOKEN_MEMORY_RE.test(v), `expected a match: ${v}`);
});

test('TOKEN_MEMORY_RE rejects rule text, placeholders, prose and unrelated values', () => {
    for (const v of TOKEN_NEGATIVES) assert.ok(!TOKEN_MEMORY_RE.test(v), `expected no match: ${v}`);
});

test('SAFE_MEMORY_KEY_RE accepts slug keys and rejects shell-unsafe ones', () => {
    for (const k of ['a', 'i9ag.14-final-review', 'Key_1.x-y', 'x'.repeat(200)]) assert.ok(SAFE_MEMORY_KEY_RE.test(k), k);
    for (const k of ['', '-lead', '.lead', 'a b', 'a;rm', 'a$b', 'a"b', 'x'.repeat(201)]) assert.ok(!SAFE_MEMORY_KEY_RE.test(k), k);
});

test('classifyMemory: token, retired, near-miss, keep', () => {
    assert.equal(classifyMemory('k1', TOKEN_POSITIVES[0]), 'token');
    assert.deepEqual(RETIRED_MEMORY_KEYS, ['token-estimates-json']);
    assert.equal(classifyMemory('token-estimates-json', '{"a":1}'), 'retired');
    assert.equal(classifyMemory('token-estimates-json', 42), 'retired');
    assert.equal(classifyMemory('k2', TOKEN_NEGATIVES[0]), 'near-miss');
    assert.equal(classifyMemory('k3', TOKEN_NEGATIVES[2]), 'near-miss');
    assert.equal(classifyMemory('k4', TOKEN_NEGATIVES[3]), 'keep');
    assert.equal(classifyMemory('schema_version', 1), 'keep');
});

function makeCommand(memories, { listFail = null, listThrow = false, forgetFail = new Set(), raw = null } = {}) {
    const calls = [];
    const command = async (cmd, opts) => {
        calls.push({ cmd, opts });
        if (cmd === 'bd memories --json') {
            if (listThrow) throw new Error('transport down');
            if (listFail) return { ok: false, output: '', error: listFail };
            return { ok: true, output: raw ?? JSON.stringify(memories) };
        }
        const m = /^bd forget (\S+)$/.exec(cmd);
        if (m) {
            if (forgetFail.has(m[1])) return { ok: false, output: '', error: 'forget failed' };
            return { ok: true, output: '' };
        }
        throw new Error(`unexpected command: ${cmd}`);
    };
    return { command, calls };
}

test('sweep with no hits: one command, no push, no WARNING', async () => {
    const { command, calls } = makeCommand({ a: 'keep me', schema_version: 1 });
    const logs = [];
    let pushes = 0;
    const r = await sweepTokenMemories({ command, log: (l) => logs.push(l), member: 'orch', pushBeads: async () => { pushes++; } });
    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0].opts, { member_name: 'orch', silent: true, failSoft: true, label: 'beads-hygiene' });
    assert.equal(pushes, 0);
    assert.equal(r.pushed, false);
    assert.ok(!logs.some((l) => l.startsWith(BEADS_HYGIENE_WARNING_PREFIX)), JSON.stringify(logs));
    assert.ok(logs.length <= 1);
});

test('sweep with hits: one forget per key, one push, one WARNING naming them; legit and near-miss untouched', async () => {
    const memories = {
        't1': TOKEN_POSITIVES[0],
        't2': TOKEN_POSITIVES[1],
        'token-estimates-json': '{"x":1}',
        'legit': 'A real operational rule.',
        'near': TOKEN_NEGATIVES[0],
    };
    const { command, calls } = makeCommand(memories);
    const logs = [];
    let pushes = 0;
    const r = await sweepTokenMemories({ command, log: (l) => logs.push(l), member: 'orch', pushBeads: async () => { pushes++; } });
    const forgets = calls.filter((c) => c.cmd.startsWith('bd forget ')).map((c) => c.cmd);
    assert.deepEqual(forgets, ['bd forget t1', 'bd forget t2', 'bd forget token-estimates-json']);
    for (const c of calls) assert.equal(c.opts.member_name, 'orch');
    assert.equal(pushes, 1);
    assert.equal(r.pushed, true);
    assert.deepEqual(r.removed, ['t1', 't2', 'token-estimates-json']);
    assert.deepEqual(r.nearMisses, ['near']);
    const warns = logs.filter((l) => l.startsWith(BEADS_HYGIENE_WARNING_PREFIX));
    assert.equal(warns.length, 1, JSON.stringify(logs));
    assert.match(warns[0], /removed 3 token-usage memories from the beads DB: t1, t2, token-estimates-json/);
    assert.match(warns[0], /not deleted.*: near/);
    assert.match(warns[0], /stale role prompts/);
    assert.ok(!warns[0].includes('legit'));
});

test('sweep caps the listed keys at 20 with a "+N more" tail', async () => {
    const memories = {};
    for (let i = 0; i < 25; i++) memories[`k${i}`] = `lbl${i} opus tokens: input=1 output=2`;
    const { command } = makeCommand(memories);
    const logs = [];
    const r = await sweepTokenMemories({ command, log: (l) => logs.push(l), member: 'orch', pushBeads: async () => {} });
    assert.equal(r.removed.length, 25);
    assert.match(logs.find((l) => l.startsWith(BEADS_HYGIENE_WARNING_PREFIX)), /removed 25 .*k19 \(\+5 more\)/);
});

test('sweep skips and warns about an unsafe key; it is never interpolated', async () => {
    const { command, calls } = makeCommand({ 'bad key;x': TOKEN_POSITIVES[0], ok1: TOKEN_POSITIVES[2] });
    const logs = [];
    let pushes = 0;
    const r = await sweepTokenMemories({ command, log: (l) => logs.push(l), member: 'orch', pushBeads: async () => { pushes++; } });
    assert.deepEqual(calls.filter((c) => c.cmd.startsWith('bd forget')).map((c) => c.cmd), ['bd forget ok1']);
    assert.deepEqual(r.skipped, ['bad key;x']);
    assert.equal(pushes, 1);
    const warn = logs.find((l) => l.startsWith(BEADS_HYGIENE_WARNING_PREFIX));
    assert.match(warn, /skipped 1 matching memory with an unsafe key/);
});

test('list failure, list throw and unparseable output -> one warning, no throw, no forget, no push', async () => {
    for (const opts of [{ listFail: 'bd: not found' }, { listThrow: true }, { raw: 'not json' }, { raw: '[1,2]' }]) {
        const { command, calls } = makeCommand({}, opts);
        const logs = [];
        let pushes = 0;
        const r = await sweepTokenMemories({ command, log: (l) => logs.push(l), member: 'orch', pushBeads: async () => { pushes++; } });
        assert.equal(calls.length, 1);
        assert.equal(pushes, 0);
        assert.equal(r.warnings.length, 1, JSON.stringify(opts));
        assert.match(logs[0], /^\[beads-hygiene\] WARNING: could not (list|parse)/);
    }
});

test('forget failure and push failure -> warnings, no throw', async () => {
    const { command } = makeCommand({ t1: TOKEN_POSITIVES[0], t2: TOKEN_POSITIVES[1] }, { forgetFail: new Set(['t2']) });
    const logs = [];
    const r = await sweepTokenMemories({ command, log: (l) => logs.push(l), member: 'orch', pushBeads: async () => { throw new Error('push rejected'); } });
    assert.deepEqual(r.removed, ['t1']);
    assert.deepEqual(r.failed, ['t2']);
    assert.equal(r.pushed, false);
    const warns = logs.filter((l) => l.startsWith(BEADS_HYGIENE_WARNING_PREFIX));
    assert.equal(warns.length, 1);
    assert.match(warns[0], /could not forget 1: t2/);
    assert.match(warns[0], /push after the sweep failed \(push rejected\)/);
});

test('all forgets failing -> no push', async () => {
    const { command } = makeCommand({ t1: TOKEN_POSITIVES[0] }, { forgetFail: new Set(['t1']) });
    let pushes = 0;
    const r = await sweepTokenMemories({ command, member: 'orch', pushBeads: async () => { pushes++; } });
    assert.equal(pushes, 0);
    assert.deepEqual(r.failed, ['t1']);
});
