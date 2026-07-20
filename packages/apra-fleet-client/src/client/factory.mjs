import { StdioTransport, StreamableHttpTransport } from './transport.mjs';
import { McpClient } from './client.mjs';
import { ApraFleet } from './api.mjs';
import { FleetWorkflow } from '../workflow/index.mjs';
import { WorkflowEngine } from '../workflow/engine.mjs';

/**
 * Creates and initializes a WorkflowEngine along with its underlying transport and API layers.
 * 
 * @param {Object} config
 * @param {'stdio'|'http'} config.transport
 * @param {string} [config.command] - Required if transport is 'stdio'
 * @param {string[]} [config.args] - Optional args if transport is 'stdio'
 * @param {string} [config.url] - Required if transport is 'http'
 * @param {Object} [config.options] - Transport options
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
        transport = new StreamableHttpTransport(config.url, config.options || {});
    } else {
        throw new Error(`Unsupported transport type: ${config.transport}`);
    }

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
