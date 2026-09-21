import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { verifyBeadsIdentity, createBeadsIdentityProber, BEADS_IDENTITY_PROBE_TIMEOUT_S } from '../fleet-sprint/beads-identity-check.mjs';
import { BEADS_IDENTITY_PROBES } from '../fleet-sprint/beads-identity.mjs';
import { BeadsIdentityError, BEADS_IDENTITY_FAILURE_REASONS } from '../fleet-sprint/errors.mjs';

// Unit tests for the beads identity precondition, driven with an injected
// fake command() so no bd/git runs: every member answers the three probes
// from a scripted per-member table.

const REMOTE = 'https://example.com/org/repo.git';

function whereJson(dir, prefix = 'proj') {
    return JSON.stringify({ database_path: `${dir}/dolt`, path: dir, prefix, schema_version: 1 });
}
function syncJson(value) {
    return JSON.stringify({ key: 'sync.remote', value });
}

function identityAnswers({ dir = '/w/.beads', prefix = 'proj', sync = REMOTE, origin = REMOTE } = {}) {
    return {
        [BEADS_IDENTITY_PROBES.where]: whereJson(dir, prefix),
        [BEADS_IDENTITY_PROBES.syncRemote]: syncJson(sync),
        [BEADS_IDENTITY_PROBES.repoRemote]: `${origin}\n`,
    };
}

/**
 * Builds a fake command(): `table[member][cmd]` is the stdout to answer with,
 * or `{ fail: '<error>' }` for a failSoft failure. Records every call.
 */
function fakeCommand(table) {
    const calls = [];
    const command = async (cmd, opts) => {
        calls.push({ cmd, opts });
        const perMember = table[opts.member_name] || {};
        const answer = perMember[cmd];
        if (answer && typeof answer === 'object' && answer.fail !== undefined) {
            return { ok: false, output: '', error: answer.fail };
        }
        return { ok: true, output: answer === undefined ? '' : answer, error: null };
    };
    return { command, calls };
}

describe('verifyBeadsIdentity', () => {
    test('all members match the supplied expectation: proceeds, logs one "beads ok:" line per member, publishes state', async () => {
        const { command, calls } = fakeCommand({ orch: identityAnswers(), m1: identityAnswers({ dir: '/m1/.beads' }), m2: identityAnswers({ dir: '/m2/.beads', sync: 'git+' + REMOTE }) });
        const logs = [];
        const published = [];
        const res = await verifyBeadsIdentity({
            command,
            log: (l) => logs.push(l),
            publishState: (ns, data) => published.push({ ns, data }),
            orchestratorMember: 'orch',
            members: ['m1', 'm2', 'orch'],
            expected: { prefix: 'proj', syncRemote: REMOTE, repoRemote: REMOTE },
        });
        assert.equal(res.expectedFrom, 'args');
        assert.deepEqual(Object.keys(res.members), ['orch', 'm1', 'm2']);
        assert.equal(res.members.m2.beadsDir, '/m2/.beads');
        const okLines = logs.filter((l) => l.startsWith('beads ok: '));
        assert.equal(okLines.length, 3);
        assert.match(okLines[0], /^beads ok: orch beads: \/w\/\.beads \| prefix=proj \| remote=/);
        assert.ok(!logs.some((l) => l.includes('taking the expectation from the orchestrator')));
        assert.equal(published.length, 1);
        assert.equal(published[0].ns, 'beadsIdentity');
        assert.deepEqual(published[0].data.expected, { prefix: 'proj', syncRemote: REMOTE, repoRemote: REMOTE });
        assert.equal(published[0].data.expectedFrom, 'args');
        assert.deepEqual(Object.keys(published[0].data.members), ['orch', 'm1', 'm2']);
        // Orchestrator probed first; every call names its member and is a silent failSoft read.
        assert.equal(calls[0].opts.member_name, 'orch');
        for (const c of calls) {
            assert.equal(c.opts.silent, true);
            assert.equal(c.opts.failSoft, true);
            assert.equal(c.opts.label, 'beads-identity');
            assert.equal(c.opts.timeout_s, BEADS_IDENTITY_PROBE_TIMEOUT_S);
        }
        // 3 probes x 3 distinct members, the duplicate 'orch' entry probed once.
        assert.equal(calls.length, 9);
    });

    test('no expectation: it is taken from the orchestrator and only the other members are compared', async () => {
        const { command } = fakeCommand({ orch: identityAnswers({ sync: '' }), m1: identityAnswers({ sync: '' }) });
        const logs = [];
        const res = await verifyBeadsIdentity({ command, log: (l) => logs.push(l), orchestratorMember: 'orch', members: ['m1'] });
        assert.equal(res.expectedFrom, 'orchestrator');
        assert.equal(res.expected.beadsDir, '/w/.beads');
        assert.ok(logs.some((l) => l.includes("taking the expectation from the orchestrator member 'orch'")));
        assert.equal(logs.filter((l) => l.startsWith('beads ok: ')).length, 2);
    });

    test('a member with a different repoRemote aborts with a MISMATCH naming member, field, expected and actual', async () => {
        const other = 'https://example.com/org/other.git';
        const { command, calls } = fakeCommand({ orch: identityAnswers(), m1: identityAnswers({ origin: other }) });
        await assert.rejects(
            verifyBeadsIdentity({ command, orchestratorMember: 'orch', members: ['m1'] }),
            (err) => {
                assert.ok(err instanceof BeadsIdentityError);
                assert.equal(err.reason, BEADS_IDENTITY_FAILURE_REASONS.MISMATCH);
                assert.equal(err.member, 'm1');
                assert.deepEqual(err.mismatches, [{ field: 'repoRemote', expected: REMOTE, actual: other }]);
                assert.match(err.message, /member 'm1'/);
                assert.match(err.message, /repoRemote: expected 'https:\/\/example\.com\/org\/repo\.git', actual 'https:\/\/example\.com\/org\/other\.git'/);
                return true;
            }
        );
        assert.equal(calls.length, 6);
    });

    test('the orchestrator itself mismatching the supplied expectation aborts before any other member is probed', async () => {
        const { command, calls } = fakeCommand({ orch: identityAnswers({ prefix: 'other' }), m1: identityAnswers() });
        await assert.rejects(
            verifyBeadsIdentity({ command, orchestratorMember: 'orch', members: ['m1'], expected: { prefix: 'proj', syncRemote: REMOTE, repoRemote: REMOTE } }),
            (err) => err instanceof BeadsIdentityError && err.member === 'orch' && err.mismatches[0].field === 'prefix'
        );
        assert.equal(calls.length, 3);
    });

    test('an empty sync.remote on a member when the expectation has one is a mismatch, not unknown', async () => {
        const { command } = fakeCommand({ orch: identityAnswers(), m1: identityAnswers({ sync: '' }) });
        await assert.rejects(
            verifyBeadsIdentity({ command, orchestratorMember: 'orch', members: ['m1'] }),
            (err) => err instanceof BeadsIdentityError && err.mismatches.length === 1 && err.mismatches[0].field === 'syncRemote' && err.mismatches[0].actual === ''
        );
    });

    test('bd where failing on a member aborts with PROBE_FAILED naming the member and the raw error', async () => {
        const { command } = fakeCommand({
            orch: identityAnswers(),
            m1: { ...identityAnswers(), [BEADS_IDENTITY_PROBES.where]: { fail: 'Error: no beads database found (run bd init)' } },
        });
        await assert.rejects(
            verifyBeadsIdentity({ command, orchestratorMember: 'orch', members: ['m1'] }),
            (err) => {
                assert.ok(err instanceof BeadsIdentityError);
                assert.equal(err.reason, BEADS_IDENTITY_FAILURE_REASONS.PROBE_FAILED);
                assert.equal(err.member, 'm1');
                assert.match(err.message, /no beads database found in the member's workFolder/);
                assert.match(err.message, /run bd init/);
                return true;
            }
        );
    });

    test('bd where succeeding with unparseable output is a PROBE_FAILED too', async () => {
        const { command } = fakeCommand({ orch: { ...identityAnswers(), [BEADS_IDENTITY_PROBES.where]: 'not a beads dir' } });
        await assert.rejects(
            verifyBeadsIdentity({ command, orchestratorMember: 'orch', members: [] }),
            (err) => err instanceof BeadsIdentityError && err.reason === 'PROBE_FAILED' && /not a beads dir/.test(err.message)
        );
    });

    test('a command() that throws is treated as a failed probe, never an unhandled crash', async () => {
        const command = async () => { throw new Error('transport down'); };
        await assert.rejects(
            verifyBeadsIdentity({ command, orchestratorMember: 'orch', members: [] }),
            (err) => err instanceof BeadsIdentityError && /transport down/.test(err.message)
        );
    });

    test('rejects a missing orchestrator member up front', async () => {
        await assert.rejects(verifyBeadsIdentity({ command: async () => ({ ok: true, output: '' }), orchestratorMember: '', members: [] }), TypeError);
    });
});

describe('createBeadsIdentityProber', () => {
    test('probes a member once per run (memoized), even across two verify passes sharing the prober', async () => {
        const { command, calls } = fakeCommand({ orch: identityAnswers(), m1: identityAnswers() });
        const prober = createBeadsIdentityProber({ command });
        await verifyBeadsIdentity({ command, prober, orchestratorMember: 'orch', members: ['m1'] });
        await verifyBeadsIdentity({ command, prober, orchestratorMember: 'orch', members: ['m1', 'orch'] });
        assert.equal(calls.length, 6);
        const again = await prober.probe('m1');
        assert.equal(again.identity.prefix, 'proj');
        assert.equal(calls.length, 6);
    });

    test('accepts a plain-string command() result (non-failSoft shape)', async () => {
        const prober = createBeadsIdentityProber({ command: async (cmd) => identityAnswers()[cmd] });
        const res = await prober.probe('x');
        assert.equal(res.failures.length, 0);
        assert.equal(res.identity.beadsDir, '/w/.beads');
    });

    test('requires a command function', () => {
        assert.throws(() => createBeadsIdentityProber({}), TypeError);
    });
});
