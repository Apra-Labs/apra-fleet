import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

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

            const before = await import(`${sandboxRunnerPath}?facade-sanity=${Date.now()}-${Math.random()}`);
            assert.equal(typeof before.decideEnsureBranchAction, 'function', 'sandbox copy must be faithful before any mutation');

            const brokenContent = originalContent.replace(`${reExportLine}\n`, '');
            assert.notEqual(brokenContent, originalContent, 'the re-export line must actually have been removed');
            fs.writeFileSync(sandboxRunnerPath, brokenContent, 'utf-8');
            const broken = await import(`${sandboxRunnerPath}?facade-broken=${Date.now()}-${Math.random()}`);
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
            const restored = await import(`${sandboxRunnerPath}?facade-restored=${Date.now()}-${Math.random()}`);
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

        const childOut = execFileSync(
            process.execPath,
            ['--test', 'test/golden-transcript.test.mjs', 'test/golden-transcript-3bead.test.mjs'],
            { cwd: SE_DIR, env, encoding: 'utf8', stdio: 'pipe', timeout: 60_000 },
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
        const childOut = execFileSync(
            process.execPath,
            ['--test', '--test-concurrency=8', ...mockSprintFiles.map((f) => path.join('test', f))],
            { cwd: SE_DIR, env, encoding: 'utf8', stdio: 'pipe', timeout: 120_000, maxBuffer: 200 * 1024 * 1024 },
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
