# Workflow Guide

This guide explains how to work with and test workflows in the `fleet-client` architecture.

## Running Workflow Test Suites

To ensure reliability and consistency, workflow test suites should be run in a single test harness. This approach provides a unified execution environment and comprehensive reporting.

1. **Test Runner**: We use the standard project test runner (e.g., `vitest` or `jest` based on your project configuration) to execute workflow tests.
2. **Execution**: You can run the complete workflow test suite by executing the following command from the `fleet-client` root directory or the project root (depending on script placement):

```bash
npm test -- -t "workflow"
# OR, if a specific npm script exists:
npm run test:workflows
```

3. **Single Harness Setup**: Ensure your tests are organized under a common directory (e.g., `tests/workflows/`) and utilize a shared setup file that initializes the necessary mock servers, MCP client contexts, and test data. This avoids redundant setup and teardown overhead across different test files.

## Passing Arguments to Workflow Instances

Workflows often require dynamic input parameters at runtime. You can pass arguments to workflow instances using the `args` object within the engine context.

### The `args` Object

When initializing or starting a workflow engine, you provide an execution context. The `args` property of this context is where you inject user-defined variables or configuration required by the specific workflow instance.

### Example

Here is an example of how to pass arguments to a workflow instance:

```javascript
import { WorkflowEngine } from './engine';

// 1. Define the arguments for this specific workflow run
const workflowArguments = {
  targetBranch: "feature/new-ui",
  userId: "user_12345",
  dryRun: false,
  retries: 3
};

// 2. Create the engine context, including the args
const executionContext = {
  workflowId: "deploy-service-workflow",
  args: workflowArguments,
  // ... other context properties (e.g., environment, credentials)
};

// 3. Initialize and run the workflow
const engine = new WorkflowEngine(executionContext);

// Inside the workflow logic, these arguments can be accessed via:
// context.args.targetBranch
// context.args.userId
```

By standardizing on the `args` object in the context, workflows remain flexible and reusable across different scenarios without hardcoding configuration values.

## Data Transformation and the \`transform()\` Primitive

Workflows often need to manipulate data between LLM inferences and command executions (e.g., parsing JSON strings, extracting text, sanitizing variables).

The \`transform(label, func, context)\` primitive securely executes Javascript mappings within the workflow Sequential while simultaneously emitting full tracking telemetry to the Workflow Dashboard UI. 

### Features
* **Telemetry**: Errors, execution durations, stringified Inputs, and stringified Outputs are logged exactly like \`agent()\` actions.
* **Failures**: Errors thrown by \`transform()\` will safely fail the node, but will not crash the workflow engine itself.

### Example
\`\`\`javascript
const planJson = await agent("Make a file", { ... });

// transform() stringifies input and output to visually trace them in the Dashboard!
const cmdString = await transform('Extract command', (data) => {
    if (!data.command) throw new Error("Missing command");
    return data.command;
}, planJson);

await command(cmdString, { ... });
\`\`\`

### \`nullTransform()\` and Identity Fallbacks
- If no transform function is provided, the node defaults to passing the data through unaltered.
- A convenience \`nullTransform\` is also exposed globally to explicitly break a data dependency chain and drop output:
  \`\`\`javascript
  await transform('Cleanup', nullTransform, data); // returns null
  \`\`\`

## Error Handling (\`continueOnError\`)

By default, any error thrown within a \`sequential()\` or \`parallel()\` block halts execution of the sequence.
If you need partial success, pass \`{ continueOnError: true }\`:

\`\`\`javascript
await sequential(items, async (item) => {
    // If one item fails, the Sequential logs the error but continues with the rest
    await transform('Risky map', riskyFunc, item);
}, { continueOnError: true });
\`\`\`

## Typed Errors from \`agent()\` / \`command()\`

\`agent()\` and \`command()\` never return \`null\`. Every failure -- a missing
member, unparseable/schema-invalid LLM output, an \`isError\` command result,
or a transport/JSON-RPC failure -- is raised as a typed error from
\`src/workflow/errors.mjs\`:

* \`MemberNotFoundError\` (\`code: MEMBER_NOT_FOUND\`)
* \`AgentOutputError\` (\`code: AGENT_OUTPUT_INVALID\`) -- empty content,
  unparseable JSON, or schema validation failures
* \`CommandError\` (\`code: COMMAND_FAILED\`) -- \`isError: true\` results
* \`FleetTransportError\` (\`code: TRANSPORT_ERROR\`) -- the underlying
  \`fleetApi\` call itself rejected; the original error is preserved on
  \`.cause\`

All four extend the base \`WorkflowError\`, which carries \`.code\` and
\`.details\`. These classes are exported from the package entry point
(\`@apralabs/apra-fleet-workflow\`), so callers can \`instanceof\`-match them:

\`\`\`javascript
import { MemberNotFoundError } from '@apralabs/apra-fleet-workflow';

try {
    await agent('Say hello', { member_name: 'maybe-missing' });
} catch (err) {
    if (err instanceof MemberNotFoundError) {
        // handle missing member specifically
    }
    throw err;
}
\`\`\`

The apra-fleet MCP server currently reports some of these conditions (e.g. a
missing member) via plain response text rather than a structured error --
see \`docs/structured-errors-proposal.md\`. The classification above is a
client-side stopgap; once the server ships a structured error contract, the
same error classes will be raised from that path instead of a text sniff.

### \`resume\` default (\`AgentOptions.resume\`)

The underlying fleet client (\`ExecutePromptOptions.resume\` in
\`@apralabs/apra-fleet-client\`) defaults to resuming the previous session
(\`resume: true\`) when the field is omitted. The **workflow layer changes
this default**: \`agent()\` always sends \`resume\` explicitly, defaulting it
to \`false\` unless the caller sets \`AgentOptions.resume\` to \`true\`. This
means workflow-authored prompts are self-contained by default and won't
silently pick up state from a prior session:

\`\`\`javascript
// Resumes the member's previous session:
await agent('Continue where we left off', { member_name: 'fleet-dev', resume: true });

// Default: starts a fresh, self-contained session:
await agent('Say hello', { member_name: 'fleet-dev' });
\`\`\`
