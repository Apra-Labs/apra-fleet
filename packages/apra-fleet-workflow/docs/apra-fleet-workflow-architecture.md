# Apra Fleet Workflow Architecture

The `apra-fleet-workflow` engine is a declarative, infrastructure-as-code orchestration layer. It completely decouples rigid loop mechanics from the underlying fleet compute grid. By parsing lightweight JavaScript workflow files (such as `sprint.js` or `review.js`), developers can author complex multi-agent interactions that execute across distributed nodes securely and reliably.

## 1. Design & Core Philosophy

The engine is built around a functional Sequential approach. Instead of hardcoding branching logic inside Node.js, users construct arrays of AI tasks and pass them through parallel barriers and stage Sequentials. 

**Available Workflow Globals:**
- `agent(prompt, opts)`: Directly dispatches a task to a fleet member's LLM via `executePrompt`.
- `command(cmd, opts)`: Dispatches a pure shell command via `executeCommand`.
- `sequential(items, processor, opts)`: Applies a single `processor(item, index, items)` function to each item in order. Passing more than one processor function (the old variadic `sequential(items, ...stages)` form) throws a `TypeError` rather than silently dropping the extra stages.
- `pipeline(items, ...stages)`: The multi-stage primitive. Each stage function is applied in order to every item; a stage receives the previous stage's result for that item (the first stage receives the raw item) and returns the input for the next stage.
- `parallel(items, processor, opts)`: Acts as a synchronization barrier, running the processor for every item concurrently across members.
- `transform(fn)`: A string-to-string mapping idiom to cleanly format outputs between Sequential stages.
- `phase(title)` and `log(message)`: Structured telemetry and UX tracking.

## 2. Robustness & Reliability

Workflows operating in a multi-node, AI-driven environment must assume that network requests drop, LLMs hallucinate, and commands crash. The engine ensures reliability through the following guarantees:

1. **Fail-fast by default, opt-in resilience:** Both `sequential()`/`pipeline()` and `parallel()` are **fail-fast by default**. The first item (or stage) that throws aborts the whole call and rethrows that error -- the engine does not silently continue or substitute `null` unless you explicitly opt in.
2. **`continueOnError: true`:** Pass `{ continueOnError: true }` as the `opts` argument to `sequential()`, `pipeline()`, or `parallel()` to change this: a failing item is logged and recorded as `null` in the results array, and the engine continues with the remaining items instead of aborting.
3. **Partial results on failure:** When the default fail-fast path rethrows (i.e. `continueOnError` was not set), the results collected for items processed *before* the failure are attached to the thrown error as `err.partialResults`, so callers can recover whatever progress was made before deciding how to handle the failure.
4. **Structured Output (Schema Validation):**
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
