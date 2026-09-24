import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { loadSweepConfig } from '../src/supervisor/sweep-config.mjs';
import { buildSprintArgv } from '../src/supervisor/spawner.mjs';
import { resolveSweepConfig, buildRunnerArgs } from '../bin/cli.mjs';
import { validateArgs } from '../fleet-sprint/sprint-args.mjs';
import { runMemberPrepPhase, formatSweepLivenessSummary } from '../fleet-sprint/phases/member-prep.mjs';
import {
    HEALTH_LINE_PREFIX, KILL_BEGIN_PREFIX, KILL_STATUS_PREFIX, MISSING_TOOL_PREFIX,
} from '../fleet-sprint/member-stray-sweep.mjs';

// =============================================================================
// apra-fleet-i4ku.18 -- the liveness predicate is ARMED on the real Member
// Prep path, not merely implemented in the module.
//
// WHAT THIS FILE DOES NOT DO: it does not restate the module-level liveness
// assertions. test/member-stray-sweep-safety-matrix.test.mjs owns those -- it
// drives sweepMemberStrayProcesses() with livenessProbe set BY HAND and pins
// what the predicate decides. That proves the predicate works; it can never
// prove anything turns it on. This file owns the arming half: that a sweep
// config's liveness option survives every link from the supervisor's loader
// to sweepMemberStrayProcesses() with its VALUES intact, that an unstated
// option is armed (the decided default -- see the "LIVENESS PROBE: ARMED BY
// DEFAULT -- DECIDED" header section of fleet-sprint/phases/member-prep.mjs
// and docs/member-prep-and-stray-sweep.md), and that an operator can tell
// "not armed" from "armed and nothing was live".
//
// NO REAL PROCESS IS TOUCHED. Every dispatch goes through a hand-built
// in-memory exec seam that records the command string and answers with
// fabricated probe output; nothing is spawned, probed, signalled or written
// to disk. The one file read is this repo's own committed runner.js, read
// as text.
// =============================================================================

const RUNNER_PATH = path.join(import.meta.dirname, '..', 'fleet-sprint', 'runner.js');

/** A path marker, so both fixture processes below are kill-grade evidence and
 *  the liveness predicate is the only thing that can separate them. */
const MARKERS = [{ kind: 'fleet-supervisor', token: 'apra-fleet-se/bin/serve.mjs', evidence: 'path' }];
const PRODUCTION_PORTS = [7523, 8787];

/** The stale sandbox supervisor this whole sweep exists to clear: hours old,
 *  daemonized, on an OS-assigned port no productionPorts list could name. */
const STALE_PID = 6642;
const STALE_PORT = 41377;
/** A supervisor deliberately started on a NON-DEFAULT port and still serving.
 *  Structurally identical to the stale one -- same marker, same ppid 1, same
 *  age, an unlisted port -- so the ONLY thing that can spare it is that it
 *  still answers HTTP. That is the hole this predicate closes. */
const LIVE_PID = 5120;
const LIVE_PORT = 18999;

/** Both processes in ONE probe table, so every assertion below is about a
 *  single sweep pass that must treat them differently. */
function twoCandidateProbeOutput() {
    return [
        `SWEEP-PROC  ${STALE_PID}  1 1-02:03:04 /usr/bin/node /home/fleet/apra-fleet/packages/apra-fleet-se/bin/serve.mjs --port ${STALE_PORT}`,
        `SWEEP-PROC  ${LIVE_PID}  1 1-02:03:04 /usr/bin/node /home/fleet/apra-fleet/packages/apra-fleet-se/bin/serve.mjs --port ${LIVE_PORT}`,
        `SWEEP-PORT-SS LISTEN 0 4096 0.0.0.0:${STALE_PORT} 0.0.0.0:* users:(("node",pid=${STALE_PID},fd=20))`,
        `SWEEP-PORT-SS LISTEN 0 4096 0.0.0.0:${LIVE_PORT} 0.0.0.0:* users:(("node",pid=${LIVE_PID},fd=21))`,
    ].join('\n');
}

/** A probe table with NO candidate that can survive the other predicates (the
 *  probe process itself, too young, no marker match), used for the
 *  "armed but never dispatched" state. */
const NO_CANDIDATE_PROBE_OUTPUT = 'SWEEP-PROC 1 0 00:01 /sbin/init';

/** A stray that survives every OTHER predicate but holds NO listening port,
 *  so the liveness predicate has nothing it can ask about it. */
const PORTLESS_PID = 7001;
const PORTLESS_PROC_LINE = `SWEEP-PROC  ${PORTLESS_PID}  1 1-02:03:04 /usr/bin/node `
    + '/home/fleet/apra-fleet/packages/apra-fleet-se/bin/serve.mjs --stdio';
/** One attributed port row owned by a NON-candidate, present only so port
 *  attribution is observable at all (`portsKnown`); without any attributed
 *  row the sweep reports and kills nothing for an unrelated reason and these
 *  fixtures would prove nothing about the liveness predicate. */
const UNRELATED_PORT_ROW = 'SWEEP-PORT-SS LISTEN 0 4096 0.0.0.0:22 0.0.0.0:* users:(("init",pid=1,fd=3))';

/** The portless stray ALONE in the pass. */
function portlessAloneProbeOutput() {
    return [PORTLESS_PROC_LINE, 'SWEEP-PROC  1  0 9-00:00:00 /sbin/init', UNRELATED_PORT_ROW].join('\n');
}

/** A stray that survives every other predicate and DOES hold a listening
 *  port -- but bound to a HOSTNAME, which livenessProbeHost() cannot turn
 *  into a URL. There is a socket to ask, so this is not `unprobeable`; the
 *  question cannot be phrased, so it is the fail-safe `unevaluable` spare.
 *  Alone in a pass it is the only shape that reaches
 *  armed && !dispatched && unevaluable > 0. */
const UNASKABLE_PID = 7100;
const UNASKABLE_PORT = 9600;
const UNASKABLE_PROC_LINE = `SWEEP-PROC  ${UNASKABLE_PID}  1 1-02:03:04 /usr/bin/node `
    + `/home/fleet/apra-fleet/packages/apra-fleet-se/bin/serve.mjs --port ${UNASKABLE_PORT}`;
const UNASKABLE_PORT_ROW = `SWEEP-PORT-SS LISTEN 0 4096 db.internal:${UNASKABLE_PORT} 0.0.0.0:* `
    + `users:(("node",pid=${UNASKABLE_PID},fd=22))`;

/** The unaskable stray ALONE, so no probeable candidate exists in the pass
 *  and no liveness dispatch can be built at all. */
function unaskableAloneProbeOutput() {
    return [
        UNASKABLE_PROC_LINE, 'SWEEP-PROC  1  0 9-00:00:00 /sbin/init', UNASKABLE_PORT_ROW, UNRELATED_PORT_ROW,
    ].join('\n');
}

/** Both undispatchable shapes in ONE pass -- an unaskable spare and a
 *  portless unchecked kill, still with no dispatch. */
function unaskableWithPortlessProbeOutput() {
    return [
        UNASKABLE_PROC_LINE, PORTLESS_PROC_LINE, 'SWEEP-PROC  1  0 9-00:00:00 /sbin/init',
        UNASKABLE_PORT_ROW, UNRELATED_PORT_ROW,
    ].join('\n');
}

/** The SAME portless stray, plus one unrelated live sibling that DOES hold a
 *  port -- the only difference between this pass and the one above. */
function portlessWithPortedSiblingProbeOutput() {
    return [
        PORTLESS_PROC_LINE,
        `SWEEP-PROC  ${LIVE_PID}  1 1-02:03:04 /usr/bin/node /home/fleet/apra-fleet/packages/apra-fleet-se/bin/serve.mjs --port ${LIVE_PORT}`,
        'SWEEP-PROC  1  0 9-00:00:00 /sbin/init',
        `SWEEP-PORT-SS LISTEN 0 4096 0.0.0.0:${LIVE_PORT} 0.0.0.0:* users:(("node",pid=${LIVE_PID},fd=21))`,
        UNRELATED_PORT_ROW,
    ].join('\n');
}

/**
 * The exec seam. Discriminates the THREE dispatch shapes, in this order:
 * kill first, then liveness, then the process probe. The order matters --
 * the liveness command carries probe-like text of its own, and a naive
 * "is this a probe?" check would swallow the kill.
 *
 * `health` is the liveness answer: 'live' (the live supervisor answers 200,
 * the stale one's port REFUSES the connection -- curl's 000 sentinel with
 * exit status 7), 'dead' (nothing answers), 'notool' (the member has no
 * curl at all), or 'tcpalive' (apra-fleet-i4ku.24.5: the live supervisor's
 * port ACCEPTS the TCP connection but returns no HTTP response -- curl's 000
 * sentinel with exit status 0, DISTINCT from the stale port's 000/7 refusal;
 * this is the tcp-alive-no-http outcome, not a plain refusal).
 */
function makeSeam({ probeOutput = twoCandidateProbeOutput(), health = 'live' } = {}) {
    const dispatches = [];
    const execCommand = async ({ member, command, kind }) => {
        dispatches.push({ member, command, kind });
        if (command.includes(KILL_BEGIN_PREFIX)) {
            const pids = [...command.matchAll(new RegExp(`${KILL_BEGIN_PREFIX} (\\d+)`, 'g'))].map((m) => Number(m[1]));
            const lines = pids.flatMap((pid) => [`${KILL_BEGIN_PREFIX} ${pid}`, `${KILL_STATUS_PREFIX} ${pid} 0`]);
            return { ok: true, output: lines.join('\n'), error: null };
        }
        if (command.includes(HEALTH_LINE_PREFIX)) {
            if (health === 'notool') return { ok: true, output: `${MISSING_TOOL_PREFIX} curl`, error: null };
            const asked = [...command.matchAll(new RegExp(`${HEALTH_LINE_PREFIX} (\\d+) (\\d+)`, 'g'))];
            return {
                ok: true,
                output: asked
                    .map(([, pid, port]) => `${HEALTH_LINE_PREFIX} ${pid} ${port} `
                        // The fourth field is the TRANSPORT status: a stale
                        // candidate's port is REFUSED (curl 7 -- the only
                        // outcome that means nothing is there), a live one
                        // answered over a healthy transport (0). 'tcpalive'
                        // gives the live pid the SAME transport status (0,
                        // connection accepted) but the '000' no-HTTP-response
                        // code, which is exactly the tcp-alive-no-http shape
                        // -- distinguishable from the stale port's refusal
                        // (000/7) only by that transport status.
                        + (health === 'live' && Number(pid) === LIVE_PID ? '200 0'
                            : health === 'tcpalive' && Number(pid) === LIVE_PID ? '000 0'
                                : '000 7'))
                    .join('\n'),
                error: null,
            };
        }
        return { ok: true, output: probeOutput, error: null };
    };
    return { execCommand, dispatches, liveness: () => dispatches.filter((d) => d.command.includes(HEALTH_LINE_PREFIX)) };
}

function makeFleetApi() {
    return {
        async listMembers() {
            return {
                content: [{
                    text: JSON.stringify({
                        members: [{ name: 'remote-worker', type: 'remote', os: 'linux', llm_auth: 'oauth' }],
                    }),
                }],
            };
        },
        async provisionLlmAuth() {
            return { content: [{ text: '[OK] mock' }], structuredContent: { ok: true, reason: 'ok' } };
        },
    };
}

/**
 * THE WHOLE CHAIN, driven for real, with nothing hand-carried past a link:
 *   .fleet/sweep-config.json content
 *     -> loadSweepConfig()        (supervisor-side parse + validate)
 *     -> buildSprintArgv()        (--sweep-config on the wire)
 *     -> resolveSweepConfig()     (the CLI parses it back)
 *     -> buildRunnerArgs()        (the sprint-args key)
 *     -> validateArgs()           (the runner's arg contract)
 *     -> runMemberPrepPhase()     (which calls runSweepStep)
 *
 * The config is fed through FLEET_SE_SWEEP_CONFIG as INLINE JSON rather than
 * a temp file, so this test writes nothing to disk anywhere (criterion 7).
 */
async function runWholeChain(configObject, seamOpts = {}) {
    const loaded = loadSweepConfig({
        repoRoot: '/nonexistent-repo-root',
        env: { FLEET_SE_SWEEP_CONFIG: JSON.stringify(configObject) },
        logger: { log: () => {} },
    });
    const argv = buildSprintArgv({
        issue: 'i', members: 'm', branch: 'b', base: 'main', viewerPort: 8080, sweepConfig: loaded,
    });
    const flagIndex = argv.indexOf('--sweep-config');
    assert.notEqual(flagIndex, -1, 'buildSprintArgv() must emit --sweep-config when a config is supplied');
    const resolved = await resolveSweepConfig(argv[flagIndex + 1]);
    const runnerArgs = buildRunnerArgs({
        targetIssues: ['apra-fleet-demo'],
        members: ['remote-worker'],
        branch: 'b',
        baseBranch: 'main',
        goal: 'P1',
        maxCycles: 1,
        sweepMarkers: resolved.markers,
        sweepProductionPorts: resolved.productionPorts,
        sweepLivenessProbe: resolved.livenessProbe,
    });
    const validated = validateArgs(runnerArgs);

    // A caller may hand in its OWN seam (rather than options for one) when it
    // needs to inspect the seam after the chain has THROWN -- see the
    // malformed-option test, whose whole point is that nothing was dispatched.
    const seam = seamOpts.seam ?? makeSeam(seamOpts);
    const lines = [];
    const phase = await runMemberPrepPhase({
        members: validated.members,
        fleetApi: makeFleetApi(),
        execCommand: seam.execCommand,
        syncBeadsBefore: async () => ({ ok: true }),
        log: (l) => lines.push(l),
        sweepMarkers: validated.sweepMarkers || [],
        sweepProductionPorts: validated.sweepProductionPorts || [],
        // Forwarded exactly as runner.js's Member Prep call site forwards it:
        // no default of its own, so `undefined` still means "unstated".
        sweepLivenessProbe: validated.sweepLivenessProbe,
        now: () => Date.parse('2026-09-23T12:00:00.000Z'),
    });

    const sweep = phase.members['remote-worker'].sweep;
    return {
        loaded,
        onTheWire: argv[flagIndex + 1],
        resolved,
        runnerArgs,
        validated,
        seam,
        sweep,
        sweepLines: lines.filter((l) => l.includes("member 'remote-worker': sweep --")),
    };
}

// ---------------------------------------------------------------------------
// Criterion 1: the round trip is closed ON VALUES, not on a flag being
// present. GUARD FOR THE WHOLE CHAIN: reverting the liveness threading at
// ANY single link (sweep-config.mjs's validate, cli.mjs's
// resolveSweepConfig, buildRunnerArgs' sweep_liveness_probe key,
// sprint-args' validateArgs, or runSweepStep's forward into
// sweepMemberStrayProcesses) drops the option somewhere along here, and the
// non-default path/timeout below stops appearing in the dispatched command.
// ---------------------------------------------------------------------------

test('GUARD (every link): a liveness option survives loader -> argv -> CLI -> arg contract -> runSweepStep with its VALUES intact', async () => {
    // Deliberately NON-DEFAULT on both fields: the module's own defaults are
    // '/' and 2000ms, so a link that dropped the option and let the defaults
    // apply would still produce a liveness dispatch and still look armed.
    // Only the values prove the option itself arrived.
    const chain = await runWholeChain({
        markers: MARKERS,
        productionPorts: PRODUCTION_PORTS,
        livenessProbe: { path: '/healthz', timeoutMs: 5000 },
    });

    assert.deepEqual(chain.loaded.livenessProbe, { path: '/healthz', timeoutMs: 5000 }, 'link 1: the supervisor loader dropped or mangled the option');
    assert.deepEqual(JSON.parse(chain.onTheWire).livenessProbe, { path: '/healthz', timeoutMs: 5000 }, 'link 2: buildSprintArgv() did not serialize the option onto the wire');
    assert.deepEqual(chain.resolved.livenessProbe, { path: '/healthz', timeoutMs: 5000 }, 'link 3: cli.mjs resolveSweepConfig() dropped the option');
    assert.deepEqual(chain.runnerArgs.sweep_liveness_probe, { path: '/healthz', timeoutMs: 5000 }, 'link 4: buildRunnerArgs() did not forward the option as a sprint-args key');
    assert.deepEqual(chain.validated.sweepLivenessProbe, { path: '/healthz', timeoutMs: 5000 }, 'link 5: sprint-args validateArgs() dropped the option');

    // Link 6 -- the one no intermediate object can prove: the values reached
    // the actual dispatch. Asserted on what was sent to the member, which is
    // the only evidence that runSweepStep() forwarded the option into
    // sweepMemberStrayProcesses() rather than merely receiving it.
    const [liveness] = chain.seam.liveness();
    assert.ok(liveness, 'link 6: runSweepStep() never issued a liveness dispatch, so the option never reached the sweep');
    assert.match(liveness.command, new RegExp(`http://127\\.0\\.0\\.1:${LIVE_PORT}/healthz`), 'the configured path must be the path actually requested');
    assert.match(liveness.command, /--max-time 5\b/, 'the configured timeout must be the timeout actually used (5000ms -> 5s), not the module default');
});

// ---------------------------------------------------------------------------
// Criterion 2: armed, through the phase, on a fixture holding BOTH shapes.
// ---------------------------------------------------------------------------

test('ARMED: a candidate answering HTTP on a port it holds is SPARED with a recorded reason, while the stale sandbox in the SAME pass is still killed', async () => {
    const chain = await runWholeChain({ markers: MARKERS, productionPorts: PRODUCTION_PORTS, livenessProbe: true });

    assert.equal(chain.sweep.status, 'ran');
    assert.equal(chain.seam.liveness().length, 1, 'an armed sweep must issue the second (liveness) dispatch');

    // The live supervisor on an unlisted port: SPARED, and the log says why.
    const sparedLive = chain.sweep.result.reported.find((d) => d.pid === LIVE_PID);
    assert.ok(sparedLive, `the live supervisor must be reported, not killed: ${JSON.stringify(chain.sweep.result.killed)}`);
    assert.ok(
        sparedLive.sparedReasons.some((r) => r.includes('responded to a liveness probe')),
        `the spare must be recorded as a liveness spare, not left unexplained: ${JSON.stringify(sparedLive.sparedReasons)}`,
    );

    // TURNING THE PREDICATE ON MUST NOT DISABLE THE SWEEP. Without this
    // assertion, "spare everything" would pass the test above.
    assert.deepEqual(
        chain.sweep.result.killed.map((k) => k.pid), [STALE_PID],
        'the stale sandbox supervisor in the same pass must still be killed -- an armed sweep that kills nothing is a disabled sweep',
    );
});

// ---------------------------------------------------------------------------
// Criterion 3: the three states must be DISTINGUISHABLE, not merely quiet.
// The decided default is ARMED (member-prep.mjs's header), so "the option is
// absent" is asserted to ARM, and only an explicit `false` disarms.
// ---------------------------------------------------------------------------

test('DEFAULT: a config that never mentions livenessProbe is ARMED -- the decided default, not silence', async () => {
    const chain = await runWholeChain({ markers: MARKERS, productionPorts: PRODUCTION_PORTS });

    assert.equal(chain.validated.sweepLivenessProbe, undefined, 'an unstated option must stay unstated through the chain, never coerced');
    assert.equal(chain.seam.liveness().length, 1, 'an unstated option must still arm the predicate -- that is the decided default');
    assert.equal(chain.sweep.result.liveness.armed, true);
    assert.deepEqual(chain.sweep.result.killed.map((k) => k.pid), [STALE_PID]);
    assert.ok(chain.sweep.result.reported.some((d) => d.pid === LIVE_PID), 'the live supervisor must be spared by default, without the target having to ask');
});

test('NOT ARMED is distinguishable: livenessProbe:false issues no liveness dispatch AND says so in the result and the summary line', async () => {
    const disarmed = await runWholeChain({
        markers: MARKERS, productionPorts: PRODUCTION_PORTS, livenessProbe: false,
    });

    assert.equal(disarmed.validated.sweepLivenessProbe, false, 'an explicit false must survive the chain as false, distinct from absent');
    assert.equal(disarmed.seam.liveness().length, 0, 'a disarmed sweep must dispatch no liveness probe at all');
    assert.deepEqual(disarmed.sweep.result.liveness, {
        armed: false, dispatched: false, checked: 0, spared: 0, unevaluable: 0, tcpAliveNoHttp: 0, unprobeable: 0,
    });
    assert.equal(disarmed.sweepLines.length, 1);
    assert.match(disarmed.sweepLines[0], /liveness probe NOT ARMED/);

    // THE POINT: with the predicate off, the live supervisor is killed too --
    // which is exactly why "not armed" must never read like a clean armed
    // pass. Both candidates die here; nothing warned anyone in the old,
    // unarmed world.
    assert.deepEqual(
        disarmed.sweep.result.killed.map((k) => k.pid).sort((a, b) => a - b), [LIVE_PID, STALE_PID],
        'precondition for this whole feature: with the predicate off, a LIVE supervisor on an unlisted port is killed',
    );

    // ... and an ARMED pass that spared nothing must not look the same. Same
    // fixture, same phase, liveness on, but nothing is answering.
    const armedFoundNothing = await runWholeChain(
        { markers: MARKERS, productionPorts: PRODUCTION_PORTS, livenessProbe: true },
        { health: 'dead' },
    );
    assert.equal(armedFoundNothing.seam.liveness().length, 1);
    assert.equal(armedFoundNothing.sweep.result.liveness.armed, true);
    assert.equal(armedFoundNothing.sweep.result.liveness.spared, 0);
    assert.match(armedFoundNothing.sweepLines[0], /liveness probe armed and dispatched: 2 candidate\(s\) checked, 0 spared as live/);
    assert.notEqual(
        armedFoundNothing.sweepLines[0].replace(/^.*sweep -- /, ''),
        disarmed.sweepLines[0].replace(/^.*sweep -- /, ''),
        'an armed pass that spared nothing must not render identically to a pass where the predicate never ran',
    );

    // The third state: armed, but no candidate ever reached the predicate.
    // It must not read as "armed and found nothing live" either.
    const nothingToCheck = await runWholeChain(
        { markers: MARKERS, productionPorts: PRODUCTION_PORTS, livenessProbe: true },
        { probeOutput: NO_CANDIDATE_PROBE_OUTPUT },
    );
    assert.equal(nothingToCheck.seam.liveness().length, 0);
    assert.match(nothingToCheck.sweepLines[0], /liveness probe armed but not dispatched/);
});

test('the LOUD losing case: a member with no probe tool spares everything unchecked and says so on its own line', async () => {
    // This is the documented cost of arming by default (member-prep.mjs's
    // header): an unevaluable probe spares, so on a member without curl the
    // stale sandbox this feature exists for survives. Fail-safe, but it must
    // never be silent -- an operator seeing "0 killed" and nothing else would
    // read it as a clean member.
    const chain = await runWholeChain(
        { markers: MARKERS, productionPorts: PRODUCTION_PORTS, livenessProbe: true },
        { health: 'notool' },
    );

    assert.deepEqual(chain.sweep.result.killed, [], 'an unevaluable probe must SPARE -- never fall back to killing');
    assert.equal(chain.sweep.result.liveness.unevaluable, 2);
    const loud = chain.sweepLines.find((l) => l.includes('LIVENESS UNEVALUABLE'));
    assert.ok(loud, `expected a dedicated loud line, got: ${JSON.stringify(chain.sweepLines)}`);
    assert.match(loud, /SPARED rather than killed/);
    assert.match(loud, /livenessProbe/, 'the loud line must name the way out, or it is an advisory the reader cannot act on');
});

// ---------------------------------------------------------------------------
// apra-fleet-i4ku.24.5: a candidate the probe DID reach -- its port ACCEPTED
// the TCP connection, it just answered no HTTP -- must narrate distinctly
// from BOTH the "checked and found dead" shape and the plain `unevaluable`
// shape above (no tool / no dispatch / unaskable address). Before this task,
// member-prep.mjs had no clause and no per-member line for this bucket at
// all, so such a spare was invisible in the phase summary and in the
// per-member notices, even though member-stray-sweep.mjs already counted it
// in its own `tcpAliveNoHttp` field (apra-fleet-i4ku.24.1.2).
// ---------------------------------------------------------------------------

test('TCP-ALIVE-NO-HTTP: a live non-HTTP listener is spared, counted in its own bucket, and narrated on its own summary clause and per-member line', async () => {
    const chain = await runWholeChain(
        { markers: MARKERS, productionPorts: PRODUCTION_PORTS, livenessProbe: true },
        { health: 'tcpalive' },
    );

    // The stale sandbox (genuinely refused) is still killed -- this fix must
    // not weaken the predicate where it already worked.
    assert.deepEqual(chain.sweep.result.killed.map((k) => k.pid), [STALE_PID]);

    // The live-but-non-HTTP listener is SPARED, never killed, and its reason
    // is the dedicated tcp-alive-no-http blocker text, not the generic
    // unevaluable one.
    const spared = chain.sweep.result.reported.find((d) => d.pid === LIVE_PID);
    assert.ok(spared, `the tcp-alive-no-http candidate must be reported, not killed: ${JSON.stringify(chain.sweep.result.killed)}`);
    assert.ok(
        spared.sparedReasons.some((r) => r.includes('still accepting TCP connections') && r.includes('no asked socket returned an HTTP response')),
        `expected the dedicated tcp-alive-no-http blocker text, got: ${JSON.stringify(spared.sparedReasons)}`,
    );

    // Counted in its OWN bucket -- never folded into `unevaluable`, and still
    // folded into `checked` because a probe genuinely reached it.
    assert.equal(chain.sweep.result.liveness.tcpAliveNoHttp, 1);
    assert.equal(chain.sweep.result.liveness.unevaluable, 0, 'a definite tcp-alive-no-http answer is not the same as "could not evaluate"');
    assert.equal(chain.sweep.result.liveness.checked, 2, 'a probe that got a definite answer (even non-HTTP) still counts as checked');

    // The phase summary line names the new outcome, worded as a spare rather
    // than a confirmed-dead verdict.
    assert.match(
        chain.sweepLines[0],
        /liveness probe armed and dispatched: 2 candidate\(s\) checked, 0 spared as live, 0 unevaluable; a further 1 candidate\(s\) held a live TCP connection that answered no HTTP and were SPARED rather than confirmed dead/,
    );

    // A DEDICATED per-member notice line, distinct from LIVENESS UNEVALUABLE
    // and LIVENESS UNPROBEABLE -- this is the line member-prep.mjs did not
    // emit before this task.
    assert.ok(
        !chain.sweepLines.some((l) => l.includes('LIVENESS UNEVALUABLE')),
        'a definite tcp-alive-no-http answer must never also print the generic unevaluable notice',
    );
    assert.ok(
        !chain.sweepLines.some((l) => l.includes('LIVENESS UNPROBEABLE')),
        'the tcp-alive-no-http candidate held a port and was asked -- it is not the portless-unchecked case',
    );
    const loud = chain.sweepLines.find((l) => l.includes('LIVENESS TCP-ALIVE-NO-HTTP'));
    assert.ok(loud, `expected a dedicated per-member loud line, got: ${JSON.stringify(chain.sweepLines)}`);
    assert.match(loud, /1 candidate\(s\) were SPARED rather than killed/);
    assert.match(loud, /ACCEPTED the TCP connection but returned no HTTP response/);
    assert.match(loud, /speaks HTTP only/, 'the loud line must name why this predicate cannot confirm the listener alive');
});

// ---------------------------------------------------------------------------
// apra-fleet-i4ku.24.2.3: formatSweepLivenessSummary() wording, driven
// directly on hand-built liveness records rather than through the whole
// chain above -- these pin the RENDERING contract itself, independent of
// whatever shape member-stray-sweep.mjs happens to produce today.
// ---------------------------------------------------------------------------

test('formatSweepLivenessSummary(): armed+dispatched with a tcpAliveNoHttp count names it and says SPARED, never checked-and-dead', () => {
    const line = formatSweepLivenessSummary({
        armed: true, dispatched: true, checked: 3, spared: 0, unevaluable: 0, tcpAliveNoHttp: 2, unprobeable: 0,
    });
    assert.match(
        line,
        /a further 2 candidate\(s\) held a live TCP connection that answered no HTTP and were SPARED rather than confirmed dead/,
        'the dispatched branch must name the tcp-alive-no-http count and say SPARED',
    );
    assert.doesNotMatch(line, /checked-and-dead/, 'the clause must never read as a confirmed-dead verdict');
    assert.doesNotMatch(
        line, /^liveness probe armed and dispatched: 3 candidate\(s\) checked, 0 spared as live, 0 unevaluable$/,
        'the tcp-alive-no-http clause must not be silently dropped from the rendered line',
    );
});

test('formatSweepLivenessSummary(): armed+not-dispatched with a tcpAliveNoHttp count still names them -- the "nothing to check" wording is unreachable here', () => {
    const line = formatSweepLivenessSummary({
        armed: true, dispatched: false, checked: 0, spared: 0, unevaluable: 0, tcpAliveNoHttp: 1, unprobeable: 0,
    });
    assert.match(
        line,
        /so 1 candidate\(s\) were SPARED rather than confirmed dead -- this predicate speaks HTTP only/,
        'the not-dispatched branch must still name the tcp-alive-no-http count',
    );
    assert.doesNotMatch(
        line, /nothing to check/,
        'the reassuring "nothing to check" wording must be unreachable once a tcp-alive-no-http candidate exists',
    );
});

test('formatSweepLivenessSummary(): tcpAliveNoHttp absent renders identically to tcpAliveNoHttp: 0 (regression guard for older result shapes)', () => {
    const withZeroField = formatSweepLivenessSummary({
        armed: true, dispatched: true, checked: 2, spared: 1, unevaluable: 0, tcpAliveNoHttp: 0, unprobeable: 0,
    });
    const withoutField = formatSweepLivenessSummary({
        armed: true, dispatched: true, checked: 2, spared: 1, unevaluable: 0, unprobeable: 0,
    });
    assert.equal(withoutField, withZeroField, 'an older result shape with no tcpAliveNoHttp field must render exactly like tcpAliveNoHttp: 0');
    assert.equal(withoutField, 'liveness probe armed and dispatched: 2 candidate(s) checked, 1 spared as live, 0 unevaluable');
});

test('formatSweepLivenessSummary(): not armed renders the fixed wording regardless of a tcpAliveNoHttp count', () => {
    const line = formatSweepLivenessSummary({ armed: false, tcpAliveNoHttp: 5 });
    assert.equal(
        line,
        'liveness probe NOT ARMED -- no candidate was checked for life before it was selected '
        + '(the sweep config set "livenessProbe": false)',
        'the NOT ARMED wording must be unchanged, even when a stray tcpAliveNoHttp count is present on the record',
    );
});

// ---------------------------------------------------------------------------
// apra-fleet-i4ku.24.2.3: docs coherence -- both docs/member-prep-and-stray-
// sweep.md and packages/apra-fleet-se/docs/cli-reference.md must keep stating
// the tcp-alive-no-http (non-HTTP listener) outcome, so a future edit that
// drops the clause from either document is caught here, in the style the
// existing --sweep-config docs/help coherence tests use (read the file,
// assert required substrings).
// ---------------------------------------------------------------------------

test('docs/member-prep-and-stray-sweep.md documents the tcp-alive-no-http (non-HTTP listener) outcome', () => {
    const docPath = path.join(import.meta.dirname, '..', '..', '..', 'docs', 'member-prep-and-stray-sweep.md');
    const content = fs.readFileSync(docPath, 'utf8');
    assert.match(content, /non-HTTP listener/, 'the doc must state the probe cannot vouch for a non-HTTP listener');
    assert.match(content, /tcpAliveNoHttp/, 'the doc must name the dedicated result bucket');
    assert.match(content, /LIVENESS TCP-ALIVE-NO-HTTP/, 'the doc must name the dedicated per-member notice line');
});

// ---------------------------------------------------------------------------
// Criterion 3, the case that reopened this bead: a candidate the predicate
// CANNOT ask about (it holds no listening port) must get the same fate in
// both passes below, and the summary must never claim there was nothing to
// check while a kill went unchecked.
//
// WHAT THIS GUARDS: the liveness block used to be gated on
// `candidates.length > 0`, a set pooled from the ports of ALL provisional
// candidates. Restore that gate and this test fails twice over -- the
// portless stray is SPARED in the sibling pass (as `unevaluable`) while it
// is killed in the pass where it is alone, and the alone pass narrates
// itself as "no candidate survived the other predicates, so there was
// nothing to check" over the top of a kill.
// ---------------------------------------------------------------------------

/** Every fact about ONE pid that an operator or caller could act on. */
function fateOf(chain, pid) {
    const decision = chain.sweep.result.candidates.find((d) => d.pid === pid);
    return { action: decision.action, sparedReasons: decision.sparedReasons };
}

test('GUARD (no sibling effect): a portless candidate is selected UNCHECKED and counted `unprobeable`, identically whether or not a ported sibling shares the pass', async () => {
    const config = { markers: MARKERS, productionPorts: PRODUCTION_PORTS, livenessProbe: true };

    // Pass A: the portless stray is the only candidate, so no liveness
    // dispatch can be issued at all.
    const alone = await runWholeChain(config, { probeOutput: portlessAloneProbeOutput() });
    assert.equal(alone.seam.liveness().length, 0, 'there is no port to ask, so no liveness dispatch should be issued');
    assert.deepEqual(
        alone.sweep.result.killed.map((k) => k.pid), [PORTLESS_PID],
        'a portless stray that survived every other predicate is still killed -- sparing it would make an armed sweep a no-op',
    );
    assert.equal(alone.sweep.result.liveness.unprobeable, 1, 'the unchecked kill must be COUNTED, not invisible on the result');
    assert.equal(alone.sweep.result.liveness.unevaluable, 0, '"nothing to ask" is not the fail-safe "asked and could not find out"');

    // THE FALSE SENTENCE THIS BEAD WAS REOPENED FOR.
    assert.doesNotMatch(
        alone.sweepLines[0], /nothing to check/,
        'a pass that killed an unchecked candidate must never narrate itself as having had nothing to check',
    );
    assert.match(alone.sweepLines[0], /armed but not dispatched -- no surviving candidate held a listening port to probe, so 1 candidate\(s\) were selected UNCHECKED/);
    const loud = alone.sweepLines.find((l) => l.includes('LIVENESS UNPROBEABLE'));
    assert.ok(loud, `an unchecked kill needs its own loud line, got: ${JSON.stringify(alone.sweepLines)}`);
    assert.match(loud, /WITHOUT a liveness check/);

    // Pass B: the SAME portless stray, with one unrelated ported sibling
    // added. The sibling answers HTTP and is spared -- it still gets the full
    // benefit of the predicate -- but it must not change 7001's fate.
    const withSibling = await runWholeChain(config, { probeOutput: portlessWithPortedSiblingProbeOutput() });
    assert.equal(withSibling.seam.liveness().length, 1, 'the ported sibling must still be probed');
    assert.ok(
        withSibling.sweep.result.reported.some((d) => d.pid === LIVE_PID),
        'the ported sibling answering HTTP must still be spared -- this fix must not weaken the predicate where it applies',
    );
    assert.equal(withSibling.sweep.result.liveness.unprobeable, 1);
    assert.equal(withSibling.sweep.result.liveness.unevaluable, 0);
    assert.equal(withSibling.sweep.result.liveness.checked, 1, 'only the candidate that could be asked counts as checked');

    // THE INVARIANT: an identical process, an identical verdict. Before the
    // fix these two differed (killed alone, spared as `unevaluable` with a
    // sibling) -- an unrelated process deciding this one's fate.
    assert.deepEqual(
        fateOf(withSibling, PORTLESS_PID), fateOf(alone, PORTLESS_PID),
        "a candidate's fate must depend only on that candidate, never on whether some unrelated process in the same pass happened to hold a port",
    );
    assert.ok(withSibling.sweep.result.killed.map((k) => k.pid).includes(PORTLESS_PID));
    assert.ok(
        withSibling.sweepLines.some((l) => l.includes('LIVENESS UNPROBEABLE')),
        'the unchecked kill must be just as loud in a pass that DID dispatch a probe',
    );
    assert.match(withSibling.sweepLines[0], /a further 1 candidate\(s\) held no listening port to probe and were selected UNCHECKED/);
});

// ---------------------------------------------------------------------------
// Criterion 3, the state apra-fleet-i4ku.21 MADE reachable: armed, nothing
// dispatched, and yet candidates survived the other predicates.
//
// WHAT THIS GUARDS: classifying an unresolvable bound address as
// `unevaluable` happens OUTSIDE the dispatch block, so a pass can now end
// with dispatched:false and unevaluable > 0 -- a combination that was
// unreachable while both unevaluable++ sites sat behind the dispatch guard.
// The not-dispatched summary branch only special-cased `unprobeable`, so
// this pass narrated itself as "no candidate survived the other predicates,
// so there was nothing to check" while a candidate had both survived AND
// held a port. Drop the `unevaluable > 0` clause from
// formatSweepLivenessSummary()'s not-dispatched branch and both assertions
// on the summary text below fail.
// ---------------------------------------------------------------------------

test('GUARD (no false reassurance): an armed pass that dispatched NOTHING because its only surviving candidate was unaskable never claims there was nothing to check', async () => {
    const config = { markers: MARKERS, productionPorts: PRODUCTION_PORTS, livenessProbe: true };

    const alone = await runWholeChain(config, { probeOutput: unaskableAloneProbeOutput() });
    assert.equal(
        alone.seam.liveness().length, 0,
        'no probeable target exists, so no liveness dispatch can be built -- this is the not-dispatched state',
    );
    assert.equal(alone.sweep.result.liveness.armed, true);
    assert.equal(alone.sweep.result.liveness.dispatched, false);
    assert.equal(alone.sweep.result.liveness.unevaluable, 1, 'an address we cannot phrase a question about is the fail-safe bucket');
    assert.equal(alone.sweep.result.liveness.unprobeable, 0, 'it DOES hold a socket, so it is not the "nothing to ask" bucket');
    assert.equal(alone.sweep.result.liveness.checked, 0, 'a candidate that was never asked must never count as checked');

    // Fail-safe direction, unchanged: unevaluable SPARES.
    assert.deepEqual(alone.sweep.result.killed, [], 'an unevaluable candidate must be spared, never killed on an unasked question');
    assert.ok(
        alone.sweep.result.reported.some((d) => d.pid === UNASKABLE_PID),
        `the unaskable candidate must be reported as surviving: ${JSON.stringify(alone.sweep.result.reported)}`,
    );

    // THE FALSE SENTENCE THIS ROUND WAS REOPENED FOR. Both of its clauses
    // were wrong at once in this pass: a candidate DID survive the other
    // predicates, and it DID hold a port there was something to check on.
    assert.doesNotMatch(
        alone.sweepLines[0], /nothing to check/,
        'a pass whose surviving candidate held a listening port must never narrate itself as having had nothing to check',
    );
    assert.doesNotMatch(
        alone.sweepLines[0], /no candidate survived the other predicates/,
        'a candidate survived every other predicate in this pass -- that is why it is in `reported`',
    );
    assert.match(
        alone.sweepLines[0],
        /armed but not dispatched -- no surviving candidate held a listening port whose bound address could be resolved to a probeable host, so 1 candidate\(s\) were SPARED unevaluable/,
        'the summary must name the real reason nothing was dispatched, and that the candidate was spared rather than checked',
    );
    assert.ok(
        alone.sweepLines.some((l) => l.includes('LIVENESS UNEVALUABLE')),
        `a spare nobody checked must still get its loud line with no dispatch in the pass: ${JSON.stringify(alone.sweepLines)}`,
    );

    // BOTH undispatchable shapes at once: the spare and the unchecked kill
    // have opposite consequences, so one must never be reported over the
    // other. Still no dispatch.
    const mixed = await runWholeChain(config, { probeOutput: unaskableWithPortlessProbeOutput() });
    assert.equal(mixed.seam.liveness().length, 0);
    assert.equal(mixed.sweep.result.liveness.unevaluable, 1);
    assert.equal(mixed.sweep.result.liveness.unprobeable, 1);
    assert.deepEqual(
        mixed.sweep.result.killed.map((k) => k.pid), [PORTLESS_PID],
        'the portless stray is still killed unchecked, and the unaskable one is still spared -- same pass, opposite fates',
    );
    assert.match(
        mixed.sweepLines[0],
        /1 candidate\(s\) were SPARED unevaluable rather than checked; a further 1 candidate\(s\) held no listening port at all and were selected UNCHECKED/,
        'a summary that reported only one of the two outcomes would hide either a kill nobody checked or a stray nobody cleared',
    );

    // Per-candidate, never per-pass: adding the portless sibling must not
    // change the unaskable candidate's fate, and vice versa.
    assert.deepEqual(fateOf(mixed, UNASKABLE_PID), fateOf(alone, UNASKABLE_PID));
});

// ---------------------------------------------------------------------------
// Criterion 4: malformed fails fast at the config/CLI boundary, BEFORE any
// dispatch is issued.
// ---------------------------------------------------------------------------

test('a malformed liveness option fails fast at every config/CLI boundary, before any dispatch is issued', async () => {
    const malformed = [
        { livenessProbe: 'yes' },
        { livenessProbe: { timeout: 5000 } },
        { livenessProbe: { path: 'healthz' } },
        { livenessProbe: { timeoutMs: 0 } },
    ];

    for (const bad of malformed) {
        const config = { markers: MARKERS, productionPorts: PRODUCTION_PORTS, ...bad };

        // Boundary 1: the supervisor's loader.
        assert.throws(
            () => loadSweepConfig({ repoRoot: '/nonexistent-repo-root', env: { FLEET_SE_SWEEP_CONFIG: JSON.stringify(config) }, logger: { log: () => {} } }),
            /livenessProbe/,
            `the supervisor loader accepted ${JSON.stringify(bad)}`,
        );
        // Boundary 2: the CLI's own re-validation of --sweep-config.
        await assert.rejects(
            () => resolveSweepConfig(JSON.stringify(config)),
            /livenessProbe/,
            `resolveSweepConfig() accepted ${JSON.stringify(bad)}`,
        );
        // Boundary 3: the runner's arg contract.
        assert.throws(
            () => validateArgs(buildRunnerArgs({
                targetIssues: ['apra-fleet-demo'], members: ['remote-worker'], branch: 'b', baseBranch: 'main',
                goal: 'P1', maxCycles: 1, sweepMarkers: MARKERS, sweepProductionPorts: PRODUCTION_PORTS,
                sweepLivenessProbe: bad.livenessProbe,
            })),
            /sweep_liveness_probe/,
            `validateArgs() accepted ${JSON.stringify(bad)}`,
        );
    }

    // BEFORE ANY DISPATCH: the whole chain refuses to start, with an exec
    // seam wired in that would have recorded a probe if one had been issued.
    const seam = makeSeam();
    await assert.rejects(
        () => runWholeChain({ markers: MARKERS, productionPorts: PRODUCTION_PORTS, livenessProbe: 'yes' }, { seam }),
        /livenessProbe/,
    );
    assert.equal(seam.dispatches.length, 0, 'a malformed option must be rejected before anything is dispatched to a member');
});

// ---------------------------------------------------------------------------
// Criterion 5, the ONE link the assertions above cannot observe: runner.js's
// Member Prep call site. Everything else is driven through real functions,
// but runner.js's call site lives inside the sprint's main body, so it is
// pinned by reading the source -- the same technique
// test/member-prep.test.mjs uses for that call site's execCommand adapter.
// Deleting `sweepLivenessProbe` from that call fails THIS test.
// ---------------------------------------------------------------------------

test('GUARD (runner.js link): the production Member Prep call site still forwards sweepLivenessProbe from the validated args', () => {
    const runnerSrc = fs.readFileSync(RUNNER_PATH, 'utf8');
    const callMatch = runnerSrc.match(/await runMemberPrepPhase\(\{([\s\S]*?)\n {4}\}\);/);
    assert.ok(
        callMatch,
        'could not find the `await runMemberPrepPhase({ ... });` call site in runner.js -- if it was rewritten, '
        + "update this pin's anchor pattern rather than deleting the pin",
    );
    assert.match(
        callMatch[1], /sweepLivenessProbe:\s*validated\.sweepLivenessProbe/,
        'runner.js no longer forwards `sweepLivenessProbe` from the validated args into Member Prep. That reverts '
        + 'this whole feature to dormant for every supervisor-launched sprint: the option would be parsed, '
        + 'validated and then dropped one call short of the sweep, and a target that set it would never be obeyed.',
    );
});
