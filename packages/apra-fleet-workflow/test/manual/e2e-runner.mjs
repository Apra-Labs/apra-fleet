// MANUAL / LIVE E2E FIXTURE -- not part of `npm test`.
// Requires a live apra-fleet MCP server on 127.0.0.1:7523 with at least one
// online local member. See test/manual/README.md for details and the beads
// issue that tracks real live-fleet E2E coverage (currently untracked -- see
// README gap note).
import path from 'path';
import { fileURLToPath } from 'url';
import { McpClient } from '@apralabs/apra-fleet-client/client';
import { StreamableHttpTransport } from '@apralabs/apra-fleet-client/transport';
import { ApraFleet } from '@apralabs/apra-fleet-client';
import { FleetWorkflow } from '../../src/workflow/index.mjs';
import { WorkflowEngine } from '../../src/workflow/engine.mjs';
import { createDashboardViewer } from '../../src/viewer/index.mjs';

// executeSource() (inline string execution) was removed in apra-fleet-unw.7 --
// workflow scripts are now loaded as real ES modules via import(), which
// requires an actual file. The script previously inlined here as a template
// string now lives at ./e2e-harness-script.mjs and is run via executeFile().
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const e2eScriptPath = path.join(__dirname, 'e2e-harness-script.mjs');

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
    // createDashboardViewer returns a plain http.Server; there is no
    // markComplete()/stop() API (that was the original dead-import bug).
    const viewer = createDashboardViewer(wf, { port: 0, name: 'E2E Fleet Harness' });

    // Ephemeral port: wait for the server to start listening and read the
    // actual bound port from server.address().port
    await new Promise((resolve, reject) => {
        viewer.once('listening', resolve);
        viewer.once('error', reject);
    });

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
        const finalResult = await engine.executeFile(e2eScriptPath, { targets: activeMembers });
        
        console.log('\n--- E2E Complete ---');
        console.log(finalResult);
    } catch (e) {
        console.error('\nFAIL: E2E Harness threw an error:', e);
    } finally {
        await new Promise(r => setTimeout(r, 2000));
        viewer.close();
        transport.stop();
    }
}

main();
