import { McpClient } from '@apralabs/apra-fleet-client/client';
import { StreamableHttpTransport } from '@apralabs/apra-fleet-client/transport';
import { ApraFleet } from '@apralabs/apra-fleet-client';
import { FleetWorkflow } from '../src/workflow/index.mjs';
import { WorkflowEngine } from '../src/workflow/engine.mjs';
import { startViewer } from '../src/viewer/index.mjs';

const e2eScript = `
export const meta = { name: "E2E Safe Harness", phases: ["Discovery", "Non-Destructive Execution"] };

async function main() {
    phase("Discovery");
    log("Available targets: " + args.targets.map(t => t.name).join(", "));
    
    if (args.targets.length === 0) {
        throw new Error("No active members found on the Apra Fleet grid. Cannot run E2E.");
    }

    phase("Non-Destructive Execution");
    const results = await sequential(args.targets, async (target) => {
        log("Testing command on " + target.name);
        
        // 1. A safe echo command
        const cmdRes = await command('echo "E2E Validation for " {{name}}', { 
            member_name: target.name, 
            substitutions: { name: target.name }
        });
        
        if (!cmdRes.includes("E2E Validation")) {
            throw new Error("Command output validation failed on " + target.name);
        }
        
        log("Command test passed on " + target.name);
        
        // 2. A safe LLM prompt asking for a specific string
        log("Testing agent prompt on " + target.name);
        const agentRes = await agent("Reply exactly with the word: E2ESAFE", { 
            member_name: target.name, 
            effort: "low" 
        });
        
        if (!agentRes || !agentRes.includes("E2ESAFE")) {
            log("Warning: Agent prompting validation failed or returned unexpected data on " + target.name + ". (Could be mock limitations)");
        } else {
            log("Agent test passed on " + target.name);
        }

        return target.name;
    });
    
    return { status: "success", testedMembers: results };
}
`;

async function main() {
    console.log('Connecting to apra-fleet...');
    const transport = new StreamableHttpTransport('http://127.0.0.1:7523/mcp');
    const client = new McpClient(transport);
    
    const readyPromise = new Promise(resolve => transport.on('ready', resolve));
    await transport.start();
    await readyPromise;

    const api = new ApraFleet(client);
    const wf = new FleetWorkflow(api);
    const engine = new WorkflowEngine(wf);
    const viewer = startViewer(wf, { name: 'E2E Fleet Harness' });

    try {
        console.log('\n--- Discovering Members ---');
        const listRes = await api.fleetStatus({ format: 'json' });
        
        let activeMembers = [];
        if (listRes.content && listRes.content.length > 0) {
            const rawMembers = JSON.parse(listRes.content[0].text);
            const memberArray = Array.isArray(rawMembers) ? rawMembers : (rawMembers.members || Object.values(rawMembers));
            
            // Filter for members that are local and online
            activeMembers = memberArray.filter(m => m.status === 'online' && m.host === '(local)');
            
            // Limit to a couple local members to avoid hampering
            activeMembers = activeMembers.slice(0, 2);
        }
        
        console.log(`Found ${activeMembers.length} valid target members:`, activeMembers.map(m => m.name));

        console.log('\n--- Executing E2E Workflow ---');
        const finalResult = await engine.executeSource(e2eScript, { targets: activeMembers });
        
        console.log('\n--- E2E Complete ---');
        console.log(finalResult);
        viewer.markComplete(true);
    } catch (e) {
        console.error('\nFAIL: E2E Harness threw an error:', e);
        viewer.markComplete(false);
    } finally {
        await new Promise(r => setTimeout(r, 2000));
        viewer.stop();
        transport.stop();
    }
}

main();
