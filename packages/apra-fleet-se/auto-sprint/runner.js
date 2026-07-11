export const meta = { name: 'auto-sprint-runner' };

// We can import standard node modules in workflows if needed, or pass them in context.
// For now, we'll assume we check runbooks via command() since we are in the workflow engine.

// ---------------------------------------------------------------------------
// CLI -> runner argument contract (apra-fleet-unw.14)
// ---------------------------------------------------------------------------
//
// This is the canonical, validated shape of `args` (the `context.args`
// object WorkflowEngine.executeFile()/runWithContext() hands to main()).
// bin/cli.mjs is required to produce args matching this contract; unknown
// keys and missing required keys are both rejected loudly here so a
// CLI/runner drift (a flag added on one side and forgotten on the other)
// fails fast instead of silently no-oping.
//
// Also serves as the A7 defense-in-depth layer: `target_issues`/
// `target_issue`, `branch`, and `base_branch` are all validated against
// shell-injection-safe patterns here, in addition to bin/cli.mjs's own
// validation (which imports validateIssueId/validateBranchName from this
// module -- single source of truth), so a malicious id/branch name can
// never reach a command() interpolation even if the CLI layer is somehow
// bypassed. Validation runs before ANY agent()/command() dispatch below,
// so a rejected arg produces zero fleet dispatches.

const ISSUE_ID_PATTERN = /^[A-Za-z0-9._-]+$/;
const BRANCH_NAME_PATTERN = /^[A-Za-z0-9._/-]+$/;
const GOAL_PATTERN = /^P[1-3](\/P[1-3]){0,2}$/;

const KNOWN_ARG_KEYS = new Set([
    'target_issues', 'target_issue', 'members', 'branch', 'base_branch',
    'goal', 'max_cycles', 'requirementsFile', 'roleMap',
]);

/**
 * Validates a single issue id against the shell-injection-safe pattern
 * (feedback.md A7). Throws with a clear message on rejection.
 * @param {unknown} id
 * @returns {string}
 */
export function validateIssueId(id) {
    if (typeof id !== 'string' || id.length === 0 || !ISSUE_ID_PATTERN.test(id)) {
        throw new Error(`[Arg Contract] Invalid issue id "${id}": must match ${ISSUE_ID_PATTERN} (letters, digits, '.', '_', '-' only).`);
    }
    return id;
}

/**
 * Validates a git branch name (sprint `branch` / `base_branch`) against a
 * shell-injection-safe pattern before it is ever interpolated into a
 * git/gh command() string.
 * @param {unknown} name
 * @param {string} label - human-readable arg name, used in the error message
 * @returns {string}
 */
export function validateBranchName(name, label) {
    if (typeof name !== 'string' || name.length === 0 || !BRANCH_NAME_PATTERN.test(name)) {
        throw new Error(`[Arg Contract] Invalid ${label} "${name}": must match ${BRANCH_NAME_PATTERN} (letters, digits, '.', '_', '-', '/' only).`);
    }
    return name;
}

/**
 * Validates and normalizes the args object passed into main(context).
 * Rejects unknown keys and missing/malformed required keys loudly.
 *
 * @param {any} args
 * @returns {{
 *   targetIssues: string[], members: string[], branch: string,
 *   baseBranch: string, goal: string, maxCycles: number,
 *   requirementsFile: string|undefined, roleMap: object|undefined
 * }}
 */
export function validateArgs(args) {
    if (!args || typeof args !== 'object' || Array.isArray(args)) {
        throw new Error('[Arg Contract] args must be an object.');
    }

    const unknown = Object.keys(args).filter((k) => !KNOWN_ARG_KEYS.has(k));
    if (unknown.length > 0) {
        throw new Error(`[Arg Contract] Unknown arg(s): ${unknown.join(', ')}. Known args: ${[...KNOWN_ARG_KEYS].join(', ')}.`);
    }

    // --- target issues: target_issues[] (preferred) or legacy single target_issue ---
    let targetIssues;
    if (Array.isArray(args.target_issues)) {
        targetIssues = args.target_issues;
    } else if (typeof args.target_issue === 'string') {
        targetIssues = [args.target_issue];
    } else {
        throw new Error('[Arg Contract] Missing required arg: target_issues (non-empty array) or target_issue (string).');
    }
    if (targetIssues.length === 0) {
        throw new Error('[Arg Contract] target_issues must be a non-empty array.');
    }
    targetIssues.forEach(validateIssueId);

    // --- members ---
    if (!Array.isArray(args.members) || args.members.length === 0) {
        throw new Error('[Arg Contract] Missing required arg: members (non-empty array of member ids/names).');
    }
    args.members.forEach((m) => {
        if (typeof m !== 'string' || m.length === 0) {
            throw new Error(`[Arg Contract] Invalid member entry "${m}": must be a non-empty string.`);
        }
    });

    // --- branch / base_branch (required; also the git/PR target) ---
    if (typeof args.branch !== 'string' || args.branch.length === 0) {
        throw new Error('[Arg Contract] Missing required arg: branch (sprint branch name).');
    }
    validateBranchName(args.branch, 'branch');

    if (typeof args.base_branch !== 'string' || args.base_branch.length === 0) {
        throw new Error('[Arg Contract] Missing required arg: base_branch (branch the sprint branch is created from and the PR targets).');
    }
    validateBranchName(args.base_branch, 'base_branch');

    // --- goal (optional, default 'P1/P2'); threaded through for
    // apra-fleet-unw.17's exit-condition logic to consume later -- this
    // issue only guarantees it reaches the runner and is validated/exposed.
    const goal = args.goal === undefined ? 'P1/P2' : args.goal;
    if (typeof goal !== 'string' || !GOAL_PATTERN.test(goal)) {
        throw new Error(`[Arg Contract] Invalid goal "${goal}": must match ${GOAL_PATTERN} (e.g. 'P1', 'P1/P2', 'P1/P2/P3').`);
    }

    // --- max_cycles (optional, default 5; replaces the old hardcoded constant) ---
    const maxCycles = args.max_cycles === undefined ? 5 : args.max_cycles;
    if (typeof maxCycles !== 'number' || !Number.isInteger(maxCycles) || maxCycles < 1) {
        throw new Error(`[Arg Contract] Invalid max_cycles "${maxCycles}": must be a positive integer.`);
    }

    // --- requirementsFile (optional) ---
    if (args.requirementsFile !== undefined && (typeof args.requirementsFile !== 'string' || args.requirementsFile.length === 0)) {
        throw new Error('[Arg Contract] Invalid requirementsFile: must be a non-empty string path.');
    }

    // --- roleMap (optional; consumed by getMemberForRole/getMembersForRole below) ---
    if (args.roleMap !== undefined && (typeof args.roleMap !== 'object' || args.roleMap === null || Array.isArray(args.roleMap))) {
        throw new Error('[Arg Contract] Invalid roleMap: must be an object mapping role -> member[].');
    }

    return {
        targetIssues,
        members: args.members,
        branch: args.branch,
        baseBranch: args.base_branch,
        goal,
        maxCycles,
        requirementsFile: args.requirementsFile,
        roleMap: args.roleMap,
    };
}

// Mechanical migration to the WorkflowEngine's ES-module entry-point contract
// (apra-fleet-unw.7): the engine now calls `main(context)` instead of
// injecting bare globals into an AsyncFunction scope. This destructure is the
// only change to this file's wiring -- every name below (agent, command,
// parallel, log, phase, group, endGroup, publishState, args) is the exact
// same binding the old bare-global version referred to; no control-flow or
// dispatch-order changes.
export async function main(context) {
    const { agent, command, parallel, log, phase, group, endGroup, publishState, args } = context;

    // Validate BEFORE any agent()/command() dispatch (apra-fleet-unw.14,
    // A7 defense in depth): a rejected/malformed arg must result in zero
    // fleet dispatches.
    const validated = validateArgs(args);

    let cycle = 1;
    const MAX_CYCLES = validated.maxCycles;

    const targetIssues = validated.targetIssues;
    const sprintFilter = targetIssues.length > 0 ? `--parent ${targetIssues.join(',')}` : '';

    // Member mapping resolution
    const physicalMembers = validated.members;
    const getMemberForRole = (role) => {
        if (validated.roleMap && validated.roleMap[role] && validated.roleMap[role].length > 0) {
            return validated.roleMap[role][0];
        }
        return physicalMembers[0];
    };

    const getMembersForRole = (role) => {
        if (validated.roleMap && validated.roleMap[role]) {
            return validated.roleMap[role];
        }
        if (role === 'Doer' || role === 'Reviewer') {
            return physicalMembers; // All members act as Doers/Reviewers by default
        }
        return [physicalMembers[0]];
    };

    const orchestratorMember = getMemberForRole('Orchestrator');

    // =======================
    // 0. Git Setup: ensure the sprint branch exists off base_branch
    // =======================
    // First fleet dispatch of the run -- runs before any bd/agent activity
    // so the whole sprint develops on `branch`, branched from `base_branch`.
    group('Sprint Setup');
    phase('Ensure Sprint Branch');
    await command(
        `git fetch origin ${validated.baseBranch} --quiet && git checkout -B ${validated.branch} origin/${validated.baseBranch}`,
        {
            member_name: orchestratorMember,
            silent: true,
            label: `Ensure sprint branch '${validated.branch}' from '${validated.baseBranch}'`,
        }
    );
    publishState('sprint-args', {
        branch: validated.branch,
        baseBranch: validated.baseBranch,
        goal: validated.goal,
        maxCycles: validated.maxCycles,
        requirementsFile: validated.requirementsFile || null,
    });
    endGroup();

    // Helper to keep the dashboard UI updated with real bd data
    async function updateDashboard() {
        try {
            const listRes = await command(`bd list ${sprintFilter} --json`, { member_name: orchestratorMember, silent: true });
            const tasks = JSON.parse(listRes || '[]');
            if (typeof publishState === 'function') {
                publishState('beads', { tasks });
            }
        } catch (e) {
            // ignore
        }
    }

    await updateDashboard();

    const initialList = await command(`bd list ${sprintFilter} --ready --json`, { member_name: orchestratorMember, silent: true });
    const initialBeads = JSON.parse(initialList || '[]');
    if (initialBeads.length === 0) {
        throw new Error(`Pre-sprint validation failed: No ready beads found for scope '${sprintFilter}'. Ensure beads are in 'open' or 'ready' status.`);
    }

    while (cycle <= MAX_CYCLES) {
        group(`Sprint Cycle ${cycle}`);

        // =======================
        // 1. Planning Loop
        // =======================
        let planApproved = false;
        let planningRounds = 0;
        let plannerFeedback = '';
        
        while (!planApproved && planningRounds < 3) {
            planningRounds++;
            phase(`Plan C${cycle} R${planningRounds}`);
            const plannerRes = await agent(
                `Analyze features and build a DAG by adding beads. ${plannerFeedback ? 'Feedback from last review: ' + plannerFeedback : ''}`,
                { member_name: getMemberForRole('planner'), agentType: 'planner' }
            );
            log(`Planner: ${plannerRes}`);
            
            const reviewerRes = await agent(
                'Review the plan. Reply APPROVED or CHANGES_NEEDED, and provide textual feedback.',
                { member_name: getMemberForRole('plan-reviewer'), agentType: 'plan-reviewer' }
            );
            log(`Plan Reviewer: ${reviewerRes}`);
            
            if (reviewerRes.includes('APPROVED')) {
                planApproved = true;
            } else {
                plannerFeedback = reviewerRes; // Pass textual feedback to planner
            }
            await updateDashboard();
        }

        // =======================
        // 2. Execution Prep
        // =======================
        const listRes = await command(`bd list ${sprintFilter} --ready --json`, { member_name: orchestratorMember, silent: true });
        const readyBeads = JSON.parse(listRes || '[]');

        if (readyBeads.length === 0) {
            log("No ready beads found. Sprint may be complete.");
            break;
        }

        // =======================
        // 3. Develop & Review Loop
        // =======================
        let devRounds = 0;
        let doerFeedback = '';
        
        const doerPool = getMembersForRole('doer');
        const reviewerPool = getMembersForRole('reviewer');
        
        while (devRounds < 3) {
            const currentListRes = await command(`bd list ${sprintFilter} --ready --json`, { member_name: orchestratorMember, silent: true });
            const currentReady = JSON.parse(currentListRes || '[]');
            
            if (currentReady.length === 0) break;

            devRounds++;
            phase(`Develop C${cycle} R${devRounds}`);
            
            const streakRes = await agent(
                `Group the following ready beads into logical development streaks (currently sequential): ${currentReady.map(b=>b.id).join(', ')}`,
                { member_name: getMemberForRole('planner'), agentType: 'planner', label: 'Streak Assignment' }
            );
            log(`Streak Assignment: ${streakRes}`);
            
            const streaks = currentReady.map(b => [b]); 
            
            await parallel(streaks, async (streak, index) => {
                const beadIds = streak.map(b => b.id).join(', ');
                const doerMember = doerPool[index % doerPool.length];
                const doerRes = await agent(
                    `Close the assigned beads: ${beadIds}. ${doerFeedback ? 'Feedback to fix: ' + doerFeedback : ''}`,
                    { member_name: doerMember, agentType: 'doer', label: `Streak [${beadIds}]` }
                );
                log(`Doer [${beadIds}] on [${doerMember}]: ${doerRes}`);
                await updateDashboard();
            });

            // Review
            phase(`Review C${cycle} R${devRounds}`);
            const codeReviewRes = await agent(
                'Verify closed beads. Reopen if flawed, else approve. Return text feedback.',
                { member_name: reviewerPool[0], agentType: 'reviewer' }
            );
            log(`Reviewer: ${codeReviewRes}`);
            await updateDashboard();
            
            const checkRes = await command(`bd list ${sprintFilter} --ready --json`, { member_name: orchestratorMember, silent: true });
            const stillOpen = JSON.parse(checkRes || '[]');
            
            if (stillOpen.length === 0) {
                break;
            } else {
                doerFeedback = codeReviewRes; // Pass feedback to doer
                log(`System found ${stillOpen.length} beads still open/ready. Looping back to develop.`);
            }
        }

        // =======================
        // 4. Deploy & Integration
        // =======================
        const deployCheck = await command('node -e "require(\'fs\').existsSync(\'deploy.md\') ? console.log(\'found\') : console.log(\'not found\')"', { member_name: orchestratorMember, silent: true });
        const hasDeploy = !deployCheck.includes('not found');
        const playCheck = await command('node -e "require(\'fs\').existsSync(\'integ-test-playbook.md\') ? console.log(\'found\') : console.log(\'not found\')"', { member_name: orchestratorMember, silent: true });
        const hasPlaybook = !playCheck.includes('not found');

        if (hasDeploy) {
            phase(`Deploy C${cycle}`);
            await agent('Deploy to test env using deploy.md.', { member_name: getMemberForRole('deployer'), agentType: 'deployer' });
        } else {
            log('Skipping Deploy Phase (no deploy.md found)');
        }

        if (hasPlaybook) {
            phase(`Integ Test C${cycle}`);
            await agent(
                'Run tests using integ-test-playbook.md. Add bug beads if needed.',
                { member_name: getMemberForRole('integ-test-runner'), agentType: 'integ-test-runner' }
            );
            await updateDashboard();
        } else {
            log('Skipping Integration Test Phase (no playbook found)');
        }

        // =======================
        // 5. Cycle Evaluation
        // =======================
        const remainingRes = await command(`bd list ${sprintFilter} --ready --json`, { member_name: orchestratorMember, silent: true });
        const remaining = JSON.parse(remainingRes || '[]');
        
        if (remaining.length === 0) {
            log("All beads closed. Exiting cycle loop.");
            endGroup();
            break;
        }
        
        cycle++;
        endGroup();
    }

    // =======================
    // 6. Finalization
    // =======================
    group('Finalization');
    phase(`Final Review C${cycle}`);
    const finalRes = await agent('Pass or Fail?', { member_name: getMemberForRole('reviewer'), agentType: 'reviewer', label: 'Final Review' });
    log(`Final Verdict: ${finalRes}`);

    phase(`Harvest C${cycle}`);
    await agent('Update memories and retrospectives.', { member_name: getMemberForRole('harvester'), agentType: 'harvester' });

    // =======================
    // 7. Publish: push the sprint branch and raise (but do NOT merge) a PR
    // =======================
    // Per the pm skill's R12 rule (never auto-merge), this only pushes and
    // opens the PR -- a human (or a later, explicitly-scoped issue) must
    // review and merge it.
    phase(`Publish PR C${cycle}`);
    await command(
        `git push -u origin ${validated.branch}`,
        {
            member_name: orchestratorMember,
            silent: true,
            label: `Push sprint branch '${validated.branch}'`,
        }
    );
    const prTitle = `Auto-sprint: ${validated.branch}`;
    const prBody = `Automated apra-fleet-se sprint (goal: ${validated.goal}). Do NOT auto-merge -- see pm skill R12; a human must review and merge this PR.`;
    await command(
        `gh pr create --base "${validated.baseBranch}" --head "${validated.branch}" --title "${prTitle}" --body "${prBody}"`,
        {
            member_name: orchestratorMember,
            silent: true,
            label: `Raise PR to '${validated.baseBranch}' (not merged)`,
        }
    );

    endGroup();

    return {
        status: 'success',
        branch: validated.branch,
        baseBranch: validated.baseBranch,
        goal: validated.goal,
        maxCycles: validated.maxCycles,
    };
}
