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
 * Thrown when the deploy dispatch would have to reach the target's production
 * deploy path on a SELF-HOSTED target -- i.e. a target whose own production
 * deploy replaces the very instance running this sprint, so that path cannot
 * succeed from inside the sprint and must never be attempted.
 *
 * Named (not a bare Error) so the refusal is distinguishable from a deploy
 * that merely failed: this is a configuration refusal raised BEFORE any
 * dispatch, with no agent turn spent.
 */
export class SelfHostedProductionDeployRefusedError extends Error {
    constructor(message) {
        super(message);
        this.name = 'SelfHostedProductionDeployRefusedError';
    }
}

/**
 * Decides, from TARGET CONFIGURATION alone, which deploy mode this dispatch is
 * allowed to use. This is the machine-enforced half of what used to be advisory
 * prose in the deployer prompt ("use a sandbox mode if the runbook has one"),
 * which an agent could and did ignore.
 *
 * The deciding input is `deploy_target.self_hosted` (fleet-sprint/
 * sprint-args.mjs), normalized to `selfHosted` here:
 *   - false / absent (every target that has not opted in): the runbook is
 *     followed as written and the production path stays reachable. No
 *     over-blocking -- an ordinary remote target is unaffected.
 *   - true, with `isolated_deploy_mode` naming the mode the TARGET's own
 *     runbook offers for isolated/test deploys: the dispatch is pinned to that
 *     mode and the production path is forbidden.
 *   - true, with no isolated mode declared: there is no safe path, so this
 *     throws instead of dispatching.
 *
 * The isolated mode's NAME is target-authored data threaded through config; the
 * engine never carries a literal for it, which is what keeps this generic
 * across targets (scripts/check-generic-boundary.mjs).
 *
 * Pure and side-effect-free: no dispatch, no process, no I/O.
 *
 * @param {{ selfHosted?: boolean, isolatedDeployMode?: string }} [deployTarget]
 * @returns {{ mode: 'runbook-as-written' | 'isolated', isolatedDeployMode: string | null }}
 * @throws {SelfHostedProductionDeployRefusedError}
 */
export function resolveDeployMode(deployTarget = {}) {
    const selfHosted = (deployTarget && deployTarget.selfHosted) === true;
    if (!selfHosted) return { mode: 'runbook-as-written', isolatedDeployMode: null };
    const isolated = typeof deployTarget.isolatedDeployMode === 'string'
        ? deployTarget.isolatedDeployMode.trim()
        : '';
    if (!isolated) {
        throw new SelfHostedProductionDeployRefusedError(
            'deploy: this sprint\'s target is configured as self-hosted (deploy_target.self_hosted), so its '
            + 'production deploy path would replace the very instance that is running this sprint and cannot '
            + 'succeed. Refusing to dispatch the deploy: the target declares no isolated deploy mode '
            + '(deploy_target.isolated_deploy_mode is unset). Set it to the isolated/test deploy mode the '
            + 'target\'s own runbook offers, or clear deploy_target.self_hosted if the target is not self-hosted.'
        );
    }
    return { mode: 'isolated', isolatedDeployMode: isolated };
}

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
    // Target configuration for the deploy-mode guard; see resolveDeployMode().
    deployTarget,
    // runSprintCycle-scoped locals, injected rather than imported (see header).
    getMemberForRole,
    ensureUnattendedAuto,
    ensureDeployPermissions,
    // Mutated in place; reassigned and returned, respectively (see header).
    deployFailures,
    deployedThisCycle,
}) {
    phase(`Deploy C${cycle}`);
    // BEFORE anything is dispatched or provisioned: a self-hosted target may
    // not reach its production deploy path (see resolveDeployMode()). Throws
    // on a self-hosted target with no isolated mode declared.
    const deployMode = resolveDeployMode(deployTarget);
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
    // The mode line the guard above decided. The default (not self-hosted) is
    // the historical advisory wording, byte-identical. The self-hosted line is
    // a REQUIREMENT, not advice, and it names the target's own isolated mode
    // from config -- the engine carries no literal for it.
    const deployModeLine = deployMode.mode === 'isolated'
        ? 'This deploy is for INTEGRATION/REGRESSION TESTING, not a production rollout. This target is '
          + 'SELF-HOSTED: its production deploy would replace the very instance running this sprint, so that '
          + `path is FORBIDDEN here. Use deploy.md's "${deployMode.isolatedDeployMode}" mode and nothing else. `
          + 'If that mode is missing or unusable, do NOT fall back to the production path -- return a report '
          + 'with deployed set to false, saying so.\n'
        : 'This deploy is for INTEGRATION/REGRESSION TESTING, not a production rollout. If deploy.md '
          + 'distinguishes a sandbox/isolated deploy mode for testing from its production deploy, use '
          + 'that mode; otherwise follow deploy.md as written.\n';
    const deployerPrompt =
        'Deploy to test env using deploy.md.\n' +
        `${sprintSelfIdLine}\n` +
        "Use it for deploy.md's active-sprints gate: a reservation whose sprintId is EXACTLY " +
        'this string is your own sprint, not a foreign one, so the deploy proceeds. Stop only ' +
        'for a reservation with a different sprintId.\n' +
        deployModeLine +
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
