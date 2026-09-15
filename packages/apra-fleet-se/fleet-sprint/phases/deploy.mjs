// =============================================================================
// PHASE MODULE: Deploy (apra-fleet-3swo.6.5).
//
// The SIXTH of runSprintCycle's twelve phase() boundaries -- the per-cycle
// deploy of the branch's work to a TEST environment, so the Integ Test phase
// that follows has something real to test against. Moved verbatim out of
// runner.js: the prompt text, the resume prompt, the role labels, the failure
// log line and the deployFailures record are byte-identical to the inline
// version, so the golden transcript is unchanged. Move-only, no behaviour
// change.
//
// WHERE THIS PHASE STARTS AND STOPS. It is the body of runSprintCycle's
// `if (hasDeploy)` branch, and nothing else. The `probeFileExists('deploy.md')`
// probe that produces `hasDeploy`, its `hasPlaybook` sibling (which gates the
// NEXT phase, not this one), the `let deployedThisCycle = false` declaration
// and the `else` branch's "Skipping Deploy Phase" log all stay in runner.js:
// the probe decides WHETHER this phase runs at all, and the flag it produces
// is read much later by Cycle Evaluation. Same boundary rule as
// ./replan.mjs's `if (eligibleReplan.length > 0)` branch.
//
// EXPLICIT STATE, NOT A CLOSURE. The inline version read its inputs off the
// enclosing runSprintCycle scope; they arrive as one explicit state argument
// now. `deployFailures` is an array this phase PUSHES to -- runner.js never
// reassigns that binding, so passing the array itself is exactly equivalent to
// the closure it replaces and the Cycle Evaluation/Final Review sections read
// every entry back off their own binding. `deployedThisCycle` is genuinely
// REASSIGNED, so it is passed in and returned instead; the caller's
// destructuring assignment restores it.
//
// WHY THE runSprintCycle LOCALS ARE INJECTED. getMemberForRole,
// ensureUnattendedAuto, ensureDeployPermissions and sprintSelfIdLine are all
// runSprintCycle-scoped (the last two are context-overridable seams), so
// there is nothing to import -- they come through the state argument, the same
// way ./develop.mjs takes its runner-owned helpers.
//
// GUARD COVERAGE: registered as 'phases/deploy.mjs' in ../guarded-modules.mjs.
// It carries NO command() call site of its own -- its only repo-side effect is
// the deployer dispatch's own read-side bracket, owned by the 'deployer' row
// of ../role-policies.mjs -- plus the ONE dispatchRole call site for the
// deployer ladder, which is exactly what dispatch-safety-guard and the phase 3
// dispatch census must keep seeing after the slice.
// =============================================================================

import { dispatchRole, TURN_BASES } from '../dispatch-role.mjs';

/**
 * Runs the per-cycle Deploy phase.
 *
 * @param {object} state Explicit phase state; see this file's header.
 * @returns {Promise<{ deployedThisCycle: boolean }>} Whether the deploy
 *   reported success this cycle -- the gate the Integ Test phase and Cycle
 *   Evaluation both read. A failure is ALSO pushed onto the caller's
 *   `deployFailures` array in place (see header).
 */
export async function runDeployPhase({
    // Presentation + dispatch seams.
    phase,
    log,
    dispatchCtx,
    // Sprint identity/config.
    cycle,
    sprintSelfIdLine,
    // runSprintCycle-scoped locals, injected rather than imported (see header).
    getMemberForRole,
    ensureUnattendedAuto,
    ensureDeployPermissions,
    // Mutated in place; reassigned and returned, respectively (see header).
    deployFailures,
    deployedThisCycle,
}) {
    phase(`Deploy C${cycle}`);
    await ensureUnattendedAuto(getMemberForRole('deployer'));
    await ensureDeployPermissions(getMemberForRole('deployer'));
    let deployResult;
    // Turn budget for the deployer, with the same-session
    // turn-exhaustion resume below: a source-build fallback deploy runs
    // npm ci plus two builds, comfortably beyond a small default budget.
    // A sprint-dispatched deploy is ALWAYS for integration/regression
    // testing, never a production rollout. Saying only "deploy to test
    // env" left the mode to inference: a target whose deploy.md offers
    // a production path that restarts a shared, OS-supervised singleton
    // had that path picked by default, and every deploy in the sprint
    // failed. So the prompt states the PURPOSE and asks the deployer to
    // use a sandbox/isolated mode IF the target's own deploy.md defines
    // one. This engine is generic (fleet-e2e-toy, Docker, k8s targets
    // all run through here): it never names a section, env var, file
    // or tool a target's deploy.md must contain -- those mechanics
    // belong to the target repo's runbook.
    //
    // The instance must SURVIVE this phase: Integration Test runs after
    // Deploy and is the phase that tests against it, so the deployer
    // leaves it running and the test phase tears it down (locating it
    // from the sprintId line, per the target's own playbook). The
    // deployer tears down only what it started if the deploy FAILS.
    //
    // sprintSelfIdLine is not decoration: deploy.md's active-sprints
    // gate stops for any foreign reservation, so a prompt that omits
    // the sprint's OWN id makes the deploy self-block. That is why the
    // 'deployer' policy row records a 'sprint-self-id-in-prompt'
    // preDispatch step -- the engine VERIFIES the id is really in the
    // prompt before dispatching, rather than trusting this string to
    // stay assembled correctly.
    const deployerPrompt =
        'Deploy to test env using deploy.md.\n' +
        `${sprintSelfIdLine}\n` +
        "Use it for deploy.md's active-sprints gate: a reservation whose sprintId is EXACTLY " +
        'this string is your own sprint, not a foreign one, so the deploy proceeds. Stop only ' +
        'for a reservation with a different sprintId.\n' +
        'This deploy is for INTEGRATION/REGRESSION TESTING, not a production rollout. If deploy.md ' +
        'distinguishes a sandbox/isolated deploy mode for testing from its production deploy, use ' +
        'that mode; otherwise follow deploy.md as written.\n' +
        'If you stood up an isolated test instance, leave it RUNNING when you return: the test phase ' +
        "that follows locates it from the sprintId above (per the repo's own runbook) and owns its " +
        'teardown. Tear down what you started only if the deploy itself fails.';
    // apra-fleet-3swo.5.7: the deployer ladder -- its dispatch, its
    // read-side git-sync bracket, its max_turns-exhaustion resume at
    // doubled turns, its one bounded LLM-auth self-heal (so the NEXT
    // cycle's deploy is not walled off identically) and its
    // deployed:false degrade -- is now the 'deployer' row of
    // fleet-sprint/role-policies.mjs, executed by dispatchRole.
    const deployOutcome = await dispatchRole(dispatchCtx, 'deployer', {
        prompt: deployerPrompt,
        resumePrompt: 'Continue the deploy exactly where you left off in this same session -- do not restart deploy.md from the top if steps already completed. Finish the remaining steps and the smoke test, and return your final report now.',
        roleLabel: 'Deployer',
        resumeLabel: `Deploy (resume, max_turns=${TURN_BASES.DEPLOYER_MAX_TURNS * 2})`,
    });
    deployResult = deployOutcome.value;
    // No duplicate log() dump -- see dispatchReview() for why.
    deployedThisCycle = deployResult.deployed === true;
    if (!deployedThisCycle) {
        deployFailures.push({ cycle, notes: deployResult.notes });
        log(`Deploy FAILED this cycle (C${cycle}): ${deployResult.notes}. Skipping Integration Test phase.`);
    }

    return { deployedThisCycle };
}
