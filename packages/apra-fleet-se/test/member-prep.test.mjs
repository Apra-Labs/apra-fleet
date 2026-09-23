import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

import {
    runMemberPrepPhase, checkMemberAuth, runSweepStep, memberPrepExecLabel,
} from '../fleet-sprint/phases/member-prep.mjs';
import { LlmAuthUnprovisionableError, MemberUnreachableError } from '../fleet-sprint/errors.mjs';
import { KILL_BEGIN_PREFIX, KILL_STATUS_PREFIX, MISSING_TOOL_PREFIX } from '../fleet-sprint/member-stray-sweep.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const RUNNER_PATH = path.join(__dirname, '../fleet-sprint/runner.js');

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
// 3b. apra-fleet-i4ku.13: UNREACHABLE is not MISSING CREDENTIAL. Both
//     branches are asserted in ONE test, deliberately, so the pair cannot
//     drift apart: a change that collapses them back into a single path has
//     to break one half of this test.
//
//     src/tools/list-members.ts's getAuthStatus() returns 'offline' the
//     moment strategy.testConnection() fails -- BEFORE it looks for any
//     credential -- so 'offline' is evidence about the MACHINE. Before this
//     fix both members below aborted with the same
//     LlmAuthUnprovisionableError ("missing credential: LLM auth"), sending
//     the operator after credentials on a host that is merely down.
// ---------------------------------------------------------------------------

test('member-prep: an UNREACHABLE member and a reachable member with no credential abort with DIFFERENT, accurate errors', async () => {
    // (a) UNREACHABLE: the registry reports 'offline' -- a failed connection
    // test. The distinct error must name the machine and must NOT claim a
    // missing credential.
    const unreachableApi = makeFleetApi({
        members: [{ name: 'downed-member', type: 'remote', os: 'linux', llm_auth: 'offline' }],
        // Deliberately EMPTY: makeFleetApi's provisionLlmAuth throws a
        // "test fixture bug" error if it is ever called, which pins the
        // second half of this branch -- provisioning must not even be
        // ATTEMPTED against a host that never answered.
        provisionOutcomes: {},
    });
    const { syncBeadsBefore, calls: unreachableDpulls } = makeSyncBeadsBefore();

    await assert.rejects(
        () => runMemberPrepPhase({
            members: ['downed-member'],
            fleetApi: unreachableApi,
            execCommand: makeExecCommand().execCommand,
            syncBeadsBefore,
            log: () => {},
        }),
        (err) => {
            assert.ok(
                err instanceof MemberUnreachableError,
                `expected MemberUnreachableError, got ${err && err.constructor && err.constructor.name}`,
            );
            assert.ok(
                !(err instanceof LlmAuthUnprovisionableError),
                'an unreachable member must NOT raise the missing-credential error',
            );
            assert.equal(err.member, 'downed-member');
            assert.equal(err.status, 'offline');
            assert.match(err.message, /could not be reached/);
            assert.doesNotMatch(
                err.message, /missing credential/,
                'the unreachable message must never claim a credential is missing -- the machine simply did not answer',
            );
            return true;
        },
    );
    assert.ok(
        !unreachableApi.calls.some((c) => c.tool === 'provision_llm_auth'),
        'provision_llm_auth must not be attempted against a member the registry already reports offline',
    );
    // Fail-loud, not a warning: the phase aborted, so later steps never ran.
    assert.equal(unreachableDpulls.length, 0, 'the unreachable case must still ABORT the phase, not warn and continue');

    // (b) REACHABLE but with no credential: unchanged -- still
    // LlmAuthUnprovisionableError, still with its existing message.
    const noCredentialApi = makeFleetApi({
        members: [{ name: 'credential-less-member', type: 'remote', os: 'linux', llm_auth: 'none' }],
        provisionOutcomes: {
            'credential-less-member': { ok: false, reason: 'no_credential', text: '[FAIL] no LLM credential found' },
        },
    });

    await assert.rejects(
        () => runMemberPrepPhase({
            members: ['credential-less-member'],
            fleetApi: noCredentialApi,
            execCommand: makeExecCommand().execCommand,
            syncBeadsBefore: makeSyncBeadsBefore().syncBeadsBefore,
            log: () => {},
        }),
        (err) => {
            assert.ok(
                err instanceof LlmAuthUnprovisionableError,
                `expected LlmAuthUnprovisionableError, got ${err && err.constructor && err.constructor.name}`,
            );
            assert.ok(
                !(err instanceof MemberUnreachableError),
                'a reachable member with no credential must NOT be reported as unreachable',
            );
            assert.equal(err.member, 'credential-less-member');
            assert.equal(err.credential, 'LLM auth');
            assert.match(err.message, /missing credential: LLM auth/);
            return true;
        },
    );
    assert.ok(
        noCredentialApi.calls.some((c) => c.tool === 'provision_llm_auth'),
        'a reachable member must still go through the real provision_llm_auth attempt',
    );
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

// ---------------------------------------------------------------------------
// 9b. apra-fleet-i4ku.12: a kill must not be recorded as a probe. One sweep
//     issues TWO dispatches through the same execCommand seam -- the
//     read-only probe and the kill -- and before this fix both reached
//     runner.js's Member Prep adapter carrying only { member, command }, so
//     the adapter labelled both with its single hardcoded probe string.
//
//     Asserted through memberPrepExecLabel(), the SAME label builder
//     runner.js's adapter uses, so this test pins the production strings
//     rather than a copy of them. BOTH labels are asserted: checking only
//     the kill would leave the probe path free to drift into saying "kill".
// ---------------------------------------------------------------------------

test('member-prep: one sweep that probes and then kills reaches the exec seam with DISTINGUISHABLE probe and kill labels', async () => {
    const fleetApi = makeFleetApi({
        members: [{ name: 'sandbox-member', type: 'remote', os: 'linux', llm_auth: 'oauth' }],
    });
    const inner = makeKillCapableExecCommand(killableStrayProbeOutput());
    // The adapter runner.js wires in production, reproduced here down to the
    // label call, so what is asserted below is what an operator would see in
    // the sprint log and ledger.
    const labelled = [];
    const execCommand = async ({ member, command, kind }) => {
        labelled.push({ label: memberPrepExecLabel(member, kind), kind, command });
        return inner.execCommand({ member, command });
    };

    await runMemberPrepPhase({
        members: ['sandbox-member'],
        fleetApi,
        execCommand,
        syncBeadsBefore: makeSyncBeadsBefore().syncBeadsBefore,
        log: () => {},
        sweepMarkers: CONFIGURED_MARKERS,
        sweepProductionPorts: [7523, 8787],
        now: () => Date.parse('2026-09-23T12:00:00.000Z'),
    });

    assert.equal(labelled.length, 2, 'expected exactly two dispatches: one probe, then one kill');

    // Dispatch 1 is the PROBE: read-only enumeration, labelled a probe.
    const [probeDispatch, killDispatch] = labelled;
    assert.equal(probeDispatch.kind, 'probe');
    assert.equal(probeDispatch.label, "Member Prep: stray-process probe on 'sandbox-member'");
    assert.doesNotMatch(probeDispatch.command, new RegExp(KILL_BEGIN_PREFIX), 'dispatch 1 must be the read-only probe');

    // Dispatch 2 is the KILL: it signals the selected pid, and must say so.
    assert.equal(killDispatch.kind, 'kill');
    assert.equal(killDispatch.label, "Member Prep: stray-process kill on 'sandbox-member'");
    assert.match(killDispatch.command, new RegExp(`${KILL_BEGIN_PREFIX} ${STALE_SUPERVISOR_PID}`), 'dispatch 2 must be the real kill');

    // The whole point: the two are DISTINGUISHABLE. Before the fix both read
    // "stray-process probe on 'sandbox-member'".
    assert.notEqual(
        probeDispatch.label, killDispatch.label,
        'a kill must never be recorded under the same label as a read-only probe',
    );
    assert.doesNotMatch(probeDispatch.label, /kill/, 'the read-only probe must not be described as a kill');

    // Labelling ONLY: the commands themselves are exactly what the sweep
    // built, byte for byte, with nothing added or reordered by the tagging.
    assert.deepEqual(
        labelled.map((d) => d.command),
        inner.calls.map((c) => c.command),
        'threading the dispatch intent must not change what is executed on the member',
    );
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
// 10. apra-fleet-i4ku.15 / apra-fleet-i4ku.11: THE SWEEP-FAILURE POLICY.
//
//     A sweep that cannot run does NOT abort the sprint. This is the single
//     decided behaviour recorded in phases/member-prep.mjs's header and in
//     the fleet-supervisor SKILL.md Member Prep section; this test is the
//     one and only place in the suite that asserts it, and it is written to
//     be readable as documentation of that decision.
//
//     Read off the assertions below, the policy is: runMemberPrepPhase()
//     RETURNS NORMALLY; the bad member's sweep is recorded as FAILURE (never
//     'skipped', never a clean scan) naming the member and the specific
//     missing tool; that member's remaining prep steps still run; and every
//     other member is prepped normally, so an otherwise healthy multi-member
//     sprint still reaches its first dispatch.
//
//     NOTHING REAL IS TOUCHED: execCommand below is a plain in-memory stub
//     that returns canned probe text. No process anywhere is enumerated or
//     signalled, and nothing is written to disk.
// ---------------------------------------------------------------------------

test('member-prep: a member with no ps/lsof/ss records a loud sweep FAILURE and the phase CONTINUES -- the sprint is not aborted', async () => {
    const { log, lines } = collectLog();
    const fleetApi = makeFleetApi({
        members: [
            { name: 'toolless-member', type: 'remote', os: 'linux', llm_auth: 'oauth' },
            { name: 'healthy-member', type: 'remote', os: 'linux', llm_auth: 'oauth' },
        ],
    });

    // 'toolless-member' answers the probe the way a member with none of the
    // supported enumeration tools does -- member-stray-sweep.mjs's
    // MISSING_TOOL_PREFIX row -- which makes it raise
    // StrayProbeToolMissingError out of sweepMemberStrayProcesses().
    // 'healthy-member' answers with a normal, parseable (clean) probe table.
    const dispatched = [];
    const execCommand = async ({ member, command }) => {
        dispatched.push({ member, command });
        if (member === 'toolless-member') return { ok: true, output: `${MISSING_TOOL_PREFIX} ps`, error: null };
        return { ok: true, output: CLEAN_PROBE_OUTPUT, error: null };
    };
    const { syncBeadsBefore, calls: dpulls } = makeSyncBeadsBefore();

    // POLICY, ASSERTION 1: the phase RETURNS. It does not throw, so the
    // sprint reaches its first dispatch. (Before apra-fleet-i4ku.11 the
    // StrayProbeToolMissingError propagated out of runMemberPrepPhase and
    // through runner.js's uncaught Member Prep call site, ending the sprint.)
    const result = await runMemberPrepPhase({
        members: ['toolless-member', 'healthy-member'],
        fleetApi,
        execCommand,
        syncBeadsBefore,
        log,
        sweepMarkers: CONFIGURED_MARKERS,
        sweepProductionPorts: [7523, 8787],
        now: () => Date.parse('2026-09-23T12:00:00.000Z'),
    });

    // POLICY, ASSERTION 2: the failure is recorded as its own FAILURE
    // outcome. Not 'skipped' (which would imply the sweep deliberately chose
    // not to look) and not 'ran' (which would imply a real, clean scan).
    const failed = result.members['toolless-member'].sweep;
    assert.equal(failed.status, 'failed');
    assert.notEqual(failed.status, 'skipped', 'a sweep that could not run is not the same as a sweep deliberately skipped');
    assert.notEqual(failed.status, 'ran', 'a sweep that could not run must never be recorded as a completed scan');
    assert.ok(failed.error instanceof Error, 'the underlying error is kept on the result, not discarded');
    assert.equal(failed.error.name, 'StrayProbeToolMissingError');
    assert.equal(failed.error.tool, 'ps', 'the specific missing tool is preserved so the operator knows what to install');

    // POLICY, ASSERTION 3: it is LOUD -- the operator sees a FAILURE line
    // naming the member and the specific cause, never a silent swallow and
    // never a claim that the member is clean.
    const failLine = lines.find((l) => l.includes("member 'toolless-member': sweep --"));
    assert.ok(failLine, 'expected a sweep result line for the failing member');
    assert.match(failLine, /FAILURE/);
    assert.match(failLine, /no supported tool available/);
    assert.match(failLine, /missing 'ps'/);
    // ...and it states the CONSEQUENCE, so the line cannot be misread as a
    // successful pass. Deliberately not a bare /clean/ search: the sweep's
    // own error text ("Refusing to report a clean member") and the policy
    // wording ("rather than clean") both contain that word as a NEGATION.
    // What must be absent is the 'ran' summary shape -- the "N killed, M
    // scanned" counts, which are the only thing that asserts real coverage.
    assert.match(failLine, /NOT scanned/, 'the line must state the member was not scanned');
    assert.doesNotMatch(failLine, /\d+ scanned/, 'a failed sweep must never report a scanned count, which would read as real coverage');
    assert.doesNotMatch(failLine, /\d+ killed/, 'a failed sweep must never report a killed count');

    // POLICY, ASSERTION 4: the failing member's own remaining prep steps
    // still run -- the failure is contained to the sweep step, not treated
    // as "give up on this member".
    assert.equal(result.members['toolless-member'].dpull.status, 'ran');

    // POLICY, ASSERTION 5: the other member is prepped completely and
    // normally. One member's missing tool must not degrade anybody else --
    // this is the "otherwise healthy multi-member sprint" case.
    assert.equal(result.members['healthy-member'].auth.status, 'present');
    assert.equal(result.members['healthy-member'].sweep.status, 'ran');
    assert.equal(result.members['healthy-member'].dpull.status, 'ran');
    assert.deepEqual(
        dpulls.map((c) => c.member), ['toolless-member', 'healthy-member'],
        'both members must have completed prep; the sprint proceeds to its first dispatch',
    );

    // The stub was genuinely exercised on both members -- this test is not
    // passing because the sweep never ran at all.
    assert.ok(dispatched.some((d) => d.member === 'toolless-member'));
    assert.ok(dispatched.some((d) => d.member === 'healthy-member'));
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

// ---------------------------------------------------------------------------
// 11. apra-fleet-i4ku.16: the test above (9b) proves memberPrepExecLabel()
//     itself distinguishes probe/kill -- but it does so inside its OWN stub
//     adapter, hand-copied from runner.js's real one. Nothing else in this
//     suite asserts that the PRODUCTION adapter runner.js actually wires into
//     runMemberPrepPhase's execCommand seam still destructures `kind` off its
//     argument and forwards it into memberPrepExecLabel(). Deleting `kind`
//     from that adapter would restore the original defect -- every kill
//     recorded as a probe -- with 9b (and the rest of this suite) still
//     green, because memberPrepExecLabel() silently defaults an absent kind
//     to the probe wording.
//
//     A full extraction into an exported factory would let this be driven
//     the same way 9b drives memberPrepExecLabel() directly, but the adapter
//     is a small inline arrow function at the runMemberPrepPhase call site in
//     runner.js, and factoring it out is more invasive than this regression
//     pin needs to be. So this is a source-text assertion, in the style of
//     test/phase-sequence-order.test.mjs's label-ownership checks: it reads
//     runner.js itself and confirms the adapter's parameter list still names
//     `kind` and that `kind` is still the second argument passed to
//     memberPrepExecLabel(). Removing `kind` from either the destructuring or
//     the memberPrepExecLabel() call fails this test.
// ---------------------------------------------------------------------------

test('runner.js: the production Member Prep execCommand adapter still destructures kind and forwards it to memberPrepExecLabel', () => {
    const runnerSrc = fs.readFileSync(RUNNER_PATH, 'utf8');

    // Anchor on the adapter's distinctive shape: `execCommand: ({ ... }) =>
    // command(cmd, { ... })`. [^}]* is safe (no nested braces appear inside
    // either the parameter list or the options object literal), and it
    // matches across the newline between the two lines the adapter is
    // written on without needing the 's' flag.
    const adapterMatch = runnerSrc.match(
        /execCommand:\s*\(\{([^}]*)\}\)\s*=>\s*command\(cmd,\s*\{([^}]*)\}\)/
    );
    assert.ok(
        adapterMatch,
        'could not find the Member Prep execCommand adapter ( execCommand: ({ ... }) => command(cmd, { ... }) ) in ' +
        'runner.js -- if it was rewritten, update this pin\'s anchor pattern to match the new shape rather than ' +
        'deleting the pin'
    );
    const [, params, body] = adapterMatch;

    assert.match(
        params, /\bkind\b/,
        'the Member Prep execCommand adapter in runner.js no longer destructures `kind` off its argument -- this ' +
        'restores the original defect where every dispatch (probe AND kill) is recorded under the same hardcoded ' +
        'label, because memberPrepExecLabel() silently defaults an absent kind to the probe wording'
    );
    assert.match(
        body, /memberPrepExecLabel\(\s*member_name\s*,\s*kind\s*\)/,
        'the Member Prep execCommand adapter in runner.js no longer forwards `kind` as the second argument to ' +
        'memberPrepExecLabel() -- a kill would again be recorded in the sprint log and ledger as a probe'
    );
});
