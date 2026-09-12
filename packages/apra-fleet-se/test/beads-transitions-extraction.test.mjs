import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
    applyGuardedReopens, buildReopenAllowlist, isDeferredScopeReopen, foldReplanIds,
    parseBareIdEntry, parseIdWithReasonEntry, isReviewerContractViolation, normalizeGoalMax,
} from '../fleet-sprint/beads-transitions.mjs';
import * as runner from '../fleet-sprint/runner.js';

// =============================================================================
// apra-fleet-3swo.4.7 -- beads-transitions.mjs extraction.
//
// Before this extraction, THREE sites applied a reviewer-shaped verdict to
// beads and only TWO were guarded. Re-Review -- the "0 open beads at goal but
// the last verdict was not APPROVED" branch -- looped over reopenIds issuing
// `bd update <id> --status=open` with no goal-scope guard, so a below-goal
// DEFERRED bead named there was pulled straight back into a sprint that no
// longer targeted it.
//
// What is pinned here:
//   (a) all THREE sites now emit the SAME "deferred scope, not reopened"
//       outcome for a below-goal reopen id -- Re-Review included;
//   (b) the FAIL-OPEN behaviour survives at all three: a THROWING scope
//       lookup applies the reopens rather than dropping them;
//   (c) Final Review still refuses an entry missing its reason;
//   (d) an id in replanIds but not reopenIds is still dropped; and
//   (e) runner.js still routes all three of its sites through this module --
//       asserted against runner.js's source, so re-introducing a private
//       unguarded reopen loop at any of them is caught.
// =============================================================================

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const RUNNER_PATH = path.join(__dirname, '../fleet-sprint/runner.js');

const GOAL = 'P1/P2';
const GOAL_MAX = 2;

// 'in-goal' is at goal priority; 'deferred' is a P3 the sprint has deferred.
const IN_SCOPE_BEADS = [
    { id: 'in-goal', priority: 1, status: 'closed' },
    { id: 'also-in-goal', priority: 2, status: 'closed' },
    { id: 'deferred', priority: 3, status: 'open' },
    { id: 'no-priority', status: 'closed' },
];

function buildHarness({ scopeThrows = false, commandThrowsFor = null } = {}) {
    const logs = [];
    const commands = [];
    return {
        logs,
        commands,
        log: (msg) => logs.push(msg),
        bdListScoped: async () => {
            if (scopeThrows) throw new Error('bd list exploded (simulated infrastructure failure)');
            return IN_SCOPE_BEADS;
        },
        command: async (cmd, opts) => {
            commands.push({ cmd, opts });
            if (commandThrowsFor && cmd.includes(commandThrowsFor)) throw new Error('bd update failed');
            return '';
        },
        reopenedCmdIds: () => commands.map((c) => /^bd update (\S+)/.exec(c.cmd)[1]),
        skipLines: () => logs.filter((l) => l.includes('deferred scope, not reopened')),
    };
}

// The three sites exactly as runner.js configures them, so this suite drives
// the real per-site wiring rather than a generic stand-in.
const SITES = [
    {
        name: 'per-round reviewer',
        logPrefix: 'Reviewer reopenIds',
        entries: ['in-goal', 'deferred'],
        opts: () => ({
            buildReopenCommand: ({ id }) => ({ cmd: `bd update ${id} --status=open`, label: `Reopen ${id} per reviewer verdict` }),
        }),
    },
    {
        name: 'Final Review',
        logPrefix: 'Final Review reopenIds',
        entries: [{ id: 'in-goal', reason: 'still broken' }, { id: 'deferred', reason: 'nice to have' }],
        opts: () => ({
            parseEntry: parseIdWithReasonEntry,
            buildReopenCommand: ({ id, reason }) => ({
                cmd: `bd update ${id} --status=open --append-notes "[Final Review C3] Reopened -- ${reason}"`,
                label: `Reopen ${id} per Final Review verdict`,
            }),
        }),
    },
    {
        name: 'Re-Review (previously UNGUARDED)',
        logPrefix: 'Re-review reopenIds',
        entries: ['in-goal', 'deferred'],
        opts: () => ({
            buildReopenCommand: ({ id }) => ({ cmd: `bd update ${id} --status=open`, label: `Reopen ${id} per re-review verdict` }),
        }),
    },
];

describe('apra-fleet-3swo.4.7: one goal-scope guard across all THREE verdict sites', () => {
    for (const site of SITES) {
        // Run each site against BOTH goalMax forms. runner.js passes the
        // STRING form ('P2', what goalPriorityMax returns and what
        // `--priority-max=` wants); the pre-extraction guard compared that
        // string straight against a NUMERIC bead.priority, so it never fired.
        // Pinning both forms is what keeps that regression from returning.
        for (const goalMaxForm of [GOAL_MAX, 'P2']) {
        test(`${site.name}: a below-goal reopen id is skipped with the shared "deferred scope, not reopened" outcome (goalMax as ${JSON.stringify(goalMaxForm)})`, async () => {
            const h = buildHarness();
            const reopened = await applyGuardedReopens({
                entries: site.entries,
                bdListScoped: h.bdListScoped, goalMax: goalMaxForm, goal: GOAL,
                log: h.log, command: h.command, member: 'orchestrator-member',
                logPrefix: site.logPrefix,
                ...site.opts(),
            });

            assert.deepEqual(reopened, ['in-goal'], 'only the in-goal bead is reopened');
            assert.deepEqual(h.reopenedCmdIds(), ['in-goal'], 'no bd update is issued for the deferred bead');
            assert.equal(h.skipLines().length, 1, 'exactly one deferred-scope skip is logged');
            assert.equal(
                h.skipLines()[0],
                `${site.logPrefix}: SKIPPED 'deferred' (priority P3 is below this sprint's goal ${GOAL} -- deferred scope, not reopened).`,
                'the skip line must be identical in shape at every site'
            );
        });
        }
    }

    test('the three sites produce byte-identical skip text apart from their own site label', async () => {
        const texts = [];
        for (const site of SITES) {
            const h = buildHarness();
            await applyGuardedReopens({
                entries: site.entries,
                bdListScoped: h.bdListScoped, goalMax: GOAL_MAX, goal: GOAL,
                log: h.log, command: h.command, member: 'm',
                logPrefix: site.logPrefix,
                ...site.opts(),
            });
            texts.push(h.skipLines()[0].slice(site.logPrefix.length));
        }
        assert.equal(new Set(texts).size, 1, `the skip text diverged between sites: ${JSON.stringify(texts)}`);
    });

    for (const site of SITES) {
        test(`${site.name}: FAIL OPEN -- a THROWING scope lookup applies the reopens rather than dropping them`, async () => {
            const h = buildHarness({ scopeThrows: true });
            const reopened = await applyGuardedReopens({
                entries: site.entries,
                bdListScoped: h.bdListScoped, goalMax: GOAL_MAX, goal: GOAL,
                log: h.log, command: h.command, member: 'm',
                logPrefix: site.logPrefix,
                ...site.opts(),
            });

            assert.deepEqual(
                reopened, ['in-goal', 'deferred'],
                'a failed scope lookup must NEVER silently swallow a reviewer\'s reopens'
            );
            assert.deepEqual(h.reopenedCmdIds(), ['in-goal', 'deferred']);
            assert.equal(h.skipLines().length, 0, 'nothing is skipped when the allowlist could not be built');
        });
    }

    test('buildReopenAllowlist returns null (fail open) on a throwing lookup, a Map otherwise', async () => {
        assert.equal(await buildReopenAllowlist(async () => { throw new Error('boom'); }), null);
        const allowlist = await buildReopenAllowlist(async () => IN_SCOPE_BEADS);
        assert.ok(allowlist instanceof Map);
        assert.equal(allowlist.get('deferred').priority, 3);
    });

    test('isDeferredScopeReopen skips ONLY a known bead with a numeric below-goal priority', async () => {
        const allowlist = await buildReopenAllowlist(async () => IN_SCOPE_BEADS);
        assert.equal(isDeferredScopeReopen(allowlist, 'deferred', GOAL_MAX).deferred, true);
        assert.equal(isDeferredScopeReopen(allowlist, 'in-goal', GOAL_MAX).deferred, false);
        assert.equal(isDeferredScopeReopen(allowlist, 'also-in-goal', GOAL_MAX).deferred, false,
            'a bead exactly AT the goal max is in scope -- the check is strictly greater-than');
        assert.equal(isDeferredScopeReopen(allowlist, 'no-priority', GOAL_MAX).deferred, false,
            'a bead with no numeric priority is never skipped');
        assert.equal(isDeferredScopeReopen(allowlist, 'never-heard-of-it', GOAL_MAX).deferred, false,
            'a bead absent from the allowlist is never skipped -- the pre-extraction sites let those through');
        assert.equal(isDeferredScopeReopen(null, 'deferred', GOAL_MAX).deferred, false,
            'a null allowlist means FAIL OPEN, never "skip everything"');
    });

    test('normalizeGoalMax accepts both the Pn string form and a bare number', () => {
        assert.equal(normalizeGoalMax('P2'), 2);
        assert.equal(normalizeGoalMax('p2'), 2);
        assert.equal(normalizeGoalMax(2), 2);
        assert.ok(Number.isNaN(normalizeGoalMax('nonsense')), 'an unparseable ceiling degrades to never-skip, not skip-everything');
        assert.ok(Number.isNaN(normalizeGoalMax(undefined)));
    });

    test("REGRESSION: the raw 'Pn' string ceiling must not silently disable the guard", async () => {
        // `3 > 'P2'` is a NaN comparison and therefore always false, so the
        // pre-extraction guard never skipped anything at ANY site, for ANY
        // priority. Prove the string form now behaves exactly like the number.
        const allowlist = await buildReopenAllowlist(async () => IN_SCOPE_BEADS);
        for (const form of ['P2', 2]) {
            assert.equal(isDeferredScopeReopen(allowlist, 'deferred', form).deferred, true,
                `a P3 bead must be refused with goalMax as ${JSON.stringify(form)}`);
            assert.equal(isDeferredScopeReopen(allowlist, 'also-in-goal', form).deferred, false);
        }
        assert.equal(
            isDeferredScopeReopen(allowlist, 'deferred', 'P2').deferred,
            isDeferredScopeReopen(allowlist, 'deferred', 2).deferred,
            'the two ceiling forms must agree'
        );
    });

    test('an empty verdict issues NO scope lookup at all', async () => {
        let looked = false;
        const reopened = await applyGuardedReopens({
            entries: [],
            bdListScoped: async () => { looked = true; return []; },
            goalMax: GOAL_MAX, goal: GOAL, log: () => {}, command: async () => {}, member: 'm',
            logPrefix: 'Reviewer reopenIds',
            buildReopenCommand: ({ id }) => ({ cmd: `bd update ${id} --status=open`, label: 'x' }),
        });
        assert.deepEqual(reopened, []);
        assert.equal(looked, false, 'a bd list per empty verdict is real dispatch cost -- do not pay it');
    });

    test('every reopen this module dispatches carries member_name', async () => {
        const h = buildHarness();
        await applyGuardedReopens({
            entries: ['in-goal'],
            bdListScoped: h.bdListScoped, goalMax: GOAL_MAX, goal: GOAL,
            log: h.log, command: h.command, member: 'orchestrator-member',
            logPrefix: 'Reviewer reopenIds',
            buildReopenCommand: ({ id }) => ({ cmd: `bd update ${id} --status=open`, label: `Reopen ${id}` }),
        });
        assert.deepEqual(h.commands[0].opts, { member_name: 'orchestrator-member', silent: true, label: 'Reopen in-goal' });
    });
});

describe('apra-fleet-3swo.4.7: the three payload shapes stay distinct (only the guard was unified)', () => {
    test('Final Review still REFUSES an entry missing its reason (and one missing its id)', async () => {
        const h = buildHarness();
        const reopened = await applyGuardedReopens({
            entries: [
                { id: 'in-goal', reason: 'genuinely still broken' },
                { id: 'also-in-goal' },                       // no reason
                { id: 'also-in-goal', reason: '   ' },        // whitespace-only reason
                { reason: 'orphan reason' },                  // no id
                null,
            ],
            bdListScoped: h.bdListScoped, goalMax: GOAL_MAX, goal: GOAL,
            log: h.log, command: h.command, member: 'm',
            logPrefix: 'Final Review reopenIds',
            parseEntry: parseIdWithReasonEntry,
            buildReopenCommand: ({ id, reason }) => ({
                cmd: `bd update ${id} --status=open --append-notes "[Final Review C3] Reopened -- ${reason}"`,
                label: `Reopen ${id} per Final Review verdict`,
            }),
        });

        assert.deepEqual(reopened, ['in-goal'], 'only the well-formed entry is reopened');
        const malformed = h.logs.filter((l) => l.includes('both id and reason are required'));
        assert.equal(malformed.length, 4, 'each malformed entry is logged, not silently dropped');
        assert.ok(malformed[0].startsWith('Final Review reopenIds: SKIPPED a malformed entry (both id and reason are required) -- '));
    });

    test('the bare-string sites keep their own shape and carry no reason', () => {
        assert.deepEqual(parseBareIdEntry('bead-1'), { id: 'bead-1', reason: '' });
        assert.deepEqual(parseBareIdEntry('  bead-1  '), { id: 'bead-1', reason: '' });
        assert.ok(parseBareIdEntry('').error, 'an empty id is refused rather than sent as `bd update  --status=open`');
        assert.ok(parseBareIdEntry({ id: 'bead-1' }).error, 'an object entry is not this site\'s shape');
        assert.deepEqual(parseIdWithReasonEntry({ id: ' b ', reason: ' r ' }), { id: 'b', reason: 'r' });
    });

    test('a builder may refuse an entry it cannot render safely, without failing the batch', async () => {
        const h = buildHarness();
        const reopened = await applyGuardedReopens({
            entries: [{ id: 'in-goal', reason: 'ok' }, { id: 'also-in-goal', reason: 'unsanitizable' }],
            bdListScoped: h.bdListScoped, goalMax: GOAL_MAX, goal: GOAL,
            log: h.log, command: h.command, member: 'm',
            logPrefix: 'Final Review reopenIds',
            parseEntry: parseIdWithReasonEntry,
            buildReopenCommand: ({ id, reason }) => (reason === 'unsanitizable'
                ? null
                : { cmd: `bd update ${id} --status=open`, label: `Reopen ${id}` }),
        });
        assert.deepEqual(reopened, ['in-goal']);
    });

    test('onEntryError makes a failing reopen non-fatal (Final Review); without it the error propagates', async () => {
        const h = buildHarness({ commandThrowsFor: 'also-in-goal' });
        const seen = [];
        const reopened = await applyGuardedReopens({
            entries: [{ id: 'also-in-goal', reason: 'first' }, { id: 'in-goal', reason: 'second' }],
            bdListScoped: h.bdListScoped, goalMax: GOAL_MAX, goal: GOAL,
            log: h.log, command: h.command, member: 'm',
            logPrefix: 'Final Review reopenIds',
            parseEntry: parseIdWithReasonEntry,
            buildReopenCommand: ({ id }) => ({ cmd: `bd update ${id} --status=open`, label: `Reopen ${id}` }),
            onEntryError: (entry, err) => seen.push([entry.id, err.message]),
        });
        assert.deepEqual(reopened, ['in-goal'], 'the batch continues past a failing entry');
        assert.deepEqual(seen, [['also-in-goal', 'bd update failed']]);

        const h2 = buildHarness({ commandThrowsFor: 'in-goal' });
        await assert.rejects(() => applyGuardedReopens({
            entries: ['in-goal'],
            bdListScoped: h2.bdListScoped, goalMax: GOAL_MAX, goal: GOAL,
            log: h2.log, command: h2.command, member: 'm',
            logPrefix: 'Reviewer reopenIds',
            buildReopenCommand: ({ id }) => ({ cmd: `bd update ${id} --status=open`, label: 'x' }),
        }), /bd update failed/, 'the sites that never had a per-entry catch must not silently gain one');
    });
});

describe('apra-fleet-3swo.4.7: the replanIds fold', () => {
    const mkLog = () => { const logs = []; return { logs, log: (m) => logs.push(m) }; };

    test('an id in replanIds but NOT in reopenIds is still DROPPED', () => {
        const { logs, log } = mkLog();
        const accepted = foldReplanIds({
            replanIds: ['reopened-one', 'never-reopened'],
            reopenedIds: new Set(['reopened-one']),
            replannedThisCycle: new Set(),
            cycle: 2, log,
        });
        assert.deepEqual(accepted, ['reopened-one']);
        const dropped = logs.filter((l) => l.includes("replanIds: DROPPED 'never-reopened'"));
        assert.equal(dropped.length, 1, 'the drop must be visible in the run log, not vanish with no trace');
        assert.ok(dropped[0].includes('requires replanIds to be a subset of reopenIds'));
    });

    test('an id the SCOPE GUARD skipped can never sneak back in through replanIds', () => {
        const { logs, log } = mkLog();
        // 'deferred' was named in reopenIds but skipped as below-goal, so it is
        // absent from reopenedIds -- exactly the set applyGuardedReopens returns.
        const accepted = foldReplanIds({
            replanIds: ['deferred'],
            reopenedIds: new Set(['in-goal']),
            replannedThisCycle: new Set(),
            cycle: 1, log,
        });
        assert.deepEqual(accepted, []);
        assert.ok(logs.some((l) => l.includes("replanIds: DROPPED 'deferred'")));
    });

    test('the replan loop guard refuses a SECOND in-cycle scoped replan for the same bead', () => {
        const { logs, log } = mkLog();
        const accepted = foldReplanIds({
            replanIds: ['fresh', 'already-done'],
            reopenedIds: new Set(['fresh', 'already-done']),
            replannedThisCycle: new Set(['already-done']),
            cycle: 3, log,
        });
        assert.deepEqual(accepted, ['fresh']);
        const guard = logs.filter((l) => l.includes('replan loop guard'));
        assert.equal(guard.length, 1);
        assert.ok(guard[0].includes('(C3)') && guard[0].includes('max one per bead per cycle'));
    });

    test('an absent replanIds field is a no-op', () => {
        const { logs, log } = mkLog();
        assert.deepEqual(foldReplanIds({ replanIds: undefined, reopenedIds: new Set(), replannedThisCycle: new Set(), cycle: 1, log }), []);
        assert.deepEqual(logs, []);
    });
});

describe('apra-fleet-3swo.4.7: the verdict contract predicate moved intact', () => {
    test('isReviewerContractViolation is re-exported from runner.js and is this module\'s implementation', () => {
        assert.equal(runner.isReviewerContractViolation, isReviewerContractViolation, 'runner.js must re-export, not re-implement');
    });

    test('a CHANGES_NEEDED verdict naming nothing actionable violates the contract; replanIds alone exempts it', () => {
        assert.equal(isReviewerContractViolation({ verdict: 'CHANGES_NEEDED', reopenIds: [], newTasks: [], replanIds: [] }), true);
        assert.equal(isReviewerContractViolation({ verdict: 'CHANGES_NEEDED' }), true);
        assert.equal(isReviewerContractViolation({ verdict: 'CHANGES_NEEDED', reopenIds: ['a'], newTasks: [], replanIds: [] }), false);
        assert.equal(isReviewerContractViolation({ verdict: 'CHANGES_NEEDED', reopenIds: [], newTasks: [{}], replanIds: [] }), false);
        assert.equal(isReviewerContractViolation({ verdict: 'CHANGES_NEEDED', reopenIds: [], newTasks: [], replanIds: ['a'] }), false);
        assert.equal(isReviewerContractViolation({ verdict: 'APPROVED', reopenIds: [], newTasks: [], replanIds: [] }), false);
    });
});

describe('apra-fleet-3swo.4.7: the engine routes ALL THREE sites through the shared guard', () => {
    // apra-fleet-3swo.6.5: re-anchored to a SET of files, not runner.js alone.
    // The per-round reviewer site moved verbatim into
    // fleet-sprint/phases/review.mjs with the Review phase. A scan that kept
    // pointing at runner.js alone would not have failed on the missing site --
    // it would have kept asserting "exactly three" against two, which is why
    // the per-file split below is pinned explicitly rather than left to the
    // concatenated total.
    //
    // apra-fleet-3swo.6.8: the Re-Review site then moved into
    // fleet-sprint/phases/re-review.mjs with the Re-Review phase, so the set
    // grows to three files and the split becomes 1/1/1. This is the site the
    // whole extraction exists for -- it was the previously UNGUARDED one --
    // and a slice that quietly reintroduced a private reopen loop there would
    // otherwise have left runner.js holding only Final Review while the total
    // silently dropped to two.
    //
    // apra-fleet-3swo.6.6: the LAST inline site, Final Review, then moved into
    // fleet-sprint/phases/final-review.mjs. runner.js now owns ZERO of the
    // three, so its entry below is deliberately kept in SOURCES with an
    // asserted count of 0 rather than dropped: that is what turns a future
    // slice leaving a stray copy behind -- or a re-inlined reopen loop -- red
    // instead of invisible. The split is now 1/1/1/0.
    const RUNNER_SRC = fs.readFileSync(RUNNER_PATH, 'utf8');
    const REVIEW_PHASE_SRC = fs.readFileSync(path.join(__dirname, '../fleet-sprint/phases/review.mjs'), 'utf8');
    const RE_REVIEW_PHASE_SRC = fs.readFileSync(path.join(__dirname, '../fleet-sprint/phases/re-review.mjs'), 'utf8');
    const FINAL_REVIEW_PHASE_SRC = fs.readFileSync(path.join(__dirname, '../fleet-sprint/phases/final-review.mjs'), 'utf8');
    // Scanned as separate files, never concatenated: every assertion below
    // uses lastIndexOf() to prove a marker precedes another IN THE SAME
    // lexical scope, and concatenating the files would let a landmark in one
    // satisfy a match in another.
    const SOURCES = [
        { name: 'fleet-sprint/runner.js', src: RUNNER_SRC },
        { name: 'fleet-sprint/phases/review.mjs', src: REVIEW_PHASE_SRC },
        { name: 'fleet-sprint/phases/re-review.mjs', src: RE_REVIEW_PHASE_SRC },
        { name: 'fleet-sprint/phases/final-review.mjs', src: FINAL_REVIEW_PHASE_SRC },
    ];
    /** The file that must own each site's `logPrefix`, after the Final Review slice. */
    const SITE_OWNER = {
        'Reviewer reopenIds': 'fleet-sprint/phases/review.mjs',
        'Final Review reopenIds': 'fleet-sprint/phases/final-review.mjs',
        'Re-review reopenIds': 'fleet-sprint/phases/re-review.mjs',
    };
    // Counted on `applyGuardedReopens({` -- the call-with-options-object shape
    // -- so prose mentions of `applyGuardedReopens()` in the surrounding
    // comments are not miscounted as call sites.
    const countGuardCalls = (src) => (src.match(/applyGuardedReopens\(\{/g) || []).length;

    test('each of the three site labels is applied via applyGuardedReopens', () => {
        for (const [prefix, ownerName] of Object.entries(SITE_OWNER)) {
            const owner = SOURCES.find((f) => f.name === ownerName);
            const at = owner.src.indexOf(`logPrefix: '${prefix}'`);
            assert.ok(at > 0, `${owner.name} has no "${prefix}" site at all`);
            const guardAt = owner.src.lastIndexOf('applyGuardedReopens({', at);
            const loopAt = owner.src.lastIndexOf('for (const id of', at);
            assert.ok(
                guardAt > 0 && guardAt > loopAt,
                `${owner.name} no longer routes the "${prefix}" site through applyGuardedReopens -- a private reopen loop is an unguarded site`
            );
            // ...and no OTHER scanned file may also carry it: a site that was
            // COPIED rather than MOVED leaves two sources of truth for one
            // reopen path, which the totals below would not notice.
            for (const other of SOURCES.filter((f) => f.name !== ownerName)) {
                assert.equal(
                    other.src.includes(`logPrefix: '${prefix}'`), false,
                    `${other.name} must not also carry the "${prefix}" site -- it belongs to ${ownerName}`
                );
            }
        }
        assert.equal(
            SOURCES.reduce((n, f) => n + countGuardCalls(f.src), 0), 3,
            'exactly three call sites across runner.js + phases/review.mjs + phases/re-review.mjs + phases/final-review.mjs: per-round reviewer, Final Review, Re-Review'
        );
        // The split itself, so the total above cannot be satisfied by three
        // sites all landing back in one file.
        assert.equal(countGuardCalls(REVIEW_PHASE_SRC), 1, 'phases/review.mjs owns exactly the per-round reviewer site');
        assert.equal(countGuardCalls(RE_REVIEW_PHASE_SRC), 1, 'phases/re-review.mjs owns exactly the Re-Review site');
        assert.equal(countGuardCalls(FINAL_REVIEW_PHASE_SRC), 1, 'phases/final-review.mjs owns exactly the Final Review site');
        assert.equal(countGuardCalls(RUNNER_SRC), 0, 'runner.js owns NONE of the three sites after apra-fleet-3swo.6.6 -- a nonzero count here means a phase slice left a copy behind or a reopen loop was re-inlined');
    });

    test('no scanned file keeps a private reopen loop or private allowlist of its own', () => {
        for (const { name, src } of SOURCES) {
            assert.ok(!/reopenAllowlist/.test(src), `the goal-scope allowlist belongs to beads-transitions.mjs now (${name})`);
            assert.ok(
                !/for \(const id of \w*[Vv]erdict\.reopenIds\)/.test(src),
                `a bare loop over a verdict's reopenIds is exactly the unguarded shape this extraction removed (${name})`
            );
        }
    });

    test('every `bd update ... --status=open` reopen is built inside an applyGuardedReopens call', () => {
        const total = SOURCES.reduce((n, f) => n + [...f.src.matchAll(/bd update \$\{id\} --status=open/g)].length, 0);
        assert.ok(total >= 3, 'expected the three sites to still build their own command text');
        for (const { name, src } of SOURCES) {
            for (const m of src.matchAll(/bd update \$\{id\} --status=open/g)) {
                const preceding = src.slice(0, m.index);
                const lastGuard = preceding.lastIndexOf('applyGuardedReopens({');
                const lastAwaitCommand = preceding.lastIndexOf('await command(');
                assert.ok(
                    lastGuard > lastAwaitCommand,
                    `a reopen command near index ${m.index} in ${name} is not inside an applyGuardedReopens call -- it would bypass the goal-scope guard`
                );
            }
        }
    });
});
