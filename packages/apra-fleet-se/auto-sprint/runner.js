export const meta = { name: 'auto-sprint-runner' };

// We can import standard node modules in workflows if needed, or pass them in context.
// For now, we'll assume we check runbooks via command() since we are in the workflow engine.

// Mechanical migration to the WorkflowEngine's ES-module entry-point contract
// (apra-fleet-unw.7): the engine now calls `main(context)` instead of
// injecting bare globals into an AsyncFunction scope. This destructure is the
// only change to this file's wiring -- every name below (agent, command,
// parallel, log, phase, group, endGroup, publishState, args) is the exact
// same binding the old bare-global version referred to; no control-flow or
// dispatch-order changes.
export async function main(context) {
    const { agent, command, parallel, log, phase, group, endGroup, publishState, args } = context;

    let cycle = 1;
    const MAX_CYCLES = 5;

    const targetIssues = args.target_issues || (args.target_issue ? [args.target_issue] : []);
    const sprintFilter = targetIssues.length > 0 ? `--parent ${targetIssues.join(',')}` : '';
    
    // Member mapping resolution
    const physicalMembers = args.members || ['local'];
    const getMemberForRole = (role) => {
        if (args.roleMap && args.roleMap[role] && args.roleMap[role].length > 0) {
            return args.roleMap[role][0];
        }
        return physicalMembers[0];
    };
    
    const getMembersForRole = (role) => {
        if (args.roleMap && args.roleMap[role]) {
            return args.roleMap[role];
        }
        if (role === 'Doer' || role === 'Reviewer') {
            return physicalMembers; // All members act as Doers/Reviewers by default
        }
        return [physicalMembers[0]];
    };

    const orchestratorMember = getMemberForRole('Orchestrator');

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
    
    endGroup();
    
    return { status: 'success' };
}
