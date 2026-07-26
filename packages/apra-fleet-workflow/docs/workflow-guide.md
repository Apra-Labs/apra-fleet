# Workflow Guide

This guide explains how to write, run, and debug workflow scripts against
`@apralabs/apra-fleet-workflow`. For the internal design (execution model, journal/replay,
budget accounting, the dashboard viewer's wire protocol), see
`docs/apra-fleet-workflow-architecture.md`.

## Writing a Workflow Script

A workflow script is a real ES module. It must export an async entry point function named
`main` (or `run`, or as the `default` export) that accepts a single `context` argument --
the object built by `FleetWorkflow.runWithContext()` (what `WorkflowEngine.executeFile()`
uses internally) or `FleetWorkflow.createContext()` (for direct, non-`executeFile()` usage).
The context exposes `agent`, `command`, `sequential`, `pipeline`, `parallel`, `transform`,
`nullTransform`, `log`, `phase`, `group`, `endGroup`, `publishState`, `args`, and `budget`.
Destructure whatever primitives you need:

```javascript
export const meta = { name: 'my-workflow' };

export async function main(context) {
    const { agent, command, log, phase, args } = context;

    phase('Greeting');
    log(`Running for ${args.targetIssue}`);
    await agent('Say hello', { member_name: 'apra-pm' });
}
```

There are no injected bare globals -- every example in this guide that reads e.g. `agent(...)`
or `sequential(...)` directly assumes it's inside a `main(context)` function that has
already destructured those names from `context`, as shown above.

Workflow scripts are **trusted code**: they run with full Node.js privileges, the same as any
other module you `import`. See `docs/apra-fleet-workflow-architecture.md` section 6 for the
trust model.

## Running a Workflow Script

Wire a `FleetWorkflow` (bound to your `fleetApi` client) to a `WorkflowEngine`, then load
and run the script by path:

```javascript
import { FleetWorkflow } from '@apralabs/apra-fleet-workflow';
import { WorkflowEngine } from '@apralabs/apra-fleet-workflow/engine';

const workflow = new FleetWorkflow(fleetApi);       // fleetApi: an ApraFleet client instance
const engine = new WorkflowEngine(workflow);

const result = await engine.executeFile('./my-workflow.js', {
    targetIssue: 'X-1',
    dryRun: false
});
```

`executeFile(scriptPath, args, opts)`:

- `scriptPath` is resolved relative to the current working directory and loaded via a real
  `import()` -- the module must export `main`/`run`/`default` as described above.
- `args` becomes `context.args` inside the script; access nested values as
  `context.args.targetIssue`.
- `opts` (all optional) controls vetting and journaling:
  - `{ strictVetting: true }` makes the advisory vetting lint block execution of high-risk
    scripts instead of only warning (architecture doc section 6).
  - `{ journal: true | '<path>' | { path: '<path>' } }` records this run's activities to an
    append-only JSONL file for later resume.
  - `{ resumeJournal: '<path>' }` resumes a previous (possibly crashed) run from an existing
    journal, replaying already-completed activities instead of re-dispatching them. See
    "Resuming a run" below and architecture doc section 5.

`executeFile()` throws whatever error killed the run (a typed `WorkflowError` subclass, or
any other error the script itself threw); wrap the call in `try`/`catch` if you need to react
to a failed or cancelled run programmatically. It also emits an `end` event on the
`FleetWorkflow` instance (`status: 'success' | 'failed' | 'cancelled'`) regardless of outcome
-- this is what the dashboard viewer listens for to leave its "running" state.

### Watching a run live: the dashboard viewer

```javascript
import { createDashboardViewer } from '@apralabs/apra-fleet-workflow/viewer';

const server = createDashboardViewer(workflow, {
    port: 8080,
    name: 'My Workflow',
    dashboardExtensions: []   // optional; see architecture doc section 7
});
```

Attach the viewer to the same `FleetWorkflow` instance you pass to `WorkflowEngine`, before
calling `executeFile()`, so it observes the run from the start. Open `http://localhost:8080`
to see phases/activities stream in live, token/cost totals, and a Stop button that triggers
cooperative cancellation (`workflow.requestStop()`) rather than killing the process.

### Running the test suite

This package's own tests run with Node's built-in test runner, not a third-party framework:

```bash
npm test          # runs `node --test test/*.test.mjs` in this package
```

Test fixtures under `test/` mock `fleetApi` (`executePrompt`/`executeCommand`) rather than
talking to a real fleet, so the suite runs offline and deterministically. See
`test/apra-fleet-workflow*.test.mjs` for coverage of the primitives, schema repair, budget,
journal/replay, concurrency, and viewer lifecycle, and `examples/*.js` for runnable workflow
scripts exercised by `test/apra-fleet-workflow-examples.test.mjs`.

## Data Transformation and the `transform()` Primitive

Workflows often need to manipulate data between LLM inferences and command executions (e.g.
parsing JSON strings, extracting text, sanitizing variables).

`transform(label, func, context)` runs `func(context)` and emits its input/output as a
tracked activity, visible in the dashboard exactly like `agent()`/`command()` activities.

### Features
* **Telemetry**: durations, stringified inputs, and stringified outputs are logged like
  `agent()`/`command()` activities. Non-string inputs/outputs are `JSON.stringify`'d for
  display (best-effort; a value that can't be stringified is passed through as-is).
* **Failures**: errors thrown by `transform()`'s function are logged to telemetry and then
  rethrown as a generic `Error` -- they DO propagate and will crash/reject the enclosing
  workflow run unless the call site catches them. Inside a `sequential()`/`pipeline()`/
  `parallel()` item processor, a `transform()` failure is handled the same way any other
  error from that processor is: it aborts the whole call by default, or is recorded as
  `null` for that item when `{ continueOnError: true }` is passed (see "Error Handling"
  below).

### Example
```javascript
const planJson = await agent("Make a file", { member_name: 'apra-pm', schema: { /* ... */ } });

const cmdString = await transform('Extract command', (data) => {
    if (!data.commandToRun) throw new Error("Missing command");
    return data.commandToRun;
}, planJson);

await command(cmdString, { member_name: 'apra-pm' });
```

### `nullTransform()` and identity fallbacks
- If no transform function is provided (`transform(label, null, context)`), the primitive
  defaults to passing the input through unaltered.
- `nullTransform` is exposed alongside `transform` on the context as a ready-made way to
  explicitly break a data-dependency chain and drop output:
  ```javascript
  await transform('Cleanup', nullTransform, data); // returns null
  ```

## Error Handling (`continueOnError`)

By default, any error thrown within a `sequential()`, `pipeline()`, or `parallel()` block is
**fail-fast**: the first failing item aborts the call and the error is rethrown to the caller
(this is the default -- no opt-in flag is required to get fail-fast behavior). When
`sequential()`/`pipeline()` rethrow this way, the results collected for items processed
*before* the failure are attached to the error as `err.partialResults`:

```javascript
try {
    await sequential(items, async (item) => {
        await transform('Risky map', riskyFunc, item);
    });
} catch (err) {
    console.log('Completed before failure:', err.partialResults);
    throw err;
}
```

If you need partial success instead -- log-and-continue rather than abort -- pass
`{ continueOnError: true }`:

```javascript
await sequential(items, async (item) => {
    // If one item fails, the call logs the error, records `null` for
    // that item, and continues with the rest
    await transform('Risky map', riskyFunc, item);
}, { continueOnError: true });
```

`parallel()` follows the same `continueOnError` contract, but because it runs every item
concurrently via `Promise.all`, a fail-fast rejection does not carry `err.partialResults` --
some branches may still be in flight at the moment one throws.

## Multi-Stage Flows (`pipeline()`)

`sequential(items, processor, opts)` only accepts a single processor function -- passing more
than one throws a `TypeError`. For a genuine multi-stage flow where each stage's output feeds
the next stage's input, use `pipeline(items, ...stages, [opts])`:

```javascript
const results = await pipeline(
    issues,
    async (issueId) => {
        const plan = await agent(`Plan for ${issueId}`, { member_name: 'apra-pm' });
        return { issueId, plan };
    },
    async (context) => {
        const devResult = await agent(`Develop ${context.issueId}`, { member_name: 'apra-pm' });
        return { ...context, devResult };
    }
);
```

Each stage is applied in order to every item; the first stage receives the raw item, and each
subsequent stage receives the previous stage's return value for that item. A trailing
non-function argument is treated as `opts` (e.g. `pipeline(items, stage1, stage2,
{ continueOnError: true })`). `pipeline()` follows the same fail-fast / `continueOnError` /
`err.partialResults` semantics as `sequential()`.

## Structured Output (`schema`)

Pass `opts.schema` (a JSON Schema object) to `agent()` to get validated, parsed JSON back
instead of raw text:

```javascript
const result = await agent('Say hello and provide a short greeting.', {
    member_name: 'apra-pm',
    schema: {
        type: 'object',
        properties: {
            greeting: { type: 'string' },
            message: { type: 'string' }
        },
        required: ['greeting', 'message']
    }
});
// result is a parsed, schema-valid object -- not a string
```

The engine compiles the schema up front (a malformed schema throws before any dispatch),
appends it to the prompt as an instruction, and validates the reply against it. If the reply
doesn't parse or doesn't validate, the engine automatically re-asks the same member with a
self-contained repair prompt (the original request, the invalid output, and the validation
errors) up to `opts.schemaRetries` times (default `2`) before giving up and throwing a typed
`AgentOutputError`. See `docs/apra-fleet-workflow-architecture.md` section 4.3 for the full
extraction/repair algorithm.

## Typed Errors from `agent()` / `command()`

`agent()` and `command()` never return `null`. Every failure -- a missing member, an
unparseable/schema-invalid LLM output, an `isError` command result, a transport/JSON-RPC
failure, an exceeded budget, or a cooperative cancellation -- is raised as a typed error from
`src/workflow/errors.mjs`:

* `MemberNotFoundError` (`code: MEMBER_NOT_FOUND`)
* `AgentOutputError` (`code: AGENT_OUTPUT_INVALID`) -- empty content, or schema-repair
  exhaustion
* `CommandError` (`code: COMMAND_FAILED`) -- `isError: true` results
* `FleetTransportError` (`code: TRANSPORT_ERROR`) -- the underlying `fleetApi` call itself
  rejected; the original error is preserved on `.cause`
* `BudgetExceededError` (`code: BUDGET_EXCEEDED`) -- see "Budget" below
* `CancelledError` (`code: CANCELLED`) -- see "Cooperative cancellation" below

All six extend the base `WorkflowError`, which carries `.code` and `.details`. These classes
are exported from the package entry point (`@apralabs/apra-fleet-workflow`), so callers can
`instanceof`-match them:

```javascript
import { MemberNotFoundError } from '@apralabs/apra-fleet-workflow';

try {
    await agent('Say hello', { member_name: 'maybe-missing' });
} catch (err) {
    if (err instanceof MemberNotFoundError) {
        // handle missing member specifically
    }
    throw err;
}
```

The apra-fleet MCP server currently reports some of these conditions (e.g. a missing member)
via plain response text rather than a structured error -- see
`docs/structured-errors-proposal.md`. The classification above is a client-side stopgap; once
the server ships a structured error contract, the same error classes will be raised from that
path instead of a text sniff.

### `resume` default (`AgentOptions.resume`)

The underlying fleet client (`ExecutePromptOptions.resume` in `@apralabs/apra-fleet-client`)
defaults to resuming the previous session (`resume: true`) when the field is omitted. The
**workflow layer changes this default**: `agent()` always sends `resume` explicitly,
defaulting it to `false` unless the caller sets `AgentOptions.resume` to `true`. This means
workflow-authored prompts are self-contained by default and won't silently pick up state from
a prior session:

```javascript
// Resumes the member's previous session:
await agent('Continue where we left off', { member_name: 'fleet-dev', resume: true });

// Default: starts a fresh, self-contained session:
await agent('Say hello', { member_name: 'fleet-dev' });
```

## `command()`'s `failSoft` option

For probes and best-effort checks where a transient failure shouldn't kill the whole
workflow, pass `{ failSoft: true }`. Instead of throwing on a `CommandError`,
`MemberNotFoundError`, or `FleetTransportError`, `command()` resolves to
`{ ok: boolean, output: string, error: string|null }` (a success also resolves to that
shape, so you never have to branch on the return type):

```javascript
const res = await command('node -e "process.exit(require(\'fs\').existsSync(\'deploy.md\') ? 0 : 1)"', {
    member_name: 'apra-pm',
    failSoft: true
});
if (!res.ok) {
    log('deploy.md not found or probe failed; skipping deploy phase');
} else {
    // proceed
}
```

Note that cooperative cancellation (`requestStop()`) is never soft-caught: a `CancelledError`
always throws, even from a `failSoft: true` call, so a stop request still unwinds the run.

## Budget

`context.budget` (or `workflow.budget` for direct, non-`executeFile()` usage) tracks spend
for the current run:

```javascript
context.budget.total = 5.00;               // set a $5 ceiling for this run (default: unlimited)
console.log(context.budget.spent());        // cumulative debited cost so far
console.log(context.budget.remaining());     // total - spent, or Infinity if total is null
```

Before each `agent()` dispatch, if `budget.total` is set and `budget.remaining() <= 0`, the
call throws a typed `BudgetExceededError` instead of dispatching. Cost is only ever debited
when it can be honestly calculated: the fleet result must report real token usage, and the
model named in `opts.model` must match an entry in the pricing table
(`src/workflow/pricing.mjs`). Pass the model tier your fleet actually uses (e.g. `'haiku'`,
`'sonnet'`, `'opus'`, `'fable'`) as `opts.model` on `agent()` calls if you want spend to
accrue against the budget -- an unpriced or unreported dispatch never debits the budget and
can never trigger enforcement. The pricing table is a hand-maintained set of estimates, not a
live pricing feed; treat budget enforcement as approximate, not a billing-grade guarantee.

## Cooperative cancellation

`workflow.requestStop(reason)` (where `workflow` is your `FleetWorkflow` instance) aborts
every currently active run started via `executeFile()`/`runWithContext()`. Any in-flight or
future `agent()`/`command()` dispatch for that run rejects with a typed `CancelledError`
instead of running to completion, and `WorkflowEngine.executeFile()` records the run's
terminal status as `cancelled`. This is what the dashboard's Stop button calls; you can call
it yourself (e.g. from a signal handler) to stop a run programmatically:

```javascript
process.on('SIGINT', () => workflow.requestStop('Interrupted by SIGINT'));
```

This is local/client-side cancellation only -- a remote fleet member that already accepted a
job may keep running to completion even after your run unwinds as cancelled.

## Resuming a run

Opt a run into journaling to make it resumable after a crash:

```javascript
await engine.executeFile('./my-workflow.js', args, { journal: true });
```

This writes `.fleet-workflow/journal-<runId>.jsonl` as the run progresses. If the process
dies partway through, resume it from the same journal:

```javascript
await engine.executeFile('./my-workflow.js', args, {
    resumeJournal: '.fleet-workflow/journal-<runId>.jsonl'
});
```

Every `agent()`/`command()` call whose deterministic replay key (position in the script +
call type + member + a hash of the prompt/command text) matches a successfully-completed
entry in the journal is returned directly, without re-dispatching to the fleet. The first
call that doesn't match switches the rest of the run to live execution from that point
onward. This only works reliably if the script itself, and its `args`, are unchanged between
the original run and the resume -- see `docs/apra-fleet-workflow-architecture.md` section 5
for exactly what is and isn't guaranteed, especially around `parallel()` branches and
`command()`'s `failSoft` option.

## Vetting

Every `executeFile()` call runs an advisory lint (`VettingEngine`) over the script's source
and logs warnings for patterns worth a second look (imports of `fs`/`child_process`/etc.,
`process.env` access, `eval`/`new Function`). This never blocks execution by default --
workflow scripts are trusted code, and the lint is not a security boundary (see architecture
doc section 6). Pass `{ strictVetting: true }` if you want high-risk scripts
(`riskScore > 50`) rejected instead of just warned about.
