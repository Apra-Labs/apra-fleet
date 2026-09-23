import { test } from 'node:test';
import assert from 'node:assert/strict';

import { buildSprintArgv } from '../src/supervisor/spawner.mjs';
import { resolveSweepConfig } from '../bin/cli.mjs';
import { runMemberPrepPhase } from '../fleet-sprint/phases/member-prep.mjs';

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
