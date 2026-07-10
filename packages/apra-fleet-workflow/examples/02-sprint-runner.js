export const meta = { 
    name: 'sprint-runner', 
    description: 'A skeleton sprint runner workflow imitating the core logic of auto-sprint runner.js using new workflow primitives' 
};

async function main(opts = {}) {
    const issues = opts.issues || ['BD-1', 'BD-2'];
    const maxCycles = opts.max_cycles || 2;
    const memberName = opts.member_name || 'apra-pm';

    await new Promise(r => setTimeout(r, 2000));

    phase('Sprint Initialization');
    log(`Starting sprint runner for issues: ${issues.join(', ')}`);
    log(`Max cycles: ${maxCycles}`);

    let cycleCount = 0;
    let sprintComplete = false;

    while (cycleCount < maxCycles && !sprintComplete) {
        cycleCount++;
        await new Promise(r => setTimeout(r, 2000));
        phase(`Sprint Cycle ${cycleCount}`);
        
        // Use Sequential to route the issues through phases: Plan -> Develop -> Test -> Harvest
        const cycleResults = await sequential(
            issues,
            
            // 1. Plan Phase
            async (issueId) => {
                log(`[Plan Phase] Planning for issue: ${issueId}`);
                const planResult = await agent(`Create a plan for issue ${issueId}`, {
                    member_name: memberName,
                    schema: {
                        type: "object",
                        properties: {
                            tasks: { type: "array", items: { type: "string" } },
                            complexity: { type: "string", enum: ["Low", "Medium", "High"] }
                        },
                        required: ["tasks", "complexity"]
                    }
                });
                return { issueId, plan: planResult };
            },
            
            // 2. Develop Phase
            async (context) => {
                log(`[Develop Phase] Developing for issue: ${context.issueId} with complexity ${context.plan.complexity}`);
                
                // Simulating shell command during development
                const devOutput = await command(`echo "Simulating dev for ${context.issueId}"`, {
                    member_name: memberName
                });
                
                const devResult = await agent(`Develop code for ${context.issueId} based on tasks: ${context.plan.tasks.join(', ')}`, {
                    member_name: memberName,
                    schema: {
                        type: "object",
                        properties: {
                            status: { type: "string", enum: ["VERIFY", "IN_PROGRESS", "BLOCKED"] },
                            notes: { type: "string" }
                        },
                        required: ["status", "notes"]
                    }
                });
                return { ...context, develop: devResult, devOutput };
            },
            
            // 3. Test Phase
            async (context) => {
                if (context.develop.status !== 'VERIFY') {
                    log(`[Test Phase] Skipping test for ${context.issueId}, status is ${context.develop.status}`);
                    return { ...context, test: { passed: false, reason: 'Not ready for test' } };
                }
                
                log(`[Test Phase] Testing issue: ${context.issueId}`);
                const testResult = await agent(`Run tests for ${context.issueId}`, {
                    member_name: memberName,
                    schema: {
                        type: "object",
                        properties: {
                            passed: { type: "boolean" },
                            notes: { type: "string" }
                        },
                        required: ["passed"]
                    }
                });
                return { ...context, test: testResult };
            },
            
            // 4. Harvest Phase
            async (context) => {
                log(`[Harvest Phase] Harvesting issue: ${context.issueId}`);
                if (context.test && context.test.passed) {
                    const harvestResult = await command(`echo "Harvesting / merging ${context.issueId}"`, {
                        member_name: memberName
                    });
                    
                    const harvestAgentResult = await agent(`Verify harvest success for ${context.issueId}`, {
                        member_name: memberName,
                        schema: {
                            type: "object",
                            properties: {
                                status: { type: "string", enum: ["OK", "FAILED"] },
                                notes: { type: "string" }
                            },
                            required: ["status"]
                        }
                    });
                    return { ...context, harvest: harvestAgentResult };
                }
                return { ...context, harvest: { status: 'FAILED', notes: 'Tests failed or skipped' } };
            }
        );

        log(`Cycle ${cycleCount} complete. Results: ${JSON.stringify(cycleResults, null, 2)}`);
        
        // Evaluate exit condition (all issues harvested successfully)
        const allHarvested = cycleResults.every(r => r && r.harvest && r.harvest.status === 'OK');
        if (allHarvested) {
            sprintComplete = true;
            log('Sprint goals met!');
        }
    }

    return { 
        status: sprintComplete ? 'success' : 'incomplete', 
        cyclesRun: cycleCount 
    };
}
