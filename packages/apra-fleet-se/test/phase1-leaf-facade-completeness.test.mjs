import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

// Namespace import on purpose (see vcs-auth-extraction-facade.test.mjs and
// phase0-seams-facade.test.mjs): a STATIC named import of a symbol this suite
// is checking for would turn a dropped re-export into a module-load
// SyntaxError that kills this whole file before assertion (1) can name the
// missing symbol. Every runner.js-sourced symbol below is reached via
// `runner.<name>`.
import * as runner from '../fleet-sprint/runner.js';
// selectStreaks was module-private to the pre-move runner.js region and stays
// module-private to worklists.mjs after the move (runner.js imports it back,
// but does not re-export it) -- it is only reachable directly from
// worklists.mjs, never through the runner.js facade.
import { selectStreaks } from '../fleet-sprint/worklists.mjs';
// apra-fleet-3swo.53: shared with phase3-dispatch-engine-completeness.test.mjs
// -- see that module's header for why this was extracted. (excerptChildOutput
// also lives there, used internally by handleNestedSuiteSpawnResult; this file
// has no direct use for it. The excerpt cap IS used directly, by section (6)
// case (b4), to prove the failing entry it asserts on really does sit outside
// the quoted tail window.)
import {
    handleNestedSuiteSpawnResult,
    extractFailingTapEntries,
    MAX_NESTED_SUITE_FAILURE_EXCERPT_CHARS,
} from './helpers/nested-suite-spawn.mjs';
// apra-fleet-j918.7.1: the six handler unit cases this file shares verbatim
// with phase3-dispatch-engine-completeness.test.mjs now live in one
// table-driven factory, instantiated below with this gate's own tuple.
import { describeHandleNestedSuiteSpawnResultCases } from './helpers/nested-suite-spawn-cases.mjs';
// apra-fleet-x0mr.1: the bd-mock-shim contract's own backend reading, used to
// pick this gate's nested-suite budget. Imported rather than re-derived from
// APRA_FLEET_BD_MOCK so a change to the spelling set cannot desynchronize.
import { bdMode } from './helpers/bd-replay.mjs';

// =============================================================================
// apra-fleet-3swo.3.7 -- prove Phase 1's leaf extractions (sprint-args.mjs
// apra-fleet-3swo.3.3, prompts.mjs apra-fleet-3swo.3.4, worklists.mjs
// apra-fleet-3swo.3.5, abort.mjs/branch-ensure.mjs apra-fleet-3swo.3.6, on
// top of the already-tested vcs-auth.mjs apra-fleet-3swo.3.1/3.2) left
// runner.js's public surface unchanged and did not smuggle behaviour changes
// into what were meant to be move-only extractions.
// =============================================================================

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SE_DIR = path.join(__dirname, '..');
const REPO_ROOT = path.join(SE_DIR, '../..');
const RUNNER_PATH = path.join(SE_DIR, 'fleet-sprint/runner.js');
const BRANCH_ENSURE_PATH = path.join(SE_DIR, 'fleet-sprint/branch-ensure.mjs');
const WORKLISTS_PATH = path.join(SE_DIR, 'fleet-sprint/worklists.mjs');
const SPRINT_ARGS_PATH = path.join(SE_DIR, 'fleet-sprint/sprint-args.mjs');
const GOLDEN_FIXTURE_DIR = path.join(__dirname, 'fixtures', 'golden-transcript');

// -----------------------------------------------------------------------------
// apra-fleet-3yuu.1 / apra-fleet-x0mr.1: shared, BACKEND-AWARE, env-overridable
// nested-suite spawn budget.
//
// describe (3) below spawns the two golden-transcript suites as a nested
// `node --test` child via execFileSync. It used to hard-code a 60s literal
// (apra-fleet-3yuu.1 replaced that with the flat 900_000ms constant below),
// and 900_000ms is a fine budget for the MOCK (replay) bd backend -- the
// nested child finishes in seconds there. It is not a fine budget for the
// real-bd suite: that run failed with "nested suite 'golden-transcript'
// exceeded its 900000ms budget" with no override set (apra-fleet-x0mr), the
// enclosing file taking 1811676ms overall. golden-transcript.test.mjs alone
// took 562s standalone under real bd when apra-fleet-3yuu was written, and
// that figure predates both the second golden file joining this nested run
// and the outer suite's concurrency contention.
//
// apra-fleet-x0mr.1 DECISION -- option (a), derive/expose the budget, chosen
// over option (b), deleting this nested run as a duplicate of phase3's:
//   - Option (b) would have left this file with NO nested spawn at all, which
//     makes runNestedSuite() below dead code and turns sections (6)/(6d) --
//     the handler-and-budget gates whose phase1 tuple apra-fleet-j918.7.1 had
//     just been required to keep covered -- into tests of machinery this file
//     no longer uses. Deleting a duplicate must not cost a live gate its
//     subject.
//   - Option (a) fixes the actual reported failure (a budget calibrated for
//     one backend applied to another) at its cause, and does so with the
//     mechanism phase3-dispatch-engine-completeness.test.mjs already proved
//     out for exactly this problem: resolve from bdMode() rather than from a
//     flat constant.
// The cost accepted: under real bd the golden pair is still spawned here as
// well as by phase3 section (7). That duplication is real, but it is a
// wall-clock cost, not a correctness one, and it is the subject of its own
// consolidation work -- not something to smuggle in under a budget fix.
//
// NOT scaledTimeout(), deliberately: test/helpers/scaled-timeout.mjs reads
// APRA_FLEET_TEST_CONCURRENCY, which only scripts/run-tests.mjs exports. The
// package.json test script passes --test-concurrency=8 WITHOUT it, so every
// scaledTimeout caller silently runs on its unscaled base budget under the
// very command CI runs. bdMode() has no such gap: it reads
// APRA_FLEET_BD_MOCK, which is set by whoever selects the backend and is
// therefore identical under `npm test`, under scripts/run-tests.mjs, and
// under scripts/run-integ-suites.mjs. Section (6d) pins that equivalence.
//
// This constant used to also budget a second nested spawn, describe (4)'s
// full mock-sprint suite run; that run was deleted in apra-fleet-j918.3.2 as
// a duplicate of phase3-dispatch-engine-completeness.test.mjs's stronger
// copy (which derives its own, separate budget), leaving describe (3) as the
// sole consumer of this constant.
//
// Override: set PHASE1_NESTED_SUITE_TIMEOUT_MS (milliseconds) in the
// environment to use a different budget for the nested spawn below. It wins
// on EITHER backend -- it is the escape hatch the timeout message itself
// tells the reader to reach for.
// -----------------------------------------------------------------------------
const DEFAULT_NESTED_SUITE_TIMEOUT_MS = 900_000;

// The nested child's file list, declared ONCE and used both as the spawn argv
// and as the file count the real-bd budget derives from, so the two can never
// disagree: adding a third golden file here raises the budget with it, and a
// renamed/deleted file trips the existence check below instead of silently
// shrinking the nested run to something that still exits 0.
const NESTED_GOLDEN_SUITE_FILES = [
    'test/golden-transcript.test.mjs',
    'test/golden-transcript-3bead.test.mjs',
];
for (const rel of NESTED_GOLDEN_SUITE_FILES) {
    if (!fs.existsSync(path.join(SE_DIR, rel))) {
        throw new Error(
            `phase1 nested golden-transcript run names ${rel}, which does not exist. A nested child given a ` +
            'missing file runs nothing and exits 0, which would read as a pass -- fix the list rather than ' +
            'letting this gate go vacuous.',
        );
    }
}

// -----------------------------------------------------------------------------
// REAL-BD BUDGET DERIVATION (apra-fleet-x0mr.1), stated as factors a reader
// can re-multiply rather than as one opaque literal:
//   ASSUMED_REAL_BD_GOLDEN_PER_FILE_MS (900_000 -- 15 min/file, above the 562s
//     apra-fleet-3yuu measured for golden-transcript.test.mjs standalone under
//     real bd, with room for the outer suite's concurrency contention)
//   x NESTED_GOLDEN_SUITE_FILES.length (2 as written, read live from the list
//     above; the nested child does NOT cap its own concurrency, so treating
//     the files as serial is the conservative direction)
//   x REAL_BD_HEADROOM_FACTOR (2, for run-to-run variance -- the same factor
//     phase3's derivation uses)
// = 900_000 x 2 x 2 = 3_600_000ms (1h) at the 2-file count in force here.
//
// Sanity-check against the failure this fixes: the whole phase1 file took
// 1811676ms (~30min) in that run WITH a second nested spawn also running, so
// 1h is comfortably above the worst observed cost of the run it must cover,
// while still small enough to bind -- a genuine hang is caught within the
// hour rather than sitting until the outer harness gives up.
//
// CEILING, for the same reason phase3 has one (apra-fleet-3swo.51): the
// derivation scales linearly with the file count, and a budget larger than
// the suite it lives in can never bind, silently retiring all hang detection
// on the real-bd path. 2h is ~2x the derived value at the current count, so
// the ceiling only bites if that count grows past 4 files.
// -----------------------------------------------------------------------------
const ASSUMED_REAL_BD_GOLDEN_PER_FILE_MS = 900_000;
const REAL_BD_HEADROOM_FACTOR = 2;
const REAL_BD_NESTED_SUITE_TIMEOUT_CEILING_MS = 2 * 60 * 60 * 1000; // 7_200_000ms
const REAL_BD_NESTED_SUITE_TIMEOUT_MS = Math.min(
    Math.ceil(ASSUMED_REAL_BD_GOLDEN_PER_FILE_MS * NESTED_GOLDEN_SUITE_FILES.length * REAL_BD_HEADROOM_FACTOR),
    REAL_BD_NESTED_SUITE_TIMEOUT_CEILING_MS,
);

const PHASE1_ENV_VAR_NAME = 'PHASE1_NESTED_SUITE_TIMEOUT_MS';
const PHASE1_TIMEOUT_EXTRA_GUIDANCE =
    'or investigate a real hang -- this is not the per-dispatch bd+dolt latency work tracked separately.';

/**
 * Resolves this gate's nested-suite timeout budget and a human-readable
 * description of where it came from. PHASE1_NESTED_SUITE_TIMEOUT_MS, when
 * set, is the highest-precedence value on either backend; otherwise the
 * budget follows the bd backend actually in force for this process (and so
 * for the nested child, which inherits the environment). The backend reading
 * comes from bdMode() in test/helpers/bd-replay.mjs -- the bd-mock-shim
 * contract's own source -- rather than being re-derived from
 * APRA_FLEET_BD_MOCK here.
 */
function resolveNestedSuiteTimeoutBudget() {
    const raw = process.env.PHASE1_NESTED_SUITE_TIMEOUT_MS;
    if (raw !== undefined && raw !== '') {
        const parsed = Number(raw);
        if (!Number.isFinite(parsed) || parsed <= 0) {
            throw new Error(`PHASE1_NESTED_SUITE_TIMEOUT_MS must be a positive number of milliseconds, got: ${JSON.stringify(raw)}`);
        }
        return { ms: parsed, source: `${PHASE1_ENV_VAR_NAME}=${raw}` };
    }
    const mode = bdMode();
    if (mode === 'replay') {
        return {
            ms: DEFAULT_NESTED_SUITE_TIMEOUT_MS,
            source: `the mock-bd default (backend=${mode}, no ${PHASE1_ENV_VAR_NAME} override set)`,
        };
    }
    return {
        ms: REAL_BD_NESTED_SUITE_TIMEOUT_MS,
        source: `the real-bd default (backend=${mode}, no ${PHASE1_ENV_VAR_NAME} override set)`,
    };
}

function resolveNestedSuiteTimeoutMs() {
    return resolveNestedSuiteTimeoutBudget().ms;
}

const NESTED_SUITE_TIMEOUT_MS = resolveNestedSuiteTimeoutMs();

/** Human-readable description of where NESTED_SUITE_TIMEOUT_MS came from. */
function resolvePhase1BudgetSource() {
    return resolveNestedSuiteTimeoutBudget().source;
}

/**
 * Runs a nested `node --test` suite via execFileSync under the shared
 * NESTED_SUITE_TIMEOUT_MS budget above, self-describing on timeout instead of
 * letting a bare "spawnSync node ETIMEDOUT" reach the test output.
 *
 * Uses the shared handleNestedSuiteSpawnResult helper (imported above) to
 * process the result, ensuring the test suite can verify the same
 * error-handling logic with synthesized results (see test section (6) below).
 */
function runNestedSuite(suiteLabel, args, extraOpts = {}) {
    let spawnError;
    try {
        return execFileSync(process.execPath, args, {
            cwd: SE_DIR,
            encoding: 'utf8',
            stdio: 'pipe',
            timeout: NESTED_SUITE_TIMEOUT_MS,
            ...extraOpts,
        });
    } catch (err) {
        spawnError = err;
    }
    handleNestedSuiteSpawnResult(
        suiteLabel,
        spawnError,
        NESTED_SUITE_TIMEOUT_MS,
        resolvePhase1BudgetSource(),
        PHASE1_ENV_VAR_NAME,
        PHASE1_TIMEOUT_EXTRA_GUIDANCE,
    );
}

// -----------------------------------------------------------------------------
// (1) runner.js's export surface is a superset of what it exported right
// before the Phase 1 leaf extractions began (git commit e5f7246b, the parent
// of the first leaf-extraction commit c516f0d2 "extract sprint-args.mjs
// move-only"). This literal list is a snapshot of `Object.keys()` on that
// commit's runner.js, taken independently of the module under test (not
// derived from it), so a symbol dropped from BOTH the snapshot and the
// current module would still be caught by a human diffing this list against
// the historical commit -- and, more importantly, a symbol dropped only from
// the CURRENT module fails the superset assertion below loudly.
// -----------------------------------------------------------------------------
const PRE_PHASE1_LEAF_EXPORT_SET = [
    'DEFAULT_CONTEXT_CEILING', 'DEFAULT_EFFORT_THRESHOLD', 'KB_CAPTURE_TYPES', 'KB_MAX_KNOWLEDGE_ENTRIES', 'KB_MAX_PROMOTION_CANDIDATES', 'KB_MIN_PROMOTE_REASON',
    'KB_PROMOTER_ROLES', 'KB_SELF_INJECTING_ROLES', 'MODEL_WEIGHT', 'SIZE_POINTS', 'appendRejectedFindingToParentNotes', 'assignDoerWorklists',
    'beadBlocksDependencyIds', 'buildCostAnalysis', 'buildCredentialReadCommand', 'buildDoerPrompt', 'buildFinalVerdictPrompt', 'buildHarvesterPrompt',
    'buildPlannerPrompt', 'buildRejectedNewTaskResurfaceLines', 'buildReviewerPrompt', 'captureDoltConflictDump', 'checkMemberTopology', 'claimBeadsBatched',
    'classifyDoltFailure', 'classifyGitFailure', 'classifyVerifySet', 'clearMemberOsCache', 'clearResubmittedNewTask', 'commandResultToSoftGit',
    'computeBranchSlug', 'computeChildFloor', 'computeLaneEffort', 'createChildBeadWithAllocatedId', 'createDeployPermissionsProvisioner', 'createHttpChildIdAllocatorClient',
    'createHttpDoltPushMutexClient', 'createKbPrimingClient', 'createKbWorkClient', 'createLlmAuthSelfHealCallback', 'createMcpChildIdAllocatorClient', 'createMcpDoltPushMutexClient',
    'createMemberReservationClient', 'createMemberSessionGuard', 'createMemberVcsProviderResolver', 'createRoundSessionRegistry', 'createUnattendedAutoProvisioner', 'createVcsAuthPreflightCallback',
    'createVcsAuthSelfHealCallback', 'decideEnsureBranchAction', 'doltPullBefore', 'doltPushAfter', 'extractConflictingTables', 'extractContestedBeadIds',
    'extractDoltRemoteUrl', 'finalizeAbort', 'findDoltDivergedCause', 'goalPriorityMax', 'groupStreaksFromLaneMetadata', 'hasContextHeadroomForResume',
    'installFatalDiagnosticsGuard', 'isMemberSyncRemoteConfigured', 'isNoMutationDispatchFailure', 'isReviewerContractViolation', 'isTerminalSprintFailure', 'isTypedAbortError',
    'kbKnowledgeBlock', 'kbPromotionBlock', 'kbQueryTerms', 'main', 'meta', 'normalizeTierToken',
    'parseBdJson', 'parseOwnerRepoFromRemoteUrl', 'parseRepoScopeFromRemoteUrl', 'parseUnmergedPaths', 'partitionByGoalMembership', 'persistNewTaskBestEffort',
    'preflightBeadsHealthGate', 'reconcilePendingRejectedNewTasks', 'resolveMemberOs', 'resolveMemberTarget', 'resolveTerminalReason', 'resolveWorklistTierPolicy',
    'resultText', 'resyncReacquiredMember', 'sanitizeNewTaskDescription', 'sanitizeNewTaskTitle', 'sanitizePrText', 'streakEffortPoints',
    'streakMinPriority', 'streakRequiredTier', 'syncMemberAfter', 'syncMemberAfterOrdered', 'syncMemberBefore', 'toolErrorText',
    'trackRejectedNewTaskForResurfacing', 'validateArgs', 'validateBranchName', 'validateIssueId', 'validateNewTask', 'vcsCredentialLabelForProvider',
    'verifyDoerStreakClosed', 'vetKbWork', 'withDispatchWatchdog',
];

describe('(1) runner.js re-exports every symbol it exported before the Phase 1 leaf extractions', () => {
    test('the explicit 105-symbol baseline is exactly covered (no accidental duplicates/typos)', () => {
        assert.equal(PRE_PHASE1_LEAF_EXPORT_SET.length, 105);
        assert.equal(new Set(PRE_PHASE1_LEAF_EXPORT_SET).size, 105, 'no duplicates in the baseline list');
    });

    test('the current runner.js export set is a superset of the pre-Phase-1-leaf baseline', () => {
        const current = new Set(Object.keys(runner));
        const missing = PRE_PHASE1_LEAF_EXPORT_SET.filter((name) => !current.has(name));
        assert.deepEqual(
            missing,
            [],
            `runner.js dropped previously-exported symbol(s): ${missing.join(', ')}. A Phase 1 leaf extraction (sprint-args.mjs/prompts.mjs/worklists.mjs/abort.mjs/branch-ensure.mjs) must re-export every symbol it moved.`,
        );
        for (const name of PRE_PHASE1_LEAF_EXPORT_SET) {
            assert.notEqual(runner[name], undefined, `runner.${name} must be defined, not just an own-enumerable key`);
        }
    });

    test('falsification: removing the decideEnsureBranchAction re-export line demonstrably breaks the superset assertion, then the line is restored', async () => {
        // Sandboxed copy, not the live tracked runner.js -- this file is
        // statically imported (via '../fleet-sprint/runner.js') by every other
        // test in a full `npm test` run (test-concurrency=8, dozens of files as
        // separate processes at once); mutating the shared tracked file in
        // place, even briefly and even restored synchronously, risks a
        // concurrent process observing it mid-edit. See phase0-seams-facade
        // .test.mjs for the identical rationale and cleanup convention.
        const realRunnerContentBefore = fs.readFileSync(RUNNER_PATH, 'utf-8');
        const sandboxDir = fs.mkdtempSync(path.join(os.tmpdir(), 'phase1-leaf-facade-'));
        assert.ok(
            fs.realpathSync(sandboxDir).startsWith(fs.realpathSync(os.tmpdir())),
            'the sandbox must live under os.tmpdir(), not the repo tree',
        );
        try {
            const sandboxFleetSprint = path.join(sandboxDir, 'fleet-sprint');
            fs.cpSync(path.join(SE_DIR, 'fleet-sprint'), sandboxFleetSprint, { recursive: true });
            // Restore workspace package resolution for the copy: runner.js
            // imports @apralabs/* workspace packages via bare specifiers Node
            // resolves by walking up node_modules from the importing file, and
            // a sandbox copy under os.tmpdir() has no such chain to the repo
            // root without this symlink. rmSync at cleanup only unlinks the
            // symlink, never recurses into the real directory it targets.
            let dir = SE_DIR;
            let hoisted;
            for (;;) {
                const candidate = path.join(dir, 'node_modules', '@apralabs');
                if (fs.existsSync(candidate)) { hoisted = path.join(dir, 'node_modules'); break; }
                const parent = path.dirname(dir);
                if (parent === dir) throw new Error(`could not locate a node_modules/@apralabs directory above ${SE_DIR}`);
                dir = parent;
            }
            fs.symlinkSync(hoisted, path.join(sandboxDir, 'node_modules'), 'dir');

            const sandboxRunnerPath = path.join(sandboxFleetSprint, 'runner.js');
            const originalContent = fs.readFileSync(sandboxRunnerPath, 'utf-8');

            const reExportLine = 'export { decideEnsureBranchAction };';
            assert.ok(
                originalContent.includes(reExportLine),
                'expected runner.js to contain the exact decideEnsureBranchAction re-export line this test removes',
            );

            const before = await import(`${pathToFileURL(sandboxRunnerPath).href}?facade-sanity=${Date.now()}-${Math.random()}`);
            assert.equal(typeof before.decideEnsureBranchAction, 'function', 'sandbox copy must be faithful before any mutation');

            const brokenContent = originalContent.replace(`${reExportLine}\n`, '');
            assert.notEqual(brokenContent, originalContent, 'the re-export line must actually have been removed');
            fs.writeFileSync(sandboxRunnerPath, brokenContent, 'utf-8');
            const broken = await import(`${pathToFileURL(sandboxRunnerPath).href}?facade-broken=${Date.now()}-${Math.random()}`);
            assert.equal(
                broken.decideEnsureBranchAction,
                undefined,
                'removing the re-export line must make decideEnsureBranchAction unresolvable through the facade -- proving assertion (1) above is not vacuous',
            );
            // Same fact the superset assertion checks, replayed against the
            // broken sandbox copy: the baseline name must fail the presence
            // check exactly as it would in the real assertion above.
            assert.ok(
                PRE_PHASE1_LEAF_EXPORT_SET.includes('decideEnsureBranchAction'),
                'decideEnsureBranchAction must be part of the baseline this falsification is demonstrating',
            );
            assert.equal(Object.prototype.hasOwnProperty.call(broken, 'decideEnsureBranchAction'), false);

            fs.writeFileSync(sandboxRunnerPath, originalContent, 'utf-8');
            const restored = await import(`${pathToFileURL(sandboxRunnerPath).href}?facade-restored=${Date.now()}-${Math.random()}`);
            assert.equal(typeof restored.decideEnsureBranchAction, 'function', 'the re-export line must be restored before this task completes');
            assert.equal(fs.readFileSync(sandboxRunnerPath, 'utf-8'), originalContent, 'sandbox runner.js must be byte-identical to its original content once restored');
        } finally {
            fs.rmSync(sandboxDir, { recursive: true, force: true });
        }

        const realRunnerContentAfter = fs.readFileSync(RUNNER_PATH, 'utf-8');
        assert.equal(realRunnerContentAfter, realRunnerContentBefore, 'the real, tracked fleet-sprint/runner.js must be byte-identical before and after this test');
    });
});

// -----------------------------------------------------------------------------
// (2) Every direct importer of fleet-sprint/runner.js resolves.
//
// The bead description calls for literally importing each importer module and
// asserting no resolution error. That is safe for most importers (test files,
// bin/cli.mjs, src/supervisor/*), but at least one -- scripts/dolt-settle-
// integration.mjs -- calls its own `main()` UNCONDITIONALLY at module-
// evaluation time (no isMainModule() guard) and that main() opens a real MCP
// connection and performs live dolt operations. Dynamically importing it here
// would fire that live side effect from a unit test, which this suite must
// never do. A named-import resolution failure is, by ECMAScript module
// semantics, a purely SYNTACTIC/link-time fact: `import { x } from mod`
// fails at link time (before mod or the importer evaluate) iff mod does not
// export `x`. So this check is done statically -- for every file that
// imports named bindings from fleet-sprint/runner.js, every one of those
// binding names must exist on the runner.js export surface -- which proves
// the identical fact ("no resolution error") without executing any
// importer's top-level code.
//
// THIS SECTION IS NOW THE SINGLE HOME OF THAT CHECK. The Phase-4 gate carried a
// byte-for-byte equivalent copy (section (2) of
// phase4-move-only-completeness.test.mjs): same two import regexes, same
// named-clause parser, same "every imported binding exists on runner.js's export
// surface" assertion, differing only in how it discovered importers (a git-grep
// of tracked files under this package, versus the disk walk below). The two
// discovery routes were measured against each other before the duplicate was
// deleted and returned the SAME 84 importers, with the walk strictly broader in
// principle (it also sees untracked and .ts files). The copy went with the rest
// of the Phase-4 move-only probe; the coverage did not move, because it was
// already here.
//
// The deleted dynamic probe had excluded bin/ and scripts/ entrypoints from
// execution (they self-invoke main() when loaded under `node --test`) and named
// THIS static check as the thing that covered them instead. Nothing else does,
// so the entrypoint-coverage test below pins that they stay in the checked set:
// a future narrowing of findImporters() that quietly dropped those directories
// would otherwise take the entrypoints' only facade proof with it, silently.
// -----------------------------------------------------------------------------
describe('(2) every direct importer of fleet-sprint/runner.js resolves the bindings it imports', () => {
    const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'coverage', '.gitnexus', 'build']);
    const EXTS = new Set(['.mjs', '.js', '.ts']);

    function walk(dir, out) {
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
            if (entry.name.startsWith('.') && entry.name !== '.claude') continue;
            const full = path.join(dir, entry.name);
            if (entry.isDirectory()) {
                if (SKIP_DIRS.has(entry.name)) continue;
                walk(full, out);
            } else if (EXTS.has(path.extname(entry.name))) {
                out.push(full);
            }
        }
        return out;
    }

    function parseNamedClause(clause) {
        const inner = clause.trim().replace(/^\{/, '').replace(/\}$/, '');
        return inner
            .split(',')
            .map((s) => s.trim())
            .filter(Boolean)
            .map((part) => {
                const asMatch = part.match(/^([A-Za-z_$][\w$]*)\s+as\s+[A-Za-z_$][\w$]*$/);
                return asMatch ? asMatch[1] : part;
            });
    }

    // `import { a, b as c } from '...'` and `import * as ns from '...'`.
    const STATIC_IMPORT_RE = /import\s*(\*\s*as\s+[A-Za-z_$][\w$]*|\{[^}]*\})\s*from\s*(['"])([^'"]*)\2/g;
    // `const { a, b as c } = await import('...')` (the one dynamic-import
    // importer in this repo, test/supervisor-sprint-identity.test.mjs).
    const DYNAMIC_IMPORT_RE = /(?:const|let)\s*\{([^}]*)\}\s*=\s*await\s+import\(\s*(['"])([^'"]*)\2\s*\)/g;
    const RUNNER_SPEC_RE = /fleet-sprint\/runner\.js$/;

    function findImporters() {
        const files = walk(SE_DIR, []);
        const importers = new Map();
        for (const file of files) {
            if (path.resolve(file) === path.resolve(RUNNER_PATH)) continue;
            const src = fs.readFileSync(file, 'utf8');
            let m;
            STATIC_IMPORT_RE.lastIndex = 0;
            while ((m = STATIC_IMPORT_RE.exec(src))) {
                if (!RUNNER_SPEC_RE.test(m[3])) continue;
                const clause = m[1].trim();
                const names = clause.startsWith('*') ? [] : parseNamedClause(clause);
                if (!importers.has(file)) importers.set(file, []);
                importers.get(file).push(...names);
            }
            DYNAMIC_IMPORT_RE.lastIndex = 0;
            while ((m = DYNAMIC_IMPORT_RE.exec(src))) {
                if (!RUNNER_SPEC_RE.test(m[3])) continue;
                const names = parseNamedClause(m[1]);
                if (!importers.has(file)) importers.set(file, []);
                importers.get(file).push(...names);
            }
        }
        return importers;
    }

    test('at least 65 files directly import fleet-sprint/runner.js (the bead description said "67"; a live repo scan at the time this test was written found 70 -- both are well above this floor, and the floor -- not a brittle exact count -- is what this assertion pins)', () => {
        const importers = findImporters();
        assert.ok(
            importers.size >= 65,
            `expected at least 65 direct importers of fleet-sprint/runner.js, found ${importers.size}`,
        );
    });

    test('every named binding every importer imports from runner.js exists on its export surface', () => {
        const importers = findImporters();
        const exportSet = new Set(Object.keys(runner));
        const problems = [];
        for (const [file, names] of importers) {
            for (const name of names) {
                if (!exportSet.has(name)) {
                    problems.push(`${path.relative(SE_DIR, file)}: imports '${name}' from fleet-sprint/runner.js, which does not export it`);
                }
            }
        }
        assert.deepEqual(problems, [], `unresolved import(s) found:\n${problems.join('\n')}`);
    });

    // The entrypoint classes are the ones with no other facade proof: they are
    // never run by the package's `test/*.test.mjs` glob, and the Phase-4 dynamic
    // probe that used to exist explicitly skipped executing them (they
    // self-invoke main() when loaded under `node --test`) on the stated grounds
    // that this static check covered them. Assert they are actually in the set,
    // and that they actually contribute named bindings to it -- a set that
    // contained them but took zero bindings from them would satisfy the
    // resolution test above vacuously.
    test('the checked set includes the bin/ and scripts/ entrypoint importers, which nothing else covers', () => {
        const byRel = new Map(
            [...findImporters()].map(([file, names]) => [path.relative(SE_DIR, file).split(path.sep).join('/'), names]),
        );
        const inDir = (prefix) => [...byRel.keys()].filter((f) => f.startsWith(`${prefix}/`));
        for (const prefix of ['bin', 'scripts']) {
            const found = inDir(prefix);
            assert.ok(
                found.length > 0,
                `no ${prefix}/ importer of fleet-sprint/runner.js is in the checked set; `
                + `either discovery stopped walking ${prefix}/ or the entrypoints stopped importing the facade. `
                + `Checked set: ${[...byRel.keys()].slice(0, 10).join(', ')}...`,
            );
            const named = found.filter((f) => byRel.get(f).length > 0);
            assert.ok(
                named.length > 0,
                `${prefix}/ importers are discovered (${found.join(', ')}) but contribute no named bindings, `
                + 'so the resolution assertion above says nothing about them',
            );
        }
    });
});

// -----------------------------------------------------------------------------
// (3) The golden transcripts still reproduce byte-for-byte, WITHOUT
// UPDATE_GOLDEN (same rationale/pattern as vcs-auth-extraction-facade.test.mjs
// and phase0-seams-facade.test.mjs).
// -----------------------------------------------------------------------------
describe('(3) golden transcripts reproduce with the fixture directory untouched', () => {
    test('both golden transcript suites pass without UPDATE_GOLDEN and leave test/fixtures/golden-transcript clean', () => {
        const before = execFileSync('git', ['status', '--porcelain', '--', 'packages/apra-fleet-se/test/fixtures/golden-transcript'], { cwd: REPO_ROOT, encoding: 'utf8' });
        assert.equal(
            before.trim(),
            '',
            `the golden fixture directory must be clean BEFORE this test runs, otherwise the after-check proves nothing. Dirty entries:\n${before}`,
        );

        const env = { ...process.env };
        delete env.UPDATE_GOLDEN;
        assert.equal(env.UPDATE_GOLDEN, undefined, 'UPDATE_GOLDEN must be unset for the child run');
        // NODE_TEST_CONTEXT=child-v8 is set by node --test on ITS OWN process
        // (verified directly: `node --test somefile.test.mjs` sets it even
        // standalone, not just when nested under a parent `node --test` run).
        // A node --test child spawned via execFileSync while that var is
        // still in its env silently no-ops -- empty stdout, exit 0, no test
        // actually run -- instead of executing the requested files. Without
        // this delete, this whole test would falsely pass in ~150-250ms
        // (verified: with the var present the child returns empty stdout;
        // with it removed the same invocation takes the genuine ~2.7s a
        // standalone `node --test test/golden-transcript*.test.mjs` run
        // takes). The two pre-existing sibling facade tests (phase0-seams-
        // facade.test.mjs, vcs-auth-extraction-facade.test.mjs) do NOT strip
        // this var and are therefore themselves silently no-op-passing their
        // own nested golden-transcript checks today -- out of this bead's
        // scope to fix, reported separately.
        delete env.NODE_TEST_CONTEXT;

        const childOut = runNestedSuite(
            'golden-transcript',
            ['--test', ...NESTED_GOLDEN_SUITE_FILES],
            { env },
        );
        // Falsifiability guard against exactly the no-op-pass failure mode
        // above recurring for some other reason: a genuinely empty/no-op
        // child run must not silently read as success.
        const passMatch = childOut.match(/^# pass (\d+)$/m);
        assert.ok(passMatch && Number(passMatch[1]) > 0, `expected the child golden-transcript run to report at least one passing test; got output:\n${childOut.slice(-2000)}`);
        const failMatch = childOut.match(/^# fail (\d+)$/m);
        assert.equal(failMatch && failMatch[1], '0', `expected zero failures in the child golden-transcript run; got output:\n${childOut.slice(-2000)}`);

        const after = execFileSync('git', ['status', '--porcelain', '--', 'packages/apra-fleet-se/test/fixtures/golden-transcript'], { cwd: REPO_ROOT, encoding: 'utf8' });
        assert.equal(
            after.trim(),
            '',
            `running the golden transcript suites must not rewrite any fixture file. git reported:\n${after}`,
        );
    });
});

// -----------------------------------------------------------------------------
// (5) The newly extracted pure helpers run with no injected agent, command or
// callTool -- each is called directly with plain data only. If any of them
// actually reached for one of those hooks, calling it without one would throw
// a TypeError (x is not a function) rather than return a well-formed result.
// -----------------------------------------------------------------------------
// Strips '//...' and '/*...*/' comments before a source-text call-shape check
// below, so a doc comment merely MENTIONING agent()/command()/callTool() (as
// several of these modules' own header comments do, to document why they are
// pure) does not register as a false-positive real call site.
function stripComments(src) {
    return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
}

describe('(5) the extracted pure helpers run with no injected agent, command or callTool', () => {
    const BRANCH_ENSURE_SRC = stripComments(fs.readFileSync(BRANCH_ENSURE_PATH, 'utf8'));
    const WORKLISTS_SRC = stripComments(fs.readFileSync(WORKLISTS_PATH, 'utf8'));
    const SPRINT_ARGS_SRC = stripComments(fs.readFileSync(SPRINT_ARGS_PATH, 'utf8'));

    test('decideEnsureBranchAction (branch-selection decision) runs from plain probe results, with no agent/command/callTool call anywhere in branch-ensure.mjs', () => {
        assert.doesNotMatch(BRANCH_ENSURE_SRC, /\b(agent|command|callTool)\s*\(/, 'branch-ensure.mjs must not call agent()/command()/callTool() anywhere -- it is documented pure');

        const result = runner.decideEnsureBranchAction({
            branch: 'auto-sprint/phase1-leaf-facade-check',
            baseBranch: 'main',
            branchFetchOk: true,
            branchFetchError: null,
            localBranchExists: false,
            localTipStatus: null,
        });
        assert.equal(result.action, 'checkout');
        assert.equal(result.reused, false);
        assert.equal(result.command, 'git checkout -B auto-sprint/phase1-leaf-facade-check origin/auto-sprint/phase1-leaf-facade-check');

        const abortResult = runner.decideEnsureBranchAction({
            branch: 'auto-sprint/phase1-leaf-facade-check',
            baseBranch: 'main',
            branchFetchOk: false,
            branchFetchError: 'fatal: unable to access remote (network down)',
            localBranchExists: false,
            localTipStatus: null,
        });
        assert.equal(abortResult.action, 'abort');
    });

    test('selectStreaks (streak-assignment validation) runs from a plain candidate + ready-bead array, with no agent/command call anywhere in worklists.mjs', () => {
        assert.doesNotMatch(WORKLISTS_SRC, /\b(agent|command|callTool)\s*\(/, 'worklists.mjs must not call agent()/command()/callTool() anywhere -- it is documented pure');

        const currentReady = [{ id: 'phase1-leaf-a' }, { id: 'phase1-leaf-b' }];
        const ok = selectStreaks({ streaks: [['phase1-leaf-a'], ['phase1-leaf-b']] }, currentReady);
        assert.equal(ok.usedFallback, false);
        assert.deepEqual(ok.streaks, [[{ id: 'phase1-leaf-a' }], [{ id: 'phase1-leaf-b' }]]);

        // Malformed candidate: falls back to one-bead-per-streak, still no
        // agent/command needed.
        const fallback = selectStreaks(null, currentReady);
        assert.equal(fallback.usedFallback, true);
        assert.deepEqual(fallback.streaks, [[{ id: 'phase1-leaf-a' }], [{ id: 'phase1-leaf-b' }]]);
    });

    test('validateArgs runs from a plain args object with no callTool key set, with no agent/command call anywhere in sprint-args.mjs', () => {
        assert.doesNotMatch(SPRINT_ARGS_SRC, /\b(agent|command)\s*\(/, 'sprint-args.mjs must not call agent()/command() anywhere -- validation runs before any dispatch');

        const validated = runner.validateArgs({
            target_issues: ['apra-fleet-phase1-leaf-check.1'],
            members: ['solo'],
            branch: 'auto-sprint/phase1-leaf-facade-check',
            base_branch: 'main',
        });
        assert.equal(validated.branch, 'auto-sprint/phase1-leaf-facade-check');
        assert.equal(validated.baseBranch, 'main');
        assert.deepEqual(validated.targetIssues, ['apra-fleet-phase1-leaf-check.1']);
        // callTool was never present in the input object at all -- proving
        // validateArgs does not require one to run.
        assert.equal(Object.prototype.hasOwnProperty.call({
            target_issues: ['apra-fleet-phase1-leaf-check.1'],
            members: ['solo'],
            branch: 'auto-sprint/phase1-leaf-facade-check',
            base_branch: 'main',
        }, 'callTool'), false);
    });
});

// =============================================================================
// (6) apra-fleet-3yuu.2 -- prove the extracted timeout-error handler works
// correctly over synthesized spawnSync results, without spawning real nested
// suites.
//
// apra-fleet-j918.7.1: the six cases below ((a) ETIMEDOUT, (b) non-zero status
// wraps, (b2) excerpt cap, (b3) classification is by error.code, (c) success,
// and the single-definition identity case) used to be duplicated near-verbatim
// here and in phase3-dispatch-engine-completeness.test.mjs section (6b),
// differing only in the (envVarName, budgetSource, extraTimeoutGuidance) tuple.
// They are now defined ONCE in helpers/nested-suite-spawn-cases.mjs and
// instantiated once per gate, with each gate passing its own tuple and its own
// imported handler binding. This gate's tuple is instantiated below; phase3's
// is instantiated from its own file. Section (6d) that follows stays here
// because it exercises phase1's OWN resolveNestedSuiteTimeoutMs, which phase3
// does not have.
// =============================================================================
describeHandleNestedSuiteSpawnResultCases({
    sectionLabel: '(6)',
    handler: handleNestedSuiteSpawnResult,
    envVarName: PHASE1_ENV_VAR_NAME,
    // The mock-bd branch of resolvePhase1BudgetSource() -- the source string
    // this gate actually feeds the handler under the backend the unit suite
    // runs on. Its real-bd counterpart is pinned by section (6d) below.
    budgetSource: `the mock-bd default (backend=replay, no ${PHASE1_ENV_VAR_NAME} override set)`,
    extraTimeoutGuidance: PHASE1_TIMEOUT_EXTRA_GUIDANCE,
});

// =============================================================================
// (6c) phase1-only -- cases added AFTER the shared table was extracted, so they
// are not part of describeHandleNestedSuiteSpawnResultCases(). Kept verbatim
// here (and mirrored in phase3's own file) because the comment below explains
// why this one is deliberately pinned in BOTH callers of the shared handler.
// =============================================================================
describe('(6c) the shared handleNestedSuiteSpawnResult names failing inner tests outside the quoted tail', () => {
    // -------------------------------------------------------------------------
    // case (b4): phase1's only nested spawn is now describe (3)'s golden-
    // transcript child -- the mock-sprint batch this comment used to cite was
    // deleted as a duplicate of phase3's stronger copy. The reporting hole is
    // a property of the SHARED handler, not of which child produced the
    // stream: phase3's nested step hit it on Windows CI with a ~1.6MB child
    // whose single `not ok` sat far outside the 4000-char tail the wrapped
    // message quoted, leaving a failure report that named no failing test.
    // Phase1's golden child can emit the same shape, and this case is a pure
    // unit test of handleNestedSuiteSpawnResult that spawns nothing, so it
    // costs phase1 nothing to keep. Pinned in BOTH callers deliberately --
    // the handler is shared (helpers/nested-suite-spawn.mjs), and the
    // extraction regressing in one gate's favour while the other stays green
    // is exactly the desynchronization that extraction existed to prevent.
    // -------------------------------------------------------------------------
    test('case (b4): a failing entry OUTSIDE the quoted tail window is still named -- the positional tail alone never identified it', () => {
        const failingName = 'mock sprint: a scenario whose name only the TAP entry carries';
        const failingError = 'Expected the sprint to abort on its own, got a hung run';
        const lines = ['TAP version 13'];
        // Sized so the synthesized stream clears the megabyte-scale
        // precondition asserted below (the real failing child emitted
        // 1,621,552 chars).
        const TOTAL = 800;
        for (let n = 1; n <= TOTAL; n += 1) {
            if (n === 3) {
                lines.push(`not ok ${n} - ${failingName}`);
                lines.push('  ---');
                lines.push("  type: 'test'");
                lines.push("  failureType: 'testCodeFailure'");
                lines.push('  error: |-');
                lines.push(`    ${failingError}`);
                lines.push("  code: 'ERR_TEST_FAILURE'");
                lines.push('  ...');
            } else {
                lines.push(`ok ${n} - mock sprint: filler scenario ${n}`);
                lines.push('  ---');
                lines.push("  type: 'test'");
                lines.push('  ...');
            }
            for (let k = 0; k < 20; k += 1) {
                lines.push(`# [Workflow Log] filler diagnostic line ${n}/${k} -- padding to reproduce the real stream width`);
            }
        }
        lines.push(`1..${TOTAL}`, `# tests ${TOTAL}`, `# pass ${TOTAL - 1}`, '# fail 1');
        const stdout = lines.join('\n');

        // Falsification precondition: the name is genuinely absent from the
        // tail window, so a tail-only implementation cannot pass this.
        assert.ok(stdout.length > 1_000_000, `the synthesized stream must be megabyte-scale like the real one; got ${stdout.length}`);
        assert.ok(
            !stdout.slice(-MAX_NESTED_SUITE_FAILURE_EXCERPT_CHARS).includes(failingName),
            'the failing test name must be absent from the quoted tail window, or this case proves nothing',
        );

        const err = new Error('Command failed: node --test failed with exit code 1');
        err.status = 1;
        err.stdout = stdout;
        err.stderr = '';

        let caught;
        try {
            handleNestedSuiteSpawnResult('mock-sprint', err, 900_000, 'the default (no PHASE1_NESTED_SUITE_TIMEOUT_MS override set)', PHASE1_ENV_VAR_NAME);
            assert.fail('should have thrown an error');
        } catch (e) {
            caught = e;
        }

        assert.ok(caught.message.includes(failingName), `the wrapped message must NAME the failing inner test; got:\n${caught.message}`);
        assert.ok(caught.message.includes(failingError), `the wrapped message must carry the failing test's own error text; got:\n${caught.message}`);
        assert.ok(
            caught.message.length < 20_000,
            `wrapped message must stay length-capped once failing entries are appended; got length ${caught.message.length}`,
        );
        const wrapperPrefix = caught.message.split('child stdout (tail):')[0];
        assert.ok(wrapperPrefix.includes('did NOT expire'), `wrapper prefix must still classify this as an inner child failure; got: ${wrapperPrefix}`);
        assert.ok(
            !wrapperPrefix.includes('timed out') && !wrapperPrefix.includes('exceeded its'),
            `appending failing entries must never leak into the wrapper prefix's timeout classification; got: ${wrapperPrefix}`,
        );
        assert.equal(caught.cause, err, 'original spawn error must still be reachable as .cause');

        // The extraction itself: every failure counted, indented (subtest)
        // entries recognised too, and an unterminated YAML block bounded
        // rather than running away to the end of a megabyte-scale string.
        const nested = extractFailingTapEntries(
            'ok 1 - fine\n    not ok 2 - an indented subtest failure\n      ---\n      error: |-\n        inner boom\n      ...\nok 3 - fine\n',
        );
        assert.equal(nested.total, 1, 'an indented subtest failure must still be found');
        assert.ok(nested.entries[0].includes('an indented subtest failure'), `expected the subtest entry; got: ${nested.entries[0]}`);
        assert.ok(nested.entries[0].includes('inner boom'), `expected the subtest's error text; got: ${nested.entries[0]}`);
        assert.ok(!nested.entries[0].includes('ok 3 - fine'), `the entry must stop at its own YAML terminator; got: ${nested.entries[0]}`);
        assert.deepEqual(extractFailingTapEntries(undefined), { total: 0, entries: [] }, 'undefined stdout must not throw');
        assert.deepEqual(extractFailingTapEntries(''), { total: 0, entries: [] }, 'empty stdout must not throw');
    });
});

// =============================================================================
// (6d) phase1-only: the budget RESOLVER itself -- override precedence,
// backend-aware defaulting (apra-fleet-x0mr.1), rejection of unparseable
// values, and that the resolved value plus resolvePhase1BudgetSource() reach
// the handler's message. Nothing here spawns a nested suite: these are the
// resolver and manipulated environment values directly, which is the whole
// point -- the 900000ms overrun this fixes cost ~30 minutes to observe once.
// phase3 has its own resolveNestedSuiteTimeoutBudget() covered in its own
// file, so this section has no phase3 twin and is not part of the shared
// table.
//
// Falsification (required, this section guards a bug fix): reverting
// resolveNestedSuiteTimeoutBudget() to return the flat
// { ms: DEFAULT_NESTED_SUITE_TIMEOUT_MS } regardless of bdMode() makes every
// subcase (d2r) case fail, plus (d4)'s real-bd half -- because the budget
// then equals the mock default that actually overran.
// =============================================================================
describe('(6d) the phase1 nested-suite budget is backend-aware, precedence-correct and self-describing', () => {
    // Pulled from bd-replay.mjs's own REAL_VALUES set (the bd-mock-shim
    // contract's source), not re-guessed here: bdMode() maps unset/anything
    // else to 'replay' (mock) and exactly these five spellings to 'real'.
    const REAL_BD_SPELLINGS = ['0', 'false', 'off', 'no', 'real'];
    const MOCK_BUDGET_MS = 900_000;

    function withEnv(overrides, fn) {
        const keys = Object.keys(overrides);
        const originals = Object.fromEntries(keys.map((k) => [k, process.env[k]]));
        try {
            for (const k of keys) {
                if (overrides[k] === undefined) delete process.env[k];
                else process.env[k] = overrides[k];
            }
            fn();
        } finally {
            for (const k of keys) {
                if (originals[k] === undefined) delete process.env[k];
                else process.env[k] = originals[k];
            }
            for (const k of keys) {
                assert.equal(process.env[k], originals[k], `env var ${k} must be restored to its original value`);
            }
        }
    }

    test('subcase (d1): PHASE1_NESTED_SUITE_TIMEOUT_MS wins on EVERY backend, and its value reaches the handler message', () => {
        for (const backend of [undefined, ...REAL_BD_SPELLINGS, 'record']) {
            withEnv({ PHASE1_NESTED_SUITE_TIMEOUT_MS: '5000', APRA_FLEET_BD_MOCK: backend }, () => {
                const budget = resolveNestedSuiteTimeoutBudget();
                assert.equal(budget.ms, 5000, `override must win with APRA_FLEET_BD_MOCK=${backend}; got ${budget.ms}`);
                assert.equal(resolveNestedSuiteTimeoutMs(), 5000, 'the ms-only wrapper must agree with the budget object');
                assert.equal(budget.source, 'PHASE1_NESTED_SUITE_TIMEOUT_MS=5000', `source must name the override; got: ${budget.source}`);

                const timeoutError = new Error('timeout signal');
                timeoutError.code = 'ETIMEDOUT';
                timeoutError.signal = 'SIGTERM';
                assert.throws(
                    () => handleNestedSuiteSpawnResult('test-suite', timeoutError, budget.ms, resolvePhase1BudgetSource(), PHASE1_ENV_VAR_NAME, PHASE1_TIMEOUT_EXTRA_GUIDANCE),
                    (err) => {
                        assert.ok(err.message.includes('PHASE1_NESTED_SUITE_TIMEOUT_MS=5000'), `message must mention the override; got: ${err.message}`);
                        assert.ok(err.message.includes('5000'), `message must include the budget value; got: ${err.message}`);
                        return true;
                    },
                );
            });
        }
    });

    test('subcase (d2): with no override, the MOCK backend keeps the 900000ms default this gate always shipped', () => {
        withEnv({ PHASE1_NESTED_SUITE_TIMEOUT_MS: undefined, APRA_FLEET_BD_MOCK: undefined }, () => {
            const budget = resolveNestedSuiteTimeoutBudget();
            assert.equal(budget.ms, MOCK_BUDGET_MS, `mock-backend default must be unchanged at ${MOCK_BUDGET_MS}; got ${budget.ms}`);
            assert.equal(resolveNestedSuiteTimeoutMs(), MOCK_BUDGET_MS, 'the ms-only wrapper must agree with the budget object');
            assert.ok(budget.source.includes('mock-bd default'), `source must say mock-bd default; got: ${budget.source}`);
            assert.ok(!budget.source.includes('real-bd default'), `mock source must not also claim real-bd; got: ${budget.source}`);
            assert.ok(budget.source.includes(PHASE1_ENV_VAR_NAME), `source must still name the override var; got: ${budget.source}`);

            const timeoutError = new Error('timeout signal');
            timeoutError.code = 'ETIMEDOUT';
            timeoutError.signal = 'SIGTERM';
            assert.throws(
                () => handleNestedSuiteSpawnResult('test-suite', timeoutError, budget.ms, resolvePhase1BudgetSource(), PHASE1_ENV_VAR_NAME, PHASE1_TIMEOUT_EXTRA_GUIDANCE),
                (err) => {
                    assert.ok(err.message.includes('mock-bd default'), `no-override case must name the default it used; got: ${err.message}`);
                    assert.ok(err.message.includes('900000'), `no-override case must include the default budget value; got: ${err.message}`);
                    return true;
                },
            );
        });
    });

    // THE REGRESSION THIS SECTION EXISTS FOR (apra-fleet-x0mr): under real bd
    // the nested golden-transcript child blew the flat 900000ms budget. A
    // budget that does not move with the backend is the bug; this pins that
    // it moves.
    for (const spelling of [...REAL_BD_SPELLINGS, 'record']) {
        test(`subcase (d2r): APRA_FLEET_BD_MOCK=${spelling} resolves to the larger real-bd budget, not the mock default`, () => {
            withEnv({ PHASE1_NESTED_SUITE_TIMEOUT_MS: undefined, APRA_FLEET_BD_MOCK: spelling }, () => {
                const budget = resolveNestedSuiteTimeoutBudget();
                assert.equal(budget.ms, REAL_BD_NESTED_SUITE_TIMEOUT_MS, `real-bd budget for APRA_FLEET_BD_MOCK=${spelling} must equal the derived/capped REAL_BD_NESTED_SUITE_TIMEOUT_MS; got ${budget.ms}`);
                assert.ok(
                    budget.ms > MOCK_BUDGET_MS,
                    `the real-bd budget must be LARGER than the mock default that overran (${MOCK_BUDGET_MS}ms); got ${budget.ms}`,
                );
                assert.ok(budget.source.includes('real-bd default'), `source must say real-bd default; got: ${budget.source}`);
                assert.ok(!budget.source.includes('mock-bd default'), `real source must not also claim mock-bd; got: ${budget.source}`);
            });
        });
    }

    test('subcase (d2x): the real-bd budget clears the runtime that actually overran (1811676ms file duration, 900000ms budget)', () => {
        // apra-fleet-x0mr's failing real-bd run: the whole phase1 file took
        // 1811676ms with TWO nested spawns in it, and the golden one -- the
        // only one left -- reported exceeding 900000ms. The replacement budget
        // must clear both of those numbers, or it has not fixed anything.
        assert.ok(
            REAL_BD_NESTED_SUITE_TIMEOUT_MS > 1_811_676,
            `real-bd budget must exceed the 1811676ms the whole file took in the failing run; got ${REAL_BD_NESTED_SUITE_TIMEOUT_MS}`,
        );
        // ...and must still BIND: a budget above the ceiling could never fire,
        // which would trade a false failure for no hang detection at all.
        assert.ok(
            REAL_BD_NESTED_SUITE_TIMEOUT_MS <= REAL_BD_NESTED_SUITE_TIMEOUT_CEILING_MS,
            `real-bd budget must stay at or under the stated ceiling; got ${REAL_BD_NESTED_SUITE_TIMEOUT_MS}`,
        );
    });

    test('subcase (d2d): REAL_BD_NESTED_SUITE_TIMEOUT_MS equals its documented arithmetic (three factors, capped)', () => {
        const expected = Math.min(
            Math.ceil(ASSUMED_REAL_BD_GOLDEN_PER_FILE_MS * NESTED_GOLDEN_SUITE_FILES.length * REAL_BD_HEADROOM_FACTOR),
            REAL_BD_NESTED_SUITE_TIMEOUT_CEILING_MS,
        );
        assert.equal(
            REAL_BD_NESTED_SUITE_TIMEOUT_MS,
            expected,
            `the shipped real-bd budget must equal per-file(${ASSUMED_REAL_BD_GOLDEN_PER_FILE_MS}) x files(${NESTED_GOLDEN_SUITE_FILES.length}) x headroom(${REAL_BD_HEADROOM_FACTOR}), capped at ${REAL_BD_NESTED_SUITE_TIMEOUT_CEILING_MS}`,
        );
        // The file count the budget derives from must be the SAME list the
        // nested child is actually given -- a budget derived from a different
        // set than the one that runs is a budget for nothing.
        assert.ok(NESTED_GOLDEN_SUITE_FILES.length >= 2, `the nested golden run must cover both golden suites; got ${NESTED_GOLDEN_SUITE_FILES.join(', ')}`);
    });

    // apra-fleet-x0mr.1: the scaledTimeout trap, pinned. test/helpers/
    // scaled-timeout.mjs scales off APRA_FLEET_TEST_CONCURRENCY, which only
    // scripts/run-tests.mjs exports -- so a budget scaled that way is inert
    // under the `npm test` command CI actually runs. This budget must resolve
    // identically no matter which entry point set (or did not set) that var.
    test('subcase (d2e): the budget is entry-point independent -- APRA_FLEET_TEST_CONCURRENCY cannot change it', () => {
        for (const backend of [undefined, 'real']) {
            let withoutConcurrencyVar;
            let withConcurrencyVar;
            withEnv({ PHASE1_NESTED_SUITE_TIMEOUT_MS: undefined, APRA_FLEET_BD_MOCK: backend, APRA_FLEET_TEST_CONCURRENCY: undefined }, () => {
                withoutConcurrencyVar = resolveNestedSuiteTimeoutBudget();
            });
            withEnv({ PHASE1_NESTED_SUITE_TIMEOUT_MS: undefined, APRA_FLEET_BD_MOCK: backend, APRA_FLEET_TEST_CONCURRENCY: '8' }, () => {
                withConcurrencyVar = resolveNestedSuiteTimeoutBudget();
            });
            assert.equal(
                withConcurrencyVar.ms,
                withoutConcurrencyVar.ms,
                `budget for backend=${backend} must not depend on APRA_FLEET_TEST_CONCURRENCY (the scaledTimeout inertness trap); got ${withoutConcurrencyVar.ms} vs ${withConcurrencyVar.ms}`,
            );
            assert.equal(withConcurrencyVar.source, withoutConcurrencyVar.source, 'the budget SOURCE must be entry-point independent too');
        }
    });

    test('subcase (d3): an unparseable override throws, naming the requirement and what it received', () => {
        withEnv({ PHASE1_NESTED_SUITE_TIMEOUT_MS: 'abc' }, () => {
            assert.throws(
                () => resolveNestedSuiteTimeoutBudget(),
                (err) => {
                    assert.ok(err.message.includes('PHASE1_NESTED_SUITE_TIMEOUT_MS must be a positive number'), `unparseable case must describe the requirement; got: ${err.message}`);
                    assert.ok(err.message.includes('abc'), `unparseable case must show what was received; got: ${err.message}`);
                    return true;
                },
            );
        });
    });

    test('subcase (d4): an empty override falls back to the backend default, exactly as unset does', () => {
        withEnv({ PHASE1_NESTED_SUITE_TIMEOUT_MS: '', APRA_FLEET_BD_MOCK: undefined }, () => {
            assert.equal(resolveNestedSuiteTimeoutMs(), MOCK_BUDGET_MS, 'empty string must fall back to the mock default');
        });
        withEnv({ PHASE1_NESTED_SUITE_TIMEOUT_MS: '', APRA_FLEET_BD_MOCK: 'real' }, () => {
            assert.equal(resolveNestedSuiteTimeoutMs(), REAL_BD_NESTED_SUITE_TIMEOUT_MS, 'empty string must fall back to the real-bd default, not the mock one');
        });
    });

    test('subcase (d5): zero is rejected (not positive)', () => {
        withEnv({ PHASE1_NESTED_SUITE_TIMEOUT_MS: '0' }, () => {
            assert.throws(
                () => resolveNestedSuiteTimeoutBudget(),
                (err) => {
                    assert.ok(err.message.includes('must be a positive number'), `zero case must describe the requirement; got: ${err.message}`);
                    return true;
                },
            );
        });
    });
});

// =============================================================================
// Falsification note for criterion (4): reverting the ETIMEDOUT handling in
// handleNestedSuiteSpawnResult (removing the "if (spawnError.code ===
// 'ETIMEDOUT')" branch) makes case (a) and section (6d) fail: case (a) would
// fall through to the non-timeout wrapping and lose the budget-exceeded
// wording, and (6d) subcase (d1) would fail on the missing
// "PHASE1_NESTED_SUITE_TIMEOUT_MS=5000" text.
//
// Falsification note for apra-fleet-80q3.1 (cases (b) and (b2)): reverting
// the non-timeout branch to a bare `throw spawnError;` (dropping the wrapping
// added for apra-fleet-80q3.1) makes case (b) fail on every one of its
// "did NOT expire" / "exit status: 1" / cause-preservation assertions, since
// the thrown object would again be the bare original error with none of that
// text, and case (b2) would fail because an unwrapped error's message is the
// original short "Command failed: ..." text, never containing "truncated".
//
// Cases (a)/(b)/(b2) now live in helpers/nested-suite-spawn-cases.mjs and run
// here via the (6) instantiation above, so these mutations are still observed
// from this file -- and, because the same table also runs under phase3's
// tuple, each of them now fails BOTH gates instead of one.
// =============================================================================
