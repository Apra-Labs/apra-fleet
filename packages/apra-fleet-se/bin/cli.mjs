#!/usr/bin/env node
import { parseArgs } from 'node:util';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { FleetWorkflow } from '@apralabs/apra-fleet-workflow';
import { WorkflowEngine } from '@apralabs/apra-fleet-workflow/engine';
import { createDashboardViewer } from '@apralabs/apra-fleet-workflow/viewer';
import { beadsExtension } from '../auto-sprint/viewer-extensions.mjs';

// TODO: Import the real ApraFleet API wrapper and MCP transport once published
// import { ApraFleet, StdioTransport, McpClient } from '@apralabs/apra-fleet-client';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

async function main() {
    const options = {
        issue: { type: 'string', short: 'i' },
        members: { type: 'string', short: 'm' },
        branch: { type: 'string', short: 'b' },
        base: { type: 'string', short: 'B' },
        goal: { type: 'string', short: 'g', default: 'P1/P2' },
        help: { type: 'boolean', short: 'h' }
    };

    const { values } = parseArgs({ options, strict: false });

    if (values.help) {
        console.log(`
Usage: fleet-se sprint [options]

Options:
  -i, --issue <ids>     (REQUIRED) Target issue ID(s). Comma separated (e.g., epic-1,epic-2).
  -m, --members <ids>   (REQUIRED) Member IDs/paths to use. Comma separated. Members act as repo targets for parallelism.
  -b, --branch <name>   (REQUIRED) Target branch name to develop on.
  -B, --base <name>     (REQUIRED) Base branch which is the target for the pull request.
  -g, --goal <goal>     Sprint goal constraint. Options: P1, P1/P2, P1/P2/P3. Default: P1/P2.
  -h, --help            Show this help message.
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

    // --- Precondition Validations ---
    
    // 1. Validate Members
    // (Placeholder logic: in reality, this queries the fleet registry or checks fs.existsSync)
    const checkMemberExists = async (m) => true; // TODO: Implement real check
    
    const validMembers = [];
    const missingMembers = [];
    for (const m of rawMembers) {
        if (await checkMemberExists(m)) validMembers.push(m);
        else missingMembers.push(m);
    }

    if (validMembers.length === 0) {
        console.error(`❌ Error: All specified members are missing or invalid.`);
        process.exit(1);
    }
    if (missingMembers.length > 0) {
        console.warn(`⚠️  Warning: The following members are missing and will be ignored: ${missingMembers.join(', ')}`);
    }

    // 2. Validate Issues
    // (Placeholder logic: in reality, this runs 'bd list' to ensure the issues exist)
    const checkIssueExists = async (id) => true; // TODO: Implement real check
    
    const missingIssues = [];
    for (const id of targetIssues) {
        if (!(await checkIssueExists(id))) missingIssues.push(id);
    }
    
    if (missingIssues.length > 0) {
        console.error(`❌ Error: The following target issues are missing from the database: ${missingIssues.join(', ')}`);
        process.exit(1);
    }

    console.log(`🚀 Starting Auto-Sprint`);
    console.log(`🎯 Target Issues: ${targetIssues.join(', ')}`);
    console.log(`🌿 Target Branch: ${branchName} (Base: ${baseBranch})`);
    console.log(`⚙️  Goal Constraint: ${goal}`);
    console.log(`👥 Active Members (${validMembers.length}): ${validMembers.join(', ')}`);

    /*
    // TODO: Wire up actual MCP Transport when apra-fleet-client is ready
    const transport = new StdioTransport('node', ['path/to/apra-fleet/dist/index.js', 'serve']);
    const mcpClient = new McpClient(transport);
    const fleetApi = new ApraFleet(mcpClient);
    
    // We pass the branch and members into the context. 
    // WorkflowEngine might need a primary member's path as targetRepo, or runner.js handles it.
    const workflow = new FleetWorkflow(fleetApi);
    const engine = new WorkflowEngine(workflow);

    const server = createDashboardViewer(workflow, {
        port: 8080,
        name: 'Auto-Sprint',
        dashboardExtensions: [beadsExtension]
    });

    console.log("📊 Dashboard live at http://localhost:8080");

    try {
        const scriptPath = path.join(__dirname, '../auto-sprint/runner.js');
        const res = await engine.executeFile(scriptPath, {
            target_issues: targetIssues,
            members: memberList,
            branch: branchName,
            goal: goal
        });
        console.log("✅ Sprint finished:", res);
    } catch (err) {
        console.error("❌ Sprint failed:", err);
        process.exit(1);
    } finally {
        server.close();
        process.exit(0);
    }
    */
   
    console.log("\\n(Note: The MCP transport integration block is currently commented out pending apra-fleet-client finalization.)");
}

main().catch(err => {
    console.error(err);
    process.exit(1);
});
