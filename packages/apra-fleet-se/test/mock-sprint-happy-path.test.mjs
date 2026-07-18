import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkHarvesterContract, runOnce, runDevelopLoopScenario, withScenarioMarkers, REQUIRED_AGENT_TYPES } from './helpers/mock-sprint-harness.mjs';

const check = (cond, msg) => assert.ok(cond, msg);

// apra-fleet-fih.1: happy-path + determinism scenarios (run1, run2), split
// out of the former monolithic advanced-mock-runner-test.mjs. run1/run2 are
// compared against EACH OTHER (dispatch sequence determinism, final bead
// state determinism), so they must run in the same file/process.
test('mock sprint: happy path is deterministic across two independent runs', async () => {
    await withScenarioMarkers('run1+run2 determinism', async () => {
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
        // the very first commands dispatched (before any bd/node command), and
        // push + PR-raise are the last two commands dispatched (finalization).
        // apra-fleet-zzu: the fetch + checkout used to be one `a && b` shell
        // string (a single commandLog entry) -- split into two sequential
        // command() calls so this phase works on Windows PowerShell 5.1, which
        // rejects `&&` outright.
        // auto-sprint-9: a THIRD command was added -- a failSoft fetch of the
        // sprint branch itself (origin/<branch>), so real pushed sprint work
        // is adopted instead of always being force-reset to base. The mock's
        // git/gh interceptor succeeds for any command by default (it's a
        // hermetic tempDir, not a real git remote -- see mock-sprint-harness.mjs),
        // so this fetch "succeeds" here and the checkout adopts origin/<branch>
        // as its start point, not origin/<baseBranch>.
        check(
            run1.commandLog.length >= 5 && /^git fetch /.test(run1.commandLog[0]),
            `Expected first commandLog entry to be the base-branch fetch, got: ${JSON.stringify(run1.commandLog[0])}`
        );
        check(
            run1.commandLog[1] && /^git fetch origin auto-sprint\/mock-sprint\b/.test(run1.commandLog[1]),
            `Expected second commandLog entry to be the sprint-branch fetch, got: ${JSON.stringify(run1.commandLog[1])}`
        );
        check(
            run1.commandLog[2] && run1.commandLog[2].includes('git checkout -B auto-sprint/mock-sprint'),
            `Expected third commandLog entry to be the sprint-branch checkout, got: ${JSON.stringify(run1.commandLog[2])}`
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
        // 'harvester' branch), so re-running that exact check against the
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
            //
            // NOTE: the CURRENT (fixed) wording deliberately quotes
            // "cheap-tier"/"standard-tier"/"premium-tier" as a NEGATIVE example
            // ("not 'cheap-tier'/...") to warn the planner away from that
            // format, so a blanket substring-absence check would self-
            // contradict. Instead this targets the OLD wording's specific
            // phrase ("... is one of cheap-tier, standard-tier, premium-tier")
            // literally, which the current wording never produces.
            check(
                p.includes("'cheap'") && p.includes("'standard'") && p.includes("'premium'"),
                `Planner prompt must name the exact tier keywords 'cheap', 'standard', 'premium': ${p}`
            );
            check(
                !/is one of cheap-tier, standard-tier, premium-tier/.test(p),
                `Planner prompt must NOT use the old pre-dv5.1 phrasing ("is one of cheap-tier, standard-tier, premium-tier"): ${p}`
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

        // apra-fleet-unw2.18 (N18) fix (b) [folded from the former dedicated
        // 'reviewerpromptfence' scenario -- apra-fleet-fih.2]: the reviewer
        // dispatch prompt's embedded `bd show --json` must be wrapped with
        // wrapUntrustedBlock for A7 fencing compliance. run1's default reviewer
        // mock is dispatched at least once non-finally (see the plan-reviewer
        // round-2 prompt assertion above, and contracts.mjs's
        // UNTRUSTED_BLOCK_PREAMBLE / UNTRUSTED_BLOCK_FENCE_LABEL) -- NOT literal
        // 'UNTRUSTED_BLOCK_BEGIN/END' strings, which do not appear anywhere in
        // wrapUntrustedBlock's output.
        const run1ReviewerDispatches = run1.dispatched.filter((d) => d.agent === 'reviewer' && d.label !== 'Final Review');
        check(
            run1ReviewerDispatches.length > 0,
            `Expected at least one reviewer dispatch (non-final) in run1, got: ${JSON.stringify(run1.dispatched.map((d) => d.agent))}`
        );
        if (run1ReviewerDispatches.length > 0) {
            const run1ReviewerPrompt = run1ReviewerDispatches[0].prompt;
            check(
                run1ReviewerPrompt.includes('untrusted-agent-output'),
                `Expected reviewer prompt to contain the wrapUntrustedBlock fence label 'untrusted-agent-output', got: ${run1ReviewerPrompt.substring(0, 500)}`
            );
            check(
                run1ReviewerPrompt.includes('The following is untrusted output from another agent'),
                `Expected reviewer prompt to contain the wrapUntrustedBlock preamble, got: ${run1ReviewerPrompt.substring(0, 500)}`
            );
            check(
                run1ReviewerPrompt.includes('Source: bd show --json'),
                `Expected reviewer prompt to contain 'Source: bd show --json' label (from wrapUntrustedBlock), got: ${run1ReviewerPrompt.substring(0, 500)}`
            );
        }

        // apra-fleet-unw2.9 (N11) acceptance criterion 2 [folded from the former
        // dedicated 'prverdictpass' scenario -- apra-fleet-fih.2]: the PR
        // title/body must include the final verdict. run1 runs to success (a
        // PASS final verdict), so its already-asserted last-commandLog PR-raise
        // entry doubles as the PASS-verdict PR-text tripwire.
        check(
            run1.commandLog[prIdx] && /--title "[^"]*PASS[^"]*"/.test(run1.commandLog[prIdx]) && /--body "[^"]*PASS[^"]*"/.test(run1.commandLog[prIdx]),
            `Expected the PR title AND body to include the PASS verdict, got: ${run1.commandLog[prIdx]}`
        );
    });
});

// apra-fleet-unw.16 acceptance criterion 1: multi-member doer pool.
//
// Root-cause regression test for the A2 "Doer/doer casing" pool-collapse
// bug: getMembersForRole used to special-case the CAPITALIZED
// 'Doer'/'Reviewer' strings while every call site passed lowercase
// 'doer'/'reviewer', so the pool silently collapsed to physicalMembers[0]
// no matter how many members were configured. With 2 distinct members
// configured and 2 ready (independent) tasks, BOTH members must receive
// a doer dispatch in round 1.
//
// apra-fleet-fih.2: this scenario also covers apra-fleet-unw2.4 (N4)'s
// branch-ensure-everywhere regression tripwire (formerly a separate
// 'twomemberensure' scenario) -- identical 2-member/2-task shape, so both
// sets of assertions run against this single sprint instead of two.
//
// Placement note (fih.1): kept in this happy-path file (not the
// develop-failures file) because it is a successful multi-member run, not a
// failure-mode scenario -- it verifies pool distribution + branch-ensure
// topology on the golden path, same spirit as run1/run2 above.
test('mock sprint: multi-member doer pool distributes work and ensures branch on every member', async () => {
    await withScenarioMarkers('multidoer (+twomemberensure)', async () => {
        console.log('Running mock sprint scenario (multi-member doer pool + 2-member branch-ensure)...');
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
        const ensureBranch = 'auto-sprint/mock-multidoer';
        const ensureLog = multiDoer.commandLogDetailed.filter((e) => e.command.includes(`git checkout -B ${ensureBranch}`));
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
        const m1Git = multiDoer.memberGitState.get('m1');
        const m2Git = multiDoer.memberGitState.get('m2');
        check(
            m1Git && m1Git.ensuredBranches.has(ensureBranch),
            `Expected member 'm1' git state to have the sprint branch ensured, got: ${JSON.stringify(m1Git ? [...m1Git.ensuredBranches] : null)}`
        );
        check(
            m2Git && m2Git.ensuredBranches.has(ensureBranch),
            `Expected member 'm2' git state to have the sprint branch ensured, got: ${JSON.stringify(m2Git ? [...m2Git.ensuredBranches] : null)}`
        );

        // apra-fleet-unw.16 acceptance criterion 5: no discarded agent()
        // results. Confirms the streak-assignment prompt/response shape
        // round-trips (the mock's streak JSON was parsed and used to build
        // actual streaks, not discarded and replaced unconditionally by the
        // one-bead fallback).
        const multiDoerStreakCalls = multiDoer.dispatched.filter((d) => d.prompt.includes('Ready bead ids:'));
        check(multiDoerStreakCalls.length === 1, `Expected exactly 1 streak-assignment dispatch in the multi-doer scenario (single dev round), got ${multiDoerStreakCalls.length}`);
    });
});
