import path from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs/promises';
import { exec } from 'child_process';
import os from 'os';
import { FleetWorkflow } from '@apralabs/apra-fleet-workflow';
import { WorkflowEngine } from '@apralabs/apra-fleet-workflow/engine';
import { createDashboardViewer } from '@apralabs/apra-fleet-workflow/viewer';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Helper to run shell commands in JS
const runCmd = (cmd, cwd) => new Promise((resolve) => {
    exec(cmd, { cwd, env: { ...process.env, BD_ALLOW_REMOTE_MIGRATE: '1' } }, (err, stdout, stderr) => {
        resolve({ err, stdout, stderr });
    });
});

import { beadsExtension } from '../auto-sprint/viewer-extensions.mjs';

async function setup() {
    const tempDir = path.join(os.tmpdir(), 'apra-fleet-mock-sprint-' + Date.now());
    await fs.mkdir(tempDir, { recursive: true });
    
    console.log("Initializing fresh beads DB at " + tempDir);
    await runCmd('bd init', tempDir);
    
    console.log("Seeding beads tasks for toy project...");
    await runCmd('bd create -t epic "Epic: Fleet Member Management APIs" -d "This epic covers the implementation of member management APIs for apra-fleet-client. It includes registerMember, listMembers, and ensuring they integrate securely using fetch across the MCP JSON-RPC boundary."', tempDir);
    await runCmd('bd create "Task: Implement registerMember in client.js" -d "Implement a registerMember(config) function in the ApraFleet API class. It should accept an object with name, prompt, url, token, etc., and map to the register_member tool."', tempDir);
    await runCmd('bd create "Task: Implement listMembers in client.js" -d "Implement a listMembers() function in the ApraFleet API class. It should call the list_members tool and return the parsed JSON array of active fleet members."', tempDir);
    
    const initialList = await runCmd('bd list --json', tempDir);
    const allBeads = JSON.parse(initialList.stdout || '[]');
    const epicBead = allBeads.find(b => b.title.includes('Epic:'));
    const task1 = allBeads.find(b => b.title.includes('registerMember'));
    const task2 = allBeads.find(b => b.title.includes('listMembers'));
    
    await runCmd(`bd update ${task1.id} --parent ${epicBead.id}`, tempDir);
    await runCmd(`bd update ${task2.id} --parent ${epicBead.id}`, tempDir);
    
    // Create dummy runbooks so Deploy/Integ phases run conditionally
    await fs.writeFile(path.join(tempDir, 'deploy.md'), '# Deploy Apra Fleet Client\\nrun `npm publish`');
    await fs.writeFile(path.join(tempDir, 'integ-test-playbook.md'), '# Integ Test\\nRun `vitest e2e`');

    return { tempDir, epicBead };
}

async function run_test(tempDir, epicBead) {
    let planRound = 0;

    const mockFleetApi = {
        executeCommand: async (opts) => {
            if (opts.command.startsWith('ls deploy.md')) {
                return { content: [{ text: 'found' }] };
            }
            if (opts.command.startsWith('ls integ-test-playbook.md')) {
                return { content: [{ text: 'found' }] };
            }
            const { err, stdout, stderr } = await runCmd(opts.command, tempDir);
            if (err) {
                return { isError: true, content: [{ text: stderr || err.message }] };
            }
            return { content: [{ text: stdout }] };
        },
        executePrompt: async (opts) => {
            // Simulated wait to feel like an LLM
            await new Promise(r => setTimeout(r, 2000));
            
            if (opts.agent === 'planner' && !opts.prompt.includes('Group')) {
                await runCmd('bd create "Task: Add tests for API endpoints" -t task', tempDir);
                const list = JSON.parse((await runCmd('bd list --json', tempDir)).stdout);
                const newT = list.find(i => i.title.includes('Add tests for API endpoints'));
                await runCmd(`bd update ${newT.id} --parent ${epicBead.id}`, tempDir);
                return { content: [{ text: 'Analyzed the Fleet Member API epic. Added a new task to ensure we have adequate e2e tests for registerMember and listMembers.' }] };
            }
            
            if (opts.agent === 'plan-reviewer') {
                planRound++;
                if (planRound < 2) {
                    return { content: [{ text: 'CHANGES_NEEDED: Ensure you also add a documentation task.' }] };
                }
                return { content: [{ text: 'Code looks solid. We have tasks for implementation, tests, and documentation. APPROVED.' }] };
            }
            
            if (opts.agent === 'planner' && opts.prompt.includes('Group')) {
                return { content: [{ text: 'Assigned implementation tasks into Streak 1 and test/doc tasks into Streak 2.' }] };
            }
            
            if (opts.agent === 'doer') {
                const match = opts.prompt.match(/Close the assigned beads:\s*([^.]+)/i);
                if (match) {
                    const ids = match[1].split(',').map(s => s.trim());
                    for (const id of ids) {
                        if (Math.random() > 0.1) { 
                            await runCmd(`bd update ${id} --close`, tempDir);
                        }
                    }
                }
                return { content: [{ text: 'Implemented the requested fleet client methods (registerMember, listMembers) using fetch to hit the MCP JSON-RPC endpoints. I have closed the assigned beads.' }] };
            }
            
            if (opts.agent === 'reviewer') {
                if (Math.random() > 0.8) {
                    const closed = await runCmd(`bd list --parent ${epicBead.id} --status=closed --json`, tempDir);
                    const closedLines = JSON.parse(closed.stdout || '[]');
                    if (closedLines.length > 0) {
                        const lastClosed = closedLines[closedLines.length - 1];
                        await runCmd(`bd update ${lastClosed.id} --status ready`, tempDir);
                        return { content: [{ text: `Reopened bead ${lastClosed.id}. The implementation is missing error handling for 401 Unauthorized responses. Please fix.` }] };
                    }
                }
                return { content: [{ text: 'Code logic is sound. Error handling and type definitions match the spec. Approved.' }] };
            }
            
            if (opts.agent === 'Integration Test Runner') {
                if (Math.random() > 0.7) {
                    await runCmd('bd create -t task "Bug: listMembers returns empty array unexpectedly"', tempDir);
                    const list = JSON.parse((await runCmd('bd list --json', tempDir)).stdout);
                    const bug = list.find(i => i.title.includes('Bug:'));
                    await runCmd(`bd update ${bug.id} --parent ${epicBead.id}`, tempDir);
                    return { content: [{ text: 'Integration test failed: listMembers returns empty array. I added a bug bead.' }] };
                }
                return { content: [{ text: 'All vitest e2e specs passed successfully.' }] };
            }
            
            if (opts.agent === 'Deployer') {
                return { content: [{ text: 'Successfully ran `npm publish` and published @apralabs/apra-fleet-client to the local registry.' }] };
            }
            
            if (opts.agent === 'Final Reviewer') {
                return { content: [{ text: 'Pass! Excellent velocity and solid implementation.' }] };
            }
            
            if (opts.agent === 'Harvester') {
                return { content: [{ text: 'Harvested API usage patterns to memory. Updated context docs.' }] };
            }
            
            return { content: [{ text: 'Agent executed successfully.' }] };
        }
    };

    const workflow = new FleetWorkflow(mockFleetApi, { targetRepo: tempDir });
    const engine = new WorkflowEngine(workflow);

    const server = createDashboardViewer(workflow, {
        port: 8080,
        name: 'Auto-Sprint (Advanced Mock)',
        dashboardExtensions: [beadsExtension]
    });

    console.log("Waiting 10 seconds for you to open http://localhost:8080 ...");
    await new Promise(resolve => setTimeout(resolve, 10000));

    const scriptPath = path.join(__dirname, '../auto-sprint/runner.js');
    const res = await engine.executeFile(scriptPath, { target_issue: epicBead.id }, true);
    console.log("Mock sprint finished with result:", res);
    
    return server;
}

async function teardown(tempDir, server) {
    console.log("Tearing down mock environment...");
    if (server) {
        try {
            server.close();
        } catch(e) {}
    }
    if (tempDir) {
        try {
            // Windows EBUSY retry loop
            let retries = 5;
            while (retries > 0) {
                try {
                    fs.rmSync(tempDir, { recursive: true, force: true, maxRetries: 3 });
                    break;
                } catch(e) {
                    if (e.code === 'EBUSY') {
                        retries--;
                        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 500);
                    } else throw e;
                }
            }
        } catch(e) {
            console.error("Could not fully clean up temp dir:", e);
        }
    }
    process.exit(0);
}

async function main() {
    let tempDir, server;
    try {
        const setupState = await setup();
        tempDir = setupState.tempDir;
        server = await run_test(tempDir, setupState.epicBead);
    } catch (err) {
        console.error("Mock sprint test failed:", err);
    } finally {
        await teardown(tempDir, server);
    }
}

main();
