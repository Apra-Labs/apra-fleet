# Apra Fleet Workflow Architecture

The `apra-fleet-workflow` engine is a declarative, infrastructure-as-code orchestration layer. It completely decouples rigid loop mechanics from the underlying fleet compute grid. By parsing lightweight JavaScript workflow files (such as `sprint.js` or `review.js`), developers can author complex multi-agent interactions that execute across distributed nodes securely and reliably.

## 1. Design & Core Philosophy

The engine is built around a functional pipeline approach. Instead of hardcoding branching logic inside Node.js, users construct arrays of AI tasks and pass them through parallel barriers and stage pipelines. 

**Available Workflow Globals:**
- `agent(prompt, opts)`: Directly dispatches a task to a fleet member's LLM via `executePrompt`.
- `command(cmd, opts)`: Dispatches a pure shell command via `executeCommand`.
- `pipeline(items, ...stages)`: Processes an array of items sequentially through distinct functional stages.
- `parallel(thunks)`: Acts as a synchronization barrier, running tasks concurrently across members.
- `transform(fn)`: A string-to-string mapping idiom to cleanly format outputs between pipeline stages.
- `phase(title)` and `log(message)`: Structured telemetry and UX tracking.

## 2. Robustness & Reliability

Workflows operating in a multi-node, AI-driven environment must assume that network requests drop, LLMs hallucinate, and commands crash. The engine ensures reliability through the following guarantees:

1. **Parallel Fallbacks:** Any thunk inside a `parallel()` block that throws an exception (due to network failure, API crash, etc.) is gracefully caught. The engine returns `null` for that specific index in the barrier array, rather than crashing the orchestrator and abandoning the other successful concurrent tasks.
2. **Sequential Pipelines:** If a specific stage inside a `pipeline()` fails for an item, the engine catches the error, aborts further processing for *that specific item*, and logs it. Surviving items continue their journey through the pipeline.
3. **Structured Output (Schema Validation):**
   - **Pre-Condition**: When `opts.schema` is provided to an `agent()`, the engine first compiles the JSON Schema using `ajv` (JSON Schema draft-07 standard). If the user provided a malformed schema, the engine halts immediately rather than wasting LLM compute.
   - **Post-Condition**: When the LLM responds, the engine attempts to scrape and parse the JSON. It then strictly validates the parsed object against the compiled `ajv` schema. A non-compliant response is treated as a fatal stage error, preventing downstream systems from processing malformed data.

## 3. Safety & The Vetting Engine

Because the workflow files are written in pure JavaScript, they introduce an inherent remote-code-execution risk if users pull unverified workflows from public repositories.

To mitigate this, the execution is protected by the **Vetting Engine** (`vetting.mjs`).

1. **Sandboxing:** Workflows are executed via the `AsyncFunction` constructor, preventing them from bleeding into the parent module scope. Node.js core modules are not injected.
2. **Static Assessment:** Before the engine attempts execution, the workflow source is passed to a series of registered `WorkflowAnalyzer` instances.
3. **Malicious Pattern Detection:** The default `BasicSecurityAnalyzer` strictly prohibits:
   - Dynamic or static imports of Node.js system modules (`fs`, `child_process`, `crypto`, `net`).
   - Access to `process.env`.
   - Dynamic code evaluation (`eval`, `new Function`).
4. **Enforced Boundaries:** If any analyzer flags a script with a risk score `> 50`, the engine outright refuses to execute the script and throws a clear security warning. A user must explicitly acknowledge the danger by passing `forceOverrideRisk=true` to bypass the boundary.

This vetting infrastructure is fully extensible. Community developers can drop in advanced AST parsers (like Babel or Acorn) to build highly sophisticated linting and security rules to secure their fleet grids.
