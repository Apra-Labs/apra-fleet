import { McpClient } from './lib/fleet-client/client.mjs';
import { StreamableHttpTransport } from './lib/fleet-client/transport.mjs';
import { ApraFleet } from './lib/fleet-client/api.mjs';
import { FleetWorkflow } from './lib/apra-fleet-workflow/index.mjs';
import { WorkflowEngine } from './lib/apra-fleet-workflow/engine.mjs';

async function main() {
    console.log('Connecting to apra-fleet...');
    const transport = new StreamableHttpTransport('http://127.0.0.1:7523/mcp');
    const readyPromise = new Promise(resolve => transport.on('ready', resolve));
    transport.start();
    await readyPromise;
    console.log('Connected!');

    const client = new McpClient(transport);
    const api = new ApraFleet(client);
    const wf = new FleetWorkflow(api);
    const engine = new WorkflowEngine(wf);

    console.log('Executing test-workflow.js...');
    const result = await engine.executeFile('test-workflow.js', { target: 'alpha' });
    console.log('\nFinal Workflow Result:', result);

    transport.stop();
}

main().catch(console.error);
