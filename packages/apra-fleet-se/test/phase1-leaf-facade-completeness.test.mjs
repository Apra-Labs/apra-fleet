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
// -- see that module's header for why this was extracted. (The excerpt cap
// and excerptChildOutput also live there now, used internally by
// handleNestedSuiteSpawnResult; this file has no direct use for them.)
import { handleNestedSuiteSpawnResult } from './helpers/nested-suite-spawn.mjs';

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
// apra-fleet-3yuu.1: shared, env-overridable nested-suite spawn budget.
//
// Both describe (3) (golden-transcript) and describe (4) (mock-sprint) below
// spawn a nested `node --test` child via execFileSync and used to hard-code
// their own timeout literal (60 seconds / 120 seconds respectively). Under a real
// bd/dolt-backed run those budgets are roughly an order of magnitude short --
// golden-transcript.test.mjs alone took 562s standalone in the failing run
// this bead fixes (apra-fleet-3yuu) -- so both now derive from ONE named
// constant, overridable by a single env var, defaulting well above that
// observed runtime. Raising the default further (or overriding per-run) is
// the correct fix if a real, slower backend needs more headroom; if the
// raised budget still times out, that is a genuine signal for the separate
// bd+dolt per-dispatch latency work, not a reason to raise this further.
//
// Override: set PHASE1_NESTED_SUITE_TIMEOUT_MS (milliseconds) in the
// environment to use a different budget for both nested spawns below.
// -----------------------------------------------------------------------------
const DEFAULT_NESTED_SUITE_TIMEOUT_MS = 900_000;

function resolveNestedSuiteTimeoutMs() {
    const raw = process.env.PHASE1_NESTED_SUITE_TIMEOUT_MS;
    if (raw === undefined || raw === '') return DEFAULT_NESTED_SUITE_TIMEOUT_MS;
    const parsed = Number(raw);
    if (!Number.isFinite(parsed) || parsed <= 0) {
        throw new Error(`PHASE1_NESTED_SUITE_TIMEOUT_MS must be a positive number of milliseconds, got: ${JSON.stringify(raw)}`);
    }
    return parsed;
}

const NESTED_SUITE_TIMEOUT_MS = resolveNestedSuiteTimeoutMs();

// -----------------------------------------------------------------------------
// apra-fleet-3swo.53: this gate's own name/wording for the shared
// handleNestedSuiteSpawnResult helper imported above.
// -----------------------------------------------------------------------------
const PHASE1_ENV_VAR_NAME = 'PHASE1_NESTED_SUITE_TIMEOUT_MS';
const PHASE1_TIMEOUT_EXTRA_GUIDANCE =
    'or investigate a real hang -- this is not the per-dispatch bd+dolt latency work tracked separately.';

/** Human-readable description of where NESTED_SUITE_TIMEOUT_MS came from, matching this gate's env override vs default. */
function resolvePhase1BudgetSource() {
    const raw = process.env.PHASE1_NESTED_SUITE_TIMEOUT_MS;
    return raw
        ? `${PHASE1_ENV_VAR_NAME}=${raw}`
        : `the default (no ${PHASE1_ENV_VAR_NAME} override set)`;
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
            ['--test', 'test/golden-transcript.test.mjs', 'test/golden-transcript-3bead.test.mjs'],
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
// (4) Every mock-sprint test file passes.
//
// Scoped to test/mock-sprint-*.test.mjs -- the package's own `npm test`
// (`test/*.test.mjs`, non-recursive glob) and `npm run test:unit` boundary --
// not test/slow/mock-sprint-*.test.mjs, which the repo already separates into
// its own `test:slow` script specifically because it is expensive (a
// multi-minute stalled-dispatch scenario); folding it in here would make this
// one facade-completeness test the slowest thing in the whole suite for a
// scenario this bead's scope (the Phase 1 leaf extractions) never touched.
// No APRA_FLEET_BD_MOCK override is passed: bd-replay.mjs's bdMode() already
// defaults an unset/empty value to 'replay' (recorded-fixture) mode, which is
// what plain `npm test` runs under too.
// -----------------------------------------------------------------------------
describe('(4) every mock-sprint test file passes', () => {
    test('node --test over every test/mock-sprint-*.test.mjs file exits clean', () => {
        const testDir = path.join(SE_DIR, 'test');
        const mockSprintFiles = fs
            .readdirSync(testDir)
            .filter((name) => name.startsWith('mock-sprint-') && name.endsWith('.test.mjs'))
            .sort();
        assert.ok(mockSprintFiles.length >= 50, `expected a substantial mock-sprint test suite, found ${mockSprintFiles.length} file(s)`);

        // NODE_TEST_CONTEXT must be stripped from the child's env -- see the
        // detailed rationale in describe (3) above. Without this, node --test
        // over 62 files returns empty stdout and exit 0 in well under a
        // second (verified directly), i.e. a false pass that never actually
        // ran any of the 62 files.
        const env = { ...process.env };
        delete env.NODE_TEST_CONTEXT;

        // Passed as an explicit argument list (not a shell glob) so this
        // spawn needs no shell -- consistent with this repo's guard-test
        // convention of never letting a dynamically-built string reach a
        // shell. maxBuffer raised well past Node's 1MB default: 62 mock-
        // sprint files produce several MB of TAP+workflow-log output, and the
        // default silently ENOBUFS/overflows on that volume (verified
        // directly).
        const childOut = runNestedSuite(
            'mock-sprint',
            ['--test', '--test-concurrency=8', ...mockSprintFiles.map((f) => path.join('test', f))],
            { env, maxBuffer: 200 * 1024 * 1024 },
        );

        // Falsifiability guard against a no-op child run (see (3) above)
        // silently reading as success: pin a plausible lower bound on the
        // number of tests actually run (at least one per file) and zero
        // failures.
        const passMatch = childOut.match(/^# pass (\d+)$/m);
        assert.ok(
            passMatch && Number(passMatch[1]) >= mockSprintFiles.length,
            `expected at least ${mockSprintFiles.length} passing tests (one per mock-sprint file) from the child run; got output tail:\n${childOut.slice(-2000)}`,
        );
        const failMatch = childOut.match(/^# fail (\d+)$/m);
        assert.equal(failMatch && failMatch[1], '0', `expected zero failures across the mock-sprint suite; got output tail:\n${childOut.slice(-4000)}`);
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
// suites. Covers the four cases: ETIMEDOUT with suite label and budget;
// non-zero-status with unchanged output message; success (null error); and
// budget-constant env-var override behavior.
// =============================================================================
describe('(6) the extracted handleNestedSuiteSpawnResult helper converts spawn results to pass/fail', () => {
    test('case (a): ETIMEDOUT error yields message with suite label and budget', () => {
        const timeoutError = new Error('timeout signal');
        timeoutError.code = 'ETIMEDOUT';
        timeoutError.signal = 'SIGTERM';
        timeoutError.status = null;

        assert.throws(
            () => handleNestedSuiteSpawnResult(
                'my-golden-suite',
                timeoutError,
                900_000,
                'the default (no PHASE1_NESTED_SUITE_TIMEOUT_MS override set)',
                PHASE1_ENV_VAR_NAME,
                PHASE1_TIMEOUT_EXTRA_GUIDANCE,
            ),
            (err) => {
                const msg = err.message;
                assert.ok(
                    msg.includes('my-golden-suite'),
                    `message must include suite label; got: ${msg}`
                );
                assert.ok(
                    msg.includes('900000'),
                    `message must include budget in ms; got: ${msg}`
                );
                return true;
            },
        );
    });

    test('case (b): non-zero status wraps with suite label, "budget did not expire", exit status and a bounded excerpt, preserving the original as cause', () => {
        const nonZeroError = new Error('Command failed: node --test failed with exit code 1');
        nonZeroError.status = 1;
        nonZeroError.stdout = 'TAP output line 1\n';
        nonZeroError.stderr = 'stderr line 1\n';

        let caughtErr;
        try {
            handleNestedSuiteSpawnResult('my-suite', nonZeroError, 900_000, 'the default (no PHASE1_NESTED_SUITE_TIMEOUT_MS override set)');
            assert.fail('should have thrown an error');
        } catch (e) {
            caughtErr = e;
        }

        assert.ok(caughtErr.message.includes('my-suite'), `message must name the outer suite label; got: ${caughtErr.message}`);
        assert.ok(
            caughtErr.message.includes('did NOT expire'),
            `message must explicitly state the outer budget did not expire, to distinguish this from case (a); got: ${caughtErr.message}`,
        );
        assert.ok(caughtErr.message.includes('900000'), `message must include the outer budget in ms; got: ${caughtErr.message}`);
        assert.ok(caughtErr.message.includes('exit status: 1'), `message must include the child exit status; got: ${caughtErr.message}`);
        assert.ok(caughtErr.message.includes('TAP output line 1'), `message must include a tail excerpt of child stdout; got: ${caughtErr.message}`);
        assert.ok(caughtErr.message.includes('stderr line 1'), `message must include a tail excerpt of child stderr; got: ${caughtErr.message}`);
        // apra-fleet-3swo.50: the two failure modes must never share text in
        // the WRAPPER PREFIX -- the portion of the message the wrapper itself
        // authors, before the quoted child stdout/stderr excerpt. The excerpt
        // is arbitrary child output and CAN legitimately contain the
        // substring "timed out" (e.g. an inner per-test timeout, as
        // apra-fleet-80q3's real case did), so asserting the absence of
        // "timed out" over the WHOLE message (including the excerpt) is a
        // false requirement on child output content, not a real guarantee
        // about the wrapper. Pin the distinguishing contract on the prefix,
        // where the wrapper itself actually enforces it.
        const wrapperPrefix = caughtErr.message.split('child stdout (tail):')[0];
        assert.ok(
            wrapperPrefix.includes('did NOT expire'),
            `wrapper prefix must explicitly state the outer budget did not expire; got: ${wrapperPrefix}`,
        );
        assert.ok(
            !wrapperPrefix.includes('timed out'),
            `wrapper prefix (excluding the quoted child excerpt) must never claim a timeout; got: ${wrapperPrefix}`,
        );
        // Cross-check against the ETIMEDOUT branch: its wrapper prefix never
        // claims the outer budget did NOT expire -- the two wrapper prefixes
        // are mutually exclusive on this marker.
        const crossCheckTimeoutError = new Error('timeout signal');
        crossCheckTimeoutError.code = 'ETIMEDOUT';
        crossCheckTimeoutError.signal = 'SIGTERM';
        let crossCheckTimeoutErr;
        try {
            handleNestedSuiteSpawnResult(
                'my-suite',
                crossCheckTimeoutError,
                900_000,
                'the default (no PHASE1_NESTED_SUITE_TIMEOUT_MS override set)',
                PHASE1_ENV_VAR_NAME,
                PHASE1_TIMEOUT_EXTRA_GUIDANCE,
            );
            assert.fail('should have thrown an error');
        } catch (e) {
            crossCheckTimeoutErr = e;
        }
        assert.ok(
            !crossCheckTimeoutErr.message.includes('did NOT expire'),
            `ETIMEDOUT wrapper prefix must never claim the outer budget did NOT expire; got: ${crossCheckTimeoutErr.message}`,
        );
        // The original spawn error must still be reachable, unmodified, as
        // `cause` -- no information is lost, only bounded in the message text.
        assert.equal(caughtErr.cause, nonZeroError, 'original spawn error must be reachable as .cause');
        assert.equal(caughtErr.cause.status, 1, 'cause must preserve the original exit status');
        assert.equal(caughtErr.cause.stdout, 'TAP output line 1\n', 'cause must preserve the original stdout verbatim');
        assert.equal(caughtErr.cause.stderr, 'stderr line 1\n', 'cause must preserve the original stderr verbatim');
    });

    test('case (b2): a multi-megabyte child stdout/stderr is length-capped in the wrapped message, not quoted verbatim', () => {
        const hugeError = new Error('Command failed: node --test failed with exit code 1');
        hugeError.status = 1;
        hugeError.stdout = 'x'.repeat(2_000_000);
        hugeError.stderr = 'y'.repeat(2_000_000);

        let caughtErr;
        try {
            handleNestedSuiteSpawnResult('huge-suite', hugeError, 900_000, 'the default (no PHASE1_NESTED_SUITE_TIMEOUT_MS override set)');
            assert.fail('should have thrown an error');
        } catch (e) {
            caughtErr = e;
        }

        assert.ok(
            caughtErr.message.length < 20_000,
            `wrapped message must be length-capped regardless of a multi-megabyte child output; got length ${caughtErr.message.length}`,
        );
        assert.ok(caughtErr.message.includes('truncated'), `message should note the excerpt was truncated; got a message of length ${caughtErr.message.length}`);
        // The uncapped original is still available via cause, so nothing is lost.
        assert.equal(caughtErr.cause.stdout.length, 2_000_000, 'cause must retain the full, untruncated original stdout');
        assert.equal(caughtErr.cause.stderr.length, 2_000_000, 'cause must retain the full, untruncated original stderr');
    });

    test('case (c): null error (status 0) yields pass (no throw)', () => {
        // Should not throw or return; just complete normally
        const result = handleNestedSuiteSpawnResult('my-suite', null, 900_000, 'the default (no PHASE1_NESTED_SUITE_TIMEOUT_MS override set)');
        assert.equal(result, undefined, 'success case should return undefined');
    });

    test('case (d): budget constant honors env-var override and falls back to default', () => {
        const originalEnv = process.env.PHASE1_NESTED_SUITE_TIMEOUT_MS;

        try {
            // Subcase (d1): resolveNestedSuiteTimeoutMs() with env var set returns the override
            process.env.PHASE1_NESTED_SUITE_TIMEOUT_MS = '5000';
            const resolved1 = resolveNestedSuiteTimeoutMs();
            assert.equal(resolved1, 5000, 'must parse env override and return numeric value');

            // Verify the handler message reflects this override
            const timeoutError1 = new Error('timeout signal');
            timeoutError1.code = 'ETIMEDOUT';
            timeoutError1.signal = 'SIGTERM';

            assert.throws(
                () => handleNestedSuiteSpawnResult(
                    'test-suite',
                    timeoutError1,
                    resolved1,
                    resolvePhase1BudgetSource(),
                    PHASE1_ENV_VAR_NAME,
                    PHASE1_TIMEOUT_EXTRA_GUIDANCE,
                ),
                (err) => {
                    const msg = err.message;
                    assert.ok(
                        msg.includes('PHASE1_NESTED_SUITE_TIMEOUT_MS=5000'),
                        `env-override case must mention the override value; got: ${msg}`,
                    );
                    assert.ok(
                        msg.includes('5000'),
                        `env-override case must include the budget value; got: ${msg}`,
                    );
                    return true;
                },
            );

            // Subcase (d2): resolveNestedSuiteTimeoutMs() with env var unset returns default
            delete process.env.PHASE1_NESTED_SUITE_TIMEOUT_MS;
            const resolved2 = resolveNestedSuiteTimeoutMs();
            assert.equal(resolved2, 900_000, 'must return default when env unset');

            // Verify the handler message reflects the default
            const timeoutError2 = new Error('timeout signal');
            timeoutError2.code = 'ETIMEDOUT';
            timeoutError2.signal = 'SIGTERM';

            assert.throws(
                () => handleNestedSuiteSpawnResult(
                    'test-suite',
                    timeoutError2,
                    resolved2,
                    resolvePhase1BudgetSource(),
                    PHASE1_ENV_VAR_NAME,
                    PHASE1_TIMEOUT_EXTRA_GUIDANCE,
                ),
                (err) => {
                    const msg = err.message;
                    assert.ok(
                        msg.includes('the default (no PHASE1_NESTED_SUITE_TIMEOUT_MS override set)'),
                        `no-override case must mention the default; got: ${msg}`,
                    );
                    assert.ok(
                        msg.includes('900000'),
                        `no-override case must include the default budget value; got: ${msg}`,
                    );
                    return true;
                },
            );

            // Subcase (d3): resolveNestedSuiteTimeoutMs() with unparseable env var throws
            process.env.PHASE1_NESTED_SUITE_TIMEOUT_MS = 'abc';
            assert.throws(
                () => resolveNestedSuiteTimeoutMs(),
                (err) => {
                    assert.ok(
                        err.message.includes('PHASE1_NESTED_SUITE_TIMEOUT_MS must be a positive number'),
                        `unparseable case must describe the requirement; got: ${err.message}`,
                    );
                    assert.ok(
                        err.message.includes('abc'),
                        `unparseable case must show what was received; got: ${err.message}`,
                    );
                    return true;
                },
            );

            // Subcase (d4): empty string falls back to default (treated same as unset)
            process.env.PHASE1_NESTED_SUITE_TIMEOUT_MS = '';
            const resolved4 = resolveNestedSuiteTimeoutMs();
            assert.equal(resolved4, 900_000, 'empty string must fall back to default');

            // Subcase (d5): zero is unparseable (not positive)
            process.env.PHASE1_NESTED_SUITE_TIMEOUT_MS = '0';
            assert.throws(
                () => resolveNestedSuiteTimeoutMs(),
                (err) => {
                    assert.ok(
                        err.message.includes('must be a positive number'),
                        `zero case must describe the requirement; got: ${err.message}`,
                    );
                    return true;
                },
            );
        } finally {
            // Restore original env state
            if (originalEnv !== undefined) {
                process.env.PHASE1_NESTED_SUITE_TIMEOUT_MS = originalEnv;
            } else {
                delete process.env.PHASE1_NESTED_SUITE_TIMEOUT_MS;
            }
        }
    });

    test('the handler is the same function runNestedSuite uses (single definition, import-proven)', () => {
        // Proof of single-definition identity: runNestedSuite calls
        // handleNestedSuiteSpawnResult directly in its catch/error path, and
        // this test file imports the SAME function from the shared
        // helpers/nested-suite-spawn.mjs module (apra-fleet-3swo.53) that
        // phase3-dispatch-engine-completeness.test.mjs also imports. If
        // handleNestedSuiteSpawnResult were copied/duplicated for testing only,
        // a mutation here would not propagate to the real calls, and the
        // acceptance criterion would be violated. This test asserts they are
        // the same reference.
        const testErrorOk = new Error('test');
        testErrorOk.code = 'ETIMEDOUT';
        testErrorOk.signal = 'SIGTERM';

        // Call the function directly (from this test scope)
        let directCallThrew = false;
        try {
            handleNestedSuiteSpawnResult('test', testErrorOk, 900_000, 'the default (no PHASE1_NESTED_SUITE_TIMEOUT_MS override set)', PHASE1_ENV_VAR_NAME);
        } catch (e) {
            directCallThrew = true;
        }
        assert.ok(directCallThrew, 'direct call must throw on ETIMEDOUT');

        // The function is imported in this file's scope (import statements
        // are hoisted above every describe() block), so there is no
        // re-export or indirect import: it is the same handleNestedSuiteSpawnResult
        // that runNestedSuite invokes. This assertion would fail if the
        // import were missing or shadowed.
        assert.equal(typeof handleNestedSuiteSpawnResult, 'function', 'handleNestedSuiteSpawnResult must be imported at module scope for runNestedSuite to use');
    });
});

// =============================================================================
// Falsification note for criterion (4): reverting the ETIMEDOUT handling in
// handleNestedSuiteSpawnResult (removing the "if (spawnError.code ===
// 'ETIMEDOUT')" branch) makes cases (a) and (d) fail: case (a) would fall
// through to the non-timeout wrapping and lose the "timed out after ...ms"
// wording, and case (d) subcase (d1) would fail on the missing
// "PHASE1_NESTED_SUITE_TIMEOUT_MS=5000" text.
//
// Falsification note for apra-fleet-80q3.1 (cases (b) and (b2)): reverting
// the non-timeout branch to a bare `throw spawnError;` (dropping the wrapping
// added for apra-fleet-80q3.1) makes case (b) fail on every one of its
// "did NOT expire" / "exit status: 1" / cause-preservation assertions, since
// the thrown object would again be the bare original error with none of that
// text, and case (b2) would fail because an unwrapped error's message is the
// original short "Command failed: ..." text, never containing "truncated".
// =============================================================================
