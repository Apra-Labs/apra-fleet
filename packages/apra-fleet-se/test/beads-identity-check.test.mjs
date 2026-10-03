import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { verifyBeadsIdentity, createBeadsIdentityProber, BEADS_IDENTITY_PROBE_TIMEOUT_S, BEADS_IDENTITY_WARNING_PREFIX, BEADS_SETUP_COMMANDS, BEADS_SETUP_TIMEOUT_S, BEADS_READING_ROLES, setupMemberBeads } from '../fleet-sprint/beads-identity-check.mjs';
import { noteMemberCommand } from '../fleet-sprint/dolt-sync.mjs';
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
            backlogMember: 'orch',
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
        const res = await verifyBeadsIdentity({ command, log: (l) => logs.push(l), backlogMember: 'orch', members: ['m1'] });
        assert.equal(res.expectedFrom, 'backlog');
        assert.equal(res.expected.beadsDir, '/w/.beads');
        assert.ok(logs.some((l) => l.includes("taking the expectation from the backlog member 'orch'")));
        assert.equal(logs.filter((l) => l.startsWith('beads ok: ')).length, 2);
    });

    test('a member with a different repoRemote aborts with a MISMATCH naming member, field, expected and actual', async () => {
        const other = 'https://example.com/org/other.git';
        const { command, calls } = fakeCommand({ orch: identityAnswers(), m1: identityAnswers({ origin: other }) });
        await assert.rejects(
            verifyBeadsIdentity({ command, backlogMember: 'orch', members: ['m1'] }),
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
            verifyBeadsIdentity({ command, backlogMember: 'orch', members: ['m1'], expected: { prefix: 'proj', syncRemote: REMOTE, repoRemote: REMOTE } }),
            (err) => err instanceof BeadsIdentityError && err.member === 'orch' && err.mismatches[0].field === 'prefix'
        );
        assert.equal(calls.length, 3);
    });

    // ---- unresolved probes are WARNINGS, never fatal --------------------
    // Only a field that resolved on BOTH sides and differs aborts. A probe
    // that fails or answers nothing leaves that field out of the comparison,
    // logs `[beads-identity] WARNING: ...` with the fix, and is published
    // (state `warnings` + per-member `unresolved`) for the viewer.

    test('an empty sync.remote on a member that is not a beads reader is a WARNING naming the member, field, probe and fix -- the sprint proceeds', async () => {
        const { command } = fakeCommand({ orch: identityAnswers(), m1: identityAnswers({ sync: '' }) });
        const logs = [];
        const published = [];
        // m1 is not a beads-reading member (setupMembers), so it is not set
        // up; its gap stays a warning.
        const res = await verifyBeadsIdentity({ command, log: (l) => logs.push(l), publishState: (ns, d) => published.push(d), backlogMember: 'orch', members: ['m1'], setupMembers: ['orch'] });
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
        const res = await verifyBeadsIdentity({ command, log: (l) => logs.push(l), backlogMember: 'orch', members: ['m1'] });
        const warn = logs.find((l) => l.includes("member 'm1' could not report repoRemote"));
        assert.ok(warn, JSON.stringify(logs));
        assert.match(warn, /'git remote get-url origin' -> fatal: No such remote 'origin'/);
        assert.match(warn, /To fix: the member's workFolder is not a git clone with an 'origin' remote; re-register the member with a real clone or add the remote/);
        assert.deepEqual(res.members.m1.unresolved, ['repoRemote']);
    });

    test('bd where failing on a member that is not a beads reader is a WARNING naming the member, the raw error and the fix; the member gets no identity entry', async () => {
        const { command } = fakeCommand({
            orch: identityAnswers(),
            m1: { ...identityAnswers(), [BEADS_IDENTITY_PROBES.where]: { fail: 'Error: no beads database found (run bd init)' } },
            m2: identityAnswers({ dir: '/m2/.beads' }),
        });
        const logs = [];
        const res = await verifyBeadsIdentity({ command, log: (l) => logs.push(l), backlogMember: 'orch', members: ['m1', 'm2'], setupMembers: ['orch', 'm2'] });
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

    test('bd where succeeding with unparseable output is the same no-database WARNING (non-reader member)', async () => {
        const { command } = fakeCommand({ orch: identityAnswers(), m1: { ...identityAnswers(), [BEADS_IDENTITY_PROBES.where]: 'not a beads dir' } });
        const logs = [];
        await verifyBeadsIdentity({ command, log: (l) => logs.push(l), backlogMember: 'orch', members: ['m1'], setupMembers: ['orch'] });
        const warn = logs.find((l) => l.includes("member 'm1' reports no beads database"));
        assert.ok(warn, JSON.stringify(logs));
        assert.match(warn, /unparseable output: not a beads dir/);
    });

    test('a command() that throws is treated as a failed probe (warning), never an unhandled crash', async () => {
        const command = async () => { throw new Error('transport down'); };
        const logs = [];
        const res = await verifyBeadsIdentity({ command, log: (l) => logs.push(l), backlogMember: 'orch', members: [] });
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
        const res = await verifyBeadsIdentity({ command, log: (l) => logs.push(l), publishState: (ns, d) => published.push(d), backlogMember: 'orch', members: ['m1', 'm2'] });
        assert.equal(res.expectedFrom, 'none');
        assert.equal(res.expected, null);
        const warn = logs.find((l) => l.includes("no expected beads identity was supplied and the backlog member 'orch' could not report its beads database"));
        assert.ok(warn, JSON.stringify(logs));
        assert.match(warn, /no cross-member beads identity check will happen this sprint/);
        assert.match(warn, /To restore it: fix the backlog member's beads \(run 'bd where' in the member's workFolder; ensure bd is installed there and the folder contains the project's \.beads\), or launch via the supervisor so --expect-beads is supplied/);
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
            verifyBeadsIdentity({ command, log: (l) => logs.push(l), backlogMember: 'orch', members: ['m1', 'm2'] }),
            (err) => err instanceof BeadsIdentityError && err.member === 'm2' && err.mismatches[0].field === 'repoRemote'
        );
        const derived = logs.filter((l) => l.includes("the backlog member 'orch' it was derived from could not report syncRemote"));
        assert.equal(derived.length, 1, JSON.stringify(logs));
        assert.match(derived[0], /syncRemote is not compared on any member this sprint/);
        assert.match(derived[0], /To fix: set it on that member with 'bd config set sync\.remote <url>' in its workFolder \(on the backlog member\), or launch via the supervisor so --expect-beads is supplied/);
        assert.ok(!logs.some((l) => l.includes("member 'orch' could not report syncRemote")), 'the orchestrator gap is not reported twice');
        // m1 HAS a sync.remote; the expectation lacks one, so it is skipped rather than mismatched.
        assert.ok(logs.some((l) => l.startsWith('beads ok: m1 ')));
    });

    test('a supplied expectation lacking a field: that field is warned about once and skipped; a real mismatch on another field still aborts', async () => {
        const { command } = fakeCommand({ orch: identityAnswers({ prefix: 'other' }) });
        const logs = [];
        await assert.rejects(
            verifyBeadsIdentity({ command, log: (l) => logs.push(l), backlogMember: 'orch', members: [], expected: { prefix: 'proj', syncRemote: '', repoRemote: REMOTE } }),
            (err) => err instanceof BeadsIdentityError && err.reason === BEADS_IDENTITY_FAILURE_REASONS.MISMATCH && err.mismatches.length === 1 && err.mismatches[0].field === 'prefix'
        );
        assert.ok(logs.some((l) => l.includes('the supplied expected beads identity carries no syncRemote; syncRemote is not compared on any member this sprint')), JSON.stringify(logs));
    });

    test('BEADS_IDENTITY_FAILURE_REASONS has no probe-failure reason: only MISMATCH, a proven-absent bd and a failed member beads set-up are fatal', () => {
        assert.deepEqual(Object.keys(BEADS_IDENTITY_FAILURE_REASONS), ['MISMATCH', 'BD_MISSING', 'BEADS_SETUP_FAILED']);
    });

    for (const [shell, error] of [
        ['POSIX', 'Exit code 127: bash: line 1: bd: command not found'],
        // The real shape: FleetWorkflow.command() failSoft error over an execute_command result.
        ['POSIX (real failSoft shape)', '[Command Failed] Exit code 127: Exit code: 127\n[stderr]\nbash: line 1: bd: command not found'],
        ['PowerShell (real failSoft shape)', "[Command Failed] Exit code 1: Exit code: 1\n[stderr]\nbd : The term 'bd' is not recognized as the name of a cmdlet, function, script file, or operable program."],
        ['PowerShell', "bd : The term 'bd' is not recognized as the name of a cmdlet, function, script file, or operable program."],
        ['cmd', "'bd' is not recognized as an internal or external command"],
    ]) {
        test(`a member whose ${shell} shell has no bd fails the preflight with BD_MISSING naming the member and the fix, before later members are probed`, async () => {
            const { command, calls } = fakeCommand({
                orch: identityAnswers(),
                m1: { [BEADS_IDENTITY_PROBES.where]: { fail: error } },
                m2: identityAnswers({ dir: '/m2/.beads' }),
            });
            await assert.rejects(
                verifyBeadsIdentity({ command, log: () => {}, backlogMember: 'orch', members: ['m1', 'm2'] }),
                (err) => {
                    assert.ok(err instanceof BeadsIdentityError);
                    assert.equal(err.reason, BEADS_IDENTITY_FAILURE_REASONS.BD_MISSING);
                    assert.equal(err.member, 'm1');
                    assert.match(err.message, /member 'm1' has no bd CLI/);
                    assert.match(err.message, /To fix: install the beads CLI \(bd\) on that member/);
                    return true;
                },
            );
            assert.ok(!calls.some((c) => c.opts.member_name === 'm2'), 'stops before probing later members');
        });
    }

    test('a backlog member without bd fails the preflight too', async () => {
        const { command } = fakeCommand({ orch: { [BEADS_IDENTITY_PROBES.where]: { fail: 'sh: 1: bd: not found' } } });
        await assert.rejects(
            verifyBeadsIdentity({ command, log: () => {}, backlogMember: 'orch', members: [] }),
            (err) => err.reason === BEADS_IDENTITY_FAILURE_REASONS.BD_MISSING && err.member === 'orch',
        );
    });

    test('rejects a missing backlog member up front', async () => {
        await assert.rejects(verifyBeadsIdentity({ command: async () => ({ ok: true, output: '' }), backlogMember: '', members: [] }), TypeError);
    });
});

describe('createBeadsIdentityProber', () => {
    test('probes a member once per run (memoized), even across two verify passes sharing the prober', async () => {
        const { command, calls } = fakeCommand({ orch: identityAnswers(), m1: identityAnswers() });
        const prober = createBeadsIdentityProber({ command });
        await verifyBeadsIdentity({ command, prober, backlogMember: 'orch', members: ['m1'] });
        await verifyBeadsIdentity({ command, prober, backlogMember: 'orch', members: ['m1', 'orch'] });
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

    test('forget() drops the memo so the next probe re-runs', async () => {
        const { command, calls } = fakeCommand({ m1: identityAnswers() });
        const prober = createBeadsIdentityProber({ command });
        await prober.probe('m1');
        prober.forget('m1');
        await prober.probe('m1');
        assert.equal(calls.length, 6);
    });
});

// =============================================================================
// Member beads set-up: a beads-reading member with no database (or a database
// with no sync.remote while the expectation names one) is set up from the
// expected beads remote BEFORE any dispatch, re-verified, and a failure is a
// typed BEADS_SETUP_FAILED -- never a warning followed by dispatches.
// =============================================================================

const SET_CMD = BEADS_SETUP_COMMANDS.setSyncRemote(REMOTE);
const EXPECTED = { prefix: 'proj', syncRemote: REMOTE, repoRemote: REMOTE };
const NO_DB = JSON.stringify({ error: 'no_beads_directory', message: 'No active beads workspace found.', schema_version: 1 });
const SYNC_PLAN = JSON.stringify({ action: 'sync', has_existing: false, reason: 'sync.remote git repo has Dolt data', sync_remote: 'git+' + REMOTE, schema_version: 1 });

/**
 * A member whose bd state changes as set-up commands run: `state.hasDb` /
 * `state.sync` drive the three identity probes; `handlers[cmd]` answers a
 * set-up command (default: success) and may mutate `state`.
 */
function statefulMember({ hasDb = false, sync = '', prefix = 'proj', handlers = {} } = {}) {
    const state = { hasDb, sync, prefix };
    const defaults = {
        [SET_CMD]: () => { state.sync = REMOTE; return ''; },
        [BEADS_SETUP_COMMANDS.plan]: () => SYNC_PLAN,
        [BEADS_SETUP_COMMANDS.bootstrap]: () => { state.hasDb = true; return 'Bootstrap complete.'; },
        [BEADS_SETUP_COMMANDS.pull]: () => 'Pulled.',
    };
    const answer = (cmd) => {
        if (cmd === BEADS_IDENTITY_PROBES.where) return state.hasDb ? whereJson('/m1/.beads', state.prefix) : { fail: NO_DB };
        if (cmd === BEADS_IDENTITY_PROBES.syncRemote) return syncJson(state.sync);
        if (cmd === BEADS_IDENTITY_PROBES.repoRemote) return `${REMOTE}\n`;
        const h = handlers[cmd] || defaults[cmd];
        return h ? h(state) : undefined;
    };
    return { state, answer };
}

function setupHarness(m1) {
    const orch = identityAnswers();
    const calls = [];
    const order = [];
    const invalidated = [];
    const command = async (cmd, opts) => {
        calls.push({ cmd, opts });
        order.push(`cmd:${opts.member_name}:${cmd}`);
        // Same seam as the runner's command() wrapper.
        if (noteMemberCommand(opts.member_name, cmd)) invalidated.push({ member: opts.member_name, cmd });
        const a = opts.member_name === 'm1' ? m1.answer(cmd) : orch[cmd];
        if (a && typeof a === 'object' && a.fail !== undefined) return { ok: false, output: '', error: a.fail };
        return { ok: true, output: a === undefined ? '' : a, error: null };
    };
    const ensureVcsAuth = async (member) => { order.push(`vcs:${member}`); };
    return { command, calls, order, invalidated, ensureVcsAuth };
}

const setupCalls = (calls) => calls.filter((c) => c.opts.label === 'beads-setup');

describe('verifyBeadsIdentity: member beads set-up', () => {
    test('no-DB beads reader: VCS credential, then config set + bootstrap plan + bootstrap via command() (noteMemberCommand sees them), re-verified, recorded', async () => {
        const m1 = statefulMember();
        const h = setupHarness(m1);
        const logs = [];
        const published = [];
        const res = await verifyBeadsIdentity({
            command: h.command, log: (l) => logs.push(l), publishState: (ns, d) => published.push(d),
            backlogMember: 'orch', members: ['m1'], expected: EXPECTED, ensureVcsAuth: h.ensureVcsAuth,
        });
        assert.deepEqual(setupCalls(h.calls).map((c) => c.cmd), [SET_CMD, BEADS_SETUP_COMMANDS.plan, BEADS_SETUP_COMMANDS.bootstrap]);
        for (const c of setupCalls(h.calls)) {
            assert.equal(c.opts.member_name, 'm1');
            assert.equal(c.opts.failSoft, true);
            assert.equal(c.opts.timeout_s, BEADS_SETUP_TIMEOUT_S);
        }
        // The credential is ensured before the first set-up command.
        assert.ok(h.order.indexOf('vcs:m1') >= 0 && h.order.indexOf('vcs:m1') < h.order.indexOf(`cmd:m1:${SET_CMD}`), JSON.stringify(h.order));
        // The memo-invalidating seam saw every remote-rewiring command.
        assert.deepEqual(h.invalidated.map((i) => i.cmd), [SET_CMD, BEADS_SETUP_COMMANDS.plan, BEADS_SETUP_COMMANDS.bootstrap]);
        // Re-probed (not served from the memo) and verified.
        assert.equal(h.calls.filter((c) => c.opts.member_name === 'm1' && c.cmd === BEADS_IDENTITY_PROBES.where).length, 2);
        assert.equal(res.members.m1.beadsDir, '/m1/.beads');
        assert.equal(res.members.m1.syncRemote, REMOTE);
        assert.deepEqual(res.setUp, ['m1']);
        assert.deepEqual(published[0].setUp, ['m1']);
        assert.ok(logs.some((l) => l.startsWith('beads ok: m1 ')), JSON.stringify(logs));
        assert.ok(!logs.some((l) => l.startsWith(BEADS_IDENTITY_WARNING_PREFIX)), `no warnings expected: ${JSON.stringify(logs)}`);
    });

    test('DB present but no sync.remote while the expectation names one: config set + bootstrap + dolt pull, re-verified', async () => {
        const m1 = statefulMember({ hasDb: true, sync: '' });
        const h = setupHarness(m1);
        const res = await verifyBeadsIdentity({ command: h.command, backlogMember: 'orch', members: ['m1'], expected: EXPECTED, ensureVcsAuth: h.ensureVcsAuth });
        assert.deepEqual(setupCalls(h.calls).map((c) => c.cmd), [SET_CMD, BEADS_SETUP_COMMANDS.bootstrap, BEADS_SETUP_COMMANDS.pull]);
        assert.equal(res.members.m1.syncRemote, REMOTE);
        assert.deepEqual(res.setUp, ['m1']);
    });

    test('an expectation derived from the backlog member also drives the set-up of the other members', async () => {
        const m1 = statefulMember();
        const h = setupHarness(m1);
        const res = await verifyBeadsIdentity({ command: h.command, backlogMember: 'orch', members: ['m1'] });
        assert.equal(res.expectedFrom, 'backlog');
        assert.deepEqual(res.setUp, ['m1']);
    });

    test('an existing matching DB is left untouched: zero set-up commands, no credential call', async () => {
        const m1 = statefulMember({ hasDb: true, sync: REMOTE });
        const h = setupHarness(m1);
        const res = await verifyBeadsIdentity({ command: h.command, backlogMember: 'orch', members: ['m1'], expected: EXPECTED, ensureVcsAuth: h.ensureVcsAuth });
        assert.equal(setupCalls(h.calls).length, 0);
        assert.ok(!h.order.includes('vcs:m1'));
        assert.deepEqual(res.setUp, []);
    });

    test('a mismatching existing DB still fails as a MISMATCH, with no set-up attempted', async () => {
        const m1 = statefulMember({ hasDb: true, sync: REMOTE, prefix: 'other' });
        const h = setupHarness(m1);
        await assert.rejects(
            verifyBeadsIdentity({ command: h.command, backlogMember: 'orch', members: ['m1'], expected: EXPECTED }),
            (err) => err.reason === BEADS_IDENTITY_FAILURE_REASONS.MISMATCH && err.member === 'm1',
        );
        assert.equal(setupCalls(h.calls).length, 0);
    });

    test('a bootstrapped DB whose prefix differs from the expectation is a MISMATCH', async () => {
        const m1 = statefulMember({ prefix: 'other' });
        const h = setupHarness(m1);
        await assert.rejects(
            verifyBeadsIdentity({ command: h.command, backlogMember: 'orch', members: ['m1'], expected: EXPECTED }),
            (err) => err.reason === BEADS_IDENTITY_FAILURE_REASONS.MISMATCH && err.mismatches[0].field === 'prefix',
        );
    });

    const failureCases = [
        ['bd bootstrap fails', { [BEADS_SETUP_COMMANDS.bootstrap]: () => ({ fail: 'Error: authentication required' }) },
            /could not bootstrap its beads from 'https:\/\/example\.com\/org\/repo\.git' \('bd bootstrap --yes' -> Error: authentication required\)/],
        ['the bootstrap plan is a JSONL import, not a clone of the expected remote',
            { [BEADS_SETUP_COMMANDS.plan]: () => JSON.stringify({ action: 'jsonl-import', reason: 'issues.jsonl exists' }) },
            /'bd bootstrap' would not clone it from the expected beads remote .*planned action 'jsonl-import' \(issues\.jsonl exists\)/],
        ['the bootstrap plan clones from a different remote',
            { [BEADS_SETUP_COMMANDS.plan]: () => JSON.stringify({ action: 'sync', sync_remote: 'https://example.com/org/other.git' }) },
            /planned action 'sync' from 'https:\/\/example\.com\/org\/other\.git'/],
        ['bd config set fails', { [SET_CMD]: () => ({ fail: 'Error: permission denied' }) },
            /could not set its sync\.remote \('bd config set sync\.remote https:\/\/example\.com\/org\/repo\.git' -> Error: permission denied\)/],
        ['bootstrap reports success but the member still has no database', { [BEADS_SETUP_COMMANDS.bootstrap]: () => 'ok' },
            /still reports no beads database after its set-up/],
        ['bootstrap auto-applies schema migrations against an older-schema remote',
            { [BEADS_SETUP_COMMANDS.bootstrap]: (st) => { st.hasDb = true; return 'BD_SMART_GATE: auto-applying 13 pending deterministic schema migrations ... Run bd dolt push after'; } },
            /bd reports a schema migration against that remote.*To fix: the shared beads remote is at an older bd schema.*run 'bd dolt push' in its workFolder/],
    ];
    for (const [name, handlers, re] of failureCases) {
        test(`${name}: typed BEADS_SETUP_FAILED naming the member, cause and fix`, async () => {
            const m1 = statefulMember({ handlers });
            const h = setupHarness(m1);
            await assert.rejects(
                verifyBeadsIdentity({ command: h.command, backlogMember: 'orch', members: ['m1'], expected: EXPECTED }),
                (err) => {
                    assert.ok(err instanceof BeadsIdentityError);
                    assert.equal(err.reason, BEADS_IDENTITY_FAILURE_REASONS.BEADS_SETUP_FAILED);
                    assert.equal(err.member, 'm1');
                    assert.match(err.message, /^Beads preflight failed: member 'm1' /);
                    assert.match(err.message, re);
                    assert.match(err.message, /so the sprint stops before any dispatch\. To fix: /);
                    return true;
                },
            );
        });
    }

    test('a failed plan never runs the real bootstrap', async () => {
        const m1 = statefulMember({ handlers: { [BEADS_SETUP_COMMANDS.plan]: () => JSON.stringify({ action: 'fresh' }) } });
        const h = setupHarness(m1);
        await assert.rejects(verifyBeadsIdentity({ command: h.command, backlogMember: 'orch', members: ['m1'], expected: EXPECTED }));
        assert.ok(!h.calls.some((c) => c.cmd === BEADS_SETUP_COMMANDS.bootstrap));
    });

    test('DB present without sync.remote that cannot pull from the expected remote: BEADS_SETUP_FAILED with the move-aside fix', async () => {
        const m1 = statefulMember({ hasDb: true, handlers: { [BEADS_SETUP_COMMANDS.pull]: () => ({ fail: 'Error: no common ancestor' }) } });
        const h = setupHarness(m1);
        await assert.rejects(
            verifyBeadsIdentity({ command: h.command, backlogMember: 'orch', members: ['m1'], expected: EXPECTED }),
            (err) => err.reason === BEADS_IDENTITY_FAILURE_REASONS.BEADS_SETUP_FAILED
                && /cannot pull from the expected beads remote .*no common ancestor/.test(err.message)
                && /move that member's existing beads database aside/.test(err.message),
        );
    });

    test('no-DB beads reader and no expected beads remote anywhere: BEADS_SETUP_FAILED, nothing issued', async () => {
        const m1 = statefulMember();
        const h = setupHarness(m1);
        await assert.rejects(
            verifyBeadsIdentity({ command: h.command, backlogMember: 'orch', members: ['m1'], expected: { prefix: 'proj', syncRemote: '', repoRemote: REMOTE } }),
            (err) => err.reason === BEADS_IDENTITY_FAILURE_REASONS.BEADS_SETUP_FAILED && /no expected beads remote to set one up from/.test(err.message),
        );
        assert.equal(setupCalls(h.calls).length, 0);
    });

    test('an expected remote that is not shell-safe is refused before any command', async () => {
        for (const url of ['https://example.com/$(evil).git', 'https://example.com/a b.git', 'C:\\beads\\remote', 'https://x/%PATH%.git', 'https://x/a;b']) {
            const calls = [];
            await assert.rejects(
                setupMemberBeads({ command: async (cmd) => { calls.push(cmd); return { ok: true, output: '' }; }, member: 'm1', url, hasDb: false }),
                (err) => err.reason === BEADS_IDENTITY_FAILURE_REASONS.BEADS_SETUP_FAILED && /cannot be passed verbatim to every member shell/.test(err.message),
                url,
            );
            assert.equal(calls.length, 0, url);
        }
    });

    test('a supplied expectation also sets up a backlog member that has no database', async () => {
        const orchState = statefulMember();
        const command = async (cmd) => {
            const a = orchState.answer(cmd);
            if (a && typeof a === 'object' && a.fail !== undefined) return { ok: false, output: '', error: a.fail };
            return { ok: true, output: a === undefined ? '' : a, error: null };
        };
        const res = await verifyBeadsIdentity({ command, backlogMember: 'orch', members: [], expected: EXPECTED });
        assert.deepEqual(res.setUp, ['orch']);
        assert.ok(res.members.orch);
    });

    test('the beads-reading roles exclude deployer and ci-watcher', () => {
        assert.ok(!BEADS_READING_ROLES.includes('deployer'));
        assert.ok(!BEADS_READING_ROLES.includes('ci-watcher'));
        for (const r of ['planner', 'plan-reviewer', 'doer', 'reviewer', 'integ-test-runner', 'regression-test-runner', 'harvester']) {
            assert.ok(BEADS_READING_ROLES.includes(r), r);
        }
    });
});
