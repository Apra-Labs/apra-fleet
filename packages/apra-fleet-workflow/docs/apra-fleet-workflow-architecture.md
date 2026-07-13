# Apra Fleet Workflow Architecture

`@apralabs/apra-fleet-workflow` is a small workflow-scripting engine for orchestrating
dispatches to a fleet of AI-agent "members" (via `@apralabs/apra-fleet-client`). A workflow
is a plain ES module that exports an entry point; the module calls a handful of primitives
(`agent()`, `command()`, `sequential()`, `pipeline()`, `parallel()`, `transform()`, plus
telemetry helpers) to describe a multi-step, possibly concurrent, LLM-driven process. The
engine adds the operational concerns a raw script wouldn't have for free: schema-validated
structured output with bounded repair, typed errors, budget accounting, cooperative
cancellation, an append-only execution journal with resumable replay, and a live web
dashboard.

## 1. Module map

| File | Responsibility |
|---|---|
| `src/workflow/index.mjs` | `FleetWorkflow` -- the class that implements every workflow primitive (`agent`, `command`, `sequential`, `pipeline`, `parallel`, `transform`, `phase`, `log`, `group`, `publishState`, `requestStop`) and per-run execution context. |
| `src/workflow/engine.mjs` | `WorkflowEngine` -- loads a workflow script as a real ES module and runs its entry point, wiring up vetting and the journal. |
| `src/workflow/journal.mjs` | Append-only JSONL execution journal, replay-key computation, and journal loading for resume. |
| `src/workflow/errors.mjs` | Typed error hierarchy (`WorkflowError` and its subclasses) raised by `agent()`/`command()`. |
| `src/workflow/pricing.mjs` | A small, hand-maintained per-model token-price table and `calculateCost()`. |
| `src/workflow/vetting.mjs` | `VettingEngine` -- an advisory (non-blocking by default) heuristic scan of a script's source for review purposes. |
| `src/viewer/index.mjs` | `createDashboardViewer()` -- an HTTP server + Server-Sent-Events dashboard that visualizes a running `FleetWorkflow` in real time. |
| `src/viewer/html-utils.mjs` | `escapeHtml()` -- the single shared HTML-escaping implementation used by both the core viewer and any dashboard extension. |

The package's `exports` map (see `package.json`) exposes four import paths:

```javascript
import { FleetWorkflow, WorkflowError, MemberNotFoundError, AgentOutputError,
         CommandError, FleetTransportError, BudgetExceededError, CancelledError }
  from '@apralabs/apra-fleet-workflow';
import { WorkflowEngine } from '@apralabs/apra-fleet-workflow/engine';
import { createDashboardViewer } from '@apralabs/apra-fleet-workflow/viewer';
import { escapeHtml } from '@apralabs/apra-fleet-workflow/viewer/html-utils';
```

`FleetWorkflow` and `WorkflowEngine` are separate classes with a clear division of labor:
`FleetWorkflow` is the runtime that implements the primitives and holds per-run state;
`WorkflowEngine` is the loader that turns a script file into a call to
`FleetWorkflow.runWithContext()`. A typical caller wires them together as:

```javascript
const workflow = new FleetWorkflow(fleetApi);
const engine = new WorkflowEngine(workflow);
const server = createDashboardViewer(workflow, { port: 8080, name: 'My Workflow' });
await engine.executeFile('./my-workflow.js', { targetIssue: 'X-1' });
```

## 2. Core primitives

`FleetWorkflow` exposes the following primitives, bound to a `context` object (see
`workflow-guide.md` for the authoring contract):

- `agent(prompt, opts)`: dispatches a prompt to a fleet member via
  `fleetApi.executePrompt()`. Supports `opts.schema` for validated structured output
  (section 4.3), `opts.model`/`opts.agentType`/`opts.member_name`/`opts.member_id` for
  routing, `opts.resume` for session continuity, and `opts.signal`/`opts.timeoutMs` for
  cancellation/timeout pass-through to the client.
- `command(cmd, opts)`: dispatches a shell command to a fleet member via
  `fleetApi.executeCommand()`. Supports `opts.failSoft` (section 4.2) and the same
  routing/cancellation options as `agent()`.
- `sequential(items, processor, opts)`: applies a single `processor(item, index, items)`
  function to each item in order. It accepts exactly one processor function; passing more
  positional arguments (the historical `sequential(items, ...stages)` form) throws a
  `TypeError` naming `pipeline()` as the replacement.
- `pipeline(items, ...stages, [opts])`: the multi-stage primitive. Each stage function is
  applied in order to every item; a stage receives the previous stage's result for that item
  (the first stage receives the raw item) and returns the input for the next stage. An
  optional trailing plain-object argument is treated as `opts` (e.g.
  `{ continueOnError: true }`); at least one stage function is required.
- `parallel(items, processor, opts)`: runs `processor(item, index, items)` for every item
  concurrently via `Promise.all`, acting as a synchronization barrier.
- `transform(label, func, context)`: runs a synchronous or async mapping function and emits
  it to the dashboard as its own activity, with the input/output stringified for display.
  `nullTransform` (exposed alongside `transform` on the context) is a ready-made identity
  breaker: `await transform('Cleanup', nullTransform, data)` always returns `null`.
- `phase(title)`: sets the current phase label, used to group subsequent activities in
  telemetry and the dashboard tree.
- `log(message)`: emits a `log` event and prints to the console.
- `group(title)` / `endGroup()`: opens/closes a top-level grouping in the dashboard tree
  (coarser than `phase()`).
- `publishState(namespace, data)`: emits a `state` event carrying an arbitrary payload under
  a namespace; the dashboard forwards this to any registered viewer extension as a
  `workflow:state:<namespace>` browser `CustomEvent` (see section 6).

## 3. Execution model: per-run isolation

Before a workflow ran, `FleetWorkflow` kept "current run" state (`args`, `currentPhase`,
`currentGroup`, `budget`) as plain mutable instance fields. That breaks as soon as two
`executeFile()` calls run concurrently on the same `FleetWorkflow` instance, or a single
run's `parallel()` branches each call `phase()` with a different value -- both would stomp
on shared state.

`FleetWorkflow` instead keeps this state in a small per-run store threaded automatically
through the async call graph via Node's `AsyncLocalStorage` (`runStorage` in
`index.mjs`):

- `WorkflowEngine.executeFile()` creates a fresh store (`{ runId, args, phase, group,
  budget, signal, ... }`) via `FleetWorkflow.runWithContext()` and runs the entry point
  inside `runStorage.run(store, ...)`. Every primitive called anywhere in that script --
  including across `await` boundaries -- sees this run's store automatically, with no
  explicit threading required in workflow-script code.
- `parallel()` forks a *shallow copy* of the current store for each branch before invoking
  its processor. `phase`/`group` are copied by value, so a `phase()` call inside one branch
  mutates only that branch's copy and can never leak into a sibling branch or the parent.
  `args`/`budget`/`runId` are copied by reference, so budget spend is aggregated for the
  whole run and `args` stays consistent across branches.
- Every activity/log/state event carries the originating run's `runId`, so even though the
  `EventEmitter` on `FleetWorkflow` is shared (a dashboard viewer subscribes to it once,
  globally), events from concurrent runs stay distinguishable.
- Direct, non-`executeFile()` usage (calling `wf.agent()`/`wf.phase()` straight off a
  `FleetWorkflow` instance, as some unit tests do) still works: when there is no active
  store, every primitive falls back to the legacy instance-level fields (`this.args`,
  `this.currentPhase`, `this.budget`), so `new FleetWorkflow(fleetApi).createContext()` /
  direct method calls behave as a single implicit "run."

Activity ids are generated with `crypto.randomUUID()`, not a weak random string, so
concurrent runs cannot collide on activity identity.

## 4. Reliability guarantees

### 4.1 Fail-fast by default, opt-in resilience

`sequential()`, `pipeline()`, and `parallel()` are **fail-fast by default**: the first item
(or stage) that throws aborts the whole call and rethrows that error. Pass
`{ continueOnError: true }` as `opts` to any of the three to change this -- a failing item is
logged and recorded as `null` in the results array, and the call continues with the
remaining items instead of aborting.

When the default fail-fast path rethrows, the results collected for items processed
*before* the failure are attached to the thrown error as `err.partialResults`, so callers
can recover whatever progress was made before deciding how to handle the failure. This
applies to `sequential()` and `pipeline()`; `parallel()`'s fail-fast path rejects the
underlying `Promise.all` and does not attach partial results (some branches may still be
in flight at the moment one throws).

### 4.2 `command()`'s `failSoft` option

`command(cmd, { failSoft: true, ... })` never throws for a command-level failure
(`CommandError`, `MemberNotFoundError`, or `FleetTransportError`). Instead it resolves to
`{ ok: boolean, output: string, error: string|null }` -- a success also resolves to that
shape (`{ ok: true, output: <text>, error: null }`) instead of the bare string, so callers
don't have to branch on the return type. This exists for best-effort probes (e.g. "does this
file exist on the member") where a transient or portability failure should be treated as "not
found" rather than aborting the whole run. `CancelledError` (cooperative `requestStop()`
cancellation) is never soft-caught -- it always throws regardless of `failSoft`, so a stop
request still unwinds a `failSoft` caller's run.

### 4.3 Structured output: schema-directed extraction with bounded repair

When `opts.schema` is provided to `agent()`:

1. The engine compiles the JSON Schema with `ajv` (draft-07-style, `strict: false`) before
   dispatching. A malformed schema throws immediately, before any fleet call is made.
2. The schema is appended to the prompt as instruction text (`"Only provide your response
   strictly as per this JSON schema:\n<JSON>"`); the workflow layer does not enforce
   structure at the transport/tool-call level, only by asking and then validating.
3. On reply, `extractStructuredOutput()` looks for a JSON candidate in the text:
   - It first tries every fenced ` ```json ` (or bare ` ``` `) code block, in order,
     parsing and schema-validating each.
   - If none of the fenced candidates parse and validate (including the case where there
     are no fenced blocks at all), it falls through to a real bracket-matching scan of the
     remaining text (with fenced spans blanked out) -- tracking JSON string state so braces
     inside string literals don't confuse the matcher -- and tries every balanced top-level
     `{...}`/`[...]` span it finds, in order.
   - As a last resort, if neither pass found any bracketed candidate at all, it tries
     `JSON.parse()` on the trimmed whole text.
   - The first candidate that both parses and validates against the compiled schema wins.
4. If no candidate parses and validates, the engine does **not** hard-fail on the first bad
   reply. It re-dispatches to the *same* member with a self-contained repair prompt (the
   original prompt/schema, the member's own invalid output, and the `ajv` validation errors)
   and tries again. This repeats up to `opts.schemaRetries` times (default `2`, so up to 3
   total dispatches: 1 original + 2 repairs). Each attempt is its own tracked activity and is
   cost-accounted individually. The repair prompt is self-contained by design -- it does not
   rely on `resume: true` -- so it stands alone even against a fresh, non-resumed session.
5. If every attempt is exhausted, `agent()` throws a typed `AgentOutputError` (section 4.4)
   whose message distinguishes "never produced parseable JSON" from "produced JSON that
   failed schema validation," and whose `.details.validationErrors` carries the last set of
   `ajv` errors.

This is a client-side mitigation, not enforcement at the member's tool-call layer; the
member can still emit non-conforming text, and the bounded repair loop exists specifically
to make that recoverable rather than fatal.

### 4.4 Typed errors from `agent()` / `command()`

`agent()` and `command()` never return `null` on failure. Every failure path raises a typed
error from `src/workflow/errors.mjs`, all extending `WorkflowError` (which carries `.code`
and `.details`, and preserves the original failure on `.cause` where applicable):

- `MemberNotFoundError` (`code: MEMBER_NOT_FOUND`) -- the target member does not exist.
  Detected today via a string-sniff on the response text
  (`text.startsWith('Member "') && text.includes('" not found.')`), because the apra-fleet
  MCP server currently reports this condition as ordinary response text rather than a
  structured error; see `docs/structured-errors-proposal.md` for the server-side fix this is
  a stopgap for.
- `AgentOutputError` (`code: AGENT_OUTPUT_INVALID`) -- empty content from the fleet, or
  (when a schema was requested) exhaustion of the repair loop above.
- `CommandError` (`code: COMMAND_FAILED`) -- an `isError: true` result from `command()`.
- `FleetTransportError` (`code: TRANSPORT_ERROR`) -- the underlying `fleetApi` call itself
  rejected (network/MCP transport failure); the original error is on `.cause`.
- `BudgetExceededError` (`code: BUDGET_EXCEEDED`) -- see section 4.5.
- `CancelledError` (`code: CANCELLED`) -- see section 4.6.

All six classes are exported from the package's top-level entry point, so callers can
`instanceof`-match them.

### 4.5 Budget accounting

Every `FleetWorkflow` run has a `budget` object (`context.budget`) with `total` (settable by
the caller; `null` means unlimited), `spent()`, and `remaining()`. Before each `agent()`
dispatch, if `budget.total !== null` and `budget.remaining() <= 0`, the engine throws a
typed `BudgetExceededError` before making the fleet call. After a dispatch, `budget._spent`
is incremented by the dispatch's calculated cost -- but only when a cost could actually be
calculated:

- Cost is `null` (never fabricated) whenever the fleet result did not report real token
  usage (`result.usage.total_tokens` is not a number), or when `calculateCost()`
  (`src/workflow/pricing.mjs`) has no pricing-table entry matching `opts.model`.
- `pricing.mjs` ships a small, explicitly-labeled-as-estimates table (standard third-party
  model ids, plus the fleet's own tier names `haiku`/`sonnet`/`opus`/`fable`) and returns
  `null` for anything unmatched rather than silently defaulting to a price. Practically,
  budget enforcement only functions for dispatches whose `opts.model` matches one of these
  table entries *and* whose fleet result reports usage; an uncosted dispatch never debits
  the budget and can never trigger `BudgetExceededError`.
- The dashboard viewer mirrors this honesty: it tallies `totalCost`/`totalTokens` only from
  activities with a known cost, and separately counts activities whose cost is unknown
  (`unknownCostCount`, rendered as "(+N unknown)" next to the spend figure) instead of
  folding them into the total as zero.

**Budget on replay is total-spend, by design.** A replayed `agent()` activity (see section
5) re-debits the run's budget using the journaled cost of the original dispatch, so
`budget.spent()` on a resumed run reflects the cumulative cost of the whole logical run
(original + resumed portions), not just what the resumed process dispatched live. This is
deliberate: a resume is a continuation of one run, so its budget ceiling must still account
for money already spent before the crash -- otherwise a run that crashed near its limit
could resume and overspend.

### 4.6 Cooperative cancellation

`FleetWorkflow.requestStop(reason)` aborts every currently active run's `AbortController`.
Each `runWithContext()` run gets its own controller; `agent()`/`command()` default to that
run's `signal` (via the internal `_currentSignal()`) unless the caller passes its own
`opts.signal`, and pass it through to the underlying `fleetApi` call. When a dispatch is
rejected because of that abort, `agent()`/`command()` recognize the client-side `AbortError`
(`.code === 'ABORTED'`) and re-wrap it as a typed `CancelledError` rather than a generic
`FleetTransportError`, so callers/tests can distinguish "the user asked to stop" from "the
network broke." `WorkflowEngine.executeFile()` treats a `CancelledError` specially, marking
the run's terminal status `cancelled` instead of `failed`.

This is client-side/local cancellation only: a remote fleet member that already accepted a
job may keep running to completion even after the workflow run itself unwinds as cancelled.
True server-side cancellation would require changes to the external apra-fleet MCP server
and is out of scope for this package.

## 5. Resumable runs: the execution journal and replay keys

`WorkflowEngine.executeFile(script, args, { journal | resumeJournal })` opts a run into an
append-only JSONL **journal** of its `activity:start`/`activity:end`/`run:end` events (see
`journal.mjs`). This is **off by default**: a run with neither option produces zero journal
I/O and byte-for-byte identical event shapes to a run without journaling at all.

- `journal: true` writes to the default path `.fleet-workflow/journal-<runId>.jsonl`;
  `journal: '<path>'` or `journal: { path: '<path>' }` writes to an explicit path.
- On **resume** (`resumeJournal: '<path>'`), each `agent()`/`command()` call computes a
  deterministic **replay key** (`computeActivityKey`) from four parts: the call's sequence
  position in the run, its type (`agent`/`command`), the target member, and a hash of the
  dispatched prompt/command text (`agent()` hashes the fully-resolved prompt including any
  appended schema instruction; `command()` hashes the substituted command text, which is
  also stored verbatim in the activity event itself). A matching COMPLETED (successful)
  journal record is returned directly WITHOUT re-dispatching to the fleet -- the activity
  still emits `activity:start`/`activity:end` (marked `replayed: true`) so a listening
  journal writer or dashboard sees it as part of the run. The first mismatch or missing key
  stops replay and switches to live execution from that point onward (Claude-CLI-style
  partial replay, not all-or-nothing).
- Unless `journal` is also given, a resumed run continues writing to the SAME file it
  resumed from.
- Activities that were started but never recorded as finished in the journal being resumed
  from (most likely because the prior run crashed mid-dispatch) are surfaced -- never
  auto-resolved -- via a `journal:ambiguous` event and a console warning, since true
  dispatch idempotency would require fleet-server-side keys (out of scope here).

### Order-independent keys across `parallel()` branches

The `sequence` component of a replay key is what makes replay stable, and its shape depends
on where the call is made:

- A call in the run's top-level (sequential) flow gets a plain numeric sequence
  `0, 1, 2, ...` in program order (the original, backward-compatible shape).
- A call INSIDE a `parallel()` branch gets a hierarchical, scheduler-INDEPENDENT sequence
  `<barrierIndex>:<branchIndex>:<localSeq>` (nested parallels extend the prefix further).
  `branchIndex` is the branch's STATIC index in the array passed to `parallel()`,
  `barrierIndex` numbers the parallel barrier in program order (assigned synchronously
  before any branch runs), and `localSeq` counts only within that one branch.

Because the key for a given logical call site is identical regardless of how branches
interleave at runtime, a journal recorded under one interleaving replays with full cache
hits under any other interleaving.

### Guaranteed vs. not guaranteed

Determinism still requires the SAME logical script structure on replay: same top-level call
order, same number and static ordering of `parallel()` branches, same per-branch call order,
and same prompt/command text. Editing the script (adding/removing/reordering calls or
branches, changing prompts) or a branch that is internally non-deterministic (dispatches a
different number/order of calls across runs) legitimately diverges -- that is real
divergence, not a scheduling artifact.

The `journal:diverged` event/warning carries an `inParallel` flag distinguishing a
parallel-region divergence (usually a pre-N6-format journal or a non-deterministic branch)
from a top-level/sequential mismatch (usually an edited script). Old-format journals (from
before order-independent parallel keys existed) degrade gracefully rather than crashing:
their parallel-region records used a shared global counter, so those calls diverge and
re-run live (as they effectively did before this feature existed anyway), while top-level
calls still replay; regenerate the journal from a fresh run to restore full parallel replay.

### `command()`'s `failSoft` shape on replay

A replayed `command()` activity reconstructs the return shape (`{ ok, output, error }` vs. a
bare string) the *current* call expects, using a `failSoft` flag persisted in the journaled
activity record. Old-format journal lines written before this field existed don't have it;
the replay path then falls back to returning the raw string, which a `failSoft: true` caller
resuming from such a journal will interpret with `res.ok === undefined`. Regenerating the
journal from a fresh (non-resumed) run restores exact fidelity.

## 6. Trust model: workflow scripts are trusted code

Workflow scripts are **trusted code**, loaded and executed the same way any other Node.js ES
module is: `WorkflowEngine.executeFile()` resolves the script path and runs
`import(pathToFileURL(fullPath))` on it, then calls the module's exported `main(context)`
(or `run(context)`/`default(context)`) entry point. There is no sandbox, no restricted
global scope, and no interception of Node.js APIs. A workflow script has full access to
`globalThis`, `process` (including `process.env`), the filesystem, the network (`fetch`),
`child_process`, and dynamic `import()` -- exactly like any other module you `import` into a
Node.js program.

**Only run workflow scripts you trust**, the same way you'd only `npm install` or `import`
packages you trust. Do not execute unreviewed workflow scripts pulled from untrusted
sources.

### The vetting engine is advisory, not a security boundary

`VettingEngine` (`vetting.mjs`) runs a `BasicSecurityAnalyzer` heuristic (plain regex
matching, no AST parsing) over the script source before it loads, and logs warnings for
patterns that are often worth a second look: imports of Node.js system modules (`fs`,
`child_process`, `crypto`, `os`, `net`, `http`), `process.env` access, or dynamic code
evaluation (`eval`, `new Function`). These warnings are printed to the console for every run,
but **`WorkflowEngine.executeFile()` never blocks execution based on them by default** --
vetting cannot meaningfully sandbox arbitrary JavaScript (it's trivially bypassed by
indirection, string concatenation, etc.), so treating it as an enforcement mechanism would be
misleading.

If you want vetting to block high-risk scripts (`riskScore > 50`) instead of just warning,
opt in explicitly:

```javascript
await engine.executeFile(scriptPath, args, { strictVetting: true });
```

This is an opt-in lint gate for teams that want a speed bump before running scripts from
less-trusted sources, not a substitute for actually trusting the code you run.

This vetting infrastructure is extensible: register additional `WorkflowAnalyzer` instances
via `VettingEngine.registerAnalyzer()` (`engine.vetting.registerAnalyzer(...)`) to add
project-specific lint rules.

## 7. Dashboard viewer

`createDashboardViewer(workflow, opts)` (`src/viewer/index.mjs`) starts a plain Node
`http.Server` (default port `8080`, override with `opts.port`) that serves a single-page
dashboard and subscribes to the given `FleetWorkflow` instance's events:

- `GET /` serves the dashboard HTML/CSS/JS (a self-contained page with no external
  dependencies).
- `GET /events` is a Server-Sent-Events stream the page uses to know when to re-poll.
- `GET /state` returns the current accumulated state as JSON (activity tree, stats,
  extension data) -- the page polls this on every `/events` message to render.
- `POST /stop` triggers cooperative cancellation: it calls `workflow.requestStop()` (section
  4.6) rather than killing the process. The run unwinds normally through its own error
  handling, and `WorkflowEngine.executeFile()`'s `finally` block emits the `end` event with
  status `cancelled`, which is what actually transitions the dashboard's status indicator
  and closes the server (after a grace period) -- there is no `process.exit()` anywhere in
  this path.

The dashboard's activity tree renders `group` > `phase` > `activity`/`log` events, tracking
running/success/error status per activity, token/cost totals, and an "(+N unknown)" suffix
for activities whose cost couldn't be priced. State/status tracking (`currentGroup`,
`currentPhase`, the whole `state` object) is scoped to a single viewer instance and is not
run-aware: this is fine because a viewer is normally attached to one `WorkflowEngine`
loop at a time, but it means a viewer instance watching a `FleetWorkflow` that runs two
concurrent workflows (section 3) will interleave both runs' events into one tree rather than
showing them as separate runs.

### Extensions

`opts.dashboardExtensions` is an array of `{ id, title, js }` objects; each gets its own tab
in the dashboard, rendered by injecting `js` as an inline `<script>` on the page and a
`<div id="extension-<id>">` container to render into. Extensions receive domain-specific data
pushed from the workflow script via `context.publishState(namespace, data)` (section 2),
which the browser side re-dispatches as a `workflow:state:<namespace>` `CustomEvent` that an
extension's script can listen for.

Because extension code and the core template both run as plain inline `<script>` tags (not
ES modules) in the browser, they cannot `import` shared helpers at runtime. The one place
this matters for safety is HTML escaping: `src/viewer/html-utils.mjs` exports a single
`escapeHtml()` implementation, and both the core template and any extension embed its
*source text* directly (`escapeHtml.toString()`) into the page they generate, so there is
exactly one escaping implementation to get right rather than a hand-copied one per
extension. Any extension that writes LLM- or user-authored text (activity output, external
record titles/descriptions, etc.) into `innerHTML` must route it through this shared
`escapeHtml()` the same way the core template does.
