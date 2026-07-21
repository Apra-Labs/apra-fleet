import path from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs/promises';
import os from 'os';
import { runCmd as bdRunCmd } from './bd-replay.mjs';
import { FleetWorkflow } from '@apralabs/apra-fleet-workflow';
import { WorkflowEngine } from '@apralabs/apra-fleet-workflow/engine';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Deterministic, CI-friendly mock of a full auto-sprint cycle driven against
// packages/apra-fleet-se/auto-sprint/runner.js. No live MCP server, no
// Math.random(), no fixed multi-second sleeps -- every branch below matches
// the EXACT lowercase `agentType` strings runner.js dispatches:
//   planner, plan-reviewer, doer, reviewer, deployer, integ-test-runner, harvester
//
// Set MOCK_SPRINT_DELAY_MS to simulate LLM latency locally; defaults to 0 for CI.
export const DELAY_MS = Number(process.env.MOCK_SPRINT_DELAY_MS || 0);

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
        addExtraTaskDuringPlan = true,
        // apra-fleet-unw.17 additions:
        deployHandler = null,
        integHandler = null,
        finalReviewHandler = null,
        // Optional (cmd: string) => boolean predicate: when it returns
        // true for a given executeCommand() invocation, the mock returns
        // `{ isError: true, ... }` instead of actually running the command
        // -- used to simulate a probe (or any other command()) failure
        // deterministically, without depending on real filesystem/process
        // flakiness.
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
        // hardcoded success below). When it matches, the mock returns
        // `{ isError: true, ... }` with `gitGhFailureMessage` (or a default)
        // as the failure text -- this is what lets a test observe a git/gh
        // failure path (e.g. `git push` rejected, `gh pr create` erroring
        // for a reason OTHER than "already exists") as something OTHER than
        // the unconditional "ok (mocked...)" success every git/gh command
        // got before this issue. Deliberately separate from
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
    } = options;

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

            // git/gh commands (apra-fleet-unw.14's branch-ensure/push/PR
            // steps) are intercepted rather than run for real: tempDir is a
            // bare `bd init` scratch directory, not a git repo with an
            // 'origin' remote, so there is nothing real to git-fetch/push/
            // gh-pr-create against here. This keeps the mock hermetic while
            // still exercising and asserting on runner.js's dispatch of
            // these commands.
            if (/^(git|gh)\s/.test(opts.command)) {
                // apra-fleet-unw2.9 (N11): injectable git/gh failure takes
                // priority over the PR-exists simulation below -- a test
                // that wants to observe a genuine (non-"already exists")
                // git/gh failure should get exactly that, deterministically.
                if (gitGhFailurePattern && gitGhFailurePattern.test(opts.command)) {
                    return {
                        isError: true,
                        content: [{ text: gitGhFailureMessage || `mock git/gh failure (injected) for: ${opts.command}` }],
                    };
                }

                // apra-fleet-unw2.9 (N11): idempotent `gh pr create`
                // simulation -- the first `gh pr create --head "<branch>"`
                // for a given branch records that branch into
                // `prExistsState` and succeeds; a SECOND `gh pr create` for
                // the SAME branch (simulating a re-run of finalization
                // against a branch that already has an open PR) fails with
                // an "already exists" message, mirroring the real `gh`
                // CLI's behaviour for this case.
                const prCreateMatch = /^gh pr create\b.*--head "([^"]+)"/.exec(opts.command);
                if (prCreateMatch) {
                    const branch = prCreateMatch[1];
                    if (prExistsState.has(branch)) {
                        return {
                            isError: true,
                            content: [{ text: `GraphQL: a pull request for branch "${branch}" already exists: https://github.com/mock-org/mock-repo/pull/1 (createPullRequest)` }],
                        };
                    }
                    prExistsState.add(branch);
                }

                return mockCmdResult(0, 'ok (mocked -- no real git remote in this mock sprint)', '');
            }

            // apra-fleet-unw.17, A4 acceptance criterion 5: deterministic
            // command-failure injection for probe/other command() calls,
            // used by the probe-failure-skips-phase scenario below.
            if (commandFailurePattern && commandFailurePattern.test(opts.command)) {
                return { isError: true, content: [{ text: `mock command failure (injected) for: ${opts.command}` }] };
            }

            // No stale intercepts here otherwise: runner.js's Deploy/Integ
            // probes, `bd show`/`bd update`/`bd create` reopen/newTasks
            // calls, etc. are executed for real against tempDir, same as
            // every other bd/node command below.
            const { err, stdout, stderr } = await runCmd(opts.command, tempDir);
            if (err) {
                return { isError: true, content: [{ text: stderr || err.message }] };
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
            dispatched.push({ agent: opts.agent, label: isFinalReview ? 'Final Review' : null, prompt: opts.prompt, member: opts.member_name, sprintId: opts.sprint_id });
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
                return {
                    content: [{
                        text: JSON.stringify({
                            featuresClosed: 2,
                            issuesCreated: 0,
                            passed: true,
                            bugsFiled: [],
                            summary: 'All vitest e2e specs passed successfully.',
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
    try {
        const mockFleetApi = buildMockFleetApi(tempDir, epicBead, dispatched, commandLog, { planReviewerMode });
        const workflow = new FleetWorkflow(mockFleetApi, { targetRepo: tempDir });
        const engine = new WorkflowEngine(workflow);

        // apra-fleet-unw.14: runner.js now validates a full CLI->runner arg
        // contract (branch/base_branch/members are required; goal/max_cycles
        // are optional with defaults) before any dispatch, and uses
        // branch/base_branch for the git checkout/push/PR steps below.
        const scriptPath = path.join(__dirname, '../../auto-sprint/runner.js');
        const result = await engine.executeFile(scriptPath, {
            target_issue: epicBead.id,
            members: ['local'],
            branch: 'auto-sprint/mock-sprint',
            base_branch: 'main',
            goal: 'P1/P2',
            max_cycles: 5,
        }, true);

        // bd list hides closed issues by default -- pass --all so the final
        // state assertion actually sees closed beads.
        const finalBeadsRaw = JSON.parse((await runCmd('bd list --all --json', tempDir)).stdout || '[]');
        const finalBeads = finalBeadsRaw
            .map((b) => ({ title: b.title, status: b.status }))
            .sort((a, b) => a.title.localeCompare(b.title));

        return { dispatched, result, finalBeads, commandLog, epicBeadId: epicBead.id };
    } finally {
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
    try {
        const mockFleetApi = buildMockFleetApi(tempDir, epicBead, dispatched, commandLog, { planReviewerMode: 'always-reject-free-text' });
        const workflow = new FleetWorkflow(mockFleetApi, { targetRepo: tempDir });
        const engine = new WorkflowEngine(workflow);
        const scriptPath = path.join(__dirname, '../../auto-sprint/runner.js');

        let error = null;
        try {
            await engine.executeFile(scriptPath, {
                target_issue: epicBead.id,
                members: ['local'],
                branch: 'auto-sprint/mock-sprint-rejected',
                base_branch: 'main',
                goal: 'P1/P2',
                max_cycles: 5,
            }, true);
        } catch (err) {
            error = err;
        }

        return { dispatched, error };
    } finally {
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
    // apra-fleet-unw.17 additions:
    deployHandler, integHandler, finalReviewHandler, commandFailurePattern,
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
    // apra-fleet-unw2.9 (N11) additions: see buildMockFleetApi's option
    // comments above. `branchOverride` lets a scenario force a specific
    // branch name (rather than the tag-derived default) -- used by the
    // idempotent-PR-creation regression test, which must dispatch TWO
    // separate scenario runs against the exact SAME branch to simulate a
    // re-run of finalization.
    gitGhFailurePattern, gitGhFailureMessage, prExistsState, branchOverride,
    // apra-fleet-eft.28.4: optional override for `args.dispatch_timeout_s`
    // (validateArgs floor: integer >= 60; runner.js defaults to 3600 when
    // omitted). Lets a scenario exercise the client-side dispatch-timeout
    // watchdog (withDispatchWatchdog, apra-fleet-eft.28.3) against a short,
    // deterministic budget instead of waiting on the hour-long production
    // default.
    dispatchTimeoutS,
}) {
    const { tempDir, epicBead, tasks } = await setupMinimal(tag, taskSpecs);
    if (withRunbooks) {
        await fs.writeFile(path.join(tempDir, 'deploy.md'), '# Deploy\nrun `npm publish`');
        await fs.writeFile(path.join(tempDir, 'integ-test-playbook.md'), '# Integ Test\nRun `vitest e2e`');
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
    try {
        const mockFleetApi = buildMockFleetApi(tempDir, epicBead, dispatched, commandLog, {
            planReviewerMode: 'approve-immediately',
            addExtraTaskDuringPlan: false,
            doerHandler,
            reviewerHandler,
            plannerHandler,
            deployHandler,
            integHandler,
            finalReviewHandler,
            commandFailurePattern,
            commandLogDetailed,
            memberGitState,
            gitGhFailurePattern,
            gitGhFailureMessage,
            prExistsState,
        });
        const workflow = new FleetWorkflow(mockFleetApi, { targetRepo: tempDir });
        workflow.on('log', (e) => logs.push(e.msg));
        // apra-fleet-eft.28.2: publishState() (runner.js's sprint-state
        // persistence, e.g. the main() typed-abort catch's
        // publishState('terminal', ...)) emits a 'state' event on the
        // FleetWorkflow instance -- captured here so a scenario can assert
        // a terminal error was actually PERSISTED to sprint state, not just
        // logged.
        workflow.on('state', (e) => states.push(e));
        const engine = new WorkflowEngine(workflow);
        const scriptPath = path.join(__dirname, '../../auto-sprint/runner.js');

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
            }, true);
        } catch (err) {
            error = err;
        }

        const finalBeadsRaw = JSON.parse((await runCmd('bd list --all --json', tempDir)).stdout || '[]');
        const finalBeadsById = new Map(finalBeadsRaw.map((b) => [b.id, b]));

        return { dispatched, commandLog, commandLogDetailed, memberGitState, logs, states, error, result, tasks, epicBeadId: epicBead.id, finalBeadsById, branch };
    } finally {
        await teardown(tempDir);
    }
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
