import { McpClient } from '@apralabs/apra-fleet-client/client';
import { StreamableHttpTransport } from '@apralabs/apra-fleet-client/transport';
import { ApraFleet } from '@apralabs/apra-fleet-client';
import { FleetWorkflow } from '../src/workflow/index.mjs';
import { WorkflowEngine } from '../src/workflow/engine.mjs';
import { startViewer } from '../src/viewer/index.mjs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

async function main() {
    console.log('Connecting to apra-fleet...');
    const transport = new StreamableHttpTransport('http://127.0.0.1:7523/mcp');
    const readyPromise = new Promise(resolve => transport.on('ready', resolve));
    transport.start();
    await readyPromise;

    const client = new McpClient(transport);
    const api = new ApraFleet(client);
    const wf = new FleetWorkflow(api);
    const engine = new WorkflowEngine(wf);
    const viewer = startViewer(wf, { name: 'Workflow Test Suite' });

    console.log('\n--- Running Vetting Test (Expected: Fail) ---');
    try {
        await engine.executeFile(path.join(__dirname, 'test-vetting.js'));
        console.error('FAIL: Vetting test should have thrown an error!');
    } catch (e) {
        console.log('SUCCESS: Vetting test correctly threw:', e.message);
    }

    console.log('\n--- Running Vetting Override Test (Expected: Bypass) ---');
    try {
        await engine.executeFile(path.join(__dirname, 'test-vetting.js'), {}, true);
        console.log('SUCCESS: Vetting test successfully overridden with forceOverrideRisk flag!');
    } catch (e) {
        console.error('FAIL: Vetting override failed:', e.message);
    }

    console.log('\n--- Running Edge Case: Pipeline Isolation (Expected: Success) ---');
    const pipelineRes = await engine.executeFile(path.join(__dirname, 'test-edge-pipeline.js'));
    console.log('Pipeline test returned successfully.');

    console.log('\n--- Running Edge Case: Agent Missing Args (Expected: Fail) ---');
    try {
        await engine.executeFile(path.join(__dirname, 'test-edge-agent-args.js'));
        console.error('FAIL: Agent args test should have thrown an error!');
    } catch (e) {
        console.log('SUCCESS: Agent args test correctly threw:', e.message);
    }

    console.log('\n--- Running Edge Case: Command Failure (Expected: Fail) ---');
    try {
        await engine.executeFile(path.join(__dirname, 'test-edge-command-fail.js'));
        console.error('FAIL: Command fail test should have thrown an error!');
    } catch (e) {
        console.log('SUCCESS: Command fail test correctly threw:', e.message);
    }

    console.log('\n--- Running Edge Case: Missing Member Graceful Handling (Expected: Success) ---');
    const missingMemRes = await engine.executeFile(path.join(__dirname, 'test-edge-missing-member.js'));
    console.log('Missing member test returned gracefully:', missingMemRes);

    console.log('\n--- Running Command & Schema Test ---');
    const result = await engine.executeFile(path.join(__dirname, 'test-command.js'));
    console.log('\n--- Running Schema Pre-condition Test ---');
    try {
        await engine.executeFile(path.join(__dirname, 'test-schema-pre.js'));
        console.error('FAIL: Schema pre-condition test should have thrown an error!');
    } catch (e) {
        console.log('SUCCESS: Schema pre-condition test correctly threw:', e.message);
    }

    console.log('\n--- Running Schema Post-condition Test (Expected: Fail) ---');
    try {
        await engine.executeFile(path.join(__dirname, 'test-schema-post.js'));
        console.error('FAIL: Schema post-condition test should have thrown an error!');
    } catch (e) {
        console.log('SUCCESS: Schema post-condition test correctly threw:', e.message);
    }

    console.log('\n--- Running Edge Case: LLM Parse Failure (Expected: Fail) ---');
    try {
        await engine.executeFile(path.join(__dirname, 'test-schema-garbage.js'));
        console.error('FAIL: LLM Parse Failure test should have thrown an error!');
    } catch (e) {
        console.log('SUCCESS: LLM Parse Failure test correctly threw:', e.message);
    }
    
    viewer.markComplete(true);
    await new Promise(r => setTimeout(r, 2000)); // Leave server up for a moment to flush

    viewer.stop();
    transport.stop();
}

main().catch(console.error);
