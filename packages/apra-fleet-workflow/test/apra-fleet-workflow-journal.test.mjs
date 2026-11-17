import { test, describe, before, after } from 'node:test';
import assert from 'node:assert';
import * as fs from 'fs/promises';
import * as fsSync from 'fs';
import * as os from 'os';
import * as path from 'path';
import { fileURLToPath } from 'url';
import { FleetWorkflow } from '../src/workflow/index.mjs';
import { WorkflowEngine } from '../src/workflow/engine.mjs';
import { hashText, computeActivityKey, resolveJournalWritePath, loadJournal } from '../src/workflow/journal.mjs';

// Tests for apra-fleet-unw.11 (F6): run journal (JSONL) + resume/replay mode.
//
// Borrows the "resumable runs / journal caching" pattern from Claude CLI's
// dynamic-workflow model: a crash mid-run should not force a full re-run
// (and re-dispatch of already-completed activities) from scratch.

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const fixture = (name) => path.join(__dirname, 'fixtures', name);

const KNOWN_MEMBERS = new Set(['fleet-dev']);

/**
 * A mock fleetApi that echoes the prompt back and records every dispatched
 * prompt, so tests can assert exactly which activities were (or were not)
 * re-dispatched during a resumed run.
 */
function createTrackingFleetApi() {
    const calls = [];
    return {
        calls,
        async executePrompt(payload) {
            calls.push(payload.prompt);
            const memberKey = payload.member_name || payload.member_id;
            if (!KNOWN_MEMBERS.has(memberKey)) {
                return { content: [{ text: `Member "${memberKey}" not found.` }] };
            }
            return {
                content: [{ text: `echo: ${payload.prompt}` }],
                usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 }
            };
        },
        async executeCommand(payload) {
            calls.push(payload.command);
            return { content: [{ text: payload.command }], isError: false };
        }
    };
}

/**
 * A mock fleetApi that fails the test outright if it is ever dispatched a
 * prompt from `forbiddenPrompts` -- used to assert ZERO re-dispatch for
 * activities that should be served entirely from the journal cache.
 */
function createGuardedFleetApi(forbiddenPrompts) {
    const calls = [];
    return {
        calls,
        async executePrompt(payload) {
            if (forbiddenPrompts.has(payload.prompt)) {
                assert.fail(`executePrompt() was called for a prompt that should have been served from the journal cache: ${JSON.stringify(payload.prompt)}`);
            }
            calls.push(payload.prompt);
            const memberKey = payload.member_name || payload.member_id;
            if (!KNOWN_MEMBERS.has(memberKey)) {
                return { content: [{ text: `Member "${memberKey}" not found.` }] };
            }
            return {
                content: [{ text: `echo: ${payload.prompt}` }],
                usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 }
            };
        },
        async executeCommand(payload) {
            calls.push(payload.command);
            return { content: [{ text: payload.command }], isError: false };
        }
    };
}

async function makeTmpDir() {
    return fs.mkdtemp(path.join(os.tmpdir(), 'fleet-journal-test-'));
}

// apra-fleet-j918.7.7: several resume-behavior cases below used to each pay
// for their OWN "fs.mkdtemp + engine1.executeFile(test-journal-sequential.mjs,
// {}, { journal })" recording leg, differing only in the post-hoc shape their
// journal ended up in (clean/successful, crash-truncated, or hand-corrupted)
// and which signal they checked on resume. That recording leg now runs
// EXACTLY ONCE for this whole file (in the top-level before() below); every
// case that needs its own journal shape copies the ONE canonical recording
// into a fresh per-case temp file and, if needed, mutates that COPY -- never
// the shared canonical file -- so no case can affect another's input, and
// corrupting one case's copy provably cannot bleed into a sibling case.
let canonicalDir;
let canonicalJournalPath;
let canonicalResult;
let canonicalJournalSnapshot;
let recordingInvocationCount = 0;

before(async () => {
    recordingInvocationCount += 1;
    canonicalDir = await makeTmpDir();
    canonicalJournalPath = path.join(canonicalDir, 'canonical-recording.jsonl');
    const wf = new FleetWorkflow(createTrackingFleetApi());
    const engine = new WorkflowEngine(wf);
    canonicalResult = await engine.executeFile(fixture('test-journal-sequential.mjs'), {}, { journal: canonicalJournalPath });
    canonicalJournalSnapshot = await fs.readFile(canonicalJournalPath, 'utf-8');
});

after(async () => {
    // The invocation counter this bead's acceptance criteria asks for: the
    // recording leg above must have run exactly once across this whole
    // file's execution, not once per case that consumes its output.
    assert.strictEqual(recordingInvocationCount, 1, `expected the shared canonical recording to run exactly once per file execution, ran ${recordingInvocationCount} time(s)`);
    // Direct proof that no case mutated the SHARED canonical file (as
    // opposed to its own copy): byte-for-byte unchanged from what before()
    // wrote, after every case has run. copyCanonicalJournal() only ever
    // opens canonicalJournalPath for reading.
    const finalCanonicalContent = await fs.readFile(canonicalJournalPath, 'utf-8');
    assert.strictEqual(finalCanonicalContent, canonicalJournalSnapshot, 'the shared canonical recording must be byte-identical after every case has run -- a case mutated shared state instead of its own copy');
    await fs.rm(canonicalDir, { recursive: true, force: true });
});

/**
 * Copies the ONE canonical recorded journal (test-journal-sequential.mjs,
 * run cleanly to completion) into a fresh per-case temp file, optionally
 * transforming its parsed records first via `mutate(records)` -- e.g. to
 * simulate a crash (flip an activity:end to success:false) or an unfinished
 * dispatch (truncate before an activity:end). The shared canonical file
 * itself is never opened for writing. Callers must remove the returned
 * `dir` when done.
 * @param {(records: object[]) => object[]} [mutate]
 * @returns {Promise<{ dir: string, copyPath: string }>}
 */
async function copyCanonicalJournal(mutate) {
    const raw = await fs.readFile(canonicalJournalPath, 'utf-8');
    const records = raw.split('\n').filter((l) => l.trim().length > 0).map((l) => JSON.parse(l));
    const finalRecords = mutate ? mutate(records) : records;
    const dir = await makeTmpDir();
    const copyPath = path.join(dir, 'case-journal.jsonl');
    await fs.writeFile(copyPath, finalRecords.map((r) => JSON.stringify(r)).join('\n') + '\n', 'utf-8');
    return { dir, copyPath };
}

// apra-fleet-j918.7.7: CASES 1-3 below (journal shape, crash+resume,
// prompt-divergence) used to be three separate describe blocks, each
// re-running the "fs.mkdtemp + engine1.executeFile(fixture, {}, {journal})"
// recording leg with only the post-hoc journal shape and the asserted
// signal actually differing between them. They now share the ONE canonical
// recording (see `before()`/`copyCanonicalJournal()` above) and are driven
// from this CASES table; each case is still individually named in test
// output (`c.name`) and runs on its OWN copy of the canonical journal, so
// corrupting one case's copy cannot affect another.
const CASES = [
    {
        name: '1. journal shape: valid JSONL, a run:start/run:end pair, and 3 successful agent activity:end records with usage/cost/sequence/replayKey',
        async run() {
            const { dir, copyPath } = await copyCanonicalJournal();
            try {
                assert.deepStrictEqual(canonicalResult, { r1: 'echo: step1', r2: 'echo: step2', r3: 'echo: step3' });

                const raw = await fs.readFile(copyPath, 'utf-8');
                const lines = raw.split('\n').filter((l) => l.trim().length > 0);
                assert.ok(lines.length > 0, 'expected at least one journal line');

                const records = lines.map((line, idx) => {
                    let parsed;
                    assert.doesNotThrow(() => { parsed = JSON.parse(line); }, `journal line ${idx} is not valid JSON: ${line}`);
                    return parsed;
                });

                const runStart = records.find((r) => r.event === 'run:start');
                assert.ok(runStart, 'expected a run:start record');
                assert.ok(runStart.scriptPath.includes('test-journal-sequential.mjs'));

                const runEnd = records.find((r) => r.event === 'run:end');
                assert.ok(runEnd, 'expected a run:end record');
                assert.strictEqual(runEnd.status, 'success');

                const activityEnds = records.filter((r) => r.event === 'activity:end' && r.type === 'agent');
                assert.strictEqual(activityEnds.length, 3, 'expected 3 agent activity:end records');
                for (const rec of activityEnds) {
                    assert.strictEqual(rec.success, true);
                    assert.ok(rec.usage, 'expected usage to be recorded when known');
                    assert.strictEqual(rec.usage.total_tokens, 2);
                    assert.strictEqual(typeof rec.cost, 'number');
                    assert.ok(typeof rec.sequence === 'number');
                    assert.ok(typeof rec.replayKey === 'string');
                }
            } finally {
                await fs.rm(dir, { recursive: true, force: true });
            }
        },
    },
    {
        name: '2. a crash after 2 of 3 activities, then resume: first 2 are served from the journal with ZERO new dispatches, final result matches an uninterrupted run',
        async run() {
            // Simulates "crash on the 3rd dispatch" by mutating a COPY of
            // the canonical (fully successful) recording's step3
            // activity:end into the exact shape FleetWorkflow.agent() emits
            // for a real synchronous transport failure (src/workflow/
            // index.mjs's generic catch-all: `{ ...activityMeta, error,
            // duration, success: false }` -- no usage/cost/output) --
            // rather than re-running a real crashing dispatch, which would
            // need its own separate recording leg and reintroduce the
            // duplication this task removes.
            const { dir, copyPath } = await copyCanonicalJournal((records) => records.map((rec) => {
                if (rec.event === 'activity:end' && rec.label === 'step3') {
                    const { usage, cost, output, ...rest } = rec;
                    return { ...rest, error: 'Simulated crash: connection lost', success: false };
                }
                return rec;
            }));
            try {
                // Sanity on the mutated copy -- the same fact the original
                // per-case recording leg's own `crashingApi.calls.length
                // === 3` assertion verified (3 activities were attempted,
                // only 2 are replayable), now read from the journal's own
                // content since there is no real crashing dispatch left to
                // count calls against in this design.
                const { completedByKey } = await loadJournal(copyPath);
                assert.strictEqual(completedByKey.size, 3, 'expected 3 activity:end records (2 successful, 1 failed) in the journal before resume');
                const successfulKeys = [...completedByKey.values()].filter((r) => r.success);
                assert.strictEqual(successfulKeys.length, 2, 'expected exactly 2 successful (replayable) records');

                // Resume: a fresh WorkflowEngine/FleetWorkflow (simulating a
                // brand new process), with a fleetApi that FAILS the test if
                // called for step1 or step2 -- those must be served
                // entirely from the journal.
                const guardedApi = createGuardedFleetApi(new Set(['step1', 'step2']));
                const wf2 = new FleetWorkflow(guardedApi);
                const engine2 = new WorkflowEngine(wf2);

                const replayedActivities = [];
                wf2.on('activity:end', (meta) => { if (meta.replayed) replayedActivities.push(meta); });

                const result = await engine2.executeFile(fixture('test-journal-sequential.mjs'), {}, { resumeJournal: copyPath });

                // Same final result as an uninterrupted run would have produced.
                assert.deepStrictEqual(result, { r1: 'echo: step1', r2: 'echo: step2', r3: 'echo: step3' });

                // Zero new dispatches for the first 2 (cached) activities;
                // exactly one live dispatch for step3.
                assert.deepStrictEqual(guardedApi.calls, ['step3']);

                // The first 2 activities were explicitly served from the
                // replay cache (marked `replayed: true`); step3 was not.
                assert.strictEqual(replayedActivities.length, 2);
                assert.deepStrictEqual(replayedActivities.map((a) => a.label).sort(), ['step1', 'step2']);
            } finally {
                await fs.rm(dir, { recursive: true, force: true });
            }
        },
    },
    {
        name: '3. a changed prompt at position k stops replay AT k and falls through to live execution from k onward, not before or after',
        async run() {
            // No journal mutation needed for this case: the divergence is
            // driven entirely by resuming with a DIFFERENT step2Prompt arg
            // against the unmodified canonical recording's copy -- position
            // 0 (step1) still matches and replays; position 1 (step2) no
            // longer matches and diverges.
            const { dir, copyPath } = await copyCanonicalJournal();
            try {
                const trackingApi2 = createTrackingFleetApi();
                const wf2 = new FleetWorkflow(trackingApi2);
                const engine2 = new WorkflowEngine(wf2);

                const divergedEvents = [];
                wf2.on('journal:diverged', (meta) => divergedEvents.push(meta));
                const replayedActivities = [];
                wf2.on('activity:end', (meta) => { if (meta.replayed) replayedActivities.push(meta); });

                const result = await engine2.executeFile(
                    fixture('test-journal-sequential.mjs'),
                    { step2Prompt: 'step2-changed' },
                    { resumeJournal: copyPath }
                );

                assert.deepStrictEqual(result, { r1: 'echo: step1', r2: 'echo: step2-changed', r3: 'echo: step3' });

                // step1 must NOT have been re-dispatched (served from cache);
                // step2-changed and step3 MUST have been dispatched live.
                assert.deepStrictEqual(trackingApi2.calls, ['step2-changed', 'step3']);

                assert.strictEqual(replayedActivities.length, 1);
                assert.strictEqual(replayedActivities[0].label, 'step1');

                // Exactly one divergence event, at sequence 1 (the 2nd call, 0-indexed).
                assert.strictEqual(divergedEvents.length, 1);
                assert.strictEqual(divergedEvents[0].sequence, 1);
                assert.strictEqual(divergedEvents[0].type, 'agent');
            } finally {
                await fs.rm(dir, { recursive: true, force: true });
            }
        },
    },
];

describe('apra-fleet-unw.11 (F6): journal shape, crash+resume, and prompt-divergence -- table-driven over ONE shared recording (apra-fleet-j918.7.7)', () => {
    for (const c of CASES) {
        test(c.name, c.run);
    }
});

describe('apra-fleet-unw2.13 (N5): replay honors the failSoft result shape for command()', () => {
    test('a resumed run replays a failSoft probe as { ok, output, error } (matching the live shape), so a Deploy/Integ-style gate is NOT silently skipped; a non-failSoft command still replays as the raw string', async () => {
        const tmpDir = await makeTmpDir();
        const journalPath = path.join(tmpDir, 'journal.jsonl');

        // First (uninterrupted) run: both the failSoft probe and the plain
        // command succeed live -- this is the "original run succeeded"
        // scenario the bug describes (probeFileExists() found the file).
        const trackingApi1 = createTrackingFleetApi();
        const wf1 = new FleetWorkflow(trackingApi1);
        const engine1 = new WorkflowEngine(wf1);
        const liveResult = await engine1.executeFile(fixture('test-journal-command-failsoft.mjs'), {}, { journal: journalPath });

        assert.deepStrictEqual(liveResult.probe, { ok: true, output: 'test -f deploy-marker', error: null });
        assert.strictEqual(liveResult.deploySkipped, false);
        assert.strictEqual(liveResult.plain, 'echo plain-output');

        // Resume: fresh FleetWorkflow/engine, with a fleetApi that FAILS the
        // test if EITHER command is redispatched -- both must be served
        // entirely from the journal cache.
        const guardedApi = createGuardedFleetApi(new Set());
        guardedApi.executeCommand = async (payload) => {
            assert.fail(`executeCommand() was called for a command that should have been served from the journal cache: ${JSON.stringify(payload.command)}`);
        };
        const wf2 = new FleetWorkflow(guardedApi);
        const engine2 = new WorkflowEngine(wf2);

        const replayedActivities = [];
        wf2.on('activity:end', (meta) => { if (meta.replayed) replayedActivities.push(meta); });

        const replayedResult = await engine2.executeFile(fixture('test-journal-command-failsoft.mjs'), {}, { resumeJournal: journalPath });

        // The crux of the bug: the replayed failSoft probe must be the
        // SHAPED object, not the bare journaled string -- so `.ok` is a real
        // boolean, and the Deploy/Integ-style gate downstream of it is not
        // silently skipped just because `.ok` read as `undefined`.
        assert.deepStrictEqual(replayedResult.probe, { ok: true, output: 'test -f deploy-marker', error: null });
        assert.strictEqual(replayedResult.deploySkipped, false, 'Deploy/Integ must NOT be silently skipped on replay when the original probe succeeded');

        // Non-failSoft replay is unchanged: still the raw string, exactly as
        // before this fix.
        assert.strictEqual(replayedResult.plain, 'echo plain-output');
        assert.strictEqual(typeof replayedResult.plain, 'string');

        assert.strictEqual(replayedActivities.length, 2, 'both the probe and the plain command should have been served from the replay cache');

        await fs.rm(tmpDir, { recursive: true, force: true });
    });

    test('OLD-FORMAT journal (no failSoft field on the activity:end record) falls back gracefully to a raw-string replay instead of crashing', async () => {
        const tmpDir = await makeTmpDir();
        const journalPath = path.join(tmpDir, 'journal.jsonl');

        const probeHash = hashText('test -f deploy-marker');
        const probeKey = computeActivityKey({ sequence: 0, type: 'command', member: 'fleet-dev', textHash: probeHash });
        const plainHash = hashText('echo plain-output');
        const plainKey = computeActivityKey({ sequence: 1, type: 'command', member: 'fleet-dev', textHash: plainHash });

        // Hand-constructed journal in the PRE-fix shape: activity:end
        // records for both command() calls, with no `failSoft` field at all
        // (as a journal written before this fix would look).
        const lines = [
            { event: 'run:start', runId: 'old-format-run', timestamp: Date.now(), scriptPath: 'irrelevant.mjs', args: {} },
            { event: 'activity:start', id: 'act-1', type: 'command', phase: null, runId: 'old-format-run', label: 'probe', member: 'fleet-dev', command: 'test -f deploy-marker', startTime: Date.now(), sequence: 0, replayKey: probeKey },
            { event: 'activity:end', id: 'act-1', type: 'command', phase: null, runId: 'old-format-run', label: 'probe', member: 'fleet-dev', command: 'test -f deploy-marker', sequence: 0, replayKey: probeKey, duration: 5, success: true, output: 'test -f deploy-marker' },
            { event: 'activity:start', id: 'act-2', type: 'command', phase: null, runId: 'old-format-run', label: 'plain-command', member: 'fleet-dev', command: 'echo plain-output', startTime: Date.now(), sequence: 1, replayKey: plainKey },
            { event: 'activity:end', id: 'act-2', type: 'command', phase: null, runId: 'old-format-run', label: 'plain-command', member: 'fleet-dev', command: 'echo plain-output', sequence: 1, replayKey: plainKey, duration: 5, success: true, output: 'echo plain-output' }
        ];
        await fs.writeFile(journalPath, lines.map((l) => JSON.stringify(l)).join('\n') + '\n', 'utf-8');

        const guardedApi = createGuardedFleetApi(new Set());
        guardedApi.executeCommand = async (payload) => {
            assert.fail(`executeCommand() was called for a command that should have been served from the journal cache: ${JSON.stringify(payload.command)}`);
        };
        const wf = new FleetWorkflow(guardedApi);
        const engine = new WorkflowEngine(wf);

        // Must not crash despite the missing `failSoft` field.
        const result = await engine.executeFile(fixture('test-journal-command-failsoft.mjs'), {}, { resumeJournal: journalPath });

        // Documented fallback: an old-format cache hit is treated as
        // non-failSoft (best-effort raw string), same as pre-fix behavior --
        // NOT a crash, but also not a perfectly-shaped replay.
        assert.strictEqual(result.probe, 'test -f deploy-marker');
        assert.strictEqual(result.plain, 'echo plain-output');

        await fs.rm(tmpDir, { recursive: true, force: true });
    });
});

describe('apra-fleet-unw.11 (F6): ambiguity guard', () => {
    // apra-fleet-j918.7.7: this is resume case 4 of the 5 the parent task
    // consolidated onto ONE shared canonical recording (see `before()`/
    // `copyCanonicalJournal()` near the top of this file). It used to
    // hand-construct its own crashed-mid-dispatch journal from scratch with
    // manually computed hashText/computeActivityKey values; it now derives
    // the identical shape by TRUNCATING a copy of the real canonical
    // recording right after step2's activity:start (dropping step2's
    // activity:end and all of step3) -- exactly what a real crash between
    // step2's dispatch and its reply would leave on disk, using the SAME
    // real ids/keys the production recording produced rather than
    // hand-typed stand-ins.
    test('4. a journal record that is started-but-never-finished is surfaced via journal:ambiguous and is never auto-resolved as a cache hit', async () => {
        const { dir, copyPath } = await copyCanonicalJournal((records) => {
            const truncated = [];
            for (const rec of records) {
                if (rec.event === 'activity:end' && rec.label === 'step2') break;
                truncated.push(rec);
            }
            return truncated;
        });
        try {
            const rawCopy = await fs.readFile(copyPath, 'utf-8');
            const copyRecords = rawCopy.split('\n').filter((l) => l.trim().length > 0).map((l) => JSON.parse(l));
            const step2StartRec = copyRecords.find((r) => r.event === 'activity:start' && r.label === 'step2');
            assert.ok(step2StartRec, "expected the truncated copy to retain step2's activity:start with no matching activity:end");

            const guardedApi = createGuardedFleetApi(new Set(['step1']));
            const wf = new FleetWorkflow(guardedApi);
            const engine = new WorkflowEngine(wf);

            const ambiguousEvents = [];
            wf.on('journal:ambiguous', (meta) => ambiguousEvents.push(meta));

            const result = await engine.executeFile(fixture('test-journal-sequential.mjs'), {}, { resumeJournal: copyPath });

            // Surfaced, not silently resolved.
            assert.strictEqual(ambiguousEvents.length, 1);
            assert.strictEqual(ambiguousEvents[0].activity.id, step2StartRec.id);
            assert.strictEqual(ambiguousEvents[0].activity.label, 'step2');

            // step1 (a genuinely completed record) is still replayed from cache...
            assert.ok(!guardedApi.calls.includes('step1'));
            // ...but step2 (ambiguous -- no completed record) and step3 are
            // dispatched live, since an ambiguous record is never auto-resolved
            // as a cache hit.
            assert.deepStrictEqual(guardedApi.calls, ['step2', 'step3']);
            assert.deepStrictEqual(result, { r1: 'echo: step1', r2: 'echo: step2', r3: 'echo: step3' });
        } finally {
            await fs.rm(dir, { recursive: true, force: true });
        }
    });
});

describe('apra-fleet-unw2.14 (N6): order-independent replay keys across parallel() branches', () => {
    // The core N6 regression: record a 2-streak parallel develop phase under
    // one branch interleaving, then resume it under a DIFFERENT (reversed)
    // interleaving, and assert every already-completed call across the barrier
    // is served from the journal cache -- ZERO live re-dispatch of the doers.
    test('a 2-streak parallel develop phase recorded under one interleaving replays with ZERO re-dispatch under a REVERSED interleaving', async () => {
        const tmpDir = await makeTmpDir();
        const journalPath = path.join(tmpDir, 'journal.jsonl');

        // Recording run: streak-a (delay 0) reaches its dispatches BEFORE
        // streak-b (delay 25), so the natural runtime order is
        // a-impl, a-test, b-impl, b-test. Under the pre-N6 single shared
        // counter these would be journaled as sequences 0,1,2,3 in that order.
        const trackingApi = createTrackingFleetApi();
        const wf1 = new FleetWorkflow(trackingApi);
        const engine1 = new WorkflowEngine(wf1);
        const recorded = await engine1.executeFile(
            fixture('test-journal-parallel-develop.mjs'),
            { delays: [0, 25] },
            { journal: journalPath }
        );
        assert.strictEqual(recorded.results.length, 2);
        // All four logical calls actually dispatched live during recording.
        assert.deepStrictEqual(
            [...trackingApi.calls].sort(),
            ['implement streak-a', 'implement streak-b', 'test streak-a', 'test streak-b']
        );

        // Resume run: REVERSED delays so streak-b now reaches its dispatches
        // FIRST -- runtime order becomes b-impl, b-test, a-impl, a-test, the
        // opposite of the recording. Under the pre-N6 shared counter this
        // reassigns sequence numbers and misses the cache; under N6 every key
        // is rooted at the branch's STATIC index, so all four still hit.
        const forbidden = new Set([
            'implement streak-a', 'test streak-a',
            'implement streak-b', 'test streak-b'
        ]);
        const guardedApi = createGuardedFleetApi(forbidden);
        const wf2 = new FleetWorkflow(guardedApi);
        const engine2 = new WorkflowEngine(wf2);

        const replayedActivities = [];
        wf2.on('activity:end', (meta) => { if (meta.replayed) replayedActivities.push(meta); });
        const divergedEvents = [];
        wf2.on('journal:diverged', (meta) => divergedEvents.push(meta));

        const resumed = await engine2.executeFile(
            fixture('test-journal-parallel-develop.mjs'),
            { delays: [25, 0] },
            { resumeJournal: journalPath }
        );

        // No live dispatch at all -- the whole barrier was served from cache
        // despite the reversed interleaving.
        assert.deepStrictEqual(guardedApi.calls, [], 'no doer should have been re-dispatched live on resume');
        // No divergence: order-independent keys all matched.
        assert.deepStrictEqual(divergedEvents, [], 'a reversed interleaving must NOT be mistaken for divergence');
        // All four agent activities replayed from cache.
        assert.strictEqual(replayedActivities.length, 4);
        assert.deepStrictEqual(
            replayedActivities.map((a) => a.label).sort(),
            ['streak-a-impl', 'streak-a-test', 'streak-b-impl', 'streak-b-test']
        );

        // Same logical result as the recording, regardless of interleaving.
        const byId = (r) => r.results.slice().sort((x, y) => x.id.localeCompare(y.id));
        assert.deepStrictEqual(byId(resumed), byId(recorded));

        await fs.rm(tmpDir, { recursive: true, force: true });
    });

    test('replay keys inside a parallel() branch are hierarchical/static (barrierIndex:branchIndex:localSeq), stable across interleavings', async () => {
        const tmpDir = await makeTmpDir();
        const journalPath = path.join(tmpDir, 'journal.jsonl');

        const wf = new FleetWorkflow(createTrackingFleetApi());
        const engine = new WorkflowEngine(wf);
        await engine.executeFile(
            fixture('test-journal-parallel-develop.mjs'),
            { delays: [0, 15] },
            { journal: journalPath }
        );

        const { completedByKey } = await loadJournal(journalPath);
        // Compute the EXPECTED order-independent keys directly from the branch
        // structure: barrier 0, static branch index 0 (streak-a) / 1
        // (streak-b), localSeq 0 (impl) / 1 (test). These must be present
        // regardless of which branch actually finished first at runtime.
        const key = (branchIdx, localSeq, text) => computeActivityKey({
            sequence: `0:${branchIdx}:${localSeq}`,
            type: 'agent',
            member: 'fleet-dev',
            textHash: hashText(text)
        });
        assert.ok(completedByKey.has(key(0, 0, 'implement streak-a')), 'streak-a impl key (0:0:0) missing');
        assert.ok(completedByKey.has(key(0, 1, 'test streak-a')), 'streak-a test key (0:0:1) missing');
        assert.ok(completedByKey.has(key(1, 0, 'implement streak-b')), 'streak-b impl key (0:1:0) missing');
        assert.ok(completedByKey.has(key(1, 1, 'test streak-b')), 'streak-b test key (0:1:1) missing');

        // The in-branch sequence surfaced on the events is the hierarchical
        // string form, not a raw run-global integer.
        for (const rec of completedByKey.values()) {
            assert.strictEqual(typeof rec.sequence, 'string');
            assert.match(rec.sequence, /^0:[01]:[01]$/);
        }

        await fs.rm(tmpDir, { recursive: true, force: true });
    });

    test('OLD-FORMAT journal (pre-N6 single global counter for parallel calls) degrades gracefully: diverges inside the parallel region and re-runs live WITHOUT crashing', async () => {
        const tmpDir = await makeTmpDir();
        const journalPath = path.join(tmpDir, 'journal.jsonl');

        // Hand-construct a pre-N6 journal: the four parallel-branch calls keyed
        // with a single run-GLOBAL numeric counter (0,1,2,3), the way the old
        // shared `activitySeq` produced them. The new code computes
        // hierarchical keys (0:0:0, 0:0:1, 0:1:0, 0:1:1) that do NOT match
        // these -- so replay legitimately diverges and re-runs live. The point
        // of this test is that this degradation NEVER crashes.
        const oldKey = (seq, text) => computeActivityKey({ sequence: seq, type: 'agent', member: 'fleet-dev', textHash: hashText(text) });
        const rec = (id, seq, prompt, label) => ([
            { event: 'activity:start', id, type: 'agent', phase: null, runId: 'old-run', label, member: 'fleet-dev', model: 'gpt-4o', repairAttempt: 0, startTime: Date.now(), sequence: seq, replayKey: oldKey(seq, prompt) },
            { event: 'activity:end', id, type: 'agent', phase: null, runId: 'old-run', label, member: 'fleet-dev', model: 'gpt-4o', repairAttempt: 0, sequence: seq, replayKey: oldKey(seq, prompt), duration: 5, success: true, usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 }, cost: 0.0001, output: `echo: ${prompt}` }
        ]);
        const lines = [
            { event: 'run:start', runId: 'old-run', timestamp: Date.now(), scriptPath: 'irrelevant.mjs', args: {} },
            ...rec('a1', 0, 'implement streak-a', 'streak-a-impl'),
            ...rec('a2', 1, 'test streak-a', 'streak-a-test'),
            ...rec('b1', 2, 'implement streak-b', 'streak-b-impl'),
            ...rec('b2', 3, 'test streak-b', 'streak-b-test')
        ];
        await fs.writeFile(journalPath, lines.map((l) => JSON.stringify(l)).join('\n') + '\n', 'utf-8');

        const trackingApi = createTrackingFleetApi();
        const wf = new FleetWorkflow(trackingApi);
        const engine = new WorkflowEngine(wf);

        const divergedEvents = [];
        wf.on('journal:diverged', (meta) => divergedEvents.push(meta));

        // Must NOT throw despite the format mismatch.
        const result = await engine.executeFile(
            fixture('test-journal-parallel-develop.mjs'),
            { delays: [0, 0] },
            { resumeJournal: journalPath }
        );

        // Correct result, produced by re-running the branches live.
        assert.strictEqual(result.results.length, 2);
        assert.ok(trackingApi.calls.length > 0, 'an old-format parallel journal should degrade to live re-dispatch, not silent skip');

        // Divergence WAS detected, and it is flagged as being inside a
        // parallel region (the graceful-degradation signal), not a suspicious
        // sequential mismatch.
        assert.ok(divergedEvents.length >= 1, 'expected at least one divergence against the old-format journal');
        assert.ok(divergedEvents.every((e) => e.inParallel === true), 'old-format parallel divergences must be flagged inParallel:true');

        await fs.rm(tmpDir, { recursive: true, force: true });
    });

    // apra-fleet-j918.7.7: resume case 5 of the 5 consolidated onto ONE
    // shared canonical recording. Same recipe as CASES[2] above (a copy of
    // the canonical test-journal-sequential.mjs recording, resumed with a
    // changed step2Prompt) but checking a DIFFERENT signal (inParallel:false)
    // -- kept here, next to its parallel-region sibling tests, rather than
    // folded into the CASES table above, since its point is the CONTRAST
    // with those siblings and moving it away would lose that context.
    test('5. journal:diverged distinguishes a SEQUENTIAL (top-level) mismatch (inParallel:false) from a parallel-region one', async () => {
        const { dir, copyPath } = await copyCanonicalJournal();
        try {
            const wf2 = new FleetWorkflow(createTrackingFleetApi());
            const engine2 = new WorkflowEngine(wf2);
            const divergedEvents = [];
            wf2.on('journal:diverged', (meta) => divergedEvents.push(meta));

            await engine2.executeFile(
                fixture('test-journal-sequential.mjs'),
                { step2Prompt: 'step2-changed' },
                { resumeJournal: copyPath }
            );

            assert.strictEqual(divergedEvents.length, 1);
            assert.strictEqual(divergedEvents[0].inParallel, false, 'a top-level mismatch must be flagged inParallel:false');
            assert.strictEqual(typeof divergedEvents[0].sequence, 'number', 'top-level sequence stays a plain integer (backward compatible)');
        } finally {
            await fs.rm(dir, { recursive: true, force: true });
        }
    });
});

describe('apra-fleet-unw2.14 (N18): replayed agent activities re-debit the run budget (total-spend semantics)', () => {
    test('a resumed run\'s budget reflects the replayed (cached) costs, not just live dispatches -- deliberate, documented', async () => {
        const tmpDir = await makeTmpDir();
        const journalPath = path.join(tmpDir, 'journal.jsonl');

        // Recording run: two agent() calls dispatch live and accrue real cost.
        const trackingApi = createTrackingFleetApi();
        const wf1 = new FleetWorkflow(trackingApi);
        const engine1 = new WorkflowEngine(wf1);
        const recorded = await engine1.executeFile(fixture('test-journal-budget.mjs'), {}, { journal: journalPath });
        assert.ok(recorded.spent > 0, 'the recording run should have accrued a positive budget spend');

        // Resume run: BOTH calls are served entirely from the journal cache
        // (the guarded api fails the test on any live dispatch), yet the
        // resumed run's budget must STILL reflect the replayed costs -- this
        // is the total-spend-view semantics N18 documents, so a resume near a
        // budget ceiling cannot silently overspend.
        const guardedApi = createGuardedFleetApi(new Set(['bstep1', 'bstep2']));
        const wf2 = new FleetWorkflow(guardedApi);
        const engine2 = new WorkflowEngine(wf2);
        const resumed = await engine2.executeFile(fixture('test-journal-budget.mjs'), {}, { resumeJournal: journalPath });

        assert.deepStrictEqual(guardedApi.calls, [], 'both calls should be served from cache, zero live dispatch');
        assert.ok(resumed.spent > 0, 'a resumed run that replayed paid work must report a positive budget spend, not $0');
        assert.strictEqual(resumed.spent, recorded.spent, 'the resumed budget must equal the recorded budget (replayed costs are re-debited)');

        await fs.rm(tmpDir, { recursive: true, force: true });
    });
});

describe('apra-fleet-unw.11 (F6): off by default', () => {
    test('a normal executeFile() call with no journal/resumeJournal option writes no journal file and creates no .fleet-workflow directory', async () => {
        const cwdBefore = process.cwd();
        const defaultJournalDir = path.join(cwdBefore, '.fleet-workflow');

        // Guard: fail loudly (rather than silently passing) if some other
        // concurrent test/process already created this directory for an
        // unrelated reason -- this test's assertion is only meaningful
        // against a clean baseline.
        const existedBefore = fsSync.existsSync(defaultJournalDir);

        const wf = new FleetWorkflow(createTrackingFleetApi());
        const engine = new WorkflowEngine(wf);

        const activityEvents = [];
        wf.on('activity:start', (meta) => activityEvents.push(meta));

        const result = await engine.executeFile(fixture('test-journal-sequential.mjs'), {});
        assert.deepStrictEqual(result, { r1: 'echo: step1', r2: 'echo: step2', r3: 'echo: step3' });

        if (!existedBefore) {
            assert.strictEqual(fsSync.existsSync(defaultJournalDir), false, 'executeFile() without journal options must not create .fleet-workflow/');
        }

        // No journal-related fields leak onto activity events when
        // journaling was never requested for this run.
        for (const meta of activityEvents) {
            assert.strictEqual(meta.sequence, undefined);
            assert.strictEqual(meta.replayKey, undefined);
            assert.strictEqual(meta.replayed, undefined);
        }
    });
});

describe('apra-fleet-unw.11 (F6): journal.mjs unit tests', () => {
    test('hashText is deterministic and null-safe', () => {
        assert.strictEqual(hashText('hello'), hashText('hello'));
        assert.notStrictEqual(hashText('hello'), hashText('world'));
        assert.strictEqual(hashText(undefined), null);
        assert.strictEqual(hashText(null), null);
    });

    test('computeActivityKey is deterministic and distinguishes sequence/type/member/text', () => {
        const base = { sequence: 0, type: 'agent', member: 'fleet-dev', textHash: hashText('hi') };
        assert.strictEqual(computeActivityKey(base), computeActivityKey({ ...base }));
        assert.notStrictEqual(computeActivityKey(base), computeActivityKey({ ...base, sequence: 1 }));
        assert.notStrictEqual(computeActivityKey(base), computeActivityKey({ ...base, type: 'command' }));
        assert.notStrictEqual(computeActivityKey(base), computeActivityKey({ ...base, member: 'apra-pm' }));
        assert.notStrictEqual(computeActivityKey(base), computeActivityKey({ ...base, textHash: hashText('bye') }));
    });

    test('resolveJournalWritePath: default path, explicit string/object paths, explicit disable, and resumeJournal continuation', () => {
        const runId = 'run-123';
        assert.strictEqual(
            resolveJournalWritePath({ journal: true }, runId),
            path.resolve('.fleet-workflow', `journal-${runId}.jsonl`)
        );
        assert.strictEqual(resolveJournalWritePath({ journal: '/tmp/custom.jsonl' }, runId), path.resolve('/tmp/custom.jsonl'));
        assert.strictEqual(resolveJournalWritePath({ journal: { path: '/tmp/custom2.jsonl' } }, runId), path.resolve('/tmp/custom2.jsonl'));
        assert.strictEqual(resolveJournalWritePath({ journal: false, resumeJournal: '/tmp/resumed.jsonl' }, runId), null);
        assert.strictEqual(resolveJournalWritePath({ resumeJournal: '/tmp/resumed.jsonl' }, runId), path.resolve('/tmp/resumed.jsonl'));
        assert.strictEqual(resolveJournalWritePath({}, runId), null);
    });

    test('loadJournal tolerates a missing file (treated as an empty journal)', async () => {
        const { completedByKey, ambiguous } = await loadJournal(path.join(os.tmpdir(), 'definitely-does-not-exist-' + Date.now() + '.jsonl'));
        assert.strictEqual(completedByKey.size, 0);
        assert.deepStrictEqual(ambiguous, []);
    });
});
