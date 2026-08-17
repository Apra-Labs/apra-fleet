import path from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs/promises';
import os from 'os';
import { runCmd as bdRunCmd } from './bd-replay.mjs';
import { FleetWorkflow, AgentDispatchError, FleetTransportError } from '@apralabs/apra-fleet-workflow';
import { WorkflowEngine } from '@apralabs/apra-fleet-workflow/engine';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Deterministic, CI-friendly mock of a full auto-sprint cycle driven against
// packages/apra-fleet-se/fleet-sprint/runner.js. No live MCP server, no
// Math.random(), no fixed multi-second sleeps -- every branch below matches
// the EXACT lowercase `agentType` strings runner.js dispatches:
//   planner, plan-reviewer, doer, reviewer, deployer, integ-test-runner, harvester
//
// Set MOCK_SPRINT_DELAY_MS to simulate LLM latency locally; defaults to 0 for CI.
export const DELAY_MS = Number(process.env.MOCK_SPRINT_DELAY_MS || 0);

// apra-fleet-1cb.1 AUDIT NOTE: grepped runner.js for every read of
// `result.isError` / `.isError` on an execute_command (bd/git/node shell)
// response. The ONLY hit is createMemberReservationClient()'s `callFor()`
// helper (member_reservation dispatch bookkeeping) -- that tool's isError is
// a genuine MCP-transport-level flag for a DIFFERENT tool, not the shell
// exit code of a bd/git invocation, so it is unaffected by this issue.
// runner.js's `command()` wrapper (packages/apra-fleet-workflow/src/workflow/
// index.mjs) already treats `result.isError` and
// `result.structuredContent.exitCode !== 0` as two DISTINCT failure signals
// (see its comment: "`result.isError` is an MCP-transport-level flag only --
// it does NOT reflect the exit code of the underlying process") -- so no
// runner.js code path depends on isError:true to detect a nonzero-exit bd/
// git command; exitCode already does that job. The mocks below (and in
// golden-transcript.test.mjs / golden-transcript-3bead.test.mjs /
// budget-live.test.mjs) previously conflated the two by returning
// `isError: true` for ordinary nonzero shell exits (a bd/git/node command
// that actually ran and failed) -- fixed here to only set isError on a
// genuine spawn failure (see isSpawnFailure() below), matching
// src/tools/execute-command.ts, which never sets isError for a nonzero exit.

// apra-fleet-eft.75.2: runner.js's main() now acquires a machine-local
// pidfile mutex keyed on (branch, members) BEFORE any dispatch (see
// fleet-sprint/sprint-lock.mjs) -- a REAL guard against two processes running
// the exact same sprint branch concurrently. Node's test runner spawns one
// process PER test FILE, and several helpers below (runOnce,
// runRejectedPlanScenario) used to pass a fixed, hardcoded literal branch
// string shared across MULTIPLE different test files -- harmless before this
// lock existed, but a genuine false-conflict risk now if two of those files'
// mock sprints happen to be in flight at the same moment under
// --test-concurrency. `uniqueMockBranch(tag)` appends this process's own pid
// to the tag-derived branch so every mock-sprint invocation gets a branch
// identity that can NEVER collide with a DIFFERENT test file's process
// (different pid), while staying stable and reproducible within a single
// call (a caller that needs to predict the exact string -- e.g.
// runner-sprint-id-token-flow.test.mjs asserting on its own dispatched
// sprint_id -- can compute the identical value with the same `tag` from
// inside its OWN process).
export function uniqueMockBranch(tag) {
    return `auto-sprint/mock-sprint-${tag}-${process.pid}`;
}

// Helper to run shell commands in JS
// apra-fleet-7ll: replicate the real execute_command MCP tool's response
// shape (src/tools/execute-command.ts) -- "Exit code: N\n<output>" display
// text PLUS a structuredContent.stdout/stderr/exitCode machine-readable
// channel -- so this mock exercises the same contract FleetWorkflow.command()
// actually receives in production, instead of a cleaner-than-reality stand-in
// that silently masked the "Exit code: N\n" prefix bug for this suite's
// whole lifetime.
export function mockCmdResult(code, stdout, stderr) {
    const parts = [];
    if (stdout) parts.push(stdout);
    if (stderr) parts.push(`[stderr]\n${stderr}`);
    const output = parts.join('\n') || '(no output)';
    return {
        content: [{ text: `Exit code: ${code}\n${output}` }],
        structuredContent: { exitCode: code, stdout: stdout ?? '', stderr: stderr ?? '' },
    };
}

// apra-fleet-1cb.1: classifies a runCmd() `err` (Node's child_process exec()
// callback error) as a genuine spawn/transport failure -- the process never
// ran at all -- as opposed to the process running and exiting nonzero, which
// is normal data (see the comment on mockCmdResult above and
// src/tools/execute-command.ts, which never sets isError for a nonzero shell
// exit code). Node's exec() sets `err.code` to the numeric exit code for an
// ordinary nonzero exit; it is left `undefined`, or set to a string like
// 'ENOENT', only when the command itself never started (e.g. a bad cwd or a
// binary that truly cannot be found).
export function isSpawnFailure(err) {
    return err.code === undefined || err.code === 'ENOENT';
}

// apra-fleet-tfx.8: the Publish PR / finalizeAbort PR-raising call sites now
// mint a just-in-time push+pr credential via `args.callTool('provision_vcs_auth',
// ...)` (ApraFleet.provisionVcsAuth) immediately before building/dispatching
// VCSModule's create-pull-request command -- so every mock-sprint scenario
// that reaches PR creation needs a working `callTool`, not just the small
// subset that opted in for self-heal/preflight coverage (apra-fleet-eft.75.3).
// This default answers 'provision_vcs_auth' with the same shape the real
// production tool returns on success (a leading check-mark line plus an
// 'expiresAt:' metadata line, see src/tools/provision-vcs-auth.ts and
// runner.js's parseExpiresAtFromProvisionText()) and, for any other tool
// name, a generic success -- so it never masks a genuinely-unexpected tool
// call as a failure. A scenario that needs to observe a provisioning
// failure, or assert on the exact provision_vcs_auth call args, still passes
// its own `callTool` override (see vcs-auth-preflight.test.mjs /
// vcs-auth-self-heal.test.mjs for that pattern applied directly against the
// exported callback factories).
//
// apra-fleet-tfx.8.4 fix: wiring `callTool` by default here (previously only
// opt-in) also activates createMcpChildIdAllocatorClient/dolt_push_mutex's
// MCP client whenever a scenario mints a new child bead or acquires the push
// mutex -- BOTH of those, unlike provision_vcs_auth/member_reservation/
// stop_prompt, are read through parseCoordinationToolResult(), which
// JSON.parse()s the tool's text and THROWS on anything that isn't valid JSON
// (see runner.js). The old generic `✅ mock <name>` text is plain prose, not
// JSON, so any scenario that reaches one of these two tools (e.g. a reviewer
// newTasks response gets id-allocated via `bd create`) would fail every
// allocate/acquire call with "returned a non-JSON response" -- a real
// regression this default callTool must not silently mask. Answer both with
// valid, minimal JSON so the allocator/mutex client's own null-token/
// null-childId fallback paths take over exactly as they did when callTool was
// unwired (id derivation still falls back to `bd create --parent` locally;
// the mutex is effectively a no-op grant).
export function defaultMockCallTool() {
    return async (name, toolArgs) => {
        // apra-fleet-647.1.2.1: provisionVcsAuthForMember now resolves the
        // member's provider via VCSModule.resolveProvider() -- a
        // 'member_detail' call BEFORE every provision_vcs_auth call -- so
        // this default must answer it with a registered 'github' provider
        // (the only provider any mock-sprint scenario configures today) or
        // every self-heal/preflight/PR-raise call site would start throwing
        // a "no registered VCS provider" ERROR: for every scenario that
        // relies on this default rather than its own callTool override.
        if (name === 'member_detail') {
            return { content: [{ text: JSON.stringify({ vcsProvider: 'github' }) }] };
        }
        if (name === 'provision_vcs_auth') {
            const expiresAt = new Date(Date.now() + 60 * 60 * 1000).toISOString();
            return { content: [{ text: `✅ Mock ${toolArgs && toolArgs.provider} credentials deployed on "${toolArgs && toolArgs.member_name}"\n  expiresAt: ${expiresAt}\n` }] };
        }
        if (name === 'child_id_allocator') {
            const action = toolArgs && toolArgs.action;
            if (action === 'allocate') {
                return { content: [{ text: JSON.stringify({ childId: null, token: null }) }] };
            }
            return { content: [{ text: JSON.stringify({ confirmed: true, released: true }) }] };
        }
        if (name === 'dolt_push_mutex') {
            const action = toolArgs && toolArgs.action;
            if (action === 'acquire') {
                return { content: [{ text: JSON.stringify({ granted: true, token: `mock-dolt-mutex-${Date.now()}` }) }] };
            }
            return { content: [{ text: JSON.stringify({ released: true }) }] };
        }
        return { content: [{ text: `✅ mock ${name}` }] };
    };
}

// Same (cmd, cwd) => Promise<{ err, stdout, stderr }> signature as always,
// but `bd ...` commands are now routed through the record/replay layer in
// ./bd-replay.mjs (APRA_FLEET_BD_MOCK: replay recorded real-bd responses by
// default; =0 to run the real bd CLI exactly as before; =record to run real
// bd AND capture fixtures). Non-bd commands always exec for real.
export const runCmd = (cmd, cwd) => bdRunCmd(cmd, cwd);

export const sleep = (ms) => (ms > 0 ? new Promise((r) => setTimeout(r, ms)) : Promise.resolve());

export async function setup(tempDirSuffix) {
    const tempDir = path.join(os.tmpdir(), `apra-fleet-mock-sprint-${tempDirSuffix}-${Date.now()}-${process.pid}`);
    await fs.mkdir(tempDir, { recursive: true });

    const initRes = await runCmd('bd init', tempDir);

    // `--silent` returns the created id directly on stdout, from the exact
    // write just performed -- unlike a separate `bd list --json` + title
    // match immediately afterward, which reads back through bd's embedded
    // Dolt store and can lag behind a just-completed write on a cold/fresh
    // environment (observed in CI: a fresh `bd` install with no warmed-up
    // Dolt state hits this every time, even though sequential `bd create`
    // calls each fully complete -- exec()'s callback only fires on process
    // exit -- before the next command starts).
    const epicRes = await runCmd('bd create -t epic "Epic: Fleet Member Management APIs" -d "This epic covers the implementation of member management APIs for apra-fleet-client. It includes registerMember, listMembers, and ensuring they integrate securely using fetch across the MCP JSON-RPC boundary." --silent', tempDir);
    const task1Res = await runCmd('bd create "Task: Implement registerMember in client.js" -d "Implement a registerMember(config) function in the ApraFleet API class. It should accept an object with name, prompt, url, token, etc., and map to the register_member tool." --silent', tempDir);
    const task2Res = await runCmd('bd create "Task: Implement listMembers in client.js" -d "Implement a listMembers() function in the ApraFleet API class. It should call the list_members tool and return the parsed JSON array of active fleet members." --silent', tempDir);
    const epicId = epicRes.stdout.trim();
    const task1Id = task1Res.stdout.trim();
    const task2Id = task2Res.stdout.trim();

    if (!epicId || !task1Id || !task2Id) {
        const describe = (label, res) => `${label}: err=${res.err ? JSON.stringify(res.err.message) : 'null'} stdout=${JSON.stringify(res.stdout)} stderr=${JSON.stringify(res.stderr)}`;
        throw new Error(
            `[advanced-mock-runner-test] setup(${tempDirSuffix}): bd create --silent did not return an id for one or more beads. tempDir=${tempDir}\n` +
                `  ${describe('bd init', initRes)}\n` +
                `  ${describe('epic create', epicRes)}\n` +
                `  ${describe('task1 create', task1Res)}\n` +
                `  ${describe('task2 create', task2Res)}`,
        );
    }

    await runCmd(`bd update ${task1Id} --parent ${epicId}`, tempDir);
    await runCmd(`bd update ${task2Id} --parent ${epicId}`, tempDir);

    const finalList = JSON.parse((await runCmd('bd list --json', tempDir)).stdout || '[]');
    const epicBead = finalList.find((b) => b.id === epicId);
    const task1 = finalList.find((b) => b.id === task1Id);
    const task2 = finalList.find((b) => b.id === task2Id);
    if (!epicBead || !task1 || !task2) {
        throw new Error(`[advanced-mock-runner-test] setup(${tempDirSuffix}): bd list --json did not include one or more just-created beads (epicId=${epicId}, task1Id=${task1Id}, task2Id=${task2Id}). Found ${finalList.length} bead(s): ${JSON.stringify(finalList.map((b) => b.id))}. tempDir=${tempDir}`);
    }

    // deploy.md / integ-test-playbook.md let runner.js's fs.existsSync probes
    // (via `node -e "require('fs').existsSync(...)"`) resolve to "found",
    // enabling the Deploy and Integ Test phases deterministically.
    await fs.writeFile(path.join(tempDir, 'deploy.md'), '# Deploy Apra Fleet Client\nrun `npm publish`');
    await fs.writeFile(path.join(tempDir, 'integ-test-playbook.md'), '# Integ Test\nRun `vitest e2e`');

    return { tempDir, epicBead, task1, task2 };
}

/**
 * Minimal setup variant for the apra-fleet-unw.16 develop/review-loop
 * scenarios below: an epic + N plain tasks, NO deploy.md/integ-test-
 * playbook.md (so those phases are deterministically skipped and don't need
 * their own mock branches), and returns the created task bead objects in
 * creation order so scenario code can address them by id without re-parsing
 * `bd list` output itself.
 */
export async function setupMinimal(tempDirSuffix, taskSpecs) {
    const tempDir = path.join(os.tmpdir(), `apra-fleet-mock-sprint-${tempDirSuffix}-${Date.now()}-${process.pid}`);
    await fs.mkdir(tempDir, { recursive: true });

    const initRes = await runCmd('bd init', tempDir);
    // `--silent` returns the created id directly, from the write just
    // performed -- avoids a separate `bd list --json` + title match, which
    // reads back through bd's embedded Dolt store and can lag behind a
    // just-completed write on a cold/fresh environment (see setup() above).
    const epicRes = await runCmd(`bd create -t epic "Epic: ${tempDirSuffix}" -d "Scenario epic for apra-fleet-unw.16 mock test." --silent`, tempDir);
    const epicId = epicRes.stdout.trim();
    if (!epicId) {
        throw new Error(
            `[advanced-mock-runner-test] setupMinimal(${tempDirSuffix}): bd create --silent did not return an epic id. tempDir=${tempDir}\n` +
                `  bd init: err=${initRes.err ? JSON.stringify(initRes.err.message) : 'null'} stdout=${JSON.stringify(initRes.stdout)} stderr=${JSON.stringify(initRes.stderr)}\n` +
                `  epic create: err=${epicRes.err ? JSON.stringify(epicRes.err.message) : 'null'} stdout=${JSON.stringify(epicRes.stdout)} stderr=${JSON.stringify(epicRes.stderr)}`,
        );
    }
    const epicBead = { id: epicId };

    const tasks = [];
    for (const spec of taskSpecs) {
        // apra-fleet-unw.17: `spec.priority` (e.g. 'P3') lets a scenario
        // create a task below the sprint's goal priority, for the A5
        // goal-priority exit-condition scenarios below.
        const priorityFlag = spec.priority ? ` -p ${spec.priority}` : '';
        const createRes = await runCmd(`bd create "${spec.title}" -d "${spec.description || 'Scenario task.'}"${priorityFlag} --silent`, tempDir);
        const id = createRes.stdout.trim();
        await runCmd(`bd update ${id} --parent ${epicBead.id}`, tempDir);
        tasks.push({ id, title: spec.title });
    }

    return { tempDir, epicBead, tasks };
}

/**
 * Builds a deterministic mock FleetApi. Every executePrompt() call is
 * recorded into `dispatched` so the caller can assert on the exact sequence
 * of agentType dispatches, and can diff that sequence across repeated runs.
 * Every dispatched entry also carries `member` (opts.member_name) so tests
 * can assert on WHICH member a doer/reviewer dispatch landed on
 * (apra-fleet-unw.16 acceptance criterion 1: the doer pool must not
 * collapse to a single member when 2+ are configured).
 *
 * Every executeCommand() call is additionally recorded into `commandLog` in
 * dispatch order -- used to assert on the git/gh command-call log added by
 * apra-fleet-unw.14 (branch creation at sprint start, push + PR raise at
 * finalization) and, as of apra-fleet-unw.16, on the orchestrator-issued
 * `bd update --status=open` reopen calls (the reviewer must never issue
 * these itself -- see the reviewer-dispatch-prompt grep assertions below).
 *
 * `planReviewerMode` (apra-fleet-unw.15) controls the plan-reviewer mock's
 * behaviour:
 *   - 'reject-then-approve' (default): CHANGES_NEEDED (schema-valid JSON)
 *     on round 1, APPROVED on round 2+. Exercises the normal happy path.
 *   - 'always-reject-free-text': every round, the reviewer returns
 *     free-text containing the literal substring "APPROVED" inside a
 *     non-approving sentence ("This can NOT be APPROVED") and is never
 *     valid JSON. This must never be misread as an approval (no substring
 *     matching in runner.js's plan phase) and must exhaust the schema-repair
 *     loop every round, ultimately aborting the sprint via
 *     SprintPlanRejectedError with zero doer dispatches.
 *   - 'approve-immediately': APPROVED on round 1, every round. Used by the
 *     apra-fleet-unw.16 develop/review-loop scenarios below, which don't
 *     care about plan-phase re-planning and want to reach Develop in one
 *     round for a smaller, easier-to-reason-about dispatch sequence.
 *
 * `doerHandler(ctx)` / `reviewerHandler(ctx)` (apra-fleet-unw.16), when
 * provided, let a scenario override the doer/reviewer mock's behavior
 * (e.g. throw, lie about closing a bead, or return specific
 * reopenIds/newTasks) without needing a second, near-duplicate mock
 * builder. Each receives `{ opts, tempDir, runCmd, epicBead, reviewRound }`
 * and must return the same `{ content: [{ text }] }` shape `executePrompt`
 * itself returns. When omitted, sensible defaults (close every assigned
 * bead / approve-with-no-reopens) are used -- these defaults are what the
 * original run1/run2 happy-path scenario relies on.
 *
 * `plannerHandler(ctx)` (apra-fleet-eft.28.2) is the same override hook for
 * the fresh (non-streak-assignment) 'planner' dispatch specifically. Receives
 * `{ opts, tempDir, runCmd, epicBead }` and must return the same
 * `{ content: [...], structuredContent?: {...} }` shape `executePrompt`
 * itself returns -- e.g. `{ content: [...], structuredContent: { isError:
 * true, reason: 'dispatch_failed' } }` to simulate a fleet-level dispatch
 * failure (what execute_prompt now returns instead of hanging when a
 * member's interactive session's underlying claude process is dead).
 */
// apra-fleet-unw2.22 (N12 follow-up): the harvester contract check must
// genuinely validate that runner.js supplied real, non-trivial CONTENT for
// analysisText/costAnalysis -- not merely that the prompt contains the
// static instructional label text buildHarvesterPrompt() always emits
// regardless of the underlying value. It previously used
// `/analysisText \(pre-computed by the orchestrator/.test(p)` etc., which
// is proven to still pass even when runner.js's buildAnalysisText()/
// buildCostAnalysis() silently return an empty string (see this bead's
// description). This helper extracts the actual fenced VALUE for
// analysisText/costAnalysis (the fence chars are a variable-length run of
// backticks per buildHarvesterPrompt's collision-safe `fence()`, so the
// regex captures whatever fence length was actually used) and requires it
// to be non-trivially long once trimmed.
//
// Also fixes analysisArtifactFile: the previous
// `/analysisArtifactFile:\s*\S+/` regex used `\s*` (which matches `\n`)
// between the colon and the value, so a BLANK analysisArtifactFile let it
// skip straight over the following blank-line paragraph break and match
// into the next paragraph's first word ("analysisText"), silently passing.
// The fixed regex uses `[ \t]*` (line-internal whitespace only) and is
// anchored with `^`/`$` (via the `m` flag) so it can never cross a
// newline.
const MIN_NONTRIVIAL_LEN = 15;

export function checkHarvesterContract(prompt) {
    const missing = [];

    const artifactMatch = /^analysisArtifactFile:[ \t]*(\S+)[ \t]*$/m.exec(prompt);
    if (!artifactMatch || artifactMatch[1].trim().length === 0) {
        missing.push('analysisArtifactFile');
    }

    const analysisTextMatch = /analysisText \(pre-computed by the orchestrator[^\n]*\):\n(`{3,})\n([\s\S]*?)\n\1/.exec(prompt);
    if (!analysisTextMatch || analysisTextMatch[2].trim().length < MIN_NONTRIVIAL_LEN) {
        missing.push('analysisText');
    }

    const costAnalysisMatch = /costAnalysis \(pre-computed by the orchestrator[^\n]*\):\n(`{3,})\n([\s\S]*?)\n\1/.exec(prompt);
    if (!costAnalysisMatch || costAnalysisMatch[2].trim().length < MIN_NONTRIVIAL_LEN) {
        missing.push('costAnalysis');
    }

    if (!/Branch:\s*\S+\s*\(base:\s*\S+\)/.test(prompt)) {
        missing.push('base-branch/branch');
    }

    return missing;
}

export function buildMockFleetApi(tempDir, epicBead, dispatched, commandLog, options = {}) {
    const {
        planReviewerMode = 'reject-then-approve',
        doerHandler = null,
        reviewerHandler = null,
        // apra-fleet-eft.28.2: optional (opts) => result override for the
        // Planner dispatch (the fresh, non-streak-assignment 'planner' call
        // only -- mirrors doerHandler/reviewerHandler). Lets a scenario
        // simulate a fleet-level dispatch failure (structuredContent:
        // { isError: true, reason: 'dispatch_failed' }, exactly what
        // execute_prompt now returns for a dead-PID interactive session
        // instead of hanging) at the Planner call site specifically, to
        // exercise runner.js's PLANNER_DISPATCH_RETRY_DELAYS_MS retry loop
        // and the terminal-error propagation through main()'s typed-abort
        // catch (publishState('terminal', ...)) end to end.
        plannerHandler = null,
        // apra-fleet-eft.72.2: optional (opts, tempDir, runCmd, epicBead,
        // planRound) => result override for the 'plan-reviewer' dispatch,
        // mirroring plannerHandler above. Lets a scenario script an exact
        // verdict sequence (e.g. CHANGES_NEEDED every round, with
        // taskAssignments/notes crafted from the real bead ids created by
        // this scenario) for the plan-cap-exhaustion deferral scenarios --
        // something the fixed `planReviewerMode` string switch below can't
        // express, since it never has access to real created bead ids. When
        // provided, this takes priority over `planReviewerMode` (but still
        // runs AFTER the promptHasScope contract check below, so that
        // regression guard stays in force for every scenario).
        planReviewerHandler = null,
        addExtraTaskDuringPlan = true,
        // apra-fleet-unw.17 additions:
        deployHandler = null,
        integHandler = null,
        finalReviewHandler = null,
        // apra-fleet-417.4: optional (opts, tempDir, runCmd, epicBead) =>
        // result override for the 'regression-test-runner' dispatch, mirroring
        // deployHandler/integHandler above. Only reachable when the scenario
        // has actually written regression-test-playbook.md into tempDir (see
        // runDevelopLoopScenario's `withRegressionPlaybook` option) -- the
        // real runner.js phase probes for that file and skips the dispatch
        // entirely otherwise, same as deploy.md/integ-test-playbook.md.
        regressionHandler = null,
        // apra-fleet-u1qw.2.3: optional (opts, tempDir, runCmd, epicBead) =>
        // result override for the 'permissions-composer' dispatch -- the
        // orchestrator-side heal dispatch runner.js's
        // healMissingPermissionsOnce() makes when a Deploy/Integ Test/
        // Regression Test result carries blockedReason='missing_permissions'.
        // Deliberately has NO default stub (unlike deployer/integ/regression
        // above): there is no sensible "default" composer verdict, and a
        // scenario that does NOT expect a heal wants a stray composer dispatch
        // to fail loudly rather than be silently absorbed. See the throw in the
        // dispatch switch below.
        permissionsComposerHandler = null,
        // Optional (cmd: string) => boolean predicate: when it returns
        // true for a given executeCommand() invocation, the mock returns a
        // nonzero-exit result (apra-fleet-1cb.1: normal data, no isError --
        // see mockCmdResult/isSpawnFailure above) instead of actually
        // running the command -- used to simulate a probe (or any other
        // command()) failure deterministically, without depending on real
        // filesystem/process flakiness.
        commandFailurePattern = null,
        // apra-fleet-unw2.4 (N4): per-member modeling. `commandLogDetailed`,
        // when provided, receives one `{ command, member }` entry per
        // executeCommand() call so a test can assert WHICH member each
        // git/gh/bd command was dispatched to (not just that it happened) --
        // the existing string-only `commandLog` is kept untouched for
        // backward compatibility. `memberGitState`, when provided, is a
        // Map<member, { ensuredBranches:Set, checkedOut:string|null }> that
        // simulates each member's git checkout independently: a
        // `git checkout -B <b>` (initial ensure) adds <b> to that member's
        // ensuredBranches and makes it current; a plain `git checkout <b>`
        // (the non-destructive re-ensure) only updates `checkedOut`. This
        // lets the 2-member regression test verify the branch-ensure reached
        // BOTH members' checkouts, which is exactly the state the pre-fix
        // (orchestrator-only ensure) failed to establish. The bd DB itself
        // still defaults to a single shared tempDir for every member (the
        // supported shared-workspace mode), so all existing single-workspace
        // tests are unaffected.
        commandLogDetailed = null,
        memberGitState = null,
        // apra-fleet-unw2.9 (N11): injectable git/gh failure. Optional
        // (cmd: string) => boolean predicate, tested ONLY against `git `/
        // `gh ` commands (the ones this mock otherwise short-circuits to a
        // hardcoded success below). When it matches, the mock returns a
        // nonzero-exit result (apra-fleet-1cb.1: normal data, no isError --
        // matches src/tools/execute-command.ts) with `gitGhFailureMessage`
        // (or a default) as the failure text -- this is what lets a test
        // observe a git/gh failure path (e.g. `git push` rejected, `gh pr
        // create` erroring for a reason OTHER than "already exists") as
        // something OTHER than the unconditional "ok (mocked...)" success
        // every git/gh command got before this issue. Deliberately separate
        // from
        // `commandFailurePattern` above, which is never matched against
        // git/gh commands (see the intercept order below) -- that keeps
        // existing scenarios using `commandFailurePattern` for bd/node probe
        // failures unaffected.
        gitGhFailurePattern = null,
        gitGhFailureMessage = null,
        // apra-fleet-unw2.9 (N11): idempotent-PR-creation simulation. When
        // provided, this Set is used (instead of a call-local one) to track
        // which branches already have a mock-simulated open PR -- passing
        // the SAME Set into two successive buildMockFleetApi()/scenario
        // calls for the SAME branch simulates "run finalization again
        // against a branch that already has a PR from a prior run", which
        // is exactly the idempotency regression this issue guards against.
        // When omitted, a fresh, call-local Set is used (existing scenarios
        // -- which never re-run against the same branch twice -- are
        // unaffected either way).
        prExistsState = new Set(),
        // apra-fleet-eft.64.1: `git remote get-url origin`'s mocked stdout --
        // the Publish PR step (runner.js) now resolves and classifies this
        // URL (isHostedGithubRemote()) BEFORE deciding whether to attempt
        // `gh pr create` at all, so this mock must answer that specific
        // command with something the classifier accepts as hosted by
        // default -- otherwise every existing PR-creation scenario below
        // would silently divert onto the new non-hosted/direct-close path
        // instead of exercising `gh pr create` as they did before this
        // classifier existed. A scenario exercising the non-hosted path
        // (e.g. a `file://` sandbox mirror) overrides this explicitly.
        originUrl = 'https://github.com/mock-org/mock-repo.git',
        // apra-fleet-647.1.1.3: stateful VCSModule create-pull-request REST
        // response override -- an array of `{ status: number, body?: object
        // }` consumed ONE PER curl POST /pulls call (the last entry sticks
        // once the queue is down to one, same one-per-call/sticky-last
        // convention as dolt-sync-brackets.test.mjs's makeCommandMock), so a
        // scenario can simulate e.g. a 401 on the first PR-creation attempt
        // and a 201 on the retry after the reactive auth self-heal -- the
        // "dedicated handler" the comment on the default curl POST /pulls
        // branch below already asks for, since prExistsState's fixed
        // 201-then-422 shape cannot express an auth failure. Checked BEFORE
        // gitGhFailurePattern/prExistsState, so it fully overrides the
        // default simulation when provided; omitted (the default), the
        // existing 201/already-exists-422 behavior is completely unchanged.
        prCurlResponseQueue = null,
    } = options;
    const prCurlResponseQueueLocal = prCurlResponseQueue ? [...prCurlResponseQueue] : null;

    let planRound = 0;
    let reviewRound = 0;
    let extraTaskAdded = false;
    // apra-fleet-02s.3: a schema-repair re-ask now FORCES resume:true and
    // sends a lean reminder prompt (no longer a self-contained echo of the
    // original prompt) -- so opts.prompt.startsWith('Final review for sprint
    // scope issue id(s):') can no longer distinguish a Final Review repair
    // round from a regular dev-loop Reviewer repair round; both share
    // agentType 'reviewer' and neither's repair prompt carries that prefix
    // anymore. Track the last FRESH (non-repair) 'reviewer' dispatch's
    // classification and reuse it for any resumed continuation, mirroring
    // what a real resumed session actually is: the same logical exchange.
    let lastFreshReviewerWasFinalReview = false;

    const defaultDoerHandler = async ({ opts }) => {
        const match = opts.prompt.match(/Assigned bead ids \(comma-separated\):\s*(.+)/);
        const ids = match ? match[1].split(',').map((s) => s.trim()).filter(Boolean) : [];
        for (const id of ids) {
            await runCmd(`bd close ${id}`, tempDir);
        }
        return {
            content: [{
                text: JSON.stringify({
                    status: 'VERIFY',
                    closedIds: ids,
                    notes: 'Implemented the requested fleet client methods using fetch to hit the MCP JSON-RPC endpoints. Closed the assigned beads.'
                })
            }]
        };
    };

    const defaultReviewerHandler = async ({ opts, reviewRound: rRound }) => {
        // Scripted, deterministic scenario: reopen exactly once, on the
        // first review round, then approve on every subsequent round. No
        // Math.random() -- identical on every run. Per apra-fleet-unw.16,
        // the mock reviewer only ever RETURNS reopenIds -- it never runs
        // `bd update` itself; the runner (orchestrator) is responsible for
        // applying the transition. See the reviewer-dispatch-prompt grep
        // assertions in main() below, which confirm the prompt text itself
        // forbids the reviewer from mutating beads.
        if (rRound === 1) {
            const closedRes = await runCmd(`bd list --parent ${epicBead.id} --status=closed --json`, tempDir);
            const closedBeads = JSON.parse(closedRes.stdout || '[]').sort((a, b) => a.id.localeCompare(b.id));
            if (closedBeads.length > 0) {
                const target = closedBeads[0];
                return {
                    content: [{
                        text: JSON.stringify({
                            verdict: 'CHANGES_NEEDED',
                            notes: `The implementation for ${target.id} is missing error handling for 401 Unauthorized responses. Please fix.`,
                            reopenIds: [target.id],
                            newTasks: [],
                        })
                    }]
                };
            }
        }
        return {
            content: [{
                text: JSON.stringify({
                    verdict: 'APPROVED',
                    notes: 'Code logic is sound. Error handling and type definitions match the spec. Approved.',
                    reopenIds: [],
                    newTasks: [],
                })
            }]
        };
    };

    return {
        executeCommand: async (opts) => {
            commandLog.push(opts.command);

            // apra-fleet-unw2.4 (N4): per-member command log + simulated
            // per-member git checkout state (see the option comments above).
            if (commandLogDetailed) {
                commandLogDetailed.push({ command: opts.command, member: opts.member_name });
            }
            if (memberGitState) {
                const m = opts.member_name || '(none)';
                if (!memberGitState.has(m)) memberGitState.set(m, { ensuredBranches: new Set(), checkedOut: null });
                const st = memberGitState.get(m);
                const ensureMatch = opts.command.match(/git checkout -B (\S+)/);
                if (ensureMatch) {
                    st.ensuredBranches.add(ensureMatch[1]);
                    st.checkedOut = ensureMatch[1];
                } else {
                    const coMatch = opts.command.match(/^git checkout (\S+)\s*$/);
                    if (coMatch) st.checkedOut = coMatch[1];
                }
            }

            // apra-fleet-9te.4.1: Ensure Sprint Branch probes for a
            // pre-existing local branch via this exact rev-parse before
            // deciding whether to reuse it as-is or reset it to base.
            // Answer deterministically from this mock's per-member
            // checkout-state model (see memberGitState doc above) instead of
            // falling through to the generic git/gh "ok (mocked)" success
            // below, which would make every scenario look like the local
            // branch already exists and silently short-circuit the
            // reset-to-base fallback path this mock exists to exercise.
            const revParseMatch = /^git rev-parse --verify --quiet refs\/heads\/(\S+)/.exec(opts.command);
            if (revParseMatch) {
                const m = opts.member_name || '(none)';
                const st = memberGitState ? memberGitState.get(m) : null;
                if (st && st.ensuredBranches.has(revParseMatch[1])) {
                    return mockCmdResult(0, revParseMatch[1], '');
                }
                // apra-fleet-1cb.1: a real `git rev-parse --verify --quiet` for a
                // ref that doesn't exist is a normal nonzero exit (code 1, no
                // stdout/stderr) -- not an MCP-level dispatch failure -- exactly
                // like src/tools/execute-command.ts, which never sets isError for
                // a nonzero shell exit. Match that: no isError, just exit code 1.
                return mockCmdResult(1, '', '');
            }

            // apra-fleet-tfx.8: VCSModule's create-pull-request path never
            // dispatches `gh`. Two new non-git-prefixed call sites feed the
            // PR-raising flow instead, both intercepted here BEFORE the
            // generic git/gh block below so they never fall through to a real
            // exec() against tempDir (which has no such credential file and
            // no live network):
            //   1. the just-provisioned git-credential-helper SCRIPT
            //      ($HOME/.fleet-git-credential-<label>), read back by
            //      readMemberVcsCredentialToken() to learn the token
            //      provision_vcs_auth deployed -- answered with a fixed mock
            //      'password=' line, mirroring the real script's protocol/
            //      host/username/password output.
            //   2. VCSModule's `curl -sS -X POST ... /pulls` REST call itself
            //      -- answered with a fake JSON body + trailing HTTP status
            //      line (mirroring buildCreatePrCommand's `-w '\n%{http_code}'`),
            //      reusing the SAME prExistsState idempotency simulation the
            //      old `gh pr create` mock used to provide.
            if (/^\$HOME\/\.fleet-git-credential-/.test(opts.command)) {
                return mockCmdResult(0, 'protocol=https\nhost=github.com\nusername=x-access-token\npassword=mock-vcs-module-token\n', '');
            }
            if (/^curl -sS -X POST\b/.test(opts.command) && /\/pulls\b/.test(opts.command)) {
                if (prCurlResponseQueueLocal && prCurlResponseQueueLocal.length > 0) {
                    const next = prCurlResponseQueueLocal.length > 1 ? prCurlResponseQueueLocal.shift() : prCurlResponseQueueLocal[0];
                    const resolved = typeof next === 'function' ? next() : next;
                    const bodyText = resolved.body !== undefined ? JSON.stringify(resolved.body) : '';
                    return mockCmdResult(0, `${bodyText}\n${resolved.status}`, '');
                }
                if (gitGhFailurePattern && gitGhFailurePattern.test(opts.command)) {
                    // A curl invocation itself still exits 0 even when the
                    // REST call fails -- this branch exists only for tests
                    // that want to simulate a genuine spawn-level failure of
                    // the curl command itself (rare; most "PR create failed"
                    // scenarios instead want a non-2xx/non-already-exists
                    // HTTP status, which prExistsState below cannot express,
                    // so those scenarios should prefer a dedicated handler).
                    return mockCmdResult(1, '', gitGhFailureMessage || `mock curl failure (injected) for: ${opts.command}`);
                }
                const headMatch = /"head":"([^"]*)"/.exec(opts.command);
                const branch = headMatch ? headMatch[1] : null;
                if (branch && prExistsState.has(branch)) {
                    const body = JSON.stringify({
                        message: 'Validation Failed',
                        errors: [{ message: `A pull request already exists for ${branch}. https://github.com/mock-org/mock-repo/pull/1` }],
                    });
                    return mockCmdResult(0, `${body}\n422`, '');
                }
                if (branch) prExistsState.add(branch);
                const body = JSON.stringify({ number: 101, html_url: 'https://github.com/mock-org/mock-repo/pull/101' });
                return mockCmdResult(0, `${body}\n201`, '');
            }

            // git/gh commands (apra-fleet-unw.14's branch-ensure/push
            // steps) are intercepted rather than run for real: tempDir is a
            // bare `bd init` scratch directory, not a git repo with an
            // 'origin' remote, so there is nothing real to git-fetch/push
            // against here. This keeps the mock hermetic while still
            // exercising and asserting on runner.js's dispatch of these
            // commands.
            if (/^(git|gh)\s/.test(opts.command)) {
                // apra-fleet-unw2.9 (N11): injectable git/gh failure takes
                // priority over the PR-exists simulation below -- a test
                // that wants to observe a genuine (non-"already exists")
                // git/gh failure should get exactly that, deterministically.
                if (gitGhFailurePattern && gitGhFailurePattern.test(opts.command)) {
                    // apra-fleet-1cb.1: a real git/gh failure (auth, network,
                    // rejected push, etc.) is the underlying CLI exiting nonzero --
                    // the MCP execute_command call itself still succeeds (no
                    // isError), matching src/tools/execute-command.ts. Simulate
                    // that as a nonzero exit carrying the failure text, not isError.
                    return mockCmdResult(1, '', gitGhFailureMessage || `mock git/gh failure (injected) for: ${opts.command}`);
                }

                // apra-fleet-eft.64.1: answer the Publish PR step's remote-
                // classification probe with `originUrl` (a hosted GitHub URL
                // by default -- see the option comment above) so this mock's
                // command() intercept has a real answer for the ONE git/gh
                // command the runner reads the mocked stdout of, rather than
                // falling through to the generic 'ok (mocked...)' text below
                // (which is not a real URL and would misclassify as
                // non-hosted).
                if (/^git remote get-url origin\b/.test(opts.command)) {
                    return mockCmdResult(0, originUrl, '');
                }

                return mockCmdResult(0, 'ok (mocked -- no real git remote in this mock sprint)', '');
            }

            // apra-fleet-unw.17, A4 acceptance criterion 5: deterministic
            // command-failure injection for probe/other command() calls,
            // used by the probe-failure-skips-phase scenario below.
            if (commandFailurePattern && commandFailurePattern.test(opts.command)) {
                // apra-fleet-1cb.1: the probe/command this simulates (e.g. a
                // `node -e existsSync(...)` check) genuinely runs and exits
                // nonzero -- not an MCP dispatch failure -- so match
                // src/tools/execute-command.ts and return normal nonzero-exit
                // data instead of isError.
                return mockCmdResult(1, '', `mock command failure (injected) for: ${opts.command}`);
            }

            // No stale intercepts here otherwise: runner.js's Deploy/Integ
            // probes, `bd show`/`bd update`/`bd create` reopen/newTasks
            // calls, etc. are executed for real against tempDir, same as
            // every other bd/node command below.
            const { err, stdout, stderr } = await runCmd(opts.command, tempDir);
            if (err) {
                // apra-fleet-1cb.1: match src/tools/execute-command.ts, which
                // only ever fails a call (no MCP result at all, or a caught
                // exception) on a genuine spawn/transport failure -- a
                // nonzero-exit `bd`/git/node invocation still returns a normal
                // ExecuteCommandResult with structuredContent.exitCode set, no
                // isError. Node's child_process exec() sets `err.code` to the
                // process's numeric exit code for an ordinary nonzero exit;
                // it is left undefined (or 'ENOENT') only when the process
                // itself never ran (e.g. couldn't spawn). Only THAT case is a
                // genuine dispatch-level failure here.
                if (isSpawnFailure(err)) {
                    return { isError: true, content: [{ text: stderr || err.message }] };
                }
                const exitCode = typeof err.code === 'number' ? err.code : 1;
                return mockCmdResult(exitCode, stdout, stderr);
            }
            return mockCmdResult(0, stdout, stderr);
        },
        executePrompt: async (opts) => {
            // Note: the workflow layer's agent() payload does NOT forward
            // opts.label into executePrompt (see
            // packages/apra-fleet-workflow/src/workflow/index.mjs, payload
            // only carries prompt/model/member/agent/etc.), so the Final
            // Review phase cannot be distinguished from the regular
            // per-round review via opts.label here. Both share agentType
            // 'reviewer'; distinguish by the (fixed, runner.js-authored)
            // prompt text instead -- apra-fleet-unw.17's buildFinalVerdictPrompt()
            // always starts with this exact prefix.
            //
            // apra-fleet-02s.3: that prefix is only present on a FRESH
            // dispatch (opts.resume === false). A schema-repair round now
            // forces resume:true with a lean reminder prompt that carries no
            // such prefix, so a resumed 'reviewer' call falls back to
            // whichever classification the last fresh dispatch had --
            // see lastFreshReviewerWasFinalReview above.
            const isFinalReview = opts.agent === 'reviewer' && (
                opts.resume === true
                    ? lastFreshReviewerWasFinalReview
                    : opts.prompt.startsWith('Final review for sprint scope issue id(s):')
            );
            if (opts.agent === 'reviewer' && opts.resume !== true) {
                lastFreshReviewerWasFinalReview = isFinalReview;
            }
            // No longer gated on opts.agent === 'planner': this dispatch has
            // no vendored persona of its own (see the streakAssignment
            // schema comment in contracts.mjs) and runner.js deliberately
            // stopped setting agentType on it (activating the real
            // planner.md persona for this narrow, self-contained grouping
            // task caused the model to go exploring instead of answering
            // directly -- the root cause of a real dispatch-timeout bug).
            // Detect it by its distinctive prompt content instead.
            const isStreakAssignment = opts.prompt.includes('Ready bead ids:');
            // apra-fleet-eft.29.2: also record the per-call sprint_id the
            // FleetWorkflow agent() payload carries through to executePrompt
            // (see AgentOptions.sprint_id / apra-fleet-eft.29.1) -- this is
            // what lets a test confirm runSprintCycle's `agent` wrapper (the
            // sprintMutexId stamp in runner.js) actually reaches every real
            // dispatch call site, not just the ones exercised directly by an
            // execute-prompt.ts unit test.
            // apra-fleet-eft.78.4: also record the resolved `resume` value
            // (boolean|string, see AgentOptions.resume in
            // packages/apra-fleet-workflow/src/workflow/index.mjs) each
            // dispatch actually carried -- lets a test assert on runner.js's
            // per-role round-resume wiring (createRoundSessionRegistry) end
            // to end: a warm within-cycle resume carries the PRIOR round's
            // explicit session id string, a cross-cycle dispatch carries
            // `false`. Purely additive (a new object key); no existing
            // assertion reads/compares the whole `dispatched` entry shape.
            // apra-fleet-eft.79: also record the resolved `model` each dispatch
            // carried -- lets a worklist test assert per-streak tier values
            // (e.g. a standard streak resumed after a cheap streak dispatches
            // with model=standard). Purely additive, same rationale as the
            // `resume` key above.
            dispatched.push({ agent: opts.agent, label: isFinalReview ? 'Final Review' : null, prompt: opts.prompt, member: opts.member_name, sprintId: opts.sprint_id, resume: opts.resume, model: opts.model });
            await sleep(DELAY_MS);

            // --- plan phase: planner ---
            if (opts.agent === 'planner' && !isStreakAssignment) {
                if (plannerHandler) {
                    return plannerHandler({ opts, tempDir, runCmd, epicBead });
                }
                if (addExtraTaskDuringPlan && !extraTaskAdded) {
                    extraTaskAdded = true;
                    // Contract enforcement (vendored planner.md Step 3): the
                    // model tier is recorded ONLY as beads `--metadata`
                    // ('{"model": "..."}') at creation time -- never in
                    // `--notes`. This mock planner obeys that contract so the
                    // suite exercises the same shape a real planner would
                    // produce, catching any future drift back to `--notes`.
                    // NOTE: the JSON arg is double-quoted with escaped inner
                    // quotes (NOT single-quoted) so it survives Windows
                    // cmd.exe, where single quotes are literal characters and
                    // would make bd reject the metadata as invalid JSON.
                    await runCmd('bd create -t task "Task: Add tests for API endpoints" --metadata "{\\"model\\": \\"standard-tier\\"}"', tempDir);
                    const list = JSON.parse((await runCmd('bd list --json', tempDir)).stdout || '[]');
                    const newTask = list.find((i) => i.title.includes('Add tests for API endpoints'));
                    if (newTask) {
                        await runCmd(`bd update ${newTask.id} --parent ${epicBead.id}`, tempDir);
                    }
                }
                return {
                    content: [{
                        text: 'Analyzed the Fleet Member API epic. Ensured tasks exist for implementation and for e2e tests covering registerMember and listMembers.'
                    }]
                };
            }

            // --- plan phase: plan-reviewer ---
            if (opts.agent === 'plan-reviewer') {
                planRound++;

                // Contract enforcement (vendored plan-reviewer.md Inputs +
                // agents/schemas/plan-reviewer-input.json, required: ["scope"]):
                // the dispatch prompt MUST supply the sprint root / scope to
                // review. Per plan-reviewer.md's missing-input behavior, a
                // dispatch without scope must return verdict CHANGES_NEEDED,
                // notes stating the scope is missing, and taskAssignments: [].
                // This mock obeys that CONTRACT rather than the runner's old
                // behavior: if runner.js ever reverts to a context-free
                // dispatch (no scope / no sprint root id), the plan is never
                // approved and the sprint fails -- a tripwire on regression.
                const promptHasScope = /scope/i.test(opts.prompt) && opts.prompt.includes(epicBead.id);
                if (!promptHasScope) {
                    return {
                        content: [{
                            text: JSON.stringify({
                                verdict: 'CHANGES_NEEDED',
                                notes: 'Dispatch prompt did not supply the sprint root / scope to review (plan-reviewer-input.json required key "scope" missing).',
                                taskAssignments: [],
                            })
                        }]
                    };
                }

                if (planReviewerHandler) {
                    return planReviewerHandler({ opts, tempDir, runCmd, epicBead, planRound });
                }

                // apra-fleet-unw.15: plan-reviewer responses are now
                // schema-validated JSON (contracts.mjs `planReviewerVerdict`)
                // consumed via agent()'s { schema } option, not free text.
                if (planReviewerMode === 'always-reject-free-text') {
                    // Deliberately NOT JSON, and deliberately contains the
                    // substring "APPROVED" inside a rejection sentence --
                    // this must never be misread as an approval, and must
                    // exhaust agent()'s bounded schema-repair loop (it can
                    // never be coerced into schema-valid JSON) every round.
                    return { content: [{ text: 'This can NOT be APPROVED: the DAG is still missing a documentation task.' }] };
                }

                if (planReviewerMode === 'approve-immediately' || planRound >= 2) {
                    return {
                        content: [{
                            text: JSON.stringify({
                                verdict: 'APPROVED',
                                notes: 'Code looks solid. We have tasks for implementation and tests.',
                                taskAssignments: [],
                            })
                        }]
                    };
                }

                return {
                    content: [{
                        text: JSON.stringify({
                            verdict: 'CHANGES_NEEDED',
                            notes: 'Ensure you also add a documentation task.',
                            taskAssignments: [],
                        })
                    }]
                };
            }

            // --- develop phase: streak grouping (still agentType 'planner') ---
            // apra-fleet-unw.16: the runner now dispatches this with a
            // schema (contracts.mjs `streakAssignment`) and actually
            // consumes the result -- the mock returns real, schema-valid
            // JSON (one bead per streak, covering every ready bead id
            // exactly once) rather than free text, so the "real
            // consumption" path is exercised, not the invalid-output
            // fallback.
            if (isStreakAssignment) {
                const idsMatch = opts.prompt.match(/Ready bead ids:\s*(.+)/);
                const ids = idsMatch ? idsMatch[1].split(',').map((s) => s.trim()).filter(Boolean) : [];
                return { content: [{ text: JSON.stringify({ streaks: ids.map((id) => [id]) }) }] };
            }

            // --- develop phase: doer ---
            if (opts.agent === 'doer') {
                // Contract enforcement (vendored doer.md Inputs +
                // agents/schemas/doer-input.json, required: ["branch"]): the
                // dispatch prompt MUST supply the sprint track branch to
                // work on. Per doer.md's missing-input behavior, a doer
                // dispatched without a branch must return status "BLOCKED"
                // (closedIds: []) instead of guessing whatever branch is
                // checked out. Enforced here at the dispatch seam -- BEFORE
                // any scenario's doerHandler override runs -- so every doer
                // path obeys the CONTRACT uniformly: if runner.js ever drops
                // the branch from buildDoerPrompt, no bead is ever
                // worked/closed and the sprint fails, tripping this
                // regression.
                //
                // Skipped on a RESUMED dispatch (opts.resume === true): the
                // max_turns-exhaustion resume path sends a short
                // "continue where you left off" nudge, not a fresh prompt --
                // the branch was already established in the session being
                // resumed, so this gate would otherwise misfire on every
                // resume attempt regardless of what the real prompt said.
                if (opts.resume !== true && !/Sprint track branch to work on:\s*\S+/.test(opts.prompt)) {
                    return {
                        content: [{
                            text: JSON.stringify({
                                status: 'BLOCKED',
                                closedIds: [],
                                notes: 'Sprint track branch was not specified in the dispatch prompt (doer-input.json required key "branch" missing).',
                            })
                        }]
                    };
                }
                const handler = doerHandler || defaultDoerHandler;
                return handler({ opts, tempDir, runCmd, epicBead });
            }

            // --- review phase: reviewer (dev-loop review; final review handled separately below) ---
            if (opts.agent === 'reviewer' && !isFinalReview) {
                reviewRound++;
                const handler = reviewerHandler || defaultReviewerHandler;
                return handler({ opts, tempDir, runCmd, epicBead, reviewRound });
            }

            // --- final review (apra-fleet-unw.17, A6) ---
            //
            // Default mock: an EVIDENCE-BASED final reviewer, not a blind
            // rubber stamp. It parses the real evidence runner.js's
            // buildFinalVerdictPrompt() embeds in the prompt text (open
            // goal-priority bead count, deploy/integ failure markers) and
            // returns a verdict actually derived from that evidence --
            // deliberately NOT a hardcoded PASS -- so this mock can never
            // accidentally paper over the exact "rubber-stamped success" bug
            // (A6) this test suite exists to catch. `finalReviewHandler`
            // lets a scenario override this when it wants to control the
            // verdict directly instead (e.g. to test a hard-FAIL response).
            if (isFinalReview) {
                if (finalReviewHandler) {
                    return finalReviewHandler({ opts, tempDir, runCmd, epicBead });
                }
                const openMatch = opts.prompt.match(/(\d+) bead\(s\) still open at or above goal priority/);
                const openCount = openMatch ? Number(openMatch[1]) : 0;
                const hasDeployFailure = opts.prompt.includes('Deploy phase FAILED');
                const hasIntegFailure = opts.prompt.includes('Integration tests FAILED');
                if (openCount > 0 || hasDeployFailure || hasIntegFailure) {
                    return {
                        content: [{
                            text: JSON.stringify({
                                verdict: 'FAIL',
                                notes: `Evidence-based FAIL: ${openCount} open goal-priority bead(s), deployFailure=${hasDeployFailure}, integFailure=${hasIntegFailure}.`,
                            })
                        }]
                    };
                }
                return {
                    content: [{
                        text: JSON.stringify({
                            verdict: 'PASS',
                            notes: 'All goal-priority beads closed, last review APPROVED, deploy/integ phases (if any) succeeded. Excellent velocity and solid implementation.',
                        })
                    }]
                };
            }

            // --- deploy phase (apra-fleet-unw.17, A4: schema-validated) ---
            if (opts.agent === 'deployer') {
                if (deployHandler) return deployHandler({ opts, tempDir, runCmd, epicBead });
                return {
                    content: [{
                        text: JSON.stringify({
                            deployed: true,
                            notes: 'Successfully ran `npm publish` and published @apralabs/apra-fleet-client to the local registry.',
                        })
                    }]
                };
            }

            // --- integ test phase (apra-fleet-unw.17, A4: schema-validated) ---
            if (opts.agent === 'integ-test-runner') {
                if (integHandler) return integHandler({ opts, tempDir, runCmd, epicBead });
                // apra-fleet-66u.2: a real integ-test-runner closes the
                // bead(s) named in its own "verification-closure: <ids>."
                // prompt clause once it confirms they hold -- the default
                // mock must do the same, or any scenario relying on this
                // default (no integHandler override) can never see its own
                // --issue target (a decomposed parent once it has children)
                // actually close, which now genuinely blocks sprint
                // completion (apra-fleet-66u.1 correctly requires it, via
                // the pre-existing stillOpenVerifyIds/verifyEverIds gate).
                const verifyMatch = opts.prompt.match(/verification-closure:\s*([^.]+)\./);
                const verifyIds = verifyMatch ? verifyMatch[1].split(',').map((s) => s.trim()).filter(Boolean) : [];
                for (const id of verifyIds) {
                    await runCmd(`bd close ${id} --reason "Verified against the deployed build."`, tempDir);
                }
                return {
                    content: [{
                        text: JSON.stringify({
                            featuresClosed: 2,
                            issuesCreated: 0,
                            passed: true,
                            bugsFiled: [],
                            summary: verifyIds.length > 0
                                ? `All vitest e2e specs passed successfully. Verified and closed: ${verifyIds.join(', ')}.`
                                : 'All vitest e2e specs passed successfully.',
                        })
                    }]
                };
            }

            // --- regression test phase (apra-fleet-417.4: schema-validated) ---
            //
            // Once-per-sprint, informational, only dispatched when
            // regression-test-playbook.md exists in tempDir (see
            // runDevelopLoopScenario's `withRegressionPlaybook` option). Not
            // reached by any existing scenario that omits that flag -- the
            // real probeFileExists('regression-test-playbook.md') check in
            // runner.js skips the phase entirely without it, same as the
            // Deploy/Integ phases above without deploy.md/integ-test-
            // playbook.md.
            if (opts.agent === 'regression-test-runner') {
                if (regressionHandler) return regressionHandler({ opts, tempDir, runCmd, epicBead });
                return {
                    content: [{
                        text: JSON.stringify({
                            passed: true,
                            suitePassed: true,
                            smokePassed: true,
                            bugsFiled: [],
                            summary: 'Mock regression pass: full suite and sandbox smoke test both green.',
                        })
                    }]
                };
            }

            // --- harvest phase (apra-fleet-unw.17, A6: schema-validated;
            //     apra-fleet-unw2.10, N12: contract enforcement) ---
            //
            // The vendored harvester-input.json requires
            // analysisArtifactFile/analysisText/costAnalysis/base-branch/
            // branch (see agents/harvester.md's own "Missing-input
            // behavior": a contract-obeying harvester returns FAILED, never
            // fabricates a substitute, if any of these is absent from its
            // dispatch). This mock now enforces that for real -- it is NOT
            // enough for the runner to merely include SOME text; each
            // required input must be genuinely present in the prompt this
            // dispatch actually received. Prior to apra-fleet-unw2.10 the
            // runner told the harvester these were UNAVAILABLE; this check
            // fails loudly if that regression ever comes back.
            if (opts.agent === 'harvester') {
                const missing = checkHarvesterContract(opts.prompt);
                if (missing.length > 0) {
                    return {
                        content: [{
                            text: JSON.stringify({
                                status: 'FAILED',
                                notes: `Missing required harvester input(s): ${missing.join(', ')}.`,
                            })
                        }]
                    };
                }
                return {
                    content: [{
                        text: JSON.stringify({
                            status: 'OK',
                            notes: 'Harvested API usage patterns to memory. Updated context docs.',
                        })
                    }]
                };
            }

            // --- permissions heal (apra-fleet-u1qw.2.3: schema-validated
            //     against runner.js's permissionsComposerReport) ---
            //
            // Only reachable when a Deploy/Integ Test/Regression Test result
            // reported blockedReason='missing_permissions'. No default stub on
            // purpose: a scenario that supplies no handler is asserting that
            // NO heal dispatch happens, so make that fail by construction.
            if (opts.agent === 'permissions-composer') {
                if (permissionsComposerHandler) return permissionsComposerHandler({ opts, tempDir, runCmd, epicBead });
                throw new Error(
                    `advanced-mock-runner-test: permissions-composer dispatched but this scenario supplied no permissionsComposerHandler (label=${opts.label})`
                );
            }

            // Any agentType reaching here means runner.js dispatched something
            // this mock doesn't know about -- fail loudly instead of silently
            // falling through to a generic stub (that's exactly the bug this
            // test exists to catch).
            throw new Error(`advanced-mock-runner-test: unhandled agentType '${opts.agent}' (label=${opts.label})`);
        }
    };
}

export async function teardown(tempDir) {
    if (!tempDir) return;
    let retries = 8;
    while (retries > 0) {
        try {
            // Windows can hold file handles open briefly after child
            // processes (bd CLI) exit; retry on EBUSY.
            await fs.rm(tempDir, { recursive: true, force: true, maxRetries: 3 });
            return;
        } catch (e) {
            if (e.code === 'EBUSY' && retries > 1) {
                retries--;
                await sleep(400);
            } else {
                console.error('Could not fully clean up temp dir:', tempDir, e.message);
                return;
            }
        }
    }
}

export async function runOnce(tag, planReviewerMode = 'reject-then-approve') {
    const { tempDir, epicBead } = await setup(tag);
    const dispatched = [];
    const commandLog = [];
    let passed = false;
    try {
        const mockFleetApi = buildMockFleetApi(tempDir, epicBead, dispatched, commandLog, { planReviewerMode });
        // apra-fleet-20i.1.2: thread this scenario's own tag through as
        // logPrefix (apra-fleet-20i.1.1's third FleetWorkflow constructor
        // arg) so every [Workflow Log]/[Dispatch]/[Command] line this run
        // produces is identifiable when scenarios interleave in test output.
        // The real single-sprint CLI path (bin/cli.mjs) constructs
        // `new FleetWorkflow(fleetApi)` with no third arg and keeps the
        // default '' prefix -- unaffected by this change.
        const workflow = new FleetWorkflow(mockFleetApi, { targetRepo: tempDir }, `[${tag}] `);
        const engine = new WorkflowEngine(workflow);

        // apra-fleet-eft.70.2: phase-tagged command activity log. FleetWorkflow
        // (an EventEmitter) emits 'activity:start' for every command()/agent()
        // call -- INCLUDING journal-replayed cache hits (see
        // packages/apra-fleet-workflow/src/workflow/index.mjs's command()) --
        // carrying the exact `command` text and the `phase` title active at
        // dispatch time (opts.phase || this._currentPhase()). Listening here
        // (rather than reconstructing phase boundaries from commandLog's flat
        // string order) gives the full-DB-fetch tripwire test
        // (test/full-db-fetch-tripwire.test.mjs) a reliable, source-independent
        // way to group commands by the phase step they ran in.
        const activityLog = [];
        workflow.on('activity:start', (meta) => {
            if (meta && meta.type === 'command') {
                activityLog.push({ phase: meta.phase, command: meta.command });
            }
        });

        // apra-fleet-unw.14: runner.js now validates a full CLI->runner arg
        // contract (branch/base_branch/members are required; goal/max_cycles
        // are optional with defaults) before any dispatch, and uses
        // branch/base_branch for the git checkout/push/PR steps below.
        const scriptPath = path.join(__dirname, '../../fleet-sprint/runner.js');
        const result = await engine.executeFile(scriptPath, {
            target_issue: epicBead.id,
            members: ['local'],
            branch: uniqueMockBranch(tag),
            base_branch: 'main',
            goal: 'P1/P2',
            max_cycles: 5,
            callTool: defaultMockCallTool(),
        }, true);

        // bd list hides closed issues by default -- pass --all so the final
        // state assertion actually sees closed beads.
        const finalBeadsRaw = JSON.parse((await runCmd('bd list --all --json', tempDir)).stdout || '[]');
        const finalBeads = finalBeadsRaw
            .map((b) => ({ title: b.title, status: b.status }))
            .sort((a, b) => a.title.localeCompare(b.title));

        // apra-fleet-x8r.5: unlike runRejectedPlanScenario/
        // runDevelopLoopScenario, runOnce() has no inner try/catch that
        // swallows the run's error into a returned value -- engine.executeFile()
        // above is awaited directly, so a thrown error skips straight past
        // this line to the finally block below with `passed` still false.
        // No change needed here; verified while auditing the other two.
        passed = true;
        return { dispatched, result, finalBeads, commandLog, activityLog, epicBeadId: epicBead.id };
    } finally {
        // apra-fleet-20i.1.2: explicit per-scenario END marker (distinct
        // from the generic withScenarioMarkers() START/END pair used by
        // individual test files -- this one is keyed on the harness's own
        // `tag`, which every dispatch/log line above was just prefixed
        // with, so the two are trivially correlated in raw test output).
        console.log(`=== END scenario: ${tag} (${passed ? 'PASS' : 'FAIL'}) ===`);
        await teardown(tempDir);
    }
}

/**
 * apra-fleet-unw.15 scenario: the plan-reviewer never approves (always
 * returns non-JSON free text containing "APPROVED" inside a rejection
 * sentence, exhausting the schema-repair loop every round). Expects
 * engine.executeFile() to REJECT with a SprintPlanRejectedError, and
 * expects zero doer dispatches -- the sprint must never reach Develop with
 * an unapproved plan.
 */
export async function runRejectedPlanScenario(tag) {
    const { tempDir, epicBead } = await setup(tag);
    const dispatched = [];
    const commandLog = [];
    let passed = false;
    try {
        const mockFleetApi = buildMockFleetApi(tempDir, epicBead, dispatched, commandLog, { planReviewerMode: 'always-reject-free-text' });
        // apra-fleet-20i.1.2: see runOnce() above -- same tag-as-logPrefix
        // threading, real single-sprint CLI path unaffected.
        const workflow = new FleetWorkflow(mockFleetApi, { targetRepo: tempDir }, `[${tag}] `);
        const engine = new WorkflowEngine(workflow);
        const scriptPath = path.join(__dirname, '../../fleet-sprint/runner.js');

        let error = null;
        try {
            await engine.executeFile(scriptPath, {
                target_issue: epicBead.id,
                members: ['local'],
                branch: uniqueMockBranch(`${tag}-rejected`),
                base_branch: 'main',
                goal: 'P1/P2',
                max_cycles: 5,
            }, true);
        } catch (err) {
            error = err;
        }

        // apra-fleet-x8r.5: this scenario's own documented contract (see the
        // docstring above) is that engine.executeFile() REJECTS with a
        // SprintPlanRejectedError -- that IS the success case, not merely
        // "the harness didn't crash". Previously `passed` was set
        // unconditionally here, so the marker printed PASS even on a run
        // where the plan was (incorrectly) never rejected, silencing the one
        // signal that would have flagged it.
        passed = Boolean(error);
        return { dispatched, error };
    } finally {
        // apra-fleet-20i.1.2: see runOnce() above.
        console.log(`=== END scenario: ${tag}-rejected (${passed ? 'PASS' : 'FAIL'}) ===`);
        await teardown(tempDir);
    }
}

/**
 * Shared harness for the apra-fleet-unw.16 develop/review-loop scenarios:
 * minimal setup (no deploy.md/integ-test-playbook.md, no plan-phase
 * re-planning churn -- plan approves immediately), a `logs` array capturing
 * every `FleetWorkflow` 'log' event (so scenarios can assert on the
 * orchestrator's own reasoning, e.g. "treating streak as FAILED", without
 * having to reverse-engineer internal round-counting), and pass-through
 * doer/reviewer handler overrides.
 */
export async function runDevelopLoopScenario(tag, {
    members, taskSpecs, doerHandler, reviewerHandler, plannerHandler,
    // apra-fleet-eft.72.2: optional plan-reviewer override -- see
    // buildMockFleetApi's `planReviewerHandler` option comment above. When
    // provided, this scenario's plan phase is driven by the handler instead
    // of the default 'approve-immediately' mode below.
    planReviewerHandler,
    // apra-fleet-unw.17 additions:
    deployHandler, integHandler, finalReviewHandler, commandFailurePattern,
    // apra-fleet-417.4: optional (opts, tempDir, runCmd, epicBead) => result
    // override for the 'regression-test-runner' dispatch -- see
    // buildMockFleetApi's option comment above. Paired with
    // `withRegressionPlaybook` below (writes regression-test-playbook.md so
    // the real probe finds it and the phase actually dispatches).
    regressionHandler,
    // apra-fleet-u1qw.2.3: optional (opts, tempDir, runCmd, epicBead) =>
    // result override for the orchestrator-side 'permissions-composer' heal
    // dispatch -- see buildMockFleetApi's option comment above. Omit it to
    // assert that a scenario triggers no heal at all.
    permissionsComposerHandler,
    goal = 'P1/P2', maxCycles = 1,
    // Optional hook invoked with {tempDir, runCmd, epicBead, tasks} AFTER
    // setupMinimal() creates the epic/tasks but BEFORE the sprint runs --
    // used by scenarios that need extra beads/dependency wiring not covered
    // by plain taskSpecs (e.g. a permanently-blocked bead for the A5
    // goal-priority exit-condition scenarios below).
    beforeSprint,
    // deploy.md / integ-test-playbook.md are NOT written by setupMinimal();
    // set true to write them (enabling the Deploy/Integ phases).
    withRunbooks = false,
    // apra-fleet-417.4: regression-test-playbook.md is NOT written by
    // setupMinimal() or withRunbooks (it is a wholly separate, once-per-
    // sprint phase with its own probe); set true to write it (enabling the
    // Regression Test phase, and pairing with `regressionHandler` above).
    withRegressionPlaybook = false,
    // apra-fleet-unw2.9 (N11) additions: see buildMockFleetApi's option
    // comments above. `branchOverride` lets a scenario force a specific
    // branch name (rather than the tag-derived default) -- used by the
    // idempotent-PR-creation regression test, which must dispatch TWO
    // separate scenario runs against the exact SAME branch to simulate a
    // re-run of finalization.
    gitGhFailurePattern, gitGhFailureMessage, prExistsState, branchOverride,
    // apra-fleet-647.1.1.3: see buildMockFleetApi's `prCurlResponseQueue`
    // option comment above.
    prCurlResponseQueue,
    // apra-fleet-eft.64.1: optional override for the mocked `git remote
    // get-url origin` stdout -- see buildMockFleetApi's `originUrl` option
    // comment above. Lets a scenario simulate a non-hosted remote (e.g.
    // `file:///path/to/bare-mirror.git`) to exercise the Publish PR step's
    // skip-PR/direct-close path instead of the default hosted-GitHub path.
    originUrl,
    // apra-fleet-eft.28.4: optional override for `args.dispatch_timeout_s`
    // (validateArgs floor: integer >= 60; runner.js defaults to 3600 when
    // omitted). Lets a scenario exercise the client-side dispatch-timeout
    // watchdog (withDispatchWatchdog, apra-fleet-eft.28.3) against a short,
    // deterministic budget instead of waiting on the hour-long production
    // default.
    dispatchTimeoutS,
    // apra-fleet-eft.75.3: optional `args.callTool` passthrough -- the exact
    // same known arg key bin/cli.mjs wires from its live `mcpClient.callTool`
    // (apra-fleet-eft.75.1) -- so a scenario can inject a spy and prove the
    // REAL runner.js call sites (e.g. the doer max-turns resume ladder) drive
    // createMemberSessionGuard()'s `stop_prompt` call end-to-end, rather than
    // only unit-testing the guard helper in isolation.
    callTool,
    // apra-fleet-eft.79: optional passthroughs for the multi-streak worklist
    // args (validateArgs: doer_worklist_mode 'resume'|'batch',
    // resume_model_switch boolean, worklist_effort_budget positive number) --
    // used by the worklist mock-sprint scenarios.
    doerWorklistMode, resumeModelSwitch, worklistEffortBudget,
    // apra-fleet-glv.2: optional `args.roleMap` passthrough (validateArgs:
    // object mapping role -> member[], see runner.js's getMemberForRole/
    // getMembersForRole). Lets a scenario pin a specific role (e.g.
    // 'reviewer') onto a member DIFFERENT from the default doer member, so a
    // test can assert per-role behavior (such as the VCS-auth preflight's
    // pushCode gating) against a member that provably never receives a
    // code-writing dispatch.
    roleMap,
}) {
    const { tempDir, epicBead, tasks } = await setupMinimal(tag, taskSpecs);
    if (withRunbooks) {
        await fs.writeFile(path.join(tempDir, 'deploy.md'), '# Deploy\nrun `npm publish`');
        await fs.writeFile(path.join(tempDir, 'integ-test-playbook.md'), '# Integ Test\nRun `vitest e2e`');
    }
    if (withRegressionPlaybook) {
        await fs.writeFile(path.join(tempDir, 'regression-test-playbook.md'), '# Regression\nRun the full suite, then the sandbox smoke test, then Teardown.');
    }
    if (beforeSprint) {
        await beforeSprint({ tempDir, runCmd, epicBead, tasks });
    }
    const dispatched = [];
    const commandLog = [];
    const commandLogDetailed = [];
    const memberGitState = new Map();
    const logs = [];
    const states = [];
    // apra-fleet-eft.60.3: opt this hermetic run into the runner's zero-wait
    // Planner-dispatch retry backoff. The ~110s of real PLANNER_DISPATCH_RETRY_
    // DELAYS_MS backoff only models a real fleet member's execute_prompt
    // busy-lock clearing -- there is no such lock in this in-process mock, so
    // burning it as real wall-clock is dead time that (stacked on the one-time
    // real-bd setup/read overhead under APRA_FLEET_BD_MOCK=off) pushed the
    // dead-session/dead-pid retry-ladder regression tests up against their 180s
    // file timeout on slow CI hosts. The runner still runs the FULL 5-attempt
    // ladder and logs each "waiting Ns" line with the real configured delay;
    // production behavior (real timed sleep, unchanged delay values) is
    // untouched -- only this env-gated test path skips the sleep. Restored in
    // the finally so it never leaks past this scenario.
    const priorInstantRetryBackoff = process.env.APRA_FLEET_MOCK_INSTANT_RETRY_BACKOFF;
    process.env.APRA_FLEET_MOCK_INSTANT_RETRY_BACKOFF = '1';
    let passed = false;
    // apra-fleet-ot2z.14: runner.js's main() acquires the machine-local
    // sprint pidfile mutex (fleet-sprint/sprint-lock.mjs) keyed on
    // (branch, members) against the OS-tmpdir-wide default lock directory
    // unless APRA_FLEET_SPRINT_LOCK_DIR is set. uniqueMockBranch()/the
    // tag-derived branch above already prevent two mock scenarios from
    // colliding on the SAME key, but every scenario still shared that one
    // real, machine-global lock directory -- so under `--test-concurrency=8`
    // a mock run here could spuriously hit SprintLockHeldError against an
    // unrelated REAL fleet-sprint concurrently running on the same host (or
    // its stale lockfile). Give every scenario invocation its own private,
    // throwaway lock directory so it can never contend with a real sprint or
    // any other test process; restored/cleaned up in the finally below.
    const priorSprintLockDir = process.env.APRA_FLEET_SPRINT_LOCK_DIR;
    const sprintLockDir = await fs.mkdtemp(path.join(os.tmpdir(), 'apra-fleet-sprint-lock-mock-'));
    process.env.APRA_FLEET_SPRINT_LOCK_DIR = sprintLockDir;
    try {
        const mockFleetApi = buildMockFleetApi(tempDir, epicBead, dispatched, commandLog, {
            planReviewerMode: 'approve-immediately',
            addExtraTaskDuringPlan: false,
            doerHandler,
            reviewerHandler,
            plannerHandler,
            planReviewerHandler,
            deployHandler,
            integHandler,
            finalReviewHandler,
            regressionHandler,
            permissionsComposerHandler,
            commandFailurePattern,
            commandLogDetailed,
            memberGitState,
            gitGhFailurePattern,
            gitGhFailureMessage,
            prExistsState,
            ...(originUrl !== undefined ? { originUrl } : {}),
            ...(prCurlResponseQueue !== undefined ? { prCurlResponseQueue } : {}),
        });
        // apra-fleet-20i.1.2: see runOnce() above -- same tag-as-logPrefix
        // threading, real single-sprint CLI path unaffected.
        const workflow = new FleetWorkflow(mockFleetApi, { targetRepo: tempDir }, `[${tag}] `);
        workflow.on('log', (e) => logs.push(e.msg));
        // apra-fleet-eft.28.2: publishState() (runner.js's sprint-state
        // persistence, e.g. the main() typed-abort catch's
        // publishState('terminal', ...)) emits a 'state' event on the
        // FleetWorkflow instance -- captured here so a scenario can assert
        // a terminal error was actually PERSISTED to sprint state, not just
        // logged.
        workflow.on('state', (e) => states.push(e));
        const engine = new WorkflowEngine(workflow);
        const scriptPath = path.join(__dirname, '../../fleet-sprint/runner.js');

        const branch = branchOverride || `auto-sprint/mock-${tag}`;
        let error = null;
        let result = null;
        try {
            result = await engine.executeFile(scriptPath, {
                target_issue: epicBead.id,
                members,
                branch,
                base_branch: 'main',
                goal,
                max_cycles: maxCycles,
                ...(dispatchTimeoutS !== undefined ? { dispatch_timeout_s: dispatchTimeoutS } : {}),
                callTool: callTool !== undefined ? callTool : defaultMockCallTool(),
                ...(doerWorklistMode !== undefined ? { doer_worklist_mode: doerWorklistMode } : {}),
                ...(resumeModelSwitch !== undefined ? { resume_model_switch: resumeModelSwitch } : {}),
                ...(worklistEffortBudget !== undefined ? { worklist_effort_budget: worklistEffortBudget } : {}),
                ...(roleMap !== undefined ? { roleMap } : {}),
            }, true);
        } catch (err) {
            error = err;
        }

        // apra-fleet-eft.54.3: a no-mutation terminal dispatch error (the
        // agent dispatch itself failed -- AgentDispatchError/FleetTransportError,
        // not a max_turns_exhausted resume case) means there is provably
        // nothing new in the beads DB for THIS run to have produced, so this
        // diagnostic `bd list --all --json` read -- a real bd/dolt spawn under
        // APRA_FLEET_BD_MOCK=off -- is skipped entirely rather than run
        // unconditionally in this shared harness's post-run teardown. Every
        // other outcome (success, or a typed sprint-abort that fired AFTER a
        // dispatch already ran -- e.g. ReviewerContractViolationError/
        // StalledSprintError -- which may have mutated real beads) keeps the
        // exact prior behavior; finalBeadsById is simply an empty Map for the
        // no-mutation case (no existing scenario asserts on it there).
        const skipFinalBeadsRead = isNoMutationTerminalDispatchError(error);
        const finalBeadsById = skipFinalBeadsRead
            ? new Map()
            : new Map(JSON.parse((await runCmd('bd list --all --json', tempDir)).stdout || '[]').map((b) => [b.id, b]));

        // apra-fleet-eft.60.4: tempDir is returned (in addition to the
        // per-command commandLog) so a scenario can query the real-mode
        // per-clone dolt-sync spawn cache (bd-replay.mjs's
        // realSyncSpawnCount(tempDir, ...)) -- the commandLog alone cannot
        // distinguish "requested N times, served from cache" from "actually
        // spawned N times".
        //
        // apra-fleet-x8r.5: `error` (captured just above from the inner
        // try/catch around engine.executeFile) is the actual run outcome --
        // previously `passed` was set unconditionally here regardless of
        // `error`, so the marker printed PASS even for a run that aborted.
        // Report the run's real outcome instead; the FAIL branch is now
        // reachable for scenarios whose sprint run ends in an error, exactly
        // as intended by callers that deliberately induce one (e.g. a doer
        // throw or a typed sprint-abort) to verify error handling.
        passed = (error === null);
        return { dispatched, commandLog, commandLogDetailed, memberGitState, logs, states, error, result, tasks, epicBeadId: epicBead.id, finalBeadsById, branch, tempDir };
    } finally {
        // apra-fleet-20i.1.2: see runOnce() above.
        console.log(`=== END scenario: ${tag} (${passed ? 'PASS' : 'FAIL'}) ===`);
        // apra-fleet-eft.60.3: restore the caller's prior value (never leak the
        // instant-backoff flag past this scenario).
        if (priorInstantRetryBackoff === undefined) {
            delete process.env.APRA_FLEET_MOCK_INSTANT_RETRY_BACKOFF;
        } else {
            process.env.APRA_FLEET_MOCK_INSTANT_RETRY_BACKOFF = priorInstantRetryBackoff;
        }
        if (priorSprintLockDir === undefined) {
            delete process.env.APRA_FLEET_SPRINT_LOCK_DIR;
        } else {
            process.env.APRA_FLEET_SPRINT_LOCK_DIR = priorSprintLockDir;
        }
        await fs.rm(sprintLockDir, { recursive: true, force: true }).catch(() => { /* best-effort */ });
        await teardown(tempDir);
    }
}

// apra-fleet-eft.54.3 (residual after eft.54.1): true when a thrown error out
// of engine.executeFile() means the agent dispatch itself never delivered a
// usable result -- an AgentDispatchError or FleetTransportError -- and
// therefore provably produced no beads/code mutation for THIS scenario run to
// verify. runner.js's own withGitSync already skips its per-dispatch real-bd
// G-push/D-push teardown for exactly this error shape (isNoMutationDispatchFailure,
// same file); this mirrors that same no-mutation judgment one layer up, at the
// shared scenario harness's OWN post-run diagnostic read below.
//
// Deliberately narrower than runner.js's isNoMutationDispatchFailure (which
// also folds in isTypedAbortError() -- ANY WorkflowError subclass, including
// ReviewerContractViolationError/StalledSprintError/SprintPlanRejectedError/
// BudgetExceededError): those are typed sprint ABORTS that fire only AFTER a
// dispatch already succeeded and possibly mutated beads (e.g. a doer closed a
// bead before the reviewer's contract-violation abort fired -- see
// mock-sprint-stall-contract-violation.test.mjs, which asserts on
// finalBeadsById for exactly that reason). Only a genuine dispatch-channel
// failure (the agent never ran / never came back) can be assumed to have
// mutated nothing.
//
// Also excludes an AgentDispatchError whose reason says the agent PROVABLY RAN
// -- 'max_turns_exhausted' (the resumable partial-work case: the agent DID run
// and may have committed/closed beads before running out of turns) and, per
// apra-fleet-9ta.2, 'watchdog_timeout' (the prompt was DELIVERED to an
// alive-but-silent member; only the RESULT was lost, so the turn may have
// created the whole DAG). In both cases this harness's own post-run bead-state
// read still needs to reflect real state -- the same exclusion set runner.js's
// own isNoMutationDispatchFailure makes.
const AGENT_RAN_DISPATCH_REASONS = new Set(['max_turns_exhausted', 'watchdog_timeout']);

export function isNoMutationTerminalDispatchError(err) {
    if (!err) return false;
    if (err instanceof AgentDispatchError && err.details && AGENT_RAN_DISPATCH_REASONS.has(err.details.reason)) {
        return false;
    }
    return err instanceof AgentDispatchError || err instanceof FleetTransportError;
}

export const REQUIRED_AGENT_TYPES = ['planner', 'plan-reviewer', 'doer', 'reviewer', 'deployer', 'integ-test-runner', 'harvester'];

// Test-time START/END markers around a scenario's driving code (fih.1): a
// plain console.log pair, no interception machinery. Wrap the scenario's
// async body in this so pass/fail + elapsed time is visible per-scenario in
// `node --test` output even when scenarios run across parallel worker files.
export async function withScenarioMarkers(name, fn) {
    console.log(`=== START: ${name} ===`);
    const startedAt = Date.now();
    let passed = false;
    try {
        const result = await fn();
        passed = true;
        return result;
    } finally {
        const elapsedS = ((Date.now() - startedAt) / 1000).toFixed(1);
        console.log(`=== END: ${name} (${passed ? 'PASS' : 'FAIL'}, ${elapsedS}s) ===`);
    }
}
