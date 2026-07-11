#!/usr/bin/env node
import { parseArgs } from 'node:util';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile as execFileCb } from 'node:child_process';
import { promisify } from 'node:util';
import { FleetWorkflow } from '@apralabs/apra-fleet-workflow';
import { WorkflowEngine } from '@apralabs/apra-fleet-workflow/engine';
import { createDashboardViewer } from '@apralabs/apra-fleet-workflow/viewer';
import { StdioTransport } from '@apralabs/apra-fleet-client/transport';
import { McpClient } from '@apralabs/apra-fleet-client/client';
import { ApraFleet } from '@apralabs/apra-fleet-client';
import { beadsExtension } from '../auto-sprint/viewer-extensions.mjs';
import { validateIssueId, validateBranchName } from '../auto-sprint/runner.js';

const execFile = promisify(execFileCb);

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/**
 * Resolves the command used to launch the apra-fleet MCP server over
 * stdio. Mirrors the SEA-binary -> npm-global-entry -> dev-mode
 * `node dist/index.js` resolution order that src/cli/install.ts uses when
 * it registers the stdio MCP server for other LLM providers (see
 * `mcpConfig` in install.ts's "Register MCP server" step), overridable via
 * env for tests/CI/non-standard installs.
 *
 * @returns {{ command: string, args: string[] }}
 */
function resolveFleetServerCommand() {
    if (process.env.APRA_FLEET_SERVER_CMD) {
        const parts = process.env.APRA_FLEET_SERVER_CMD.split(' ').filter(Boolean);
        if (parts.length === 0) {
            throw new Error('APRA_FLEET_SERVER_CMD is set but empty.');
        }
        return { command: parts[0], args: parts.slice(1) };
    }
    if (process.env.APRA_FLEET_SERVER_BIN) {
        return { command: process.env.APRA_FLEET_SERVER_BIN, args: ['run', '--transport', 'stdio'] };
    }
    // Dev-mode default: this package lives at <repoRoot>/packages/apra-fleet-se/bin,
    // so the built server entry point is three levels up at <repoRoot>/dist/index.js
    // (see the repo root package.json's "main"/"bin": "dist/index.js").
    const repoRoot = path.resolve(__dirname, '..', '..', '..');
    return { command: 'node', args: [path.join(repoRoot, 'dist', 'index.js'), 'run', '--transport', 'stdio'] };
}

async function main() {
    const options = {
        issue: { type: 'string', short: 'i' },
        members: { type: 'string', short: 'm' },
        branch: { type: 'string', short: 'b' },
        base: { type: 'string', short: 'B' },
        goal: { type: 'string', short: 'g', default: 'P1/P2' },
        'max-cycles': { type: 'string', short: 'c' },
        help: { type: 'boolean', short: 'h' }
    };

    const { values } = parseArgs({ options, strict: false });

    if (values.help) {
        console.log(`
Usage: fleet-se sprint [options]

Options:
  -i, --issue <ids>       (REQUIRED) Target issue ID(s). Comma separated (e.g., epic-1,epic-2).
  -m, --members <ids>     (REQUIRED) Member IDs/names to use. Comma separated. Members act as repo targets for parallelism.
  -b, --branch <name>     (REQUIRED) Sprint branch to develop on (created from --base if it doesn't exist).
  -B, --base <name>       (REQUIRED) Base branch the sprint branch is created from and the eventual PR targets.
  -g, --goal <goal>       Sprint goal constraint. Options: P1, P1/P2, P1/P2/P3. Default: P1/P2.
  -c, --max-cycles <n>    Max plan/develop/review cycles. Default: 5.
  -h, --help              Show this help message.
        `.trim());
        process.exit(0);
    }

    const missing = [];
    if (!values.issue) missing.push('--issue');
    if (!values.members) missing.push('--members');
    if (!values.branch) missing.push('--branch');
    if (!values.base) missing.push('--base');

    if (missing.length > 0) {
        console.error(`Error: Missing required flags: ${missing.join(', ')}`);
        process.exit(1);
    }

    // Split and clean comma-separated lists
    const targetIssues = values.issue.split(',').map(s => s.trim()).filter(Boolean);
    const rawMembers = values.members.split(',').map(s => s.trim()).filter(Boolean);
    const branchName = values.branch;
    const baseBranch = values.base;
    const goal = values.goal;
    const maxCycles = values['max-cycles'] !== undefined ? Number(values['max-cycles']) : 5;

    // --- A7 defense-in-depth: reject shell-unsafe issue ids / branch names
    // BEFORE any bd/fleet dispatch happens. runner.js re-validates these
    // independently (see auto-sprint/runner.js validateArgs()) so a
    // malformed id can never reach a shell command even if this CLI layer
    // is somehow bypassed -- both layers share the exact same validators
    // (imported from runner.js) so there is a single source of truth.
    try {
        targetIssues.forEach(validateIssueId);
        validateBranchName(branchName, 'branch');
        validateBranchName(baseBranch, 'base');
    } catch (err) {
        console.error(`Error: ${err.message}`);
        process.exit(1);
    }

    if (!Number.isInteger(maxCycles) || maxCycles < 1) {
        console.error(`Error: --max-cycles must be a positive integer, got "${values['max-cycles']}".`);
        process.exit(1);
    }

    // --- Precondition Validations ---

    // 1. Validate issues exist via `bd show <id>`.
    const missingIssues = [];
    for (const id of targetIssues) {
        try {
            await execFile('bd', ['show', id]);
        } catch (err) {
            missingIssues.push(id);
        }
    }
    if (missingIssues.length > 0) {
        console.error(`Error: The following target issues are missing from the database: ${missingIssues.join(', ')}`);
        process.exit(1);
    }

    // 2. Stand up the fleet MCP transport so member validation and the
    // sprint itself run against the same live client/connection.
    const { command: serverCommand, args: serverArgs } = resolveFleetServerCommand();
    const transport = new StdioTransport(serverCommand, serverArgs);
    await transport.start();
    const mcpClient = new McpClient(transport);
    await mcpClient.request('initialize', {
        protocolVersion: '2024-11-05',
        capabilities: {},
        clientInfo: { name: 'apra-fleet-se', version: '1.0.0' }
    });
    await transport.send({
        jsonrpc: '2.0',
        method: 'notifications/initialized',
        params: {}
    });

    const fleetApi = new ApraFleet(mcpClient);

    // 3. Validate members exist via the fleet's list_members tool.
    let validMembers = [];
    let missingMembers = [];
    try {
        const listRes = await fleetApi.listMembers({ format: 'json' });
        const text = listRes && listRes.content && listRes.content[0] ? listRes.content[0].text : JSON.stringify(listRes);
        const parsed = JSON.parse(text);
        const registeredNames = new Set((parsed.members || []).map(m => m.name));
        for (const m of rawMembers) {
            if (registeredNames.has(m)) validMembers.push(m);
            else missingMembers.push(m);
        }
    } catch (err) {
        console.error(`Error: Failed to list fleet members: ${err.message}`);
        transport.stop();
        process.exit(1);
    }

    if (validMembers.length === 0) {
        console.error(`Error: All specified members are missing or invalid: ${rawMembers.join(', ')}`);
        transport.stop();
        process.exit(1);
    }
    if (missingMembers.length > 0) {
        console.warn(`Warning: The following members are missing and will be ignored: ${missingMembers.join(', ')}`);
    }

    console.log('Starting Auto-Sprint');
    console.log(`Target Issues: ${targetIssues.join(', ')}`);
    console.log(`Sprint Branch: ${branchName} (Base: ${baseBranch})`);
    console.log(`Goal Constraint: ${goal}`);
    console.log(`Max Cycles: ${maxCycles}`);
    console.log(`Active Members (${validMembers.length}): ${validMembers.join(', ')}`);

    const workflow = new FleetWorkflow(fleetApi);
    const engine = new WorkflowEngine(workflow);

    const server = createDashboardViewer(workflow, {
        port: 8080,
        name: 'Auto-Sprint',
        dashboardExtensions: [beadsExtension]
    });

    console.log('Dashboard live at http://localhost:8080');

    try {
        const scriptPath = path.join(__dirname, '../auto-sprint/runner.js');
        const res = await engine.executeFile(scriptPath, {
            target_issues: targetIssues,
            members: validMembers,
            branch: branchName,
            base_branch: baseBranch,
            goal: goal,
            max_cycles: maxCycles
        });
        console.log('Sprint finished:', res);
    } catch (err) {
        console.error('Sprint failed:', err);
        process.exitCode = 1;
    } finally {
        server.close();
        transport.stop();
        process.exit(process.exitCode || 0);
    }
}

main().catch(err => {
    console.error(err);
    process.exit(1);
});
