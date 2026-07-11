// MANUAL / LIVE E2E FIXTURE -- not part of `npm test`.
// Requires a live apra-fleet MCP server on 127.0.0.1:7523 with an online
// member named 'alpha'. See test/manual/README.md for details and the beads
// issue that tracks real live-fleet E2E coverage (currently untracked -- see
// README gap note).
import path from 'path';
import { fileURLToPath } from 'url';
import { McpClient } from '@apralabs/apra-fleet-client/client';
import { StreamableHttpTransport } from '@apralabs/apra-fleet-client/transport';
import { ApraFleet } from '@apralabs/apra-fleet-client';
import { FleetWorkflow } from '../../src/workflow/index.mjs';
import { WorkflowEngine } from '../../src/workflow/engine.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

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
    const result = await engine.executeFile(path.join(__dirname, 'test-workflow.js'), { target: 'alpha' });
    console.log('\nFinal Workflow Result:', result);

    transport.stop();
}

main().catch(console.error);
