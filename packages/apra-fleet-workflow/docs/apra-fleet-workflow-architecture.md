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

## 3. Trust Model: Workflow Scripts Are Trusted Code

Workflow scripts are **trusted code**, loaded and executed the same way any other Node.js ES module is: `WorkflowEngine.executeFile()` resolves the script path and runs `import(pathToFileURL(fullPath))` on it, then calls the module's exported `main(context)` (or `run(context)`/`default(context)`) entry point. There is no sandbox, no restricted global scope, and no interception of Node.js APIs. A workflow script has full access to `globalThis`, `process` (including `process.env`), the filesystem, the network (`fetch`), `child_process`, and dynamic `import()` -- exactly like any other module you `import` into a Node.js program.

**Only run workflow scripts you trust**, the same way you'd only `npm install` or `import` packages you trust. Do not execute unreviewed workflow scripts pulled from untrusted sources.

### The Vetting Engine is advisory, not a security boundary

`VettingEngine` (`vetting.mjs`) runs a `BasicSecurityAnalyzer` heuristic (plain regex matching, no AST parsing) over the script source before it loads, and logs warnings for patterns that are often worth a second look: imports of Node.js system modules (`fs`, `child_process`, `crypto`, `net`, `http`), `process.env` access, or dynamic code evaluation (`eval`, `new Function`). These warnings are printed to the console for every run, but **`WorkflowEngine.executeFile()` never blocks execution based on them by default** -- vetting cannot meaningfully sandbox arbitrary JavaScript (it's trivially bypassed by indirection, string concatenation, etc.), so treating it as an enforcement mechanism would be misleading.

If you want vetting to block high-risk scripts (`riskScore > 50`) instead of just warning, opt in explicitly:

```js
await engine.executeFile(scriptPath, args, { strictVetting: true });
```

This is an opt-in lint gate for teams that want a speed bump before running scripts from less-trusted sources, not a substitute for actually trusting the code you run.

This vetting infrastructure is extensible: register additional `WorkflowAnalyzer` instances via `VettingEngine.registerAnalyzer()` to add project-specific lint rules.
