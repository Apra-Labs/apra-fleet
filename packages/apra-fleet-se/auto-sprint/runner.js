export const meta = { name: 'auto-sprint-runner' };

// We can import standard node modules in workflows if needed, or pass them in context.
// For now, we'll assume we check runbooks via command() since we are in the workflow engine.


async function main() {
    let cycle = 1;
    const MAX_CYCLES = 5;

    const sprintFilter = args.target_issue ? `--parent ${args.target_issue}` : '';

    // Helper to keep the dashboard UI updated with real bd data
    async function updateDashboard() {
        try {
            const listRes = await command(`bd list ${sprintFilter} --json`, { member_name: 'local', silent: true });
            const tasks = JSON.parse(listRes || '[]');
            if (typeof publishState === 'function') {
                publishState('beads', { tasks });
            }
        } catch (e) {
            // ignore
        }
    }

    await updateDashboard();

    const initialList = await command(`bd list ${sprintFilter} --ready --json`, { member_name: 'local', silent: true });
    const initialBeads = JSON.parse(initialList || '[]');
    if (initialBeads.length === 0) {
        throw new Error(`Pre-sprint validation failed: No ready beads found for scope '${sprintFilter}'. Ensure beads are in 'open' or 'ready' status.`);
    }

    while (cycle <= MAX_CYCLES) {
        log(`\n=== Starting Sprint Cycle ${cycle} ===`);

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
                { member_name: 'Planner', agentType: 'Planner' }
            );
            log(`Planner: ${plannerRes}`);
            
            const reviewerRes = await agent(
                'Review the plan. Reply APPROVED or CHANGES_NEEDED, and provide textual feedback.',
                { member_name: 'Plan Reviewer', agentType: 'Plan Reviewer' }
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
        // Get ready beads using real command
        const listRes = await command(`bd list ${sprintFilter} --ready --json`, { member_name: 'local', silent: true });
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
        
        while (devRounds < 3) {
            const listRes = await command(`bd list ${sprintFilter} --ready --json`, { member_name: 'local', silent: true });
            const currentReady = JSON.parse(listRes || '[]');
            
            if (currentReady.length === 0) break;

            devRounds++;
            phase(`Develop C${cycle} R${devRounds}`);
            
            const streakRes = await agent(
                `Group the following ready beads into logical development streaks (currently sequential): ${currentReady.map(b=>b.id).join(', ')}`,
                { member_name: 'Streak Assignment', agentType: 'Streak Assignment' }
            );
            log(`Streak Assignment: ${streakRes}`);
            
            const streaks = currentReady.map(b => [b]); 
            
            await parallel(streaks, async (streak) => {
                const beadIds = streak.map(b => b.id).join(', ');
                const doerRes = await agent(
                    `Close the assigned beads: ${beadIds}. ${doerFeedback ? 'Feedback to fix: ' + doerFeedback : ''}`,
                    { member_name: 'Doer', agentType: 'Doer', label: `Streak [${beadIds}]` }
                );
                log(`Doer [${beadIds}]: ${doerRes}`);
                await updateDashboard();
            });

            // Review
            phase(`Review C${cycle} R${devRounds}`);
            const codeReviewRes = await agent(
                'Verify closed beads. Reopen if flawed, else approve. Return text feedback.',
                { member_name: 'Reviewer', agentType: 'Reviewer' }
            );
            log(`Reviewer: ${codeReviewRes}`);
            await updateDashboard();
            
            const checkRes = await command(`bd list ${sprintFilter} --ready --json`, { member_name: 'local', silent: true });
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
        const deployCheck = await command('node -e "require(\'fs\').existsSync(\'deploy.md\') ? console.log(\'found\') : console.log(\'not found\')"', { member_name: 'local', silent: true });
        const hasDeploy = !deployCheck.includes('not found');
        const playCheck = await command('node -e "require(\'fs\').existsSync(\'integ-test-playbook.md\') ? console.log(\'found\') : console.log(\'not found\')"', { member_name: 'local', silent: true });
        const hasPlaybook = !playCheck.includes('not found');

        if (hasDeploy) {
            phase(`Deploy C${cycle}`);
            await agent('Deploy to test env using deploy.md.', { member_name: 'Deployer', agentType: 'Deployer' });
        } else {
            log('Skipping Deploy Phase (no deploy.md found)');
        }

        if (hasPlaybook) {
            phase(`Integ Test C${cycle}`);
            await agent(
                'Run tests using integ-test-playbook.md. Add bug beads if needed.',
                { member_name: 'Integration Test Runner', agentType: 'Integration Test Runner' }
            );
            await updateDashboard();
        } else {
            log('Skipping Integration Test Phase (no playbook found)');
        }

        // =======================
        // 5. Cycle Evaluation
        // =======================
        const remainingRes = await command(`bd list ${sprintFilter} --ready --json`, { member_name: 'local', silent: true });
        const remaining = JSON.parse(remainingRes || '[]');
        
        if (remaining.length === 0) {
            log("All beads closed. Exiting cycle loop.");
            break;
        }
        
        cycle++;
    }

    // =======================
    // 6. Finalization
    // =======================
    phase(`Final Review C${cycle}`);
    const finalRes = await agent('Pass or Fail?', { member_name: 'Final Reviewer', agentType: 'Final Reviewer' });
    log(`Final Verdict: ${finalRes}`);

    phase(`Harvest C${cycle}`);
    await agent('Update memories and retrospectives.', { member_name: 'Harvester', agentType: 'Harvester' });
    
    return { status: 'success' };
}
