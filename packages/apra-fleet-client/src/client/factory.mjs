import { StdioTransport, StreamableHttpTransport } from './transport.mjs';
import { McpClient } from './client.mjs';
import { ApraFleet } from './api.mjs';
import { withFleetAccessSecret } from './server-resolution.mjs';

/**
 * FleetWorkflow/WorkflowEngine live in @apralabs/apra-fleet-workflow, which
 * depends on THIS package; loading them lazily keeps that dependency one-way
 * at module-load time (a static import made this module unloadable).
 */
async function loadWorkflowClasses() {
    const [{ FleetWorkflow }, { WorkflowEngine }] = await Promise.all([
        import('@apralabs/apra-fleet-workflow'),
        import('@apralabs/apra-fleet-workflow/engine'),
    ]);
    return { FleetWorkflow, WorkflowEngine };
}

/**
 * Creates and initializes a WorkflowEngine along with its underlying transport and API layers.
 * 
 * @param {Object} config
 * @param {'stdio'|'http'} config.transport
 * @param {string} [config.command] - Required if transport is 'stdio'
 * @param {string[]} [config.args] - Optional args if transport is 'stdio'
 * @param {string} [config.url] - Required if transport is 'http'
 * @param {Object} [config.options] - Transport options. For 'http' the local install's
 *   access secret header is added (an explicit header in options wins): the server
 *   refuses an /mcp session without it (HTTP 401).
 * @param {NodeJS.ProcessEnv} [config.env] - Env naming the install's data dir the
 *   access secret is read from (APRA_FLEET_DATA_DIR); defaults to process.env.
 * @param {Object} [config.workflowArgs] - Arguments for the workflow context
 * @returns {Promise<{transport: any, mcpClient: McpClient, apraFleet: ApraFleet, fleetWorkflow: FleetWorkflow, engine: WorkflowEngine}>}
 */
export async function createWorkflowEngine(config) {
    let transport;

    if (config.transport === 'stdio') {
        if (!config.command) {
            throw new Error("StdioTransport requires a 'command' property in config.");
        }
        transport = new StdioTransport(config.command, config.args || [], config.options || {});
    } else if (config.transport === 'http') {
        if (!config.url) {
            throw new Error("StreamableHttpTransport requires a 'url' property in config.");
        }
        transport = new StreamableHttpTransport(config.url, withFleetAccessSecret(config.options || {}, config.env || process.env));
    } else {
        throw new Error(`Unsupported transport type: ${config.transport}`);
    }

    // Before start(): a load failure must not leave a connected transport behind.
    const { FleetWorkflow, WorkflowEngine } = await loadWorkflowClasses();

    await transport.start();

    const mcpClient = new McpClient(transport);

    // Standard MCP requires the client to initialize the connection
    if (config.transport === 'stdio') {
        await mcpClient.request('initialize', {
            protocolVersion: '2024-11-05',
            capabilities: {},
            clientInfo: { name: 'fleet-client', version: '1.0.0' }
        });
        await transport.send({
            jsonrpc: '2.0',
            method: 'notifications/initialized',
            params: {}
        });
    }

    const apraFleet = new ApraFleet(mcpClient);
    const fleetWorkflow = new FleetWorkflow(apraFleet, config.workflowArgs || {});
    const engine = new WorkflowEngine(fleetWorkflow);

    return {
        transport,
        mcpClient,
        apraFleet,
        fleetWorkflow,
        engine
    };
}
