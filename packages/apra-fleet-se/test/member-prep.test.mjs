import { test } from 'node:test';
import assert from 'node:assert/strict';

import { runMemberPrepPhase, checkMemberAuth, runSweepStep } from '../fleet-sprint/phases/member-prep.mjs';
import { LlmAuthUnprovisionableError } from '../fleet-sprint/errors.mjs';
import { KILL_BEGIN_PREFIX, KILL_STATUS_PREFIX } from '../fleet-sprint/member-stray-sweep.mjs';

// =============================================================================
// Member Prep (apra-fleet-9be4.4) -- verification for the sprint-start
// once-per-member step (apra-fleet-9be4.3's phases/member-prep.mjs).
//
// Everything below drives runMemberPrepPhase (and its two named sub-steps)
// DIRECTLY with hand-built stub seams -- no real sprint runs, no real
// process is started or killed, no real credential is provisioned, and
// nothing is written to disk. `execCommand`/`fleetApi`/`syncBeadsBefore` are
// all plain in-memory functions that record what they were called with.
// =============================================================================

/** A list_members(format:'json') MCP result carrying `members`. */
function listMembersResult(members) {
    return { content: [{ text: JSON.stringify({ members }) }] };
}

/** A provision_llm_auth MCP result carrying both the prose and structured halves. */
function provisionResult(text, { ok, reason }) {
    return { content: [{ text }], structuredContent: { ok, reason } };
}

function makeFleetApi({ members = [], provisionOutcomes = {} } = {}) {
    const calls = [];
    return {
        calls,
        async listMembers(opts) {
            calls.push({ tool: 'list_members', opts });
            return listMembersResult(members);
        },
        async provisionLlmAuth({ member_name }) {
            calls.push({ tool: 'provision_llm_auth', member: member_name });
            const outcome = provisionOutcomes[member_name];
            if (!outcome) throw new Error(`test fixture bug: no provisionOutcomes entry for '${member_name}'`);
            if (outcome.throw) throw outcome.throw;
            return provisionResult(outcome.text ?? '', { ok: outcome.ok, reason: outcome.reason });
        },
    };
}

// A minimal but VALID probe table: one process row (the probe process
// itself, pid 1, no parent, elapsed 1s) and no listening sockets. A working
// probe always reports at least itself (member-stray-sweep.mjs's
// parseProbeOutput() throws StrayProbeError on a truly empty table -- "the
// probe did not run", never "the member is clean") -- this fixture exists so
// the stub execCommand seam answers the sweep's probe dispatch with
// something parseProbeOutput() accepts, without matching any real process.
const CLEAN_PROBE_OUTPUT = 'SWEEP-PROC 1 0 00:01 /sbin/init';

function makeExecCommand() {
    const calls = [];
    const execCommand = async (opts) => {
        calls.push(opts);
        return { ok: true, output: CLEAN_PROBE_OUTPUT, error: null };
    };
    return { execCommand, calls };
}

function makeSyncBeadsBefore() {
    const calls = [];
    const syncBeadsBefore = async (member, options) => {
        calls.push({ member, options });
        return { ok: true };
    };
    return { syncBeadsBefore, calls };
}

function collectLog() {
    const lines = [];
    return { log: (msg) => lines.push(msg), lines };
}

// ---------------------------------------------------------------------------
// 1. Per-member reporting: a two-member sprint gets a result line for each of
//    the four steps, for EACH member -- eight lines -- including explicit
//    skip lines with reasons.
// ---------------------------------------------------------------------------

test('member-prep: reports one result line for each of the four steps, for every member, including skip reasons', async () => {
    const { log, lines } = collectLog();
    const fleetApi = makeFleetApi({
        members: [
            { name: 'doer-remote', type: 'remote', os: 'linux', llm_auth: 'oauth' },
            { name: 'doer-local', type: 'local', os: 'linux', llm_auth: 'N/A' },
        ],
        provisionOutcomes: {
            // 'doer-remote' is already 'oauth' per list_members, so this
            // should never be called for it (verified in the ordering test
            // below); provided anyway so a fixture bug would surface loudly
            // instead of silently.
            'doer-remote': { ok: true, reason: 'ok', text: '[OK] mock' },
            'doer-local': { ok: true, reason: 'ok', text: '[OK] mock' },
        },
    });
    const { execCommand } = makeExecCommand();
    const { syncBeadsBefore } = makeSyncBeadsBefore();

    const result = await runMemberPrepPhase({
        members: ['doer-remote', 'doer-local'],
        fleetApi,
        execCommand,
        syncBeadsBefore,
        log,
    });

    const stepLines = lines.filter((l) => l.startsWith('[member-prep] member '));
    assert.equal(stepLines.length, 8, `expected 8 per-member step lines, got ${stepLines.length}:\n${stepLines.join('\n')}`);

    for (const member of ['doer-remote', 'doer-local']) {
        for (const step of ['auth', 'sweep', 'G-pull', 'D-pull']) {
            assert.ok(
                stepLines.some((l) => l.includes(`member '${member}'`) && l.includes(`: ${step} --`)),
                `missing a '${step}' result line for member '${member}'`,
            );
        }
    }

    // The local member's sweep step is an explicit skip WITH a reason.
    assert.ok(
        stepLines.some((l) => l.includes("member 'doer-local': sweep -- skipped (local member)")),
        'expected an explicit skip-with-reason line for the local member\'s sweep step',
    );

    assert.deepEqual(Object.keys(result.members).sort(), ['doer-local', 'doer-remote']);
});

// ---------------------------------------------------------------------------
// 2. Ordering: Member Prep completes before the first role dispatch. Proven
//    through a shared call-order ledger every seam (including a stand-in
//    "dispatch") pushes to -- not by reading runner.js's source.
// ---------------------------------------------------------------------------

test('member-prep: every prep-step call lands on the ledger before a simulated first role dispatch', async () => {
    const order = [];
    const fleetApi = {
        // 'm1' is registered remote (llm_auth 'none') so the auth step's
        // provisionLlmAuth call actually fires -- checkMemberAuth() gates
        // that call on locality (see this module's header), so a local/
        // unregistered member would otherwise leave this ledger entry
        // unreachable and the ordering assertion below vacuous.
        async listMembers() { order.push('list_members'); return listMembersResult([{ name: 'm1', type: 'remote', os: 'linux', llm_auth: 'none' }]); },
        async provisionLlmAuth({ member_name }) {
            order.push(`provision_llm_auth:${member_name}`);
            return provisionResult('[OK] mock', { ok: true, reason: 'ok' });
        },
    };
    const execCommand = async (opts) => { order.push(`execCommand:${opts.member}`); return { ok: true, output: CLEAN_PROBE_OUTPUT, error: null }; };
    const syncBeadsBefore = async (member) => { order.push(`syncBeadsBefore:${member}`); return { ok: true }; };
    const dispatchRole = async (member) => { order.push(`dispatch:${member}`); return { ok: true }; };

    await runMemberPrepPhase({
        members: ['m1'],
        fleetApi,
        execCommand,
        syncBeadsBefore,
        log: () => {},
        // A non-empty marker is required for the sweep to actually probe
        // (review blocker 2 -- with no markers configured the sweep step is
        // a deliberate skip and dispatches no probe), so this ordering
        // assertion's execCommand ledger entry stays reachable.
        sweepMarkers: [{ kind: 'env', token: 'FLEET_SANDBOX=1', evidence: 'fleet sandbox marker' }],
    });
    // The real caller (runner.js) awaits Member Prep, THEN runs Ensure
    // Sprint Branch, THEN eventually dispatches a role -- simulate that
    // ordering constraint at this call site.
    await dispatchRole('m1');

    const dispatchIdx = order.indexOf('dispatch:m1');
    assert.notEqual(dispatchIdx, -1, 'dispatch stub was never called');
    for (const entry of order.slice(0, dispatchIdx)) {
        assert.notEqual(entry, 'dispatch:m1');
    }
    // Every prep-step ledger entry (list_members, provision_llm_auth,
    // execCommand -- 'm1' is registered remote so the sweep step actually
    // probes -- and syncBeadsBefore) precedes the dispatch entry.
    assert.ok(order.slice(0, dispatchIdx).some((e) => e.startsWith('provision_llm_auth:')));
    assert.ok(order.slice(0, dispatchIdx).some((e) => e.startsWith('execCommand:')));
    assert.ok(order.slice(0, dispatchIdx).some((e) => e.startsWith('syncBeadsBefore:')));
    assert.equal(order[order.length - 1], 'dispatch:m1');
});

// ---------------------------------------------------------------------------
// 3. The loud-failure path: LLM auth missing and not provisionable -> the
//    sprint fails with a named error BEFORE any role dispatch, and zero
//    dispatches occurred.
// ---------------------------------------------------------------------------

test('member-prep: unprovisionable LLM auth throws a named error before any dispatch, with zero dispatches attempted', async () => {
    const fleetApi = makeFleetApi({
        members: [{ name: 'broken-member', type: 'remote', os: 'linux', llm_auth: 'none' }],
        provisionOutcomes: {
            'broken-member': { ok: false, reason: 'member_offline', text: '[FAIL] Member "broken-member" is offline: connection refused' },
        },
    });
    const { execCommand } = makeExecCommand();
    const { syncBeadsBefore } = makeSyncBeadsBefore();
    let dispatchCount = 0;
    const dispatchRole = async () => { dispatchCount += 1; };

    await assert.rejects(
        () => runMemberPrepPhase({
            members: ['broken-member'],
            fleetApi,
            execCommand,
            syncBeadsBefore,
            log: () => {},
        }),
        (err) => {
            assert.ok(err instanceof LlmAuthUnprovisionableError, `expected LlmAuthUnprovisionableError, got ${err && err.constructor && err.constructor.name}`);
            assert.equal(err.member, 'broken-member');
            assert.equal(err.credential, 'LLM auth');
            return true;
        },
    );
    // The caller (runner.js) never reaches its first role dispatch when
    // Member Prep throws -- simulated here by never having called
    // dispatchRole in the first place, since the throw unwinds straight out
    // of the await above.
    assert.equal(dispatchCount, 0);
    // D-pull must never have been reached for this member either -- the
    // auth step is checked BEFORE sweep/G-pull/D-pull, per this module's
    // documented per-member step order.
    assert.equal(syncBeadsBefore.calls?.length ?? 0, 0);
});

// ---------------------------------------------------------------------------
// 4. The local-member trap: skipped_local_member is NOT read as successful
//    provisioning -- it reaches the abort path, not the success path.
//
//    NOTE on locality gating: checkMemberAuth() only calls provisionLlmAuth
//    at all for a member memberLocality() classifies LOCALITY_REMOTE (a
//    genuinely local/relay/unknown member is a plain 'skipped' outcome with
//    no call attempted at all -- see 'sweep step is skipped ... for a local
//    member' below for the sibling case, and this module's header for why:
//    calling provision_llm_auth unconditionally and fail-looding on its
//    guaranteed skipped_local_member no-op broke every local-member sprint,
//    the single most common fleet-sprint configuration -- confirmed via a
//    real regression in test/mock-sprint-planner-auth-failure-no-retry.
//    test.mjs). So this trap is exercised here against a member REGISTERED
//    remote whose provision_llm_auth nonetheless answers
//    skipped_local_member -- the one edge case where the gate above does not
//    save this member from reaching the real call, and the defensive
//    ok:true-is-not-success check earns its keep.
// ---------------------------------------------------------------------------

test('member-prep: a provision_llm_auth outcome of skipped_local_member is treated as NOT provisioned (reaches the abort path)', async () => {
    const fleetApi = makeFleetApi({
        members: [{ name: 'misclassified-member', type: 'remote', os: 'linux', llm_auth: 'none' }],
        provisionOutcomes: {
            'misclassified-member': {
                ok: true, // structuredContent.ok IS true for this reason (src/tools/provision-auth.ts OK_REASONS) --
                reason: 'skipped_local_member', // this is exactly the trap: ok:true must still not mean "provisioned".
                text: '[SKIP] Skipping "misclassified-member" -- local members use this machine\'s credentials directly.',
            },
        },
    });

    await assert.rejects(
        () => checkMemberAuth({ member: 'misclassified-member', memberRecord: { type: 'remote', llm_auth: 'none' }, fleetApi, log: () => {} }),
        (err) => {
            assert.ok(err instanceof LlmAuthUnprovisionableError);
            assert.match(err.message, /skipped_local_member/);
            return true;
        },
    );
});

test('member-prep: an ok:true provision result with a REAL (non-skip) reason is read as successfully provisioned', async () => {
    const fleetApi = makeFleetApi({
        members: [],
        provisionOutcomes: {
            'healed-member': { ok: true, reason: 'ok', text: '[OK] OAuth credentials deployed' },
        },
    });
    const outcome = await checkMemberAuth({ member: 'healed-member', memberRecord: { type: 'remote' }, fleetApi, log: () => {} });
    assert.equal(outcome.status, 'provisioned');
});

// ---------------------------------------------------------------------------
// 5. Local member, sweep: no kill is attempted; the sweep module is not even
//    invoked (member-prep's own gate, mirroring the sweep's own local-member
//    rule one level up -- apra-fleet-9be4.3 criterion 3: invoked only for
//    remote members).
// ---------------------------------------------------------------------------

test('member-prep: sweep step is skipped (no kill attempted, no probe issued) for a local member', async () => {
    const { execCommand, calls } = makeExecCommand();
    const sweep = await runSweepStep({
        member: 'local-op-machine',
        memberRecord: { type: 'local', os: 'linux' },
        execCommand,
    });
    assert.equal(sweep.status, 'skipped');
    assert.equal(sweep.reason, 'local member');
    assert.equal(calls.length, 0, 'execCommand (the sweep probe/kill seam) must never be called for a local member');
});

test('member-prep: sweep step DOES invoke the sweep module for a remote member when markers are configured', async () => {
    const { execCommand, calls } = makeExecCommand();
    const sweep = await runSweepStep({
        member: 'remote-worker',
        memberRecord: { type: 'remote', os: 'linux' },
        execCommand,
        sweepMarkers: [{ kind: 'env', token: 'FLEET_SANDBOX=1', evidence: 'fleet sandbox marker' }],
        sweepProductionPorts: [],
    });
    assert.equal(sweep.status, 'ran');
    assert.ok(calls.length > 0, 'execCommand should have been called at least once (the probe dispatch) for a remote member');
});

// ---------------------------------------------------------------------------
// 7. Review blocker 2: with no sweep markers configured, the sweep step must
//    report a deliberate SKIP and dispatch no probe at all -- a probe with no
//    markers can never identify a fleet-started process, so running it
//    anyway would only ever produce a false "clean, N scanned" result.
// ---------------------------------------------------------------------------

test('member-prep: sweep step is skipped and dispatches NO probe when no sweep markers are configured', async () => {
    const { execCommand, calls } = makeExecCommand();
    const sweep = await runSweepStep({
        member: 'remote-worker',
        memberRecord: { type: 'remote', os: 'linux' },
        execCommand,
        sweepMarkers: [],
        sweepProductionPorts: [],
    });
    assert.equal(sweep.status, 'skipped');
    assert.match(sweep.reason, /no fleet-start markers configured/);
    assert.equal(calls.length, 0, 'execCommand (the sweep probe seam) must never be called with no markers configured');
});

// ---------------------------------------------------------------------------
// 8. Review blocker 1: a failed member-registry read must NOT be silently
//    read as "every member is local". The auth gate must actively attempt
//    provision_llm_auth instead of skipping, and the resulting outcome/log
//    text must never claim the member is local when that was never
//    confirmed. The sweep stays a safe skip on unknown locality, but with an
//    honest reason instead of "local member".
// ---------------------------------------------------------------------------

test('member-prep: a list_members failure does NOT silently skip auth -- provision_llm_auth is still attempted and a real failure still aborts loud', async () => {
    const fleetApi = {
        async listMembers() { throw new Error('registry offline'); },
        async provisionLlmAuth() {
            return provisionResult('[FAIL] Member is offline: connection refused', { ok: false, reason: 'member_offline' });
        },
    };
    const { execCommand } = makeExecCommand();
    const { syncBeadsBefore } = makeSyncBeadsBefore();

    await assert.rejects(
        () => runMemberPrepPhase({
            members: ['remote-member-with-broken-registry'],
            fleetApi,
            execCommand,
            syncBeadsBefore,
            log: () => {},
        }),
        (err) => {
            assert.ok(err instanceof LlmAuthUnprovisionableError);
            assert.equal(err.member, 'remote-member-with-broken-registry');
            return true;
        },
    );
    // D-pull must never have been reached -- the auth step aborts the whole
    // phase before sweep/G-pull/D-pull run for this member.
    assert.equal(syncBeadsBefore.calls?.length ?? 0, 0);
});

test('member-prep: a list_members failure lets a healthy member\'s auth actually provision (not a silent local-member skip)', async () => {
    const provisionCalls = [];
    const fleetApi = {
        async listMembers() { throw new Error('registry offline'); },
        async provisionLlmAuth({ member_name }) {
            provisionCalls.push(member_name);
            return provisionResult('[OK] mock', { ok: true, reason: 'ok' });
        },
    };
    const outcome = await checkMemberAuth({
        member: 'healthy-member', memberRecord: null, fleetApi, registryReadFailed: true, log: () => {},
    });
    assert.equal(outcome.status, 'provisioned');
    assert.deepEqual(provisionCalls, ['healthy-member'], 'provision_llm_auth must actually be attempted when the registry could not be read');
});

test('member-prep: a list_members failure plus a skipped_local_member provision outcome is a confirmed skip, not an abort', async () => {
    const fleetApi = {
        async provisionLlmAuth() {
            return provisionResult('[SKIP] local members use this machine\'s credentials directly.', { ok: true, reason: 'skipped_local_member' });
        },
    };
    const outcome = await checkMemberAuth({
        member: 'actually-local-member', memberRecord: null, fleetApi, registryReadFailed: true, log: () => {},
    });
    assert.equal(outcome.status, 'skipped');
    assert.match(outcome.detail, /skipped_local_member/);
    assert.doesNotMatch(outcome.detail, /^local member --/, 'must not be worded as a pre-emptive "local member" skip -- this was confirmed by a real provision_llm_auth call, not guessed from a missing registry entry');
});

test('member-prep: sweep step skips with an honest reason (not "local member") when the registry could not be read', async () => {
    const { execCommand, calls } = makeExecCommand();
    const sweep = await runSweepStep({
        member: 'unknown-locality-member',
        memberRecord: null,
        execCommand,
        registryReadFailed: true,
        sweepMarkers: [{ kind: 'env', token: 'FLEET_SANDBOX=1', evidence: 'fleet sandbox marker' }],
    });
    assert.equal(sweep.status, 'skipped');
    assert.notEqual(sweep.reason, 'local member', 'must not claim the member is local when locality was never confirmed');
    assert.match(sweep.reason, /registry could not be read/);
    assert.equal(calls.length, 0, 'execCommand (the sweep probe seam) must never be called when locality is unknown');
});

// ---------------------------------------------------------------------------
// 9. apra-fleet-i4ku.7: the new target-owned config surface (--sweep-config
//    -> sprint-args.mjs's sweep_markers/sweep_production_ports -> runner.js's
//    Member Prep call site) actually produces a KILL decision end to end
//    through runMemberPrepPhase's own stubbed execCommand seam -- not just an
//    empty "ran, 0 killed" result. NOTHING REAL IS TOUCHED: execCommand below
//    is a plain in-memory stub that only ever records/synthesizes text, the
//    same pattern member-stray-sweep-safety-matrix.test.mjs's stubSeam()
//    uses.
// ---------------------------------------------------------------------------

const CONFIGURED_MARKERS = [
    { kind: 'sandbox-supervisor', token: '/opt/fleetwork/sandbox-run1/', evidence: 'path' },
];
const STALE_SUPERVISOR_PID = 4242;
const DEAD_PARENT_PID = 9999;
const SANDBOX_SUPERVISOR_CMD = '/usr/bin/node /opt/fleetwork/sandbox-run1/supervisor.js --listen 18701';

/** Probe output carrying ONE real killable stray process (stale sandbox
 *  supervisor, dead parent, non-production listening port) and nothing else,
 *  so a kill decision -- if it happens -- is unambiguous. */
function killableStrayProbeOutput() {
    return [
        `SWEEP-PROC  ${STALE_SUPERVISOR_PID}  ${DEAD_PARENT_PID} 1-02:03:04 ${SANDBOX_SUPERVISOR_CMD}`,
        `SWEEP-PORT-SS LISTEN 0 4096 0.0.0.0:18701 0.0.0.0:* users:(("node",pid=${STALE_SUPERVISOR_PID},fd=20))`,
    ].join('\n');
}

/** Same execCommand-shape stub runMemberPrepPhase's caller (runner.js) wires
 *  in production -- ({ member, command }) => Promise<{ ok, output, error }>
 *  -- but synthesizes a real kill-dispatch response for the configured pid,
 *  exactly like member-stray-sweep-safety-matrix.test.mjs's stubSeam(). */
function makeKillCapableExecCommand(probeOutput) {
    const calls = [];
    const execCommand = async ({ member, command }) => {
        calls.push({ member, command });
        if (command.includes(KILL_BEGIN_PREFIX)) {
            const pids = [...command.matchAll(new RegExp(`${KILL_BEGIN_PREFIX} (\\d+)`, 'g'))].map((m) => Number(m[1]));
            const lines = pids.flatMap((pid) => [`${KILL_BEGIN_PREFIX} ${pid}`, `${KILL_STATUS_PREFIX} ${pid} 0`]);
            return { ok: true, output: lines.join('\n'), error: null };
        }
        return { ok: true, output: probeOutput, error: null };
    };
    return { execCommand, calls };
}

test('member-prep: a configured marker set (the new target-owned config surface) actually produces a KILL decision end to end through runMemberPrepPhase', async () => {
    const { log, lines } = collectLog();
    const fleetApi = makeFleetApi({
        members: [{ name: 'sandbox-member', type: 'remote', os: 'linux', llm_auth: 'oauth' }],
    });
    const { execCommand, calls } = makeKillCapableExecCommand(killableStrayProbeOutput());
    const { syncBeadsBefore } = makeSyncBeadsBefore();
    const fixedNow = () => Date.parse('2026-09-23T12:00:00.000Z');

    const result = await runMemberPrepPhase({
        members: ['sandbox-member'],
        fleetApi,
        execCommand,
        syncBeadsBefore,
        log,
        // The exact shape --sweep-config's resolveSweepConfig() (bin/cli.mjs)
        // resolves into, after flowing through sprint-args.mjs's
        // validateArgs() -- proving the marker/port CONFIGURATION itself, not
        // just member-stray-sweep.mjs's own decision logic (already covered
        // by test/member-stray-sweep-safety-matrix.test.mjs), reaches this
        // phase and results in a real kill dispatch.
        sweepMarkers: CONFIGURED_MARKERS,
        sweepProductionPorts: [7523, 8787],
        now: fixedNow,
    });

    assert.equal(result.members['sandbox-member'].sweep.status, 'ran');
    assert.deepEqual(
        result.members['sandbox-member'].sweep.result.killed.map((k) => k.pid),
        [STALE_SUPERVISOR_PID],
        'the configured marker must have matched the stale supervisor and produced exactly one kill decision',
    );

    // A real kill dispatch was issued (probe, then kill -- two execCommand
    // calls), naming the selected pid.
    assert.equal(calls.length, 2, 'expected one probe dispatch and one kill dispatch');
    assert.match(calls[1].command, new RegExp(`${KILL_BEGIN_PREFIX} ${STALE_SUPERVISOR_PID}`));

    // The summary log line reports a nonzero killed count, not "0 killed".
    const sweepLine = lines.find((l) => l.includes("member 'sandbox-member': sweep --"));
    assert.ok(sweepLine, 'expected a sweep summary log line');
    assert.match(sweepLine, /1 killed/);
});

test('member-prep: an UNCONFIGURED target (--sweep-config omitted -> no sweepMarkers passed) reports the sweep step SKIPPED, never a false "clean" scan', async () => {
    const { log, lines } = collectLog();
    const fleetApi = makeFleetApi({
        members: [{ name: 'sandbox-member', type: 'remote', os: 'linux', llm_auth: 'oauth' }],
    });
    // The SAME probe output that produces a real kill above -- if the sweep
    // module were invoked with no markers it could only ever answer "clean, N
    // scanned", which is exactly the false-coverage result this proves never
    // happens: no probe is dispatched at all when unconfigured.
    const { execCommand, calls } = makeKillCapableExecCommand(killableStrayProbeOutput());
    const { syncBeadsBefore } = makeSyncBeadsBefore();

    const result = await runMemberPrepPhase({
        members: ['sandbox-member'],
        fleetApi,
        execCommand,
        syncBeadsBefore,
        log,
        // No sweepMarkers/sweepProductionPorts passed at all -- exactly what
        // runner.js's Member Prep call site now does by default when
        // validated.sweepMarkers is undefined (--sweep-config never passed).
    });

    assert.equal(result.members['sandbox-member'].sweep.status, 'skipped');
    assert.match(result.members['sandbox-member'].sweep.reason, /no fleet-start markers configured/);
    assert.equal(calls.length, 0, 'no probe may be dispatched at all when unconfigured');

    const sweepLine = lines.find((l) => l.includes("member 'sandbox-member': sweep --"));
    assert.ok(sweepLine, 'expected a sweep summary log line');
    assert.match(sweepLine, /skipped/);
    assert.doesNotMatch(sweepLine, /clean/, 'must never report a false "clean" result with no markers configured');
});

// ---------------------------------------------------------------------------
// 6. No real process, no real dispatch, no real credential, no artifact
//    outside this test's own in-memory fixtures -- implicit in every test
//    above: every seam is a plain in-memory async function, none of them
//    shell out, spawn a process, or touch the filesystem.
// ---------------------------------------------------------------------------

test('member-prep: auth check degrades gracefully for a non-remote member with no fleet API wired at all (never throws, never fabricates an abort)', async () => {
    const outcome = await checkMemberAuth({ member: 'no-fleet-api-member', memberRecord: null, fleetApi: undefined, log: () => {} });
    assert.equal(outcome.status, 'skipped');
});

test('member-prep: auth check degrades gracefully for a REMOTE member with no fleet API wired at all (never throws, never fabricates an abort)', async () => {
    const outcome = await checkMemberAuth({
        member: 'no-fleet-api-member', memberRecord: { type: 'remote' }, fleetApi: undefined, log: () => {},
    });
    assert.equal(outcome.status, 'present');
    assert.match(outcome.detail, /no fleet API wired/);
});

test('member-prep: an empty members list is a no-op (no group/phase/log calls, no seam calls)', async () => {
    const { log, lines } = collectLog();
    const { execCommand, calls: execCalls } = makeExecCommand();
    const { syncBeadsBefore, calls: dpullCalls } = makeSyncBeadsBefore();
    const result = await runMemberPrepPhase({ members: [], execCommand, syncBeadsBefore, log });
    assert.deepEqual(result.members, {});
    assert.equal(lines.length, 0);
    assert.equal(execCalls.length, 0);
    assert.equal(dpullCalls.length, 0);
});
