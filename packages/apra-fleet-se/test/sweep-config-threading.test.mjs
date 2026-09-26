import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';

import { buildSprintArgv } from '../src/supervisor/spawner.mjs';
import { loadSweepConfig } from '../src/supervisor/sweep-config.mjs';
import { resolveSweepConfig } from '../bin/cli.mjs';
import { runMemberPrepPhase } from '../fleet-sprint/phases/member-prep.mjs';
import { ACTION_KILL, LOCALITY_REMOTE, decideStrayProcess } from '../fleet-sprint/member-stray-sweep.mjs';

// =============================================================================
// apra-fleet-i4ku.14 -- proves the supervisor-to-cli-to-Member-Prep sweep
// config ROUND TRIP is closed end to end, not just that buildSprintArgv()
// emits a --sweep-config flag (that half is pinned separately in
// test/spawner.test.mjs's "supervisor sweep-config surface" describe block).
//
// This is a NEW, focused file rather than an addition to
// test/member-prep.test.mjs deliberately: that file is the shared fixture of
// a concurrently-run lane (member-prep-hardening, tasks .11/.12/.13/.15) and
// must not be touched here to avoid two doers colliding on it. Its own
// negative-case sibling, "an UNCONFIGURED target (--sweep-config omitted ->
// no sweepMarkers passed) reports the sweep step SKIPPED", already covers
// the no-config path; this file covers the configured, armed path by driving
// runMemberPrepPhase directly (same import, same shape of stubs), never by
// editing that file.
//
// Everything below is driven with hand-built in-memory stub seams -- no real
// sprint runs, no real process is started or killed, nothing is written to
// disk. The exec seam is a plain async function that records its calls; nothing
// here can act on a real developer-machine process.
// =============================================================================

const CLEAN_PROBE_OUTPUT = 'SWEEP-PROC 1 0 00:01 /sbin/init';

function makeExecCommand() {
    const calls = [];
    const execCommand = async (opts) => {
        calls.push(opts);
        return { ok: true, output: CLEAN_PROBE_OUTPUT, error: null };
    };
    return { execCommand, calls };
}

function makeFleetApi(members) {
    return {
        async listMembers() {
            return { content: [{ text: JSON.stringify({ members }) }] };
        },
        async provisionLlmAuth() {
            return { content: [{ text: '[OK] mock' }], structuredContent: { ok: true, reason: 'ok' } };
        },
    };
}

function makeSyncBeadsBefore() {
    return async () => ({ ok: true });
}

test('a sweep config round-tripped through buildSprintArgv() -> cli.mjs resolveSweepConfig() arms a real Member Prep sweep, not a skip', async () => {
    const supplied = {
        markers: [{ kind: 'env', token: 'FLEET_SANDBOX=1', evidence: 'flag' }],
        productionPorts: [8787],
    };

    // Step 1: the supervisor's own argv builder (spawner.mjs buildSprintArgv).
    const args = buildSprintArgv({
        issue: 'i', members: 'm', branch: 'b', base: 'main', viewerPort: 8080, sweepConfig: supplied,
    });

    // GUARD: this assertion (and the round trip below) is what fails if the
    // --sweep-config passthrough added in spawner.mjs's buildSprintArgv() is
    // ever reverted -- the flag would never reach argv, `flagIndex` would be
    // -1, `onTheWire` would be undefined, resolveSweepConfig(undefined)
    // resolves to undefined, and the Member Prep run below would fall back
    // to its default sweepMarkers: [] and report "skipped" instead of "ran".
    const flagIndex = args.indexOf('--sweep-config');
    assert.notEqual(flagIndex, -1, 'buildSprintArgv() must emit --sweep-config when a config is supplied');
    const onTheWire = args[flagIndex + 1];

    // Step 2: the REAL cli.mjs parser -- the other half of the round trip,
    // proving the supervisor and the CLI agree on the wire format.
    const resolved = await resolveSweepConfig(onTheWire);
    assert.deepEqual(resolved, supplied, 'what the supervisor serialized must be exactly what cli.mjs parsed back');

    // Step 3: feed the round-tripped config into a real Member Prep run and
    // prove it performs an actual sweep -- never
    // "sweep skipped: no fleet-start markers configured".
    const { execCommand, calls } = makeExecCommand();
    const result = await runMemberPrepPhase({
        members: ['remote-worker'],
        fleetApi: makeFleetApi([{ name: 'remote-worker', type: 'remote', os: 'linux', llm_auth: 'oauth' }]),
        execCommand,
        syncBeadsBefore: makeSyncBeadsBefore(),
        log: () => {},
        sweepMarkers: resolved.markers,
        sweepProductionPorts: resolved.productionPorts,
    });

    const sweep = result.members['remote-worker'].sweep;
    assert.equal(sweep.status, 'ran', `expected the sweep to actually run once the config survived the round trip, got ${JSON.stringify(sweep)}`);
    assert.ok(
        calls.length > 0,
        'a real probe (execCommand) must have been dispatched once markers survived the round trip -- an armed sweep that dispatches nothing is still effectively dormant',
    );
});

// AC4: a malformed --sweep-config must fail fast at the CLI boundary rather
// than silently resolving to "no markers" (which would disarm the sweep
// without anyone noticing).
test('a malformed --sweep-config fails fast at the CLI boundary rather than silently disarming the sweep', async () => {
    await assert.rejects(
        () => resolveSweepConfig('{ not json'),
        /must be valid JSON/,
    );
    await assert.rejects(
        () => resolveSweepConfig(JSON.stringify({ markers: [{ kind: 'k', token: 't', evidence: 'not-a-real-evidence-kind' }] })),
        /markers\[0\]/,
    );
    await assert.rejects(
        () => resolveSweepConfig(JSON.stringify({ markers: [], productionPorts: [99999] })),
        /productionPorts\[0\]/,
    );
});

// =============================================================================
// apra-fleet-i4ku.10 -- THE DATA'S OWN SAFETY MATRIX.
//
// The block above proves the config REACHES Member Prep. That is only half
// the task: arming the sweep for the first time makes apra-fleet's OWN
// marker/port set (.fleet/sweep-config.json) the thing that decides which
// real processes on a member are killable, so the data needs the same kind
// of adversarial pinning the engine predicates get in
// test/member-stray-sweep-safety-matrix.test.mjs.
//
// Everything below drives the REAL loader over the REAL repo file and feeds
// the result into the REAL decideStrayProcess() -- no copy of the marker
// list, no re-derivation of the rules. It asserts the two directions that
// matter: a HEALTHY fleet process is SPARED (not merely "a marker matched"),
// and the stale sandbox supervisor this feature exists for is still KILLED,
// so a safety fix can never be a silent disabling of the feature.
//
// Nothing here starts, probes or kills a process: decideStrayProcess() is a
// pure function over fabricated records.
// =============================================================================

/** The repo root this package lives in -- the sprint repo whose
 *  .fleet/sweep-config.json the supervisor loads in production. */
const REPO_ROOT = path.resolve(import.meta.dirname, '..', '..', '..');

/** apra-fleet's real, committed marker/port set, through the real loader
 *  (env deliberately empty so FLEET_SE_SWEEP_CONFIG in a developer's shell
 *  cannot swap the file under this test). */
function realConfig() {
    const config = loadSweepConfig({ repoRoot: REPO_ROOT, env: {}, logger: { log: () => {} } });
    assert.ok(config, `expected ${REPO_ROOT}/.fleet/sweep-config.json to exist and load`);
    return config;
}

/** "Now" for every decision below, and the ages judged against it. Both
 *  comfortably clear DEFAULT_MIN_AGE_MS so the minimum-age guard is never
 *  what a spared/killed assertion below is really testing. */
const NOW_MS = Date.parse('2026-09-23T12:00:00.000Z');
const SIX_HOURS_AGO = NOW_MS - (6 * 60 * 60 * 1000);
const TWENTY_FIVE_MIN_AGO = NOW_MS - (25 * 60 * 1000);

/** A remote-member decision against the real config. `caseInsensitive` is
 *  how the engine treats a Windows member's command line. */
function decideWithRealConfig(record, { caseInsensitive = false, productionPorts } = {}) {
    const config = realConfig();
    return decideStrayProcess({
        locality: LOCALITY_REMOTE,
        record,
        markers: config.markers,
        productionPorts: productionPorts ?? config.productionPorts,
        caseInsensitive,
        nowMs: NOW_MS,
    });
}

test('the real .fleet/sweep-config.json never declares the sprint engine as kill-grade evidence', () => {
    const { markers } = realConfig();
    const engineMarkers = markers.filter((m) => /bin[\\/]cli\.mjs/.test(m.token));
    assert.ok(engineMarkers.length > 0, 'expected the sprint engine to still be declared, as a labelling marker');
    for (const m of engineMarkers) {
        assert.equal(
            m.evidence, 'name',
            `marker '${m.token}' must stay evidence: "name". A live sprint child is spawned detached (ppid 1 the `
            + 'instant its supervisor restarts -- the readopt.mjs window) and listens only on an allocateFreePort() '
            + 'viewer port that no static productionPorts list can contain, so promoting it to path/flag evidence '
            + "lets one sprint's Member Prep kill another live sprint.",
        );
    }
});

test('SPARED: a healthy production supervisor on the default port is not killed by the real config', () => {
    const decision = decideWithRealConfig({
        pid: 5120,
        ppid: 1, // daemonized: "parent gone" is already true, as it is for every long-lived fleet process
        startedAtMs: SIX_HOURS_AGO,
        commandLine: '/usr/bin/node /home/fleet/apra-fleet/packages/apra-fleet-se/bin/serve.mjs',
        parentGone: true,
        listeningPorts: [8787],
        portsKnown: true,
    });
    assert.notEqual(decision.action, ACTION_KILL, `a healthy production supervisor must never be selected: ${JSON.stringify(decision)}`);
    assert.ok(
        decision.sparedReasons.some((r) => r.includes('8787')),
        `expected the production-port predicate to be the reason it was spared, got ${JSON.stringify(decision.sparedReasons)}`,
    );
});

test('SPARED: a LIVE, re-adoptable sprint child on an OS-assigned viewer port is not killed by the real config', () => {
    const decision = decideWithRealConfig({
        pid: 7788,
        ppid: 1, // its supervisor restarted -- exactly the re-adoption window, not a dead sprint
        startedAtMs: TWENTY_FIVE_MIN_AGO,
        commandLine: '/usr/bin/node /home/fleet/apra-fleet/packages/apra-fleet-se/bin/cli.mjs '
            + '--issue apra-fleet-demo --members worker-1 --branch feat/x --viewer-port 39114 --run-id r-123',
        parentGone: true,
        listeningPorts: [39114],
        portsKnown: true,
    });
    assert.notEqual(decision.action, ACTION_KILL, `a live sprint child must never be selected: ${JSON.stringify(decision)}`);
    assert.ok(
        decision.sparedReasons.some((r) => r.includes('process-name marker only')),
        'the sprint engine must be spared because its marker is name-only evidence -- the only protection available '
        + `to it, since its viewer port can never be in productionPorts. Got ${JSON.stringify(decision.sparedReasons)}`,
    );
});

test('SPARED: the same live sprint child reported by a WINDOWS member (backslashes, mixed case) is not killed either', () => {
    const decision = decideWithRealConfig({
        pid: 9001,
        ppid: 1,
        startedAtMs: TWENTY_FIVE_MIN_AGO,
        commandLine: '"C:\\Program Files\\nodejs\\node.exe" '
            + 'C:\\Users\\Fleet\\Apra-Fleet\\packages\\Apra-Fleet-SE\\bin\\cli.mjs --issue apra-fleet-demo --viewer-port 51221',
        parentGone: true,
        listeningPorts: [51221],
        portsKnown: true,
    }, { caseInsensitive: true });
    assert.notEqual(decision.action, ACTION_KILL, `a live sprint child on Windows must never be selected: ${JSON.stringify(decision)}`);
});

test('SPARED: the singleton fleet MCP server on its production port is not killed by the real config', () => {
    const decision = decideWithRealConfig({
        pid: 4310,
        ppid: 1,
        startedAtMs: SIX_HOURS_AGO,
        commandLine: '/usr/bin/node /home/fleet/apra-fleet/dist/index.js',
        parentGone: true,
        listeningPorts: [7523],
        portsKnown: true,
    });
    assert.notEqual(decision.action, ACTION_KILL, `the fleet MCP server must never be selected: ${JSON.stringify(decision)}`);
});

/** The case this whole feature exists for (apra-fleet-9be4): a sandbox
 *  supervisor left running on a remote member after its run ended. It holds
 *  an OS-assigned port (scripts/sandbox-deploy.mjs), so productionPorts does
 *  not cover it, and it is hours old with a dead parent. */
function staleSandboxSupervisor(overrides = {}) {
    return {
        pid: 6642,
        ppid: 1,
        startedAtMs: SIX_HOURS_AGO,
        commandLine: '/usr/bin/node /home/fleet/apra-fleet/packages/apra-fleet-se/bin/serve.mjs --port 41377',
        parentGone: true,
        listeningPorts: [41377],
        portsKnown: true,
        ...overrides,
    };
}

test('CONTROL -- KILLED: the stale sandbox supervisor this sweep exists for is still selected by the real config', () => {
    const decision = decideWithRealConfig(staleSandboxSupervisor());
    assert.equal(
        decision.action, ACTION_KILL,
        'the spared cases above prove nothing if the real config can no longer select anything: '
        + `${JSON.stringify(decision)}`,
    );
    assert.match(decision.selectionReason, /fleet-supervisor via path marker/);
});

test('the documented remedy works: adding a non-default supervisor port to productionPorts spares that supervisor', () => {
    // The accepted, DOCUMENTED consequence of keeping bin/serve.mjs as path
    // evidence (.fleet/sweep-config.json "_readme_supervisor", and trap 3 in
    // docs/fleet-sprint-getting-started.md section 2.6): a supervisor on a
    // member that is NOT on one of the enumerated production ports is
    // selectable -- which is what makes the control above work, since a
    // sandbox supervisor is exactly that shape. This test pins the remedy an
    // operator who deliberately runs a second long-lived supervisor on a
    // member is told to use, so the doc's instruction is executable, not a
    // hope.
    const config = realConfig();
    const record = staleSandboxSupervisor({ pid: 6643, listeningPorts: [8788], commandLine: '/usr/bin/node /home/fleet/apra-fleet/packages/apra-fleet-se/bin/serve.mjs --port 8788' });

    const withoutRemedy = decideWithRealConfig(record);
    assert.equal(withoutRemedy.action, ACTION_KILL, 'precondition: an unenumerated port leaves this supervisor selectable');

    const withRemedy = decideWithRealConfig(record, { productionPorts: [...config.productionPorts, 8788] });
    assert.notEqual(withRemedy.action, ACTION_KILL, `declaring the port must spare it: ${JSON.stringify(withRemedy)}`);
    assert.ok(withRemedy.sparedReasons.some((r) => r.includes('8788')));
});
