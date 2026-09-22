import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { verifyBeadsIdentity, createBeadsIdentityProber, BEADS_IDENTITY_PROBE_TIMEOUT_S, BEADS_IDENTITY_WARNING_PREFIX } from '../fleet-sprint/beads-identity-check.mjs';
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

    // ---- unresolved probes are WARNINGS, never fatal --------------------
    // Only a field that resolved on BOTH sides and differs aborts. A probe
    // that fails or answers nothing leaves that field out of the comparison,
    // logs `[beads-identity] WARNING: ...` with the fix, and is published
    // (state `warnings` + per-member `unresolved`) for the viewer.

    test('an empty sync.remote on a member is a WARNING naming the member, field, probe and fix -- the sprint proceeds', async () => {
        const { command } = fakeCommand({ orch: identityAnswers(), m1: identityAnswers({ sync: '' }) });
        const logs = [];
        const published = [];
        const res = await verifyBeadsIdentity({ command, log: (l) => logs.push(l), publishState: (ns, d) => published.push(d), orchestratorMember: 'orch', members: ['m1'] });
        const warn = logs.find((l) => l.startsWith(BEADS_IDENTITY_WARNING_PREFIX) && l.includes("member 'm1' could not report syncRemote"));
        assert.ok(warn, `expected a syncRemote warning for m1, got: ${JSON.stringify(logs)}`);
        assert.match(warn, /'bd config get sync\.remote --json' -> sync\.remote is unset/);
        assert.match(warn, /not compared/);
        assert.match(warn, /To fix: set it on that member with 'bd config set sync\.remote <url>' in its workFolder/);
        // Still reported ok (nothing mismatched), with its unresolved field listed.
        assert.ok(logs.some((l) => l.startsWith('beads ok: m1 ')));
        assert.deepEqual(res.members.m1.unresolved, ['syncRemote']);
        assert.deepEqual(res.members.orch.unresolved, []);
        assert.deepEqual(res.warnings, [warn.slice(BEADS_IDENTITY_WARNING_PREFIX.length)]);
        assert.deepEqual(published[0].warnings, res.warnings);
        assert.deepEqual(published[0].members.m1.unresolved, ['syncRemote']);
    });

    test('a missing git origin on a member is a WARNING with the re-register/add-remote fix', async () => {
        const { command } = fakeCommand({
            orch: identityAnswers(),
            m1: { ...identityAnswers(), [BEADS_IDENTITY_PROBES.repoRemote]: { fail: "fatal: No such remote 'origin'" } },
        });
        const logs = [];
        const res = await verifyBeadsIdentity({ command, log: (l) => logs.push(l), orchestratorMember: 'orch', members: ['m1'] });
        const warn = logs.find((l) => l.includes("member 'm1' could not report repoRemote"));
        assert.ok(warn, JSON.stringify(logs));
        assert.match(warn, /'git remote get-url origin' -> fatal: No such remote 'origin'/);
        assert.match(warn, /To fix: the member's workFolder is not a git clone with an 'origin' remote; re-register the member with a real clone or add the remote/);
        assert.deepEqual(res.members.m1.unresolved, ['repoRemote']);
    });

    test('bd where failing on a member is a WARNING naming the member, the raw error and the fix; the member gets no identity entry', async () => {
        const { command } = fakeCommand({
            orch: identityAnswers(),
            m1: { ...identityAnswers(), [BEADS_IDENTITY_PROBES.where]: { fail: 'Error: no beads database found (run bd init)' } },
            m2: identityAnswers({ dir: '/m2/.beads' }),
        });
        const logs = [];
        const res = await verifyBeadsIdentity({ command, log: (l) => logs.push(l), orchestratorMember: 'orch', members: ['m1', 'm2'] });
        const warn = logs.find((l) => l.startsWith(BEADS_IDENTITY_WARNING_PREFIX) && l.includes("member 'm1' reports no beads database in its workFolder"));
        assert.ok(warn, JSON.stringify(logs));
        assert.match(warn, /'bd where --json' -> Error: no beads database found \(run bd init\)/);
        assert.match(warn, /nothing to compare/);
        assert.match(warn, /To fix: run 'bd where' in the member's workFolder; ensure bd is installed there and the folder contains the project's \.beads/);
        assert.ok(!('m1' in res.members), 'a member with no database has no identity entry');
        assert.ok(!logs.some((l) => l.startsWith('beads ok: m1 ')));
        // The other members are still probed and checked.
        assert.equal(res.members.m2.beadsDir, '/m2/.beads');
        assert.ok(logs.some((l) => l.startsWith('beads ok: m2 ')));
        assert.equal(res.warnings.length, 1);
    });

    test('bd where succeeding with unparseable output is the same no-database WARNING', async () => {
        const { command } = fakeCommand({ orch: identityAnswers(), m1: { ...identityAnswers(), [BEADS_IDENTITY_PROBES.where]: 'not a beads dir' } });
        const logs = [];
        await verifyBeadsIdentity({ command, log: (l) => logs.push(l), orchestratorMember: 'orch', members: ['m1'] });
        const warn = logs.find((l) => l.includes("member 'm1' reports no beads database"));
        assert.ok(warn, JSON.stringify(logs));
        assert.match(warn, /unparseable output: not a beads dir/);
    });

    test('a command() that throws is treated as a failed probe (warning), never an unhandled crash', async () => {
        const command = async () => { throw new Error('transport down'); };
        const logs = [];
        const res = await verifyBeadsIdentity({ command, log: (l) => logs.push(l), orchestratorMember: 'orch', members: [] });
        assert.ok(logs.some((l) => l.startsWith(BEADS_IDENTITY_WARNING_PREFIX) && /transport down/.test(l)), JSON.stringify(logs));
        assert.equal(res.expectedFrom, 'none');
    });

    test('no expectation AND the orchestrator resolves nothing: one warning says no cross-member check happens and how to restore it; other members are displayed, not compared', async () => {
        const { command } = fakeCommand({
            orch: { [BEADS_IDENTITY_PROBES.where]: { fail: 'Error: no beads database found' } },
            m1: identityAnswers({ dir: '/m1/.beads' }),
            m2: identityAnswers({ dir: '/m2/.beads', prefix: 'unrelated', origin: 'https://example.com/x/y.git' }),
        });
        const logs = [];
        const published = [];
        const res = await verifyBeadsIdentity({ command, log: (l) => logs.push(l), publishState: (ns, d) => published.push(d), orchestratorMember: 'orch', members: ['m1', 'm2'] });
        assert.equal(res.expectedFrom, 'none');
        assert.equal(res.expected, null);
        const warn = logs.find((l) => l.includes("no expected beads identity was supplied and the orchestrator member 'orch' could not report its beads database"));
        assert.ok(warn, JSON.stringify(logs));
        assert.match(warn, /no cross-member beads identity check will happen this sprint/);
        assert.match(warn, /To restore it: fix the orchestrator member's beads \(run 'bd where' in the member's workFolder; ensure bd is installed there and the folder contains the project's \.beads\), or launch via the supervisor so --expect-beads is supplied/);
        // m2 differs from m1 on prefix and origin, but with no expectation nothing is compared.
        assert.deepEqual(Object.keys(res.members), ['m1', 'm2']);
        assert.equal(res.members.m2.prefix, 'unrelated');
        assert.ok(logs.some((l) => l.startsWith('beads ok: m2 ')));
        assert.equal(published[0].expectedFrom, 'none');
        assert.ok(published[0].warnings.length >= 2, 'the orchestrator no-database warning plus the no-expectation warning');
    });

    test('expectation derived from an orchestrator missing sync.remote: warned once (not per member), that field skipped everywhere, others still compared', async () => {
        const other = 'https://example.com/org/other.git';
        const { command } = fakeCommand({ orch: identityAnswers({ sync: '' }), m1: identityAnswers({ sync: REMOTE }), m2: identityAnswers({ origin: other }) });
        const logs = [];
        await assert.rejects(
            verifyBeadsIdentity({ command, log: (l) => logs.push(l), orchestratorMember: 'orch', members: ['m1', 'm2'] }),
            (err) => err instanceof BeadsIdentityError && err.member === 'm2' && err.mismatches[0].field === 'repoRemote'
        );
        const derived = logs.filter((l) => l.includes("the orchestrator member 'orch' it was derived from could not report syncRemote"));
        assert.equal(derived.length, 1, JSON.stringify(logs));
        assert.match(derived[0], /syncRemote is not compared on any member this sprint/);
        assert.match(derived[0], /To fix: set it on that member with 'bd config set sync\.remote <url>' in its workFolder \(on the orchestrator member\), or launch via the supervisor so --expect-beads is supplied/);
        assert.ok(!logs.some((l) => l.includes("member 'orch' could not report syncRemote")), 'the orchestrator gap is not reported twice');
        // m1 HAS a sync.remote; the expectation lacks one, so it is skipped rather than mismatched.
        assert.ok(logs.some((l) => l.startsWith('beads ok: m1 ')));
    });

    test('a supplied expectation lacking a field: that field is warned about once and skipped; a real mismatch on another field still aborts', async () => {
        const { command } = fakeCommand({ orch: identityAnswers({ prefix: 'other' }) });
        const logs = [];
        await assert.rejects(
            verifyBeadsIdentity({ command, log: (l) => logs.push(l), orchestratorMember: 'orch', members: [], expected: { prefix: 'proj', syncRemote: '', repoRemote: REMOTE } }),
            (err) => err instanceof BeadsIdentityError && err.reason === BEADS_IDENTITY_FAILURE_REASONS.MISMATCH && err.mismatches.length === 1 && err.mismatches[0].field === 'prefix'
        );
        assert.ok(logs.some((l) => l.includes('the supplied expected beads identity carries no syncRemote; syncRemote is not compared on any member this sprint')), JSON.stringify(logs));
    });

    test('BEADS_IDENTITY_FAILURE_REASONS has no probe-failure reason any more: only MISMATCH is fatal', () => {
        assert.deepEqual(Object.keys(BEADS_IDENTITY_FAILURE_REASONS), ['MISMATCH']);
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
