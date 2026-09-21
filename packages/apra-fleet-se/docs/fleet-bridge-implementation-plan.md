# fleet-bridge: implementation plan (Phases 1-3, Azure DevOps)

## Context

Today a fleet-sprint is launched by a human calling the supervisor. We want a user
sitting in Azure DevOps to select work items, trigger a pipeline, and get a sprint
that develops on a target branch, raises a PR, pushes its carry-over back as new
backlog items, and can be watched from where they already work.

The design is settled and written up at
`packages/apra-fleet-se/docs/fleet-bridge-design.md`
(branch `worktree-fleet-bridge-plan`, 5 commits). This plan turns that into code.

Two things shape everything below:

1. **The pipeline job must not hold a runner slot for two days** - but it should hold
   long enough to report something meaningful. The job waits for a **configurable
   milestone** (default: one completed planning round, typically 10-20 min), then
   detaches; the sprint continues as the detached child it already is. The slot
   argument is about *bounded minutes vs unbounded days*, not about exiting as fast
   as possible.
2. **The plan-reviewer verdict is currently unreachable over HTTP.** It is a local
   var in `plan.mjs`, deliberately unlogged, never published. Without it, a pipeline
   can only report "we launched something". This is the one genuine engine gap, and
   closing it is the first task.

Decisions taken: add `publishState('plan', ...)`; build Phases 1-3 (the full loop);
package is plain `.mjs` + `node --test`, matching `apra-fleet-client`; end-to-end
verification runs against our own Azure DevOps toy project.

A third constraint runs through the whole design (Part C): **no deployment-specific
assumptions anywhere.** No organisation, subscription, storage account or container
is baked into the bridge or its templates - all are pipeline parameters, secrets live
in Azure DevOps variable groups and reach the runner without ever being read, logged
or persisted by the bridge.

---

## Part A - changes to existing apra-fleet code

Five files. ~50 added lines. Everything else is a new package.

### A1. Publish the plan verdict (REQUIRED - unblocks `--await-plan`)

`packages/apra-fleet-se/fleet-sprint/phases/plan.mjs`

- Add `publishState` to the destructured params (currently absent; the list ends
  `...stageCommandBodyMemberSide, updateDashboard`). Guard every use with
  `typeof publishState === 'function'` so the phase never hard-depends on a wired
  viewer - unit harnesses construct it directly.
- Add a local `publishPlanState(status, {verdict, deferredIds})` helper, wrapped in
  try/catch: this is telemetry and must never fail a sprint that planned correctly.
- Call it twice:
  - in the round loop, right after the existing
    `if (verdict.verdict === 'APPROVED')` branch (currently followed by
    `await updateDashboard()`), with `'approved'` or `'iterating'`;
  - immediately before the final
    `return { planCapDeferredIds, lastVerdict, planningRounds, pendingRejectedNewTasks }`,
    with `'approved'` or `'deferred'`. `publishState` is last-write-wins per
    namespace, so this terminal write is authoritative.

Payload (`state.extensions.plan`):

| field | type | notes |
|---|---|---|
| `cycle`, `planningRounds` | number | |
| `status` | `'iterating'\|'approved'\|'deferred'` | the three-way discriminator |
| `verdict` | `'APPROVED'\|'CHANGES_NEEDED'\|null` | raw enum |
| `approved` | boolean | **true only on a clean APPROVED** |
| `deferredIds` | string[] | plan-cap-deferred bead ids |
| `findings` | `{id,kind,detail}[]` | from the verdict's structured `findings` |
| `notesSummary` | string\|null | |
| `updatedAt` | ISO string | |

Reaching the final return with `planApproved === false` means the plan-cap deferral
path ran (the whole-plan-contested and dispatch-failed branches both throw), so
`deferred` is never conflated with approval. **This is the case a phase-title
heuristic gets wrong, and the reason this change exists.**

**Payload must survive leaning.** `lean-state.mjs` leans `state.extensions`, not just
`state.tree`: it collapses any object carrying `error`/`output`/`input`/`description`/
`transcript`/`stdout`/`stderr` into a 200-char `summary`, and caps every other string
at 400. So the payload uses none of those key names and caps its own strings at 300.

`packages/apra-fleet-se/fleet-sprint/runner.js` (~line 2298) - add `publishState` to
the `runPlanPhase({...})` call. It is already in scope (destructured at line 786).
`grep runPlanPhase` returns only these two sites, so the blast radius is exact.

**Skip `replan.mjs` for now.** It is an in-cycle amendment loop, not the gate that
decides whether Develop proceeds. If needed later it gets its own `'replan'`
namespace - never a write into `'plan'`.

### A2. Export the proxy helpers (REQUIRED for the LAN viewer)

`packages/apra-fleet-se/src/supervisor/proxy.mjs` - add `export` to `proxyStream`,
`proxyHtml`, `upstreamRequestHeaders`, `downstreamResponseHeaders` (and `sendPlain`,
`HOP_BY_HOP`). All are plain hoisted declarations with intra-module callers only, so
this cannot break an existing import. `rewriteChildHtml` and `livePrefixFor` are
already exported.

**Plus one real behaviour change:** `proxyStream`/`proxyHtml` build upstream headers
internally and take no override, so the bridge cannot inject
`Authorization: Bearer`. Add an optional `extraHeaders` argument merged into
`upstreamRequestHeaders(req)`. Two lines, and strictly safer than the bridge
re-deriving the streaming/premature-close edge cases.

### A3-A5. Wiring

- Root `package.json`: add `"packages/apra-fleet-bridge"` to `workspaces`.
- `package-lock.json`: regenerate via `npm install` at root - never hand-edit. CI's
  `npm ci` fails otherwise.
- `scripts/run-all-tests.mjs`: append a third entry to the `suites` array so the
  bridge's `node --test` suite runs in local `npm test`. (CI's
  `npm test --workspaces --if-present` would catch it anyway, but local parity
  matters more.)

Not needed: `files` allowlist (bridge is monorepo-internal, not shipped in the root
tarball), `lean-state.mjs`, `vitest.config.ts`, `guarded-modules.mjs`.
`check-generic-boundary.mjs` does not apply - it scans only `fleet-sprint/**` and
`apra-pm/agents/**`.

### Tests to add in apra-fleet

New `packages/apra-fleet-se/test/plan-state-publication.test.mjs`, following the
`publishedStates.find(e => e.namespace === ...)` pattern already used in
`test/runner-arg-contract.test.mjs`:

1. clean APPROVED -> `status:'approved'`, `approved:true`, `deferredIds:[]`
2. plan-cap deferral -> `status:'deferred'`, `approved:false`, ids populated
   (reuse `test/contested-bead-findings.test.mjs`'s fixture)
3. hard rejection -> no terminal write claims `approved:true`
4. `runPlanPhase` with `publishState` omitted does not throw
5. **lean round-trip**: feed `{extensions:{plan:payload}}` through
   `buildListStatePayload` + `resolveStringRefs` and assert every field survives
   byte-identical. Without this, someone adding a `description` field later silently
   destroys the payload.

Verified not to break: `phase-sequence-order`, `golden-transcript`,
`dispatch-pin-module-offsets` (all key on phase/dispatch events, not `publishState`).

---

## Part B - the new package

`packages/apra-fleet-bridge` - plain `.mjs`, `private: true`, no build step, tests in
`test/*.test.mjs` via `node --test`. Every verb is `run<Verb>(opts, deps)`; only
`bin/fleet-bridge.mjs` constructs real deps or calls `process.exit`.

```
bin/fleet-bridge.mjs        verb dispatch, exit-code mapping
src/contracts.mjs           SprintRequest / SprintHandle / ProgressSnapshot / CarryOverItem + validators
src/errors.mjs              typed BridgeError codes + exitCodeFor()
src/supervisor-client.mjs   bearer-aware HTTP client (PR #493 forward-compat)
src/beads-client.mjs        typed wrapper over exec-bd + assertNoBareSync
src/await-gate.mjs          awaitMilestone() - the configurable --await-until gate
src/carry-over.mjs          selectCarryOver() - pure, no I/O
src/snapshot.mjs            sprint state -> ProgressSnapshot
src/spool.mjs               handle spool (ledger.mjs atomic pattern)
src/viewer-proxy.mjs        0.0.0.0 -> 127.0.0.1:8787, bearer injection
src/verbs/*.mjs             preflight ingest launch watch finalize status daemon viewer
src/adapters/               index.mjs (registry) + azure-devops / github / bitbucket
src/adapters/lib/native-beads-sync.mjs   shared impl parameterised by 'ado' | 'github'
src/sinks/                  index.mjs (fan-out) + jsonl-file + append-blob + append-blob-http
templates/azure-pipelines.yml (+ github, bitbucket)
examples/azure-devops-toy/    concrete working instantiation + adaptation README
```

### The Azure Pipelines sample: built against the toy project, shipped adaptable

Two files, deliberately separated, because "concrete enough to actually run" and
"generic enough to adopt" pull in opposite directions:

- **`templates/azure-pipelines.yml`** - self-contained and fully parameterised, with
  no organisation, project, pool, storage account or variable-group name in it. A
  single clearly delimited `parameters:` block at the top is the only region an
  adopter edits; everything below it is logic. It carries the secret handling from
  Part C inline - notably the explicit `env:` mapping, with a comment saying why
  (secret variables are not auto-exposed, and omitting it yields an empty string
  rather than an error).
- **`examples/azure-devops-toy/azure-pipelines.yml`** - the concrete instantiation we
  actually run against our own toy project, with its real parameter values and
  variable-group name. This is the copy-paste starting point, and it is what
  verification step 3 executes - so **the sample is proven by the end-to-end run
  rather than written blind**, which is the whole point of developing it against the
  toy project.

The example uses AzDO's `extends` against the template, so adopting it is "copy ~15
lines, change the values" rather than "diff a 200-line file". Document the
self-contained-copy variant too, for orgs that would rather not add a
`resources: repositories:` entry to reference a template across repos.

`examples/azure-devops-toy/README.md` is an adaptation checklist: every value to
change, every variable group and service connection to create, the pipeline
permissions to grant (OAuth token access, pool access), and how to verify with
`fleet-bridge preflight` before the first real trigger.

Both `.yml` files must be pure ASCII - the repo's pre-commit hook enforces this on
staged `.yml`/`.yaml`/`.sh`/`.md`, so a stray smart quote blocks the commit.

### Reuse, not reimplementation

| Need | Use |
|---|---|
| `bd` invocation | `apra-fleet-se/src/supervisor/lib/exec-bd.mjs` - `execBdSync`, `execBdAsync`, `BD_MAX_BUFFER_BYTES` (64 MiB; Node's 1 MiB default truncates `bd list --json`) |
| HTTP routing | `apra-fleet-se/src/supervisor/server.mjs` - `createSupervisor`, `readJsonBody`, `sendJson` |
| Proxy forwarding | `apra-fleet-se/src/supervisor/proxy.mjs` (after A2) |
| Credential store | `apra-fleet-client` - `ApraFleet`, `parseToolJson` |
| Supervisor HTTP shape | mirror `fleet-sprint/coordination.mjs:49-112` - injectable fetch, shared `postJson`, throw-on-primary / swallow-on-cleanup |
| Atomic spool writes | `apra-fleet-se/src/supervisor/ledger.mjs` + `rename-with-retry.mjs` |
| JSONL append | `apra-fleet-se/src/supervisor/self-log.mjs` append-stream pattern |
| Un-leaning state | `resolveStringRefs` from `@apralabs/apra-fleet-workflow/viewer/lean-state` |

### Decisions that changed during design review

- **`execBdSync` vs `execBdAsync` is a hard rule.** `execBdAsync` validates args
  against `/^[A-Za-z0-9_.\-]+$/`, so anything carrying free text (work-item titles,
  bodies) must use `execBdSync`. Encode this in `beads-client.mjs`, not in callers.
- **`assertNoBareSync` in code, not review.** `bd ado sync` is bidirectional and
  would push the whole local beads DB into the customer's backlog. The beads client
  throws if `args[1] === 'sync'`, with a source-scan test backing it.
- **The bridge must un-lean state.** `dedupeStrings` replaces any string >=24 chars
  appearing twice with `{$ref:n}`. `notesSummary` and an identical `finding.detail`
  will collide in practice, so `resolveStringRefs` is mandatory, not defensive.
- **Carry-over rule 3 narrowed to `created-after` only.** The design doc wrote three
  OR'd heuristics but showed a query implementing one. Narrowing is the honest fix;
  the other two disjuncts would need a second `bd list` over the scope subtree for
  marginal gain.
- **`--max-carry-over` breach no longer publishes nothing.** After a two-day sprint
  that would strand everything in the local beads DB where nobody looks. Publish the
  top-N by priority plus one work item saying N more were suppressed.
- **Synthetic root id goes in the `SprintHandle`.** `finalize` must exclude it from
  carry-over, so `ingest` has to persist it - a data-flow requirement, not an open
  question.
- **The wait milestone is configurable per pipeline, not hardcoded.** See
  "`--await-until`" below. `await-gate.mjs` also exposes `readPlanState(state)` with a
  documented fallback to scraping `GET /sprints/:id/log?tail=N`, so the gate degrades
  rather than hard-blocking if A1 lands late or changes shape.
- **`mode: 'attached'` is rejected with a clear message for now.** It doubles the CLI
  mode matrix, is impossible on Bitbucket, and nothing in Phases 1-3 needs it. The
  field stays in `SprintRequest` so the contract is future-proof.
- **Blob-sink single-writer is enforced, not asserted.** `watch` refuses to enable the
  append-blob sink when a live spool claim exists, so a stray terminal `watch` cannot
  corrupt the daemon's `appendpos` sequence.

### `--await-until`: the configurable hold

Different pipelines want different confidence before releasing the slot, so the
milestone is a parameter, not a constant. `await-gate.mjs` exposes:

```js
export async function awaitMilestone(handle, spec, deps, { timeoutMs, pollMs })
  -> { outcome: 'reached'|'terminal'|'timeout', milestone, reason, snapshot }
```

| `--await-until` | Reached when | Typical wait |
|---|---|---|
| `launch` | the 201 comes back | seconds |
| `plan-round` | `plan.planningRounds >= 1`, any verdict | 10-20 min |
| `plan-approved` **(default)** | `plan.status === 'approved'` | 10-30 min |
| `plan-settled` | `plan.status` is `approved` **or** `deferred` | 10-30 min |
| `phase:<regex>` | a phase whose title matches appears in `state.tree` | caller's choice |
| `cycle:N` | cycle N begins | hours |

`plan-round` is the milestone that matches "hold until at least one round of planning
is done" - it says the planner and plan-reviewer both ran and produced a verdict,
without requiring that verdict to be APPROVED. `plan-approved` is the stronger
default; `plan-settled` is the pragmatic one for teams that treat a plan-cap deferral
as good enough to walk away from.

`phase:<regex>` is the escape hatch, and its risk is stated in the help text: phase
titles are free text (`Plan C1 R1`, `Develop C2 R1`, `Publish PR C1`) pinned only by
an internal test, with no API contract - so a regex may silently never match. The
gate therefore always reports which milestone it was waiting for on timeout, and
`--await-until phase:...` logs the phase titles it *did* observe, so a
non-matching pattern is diagnosable rather than mysterious.

Outcomes are uniform across every spec: **reached** -> green; **terminal before the
milestone** -> red with the engine's reason verbatim; **timeout** -> green with
"milestone not reached, now detached", and **never** a stop. The timeout default
scales with the spec (20 min for the plan milestones) and is overridable per pipeline.

### Append-blob sink specifics

Batch on a 10 s timer, flush early on phase transitions; never append per line
(50,000-append cap, 409 on exceed). Send `x-ms-blob-condition-appendpos` every time
and **treat 412 as success** - it means the block already landed, which is what makes
restart-without-duplicates a protocol property rather than hand-rolled logic. Track
`x-ms-blob-committed-block-count`, roll to `-partN` at 45,000, rewrite a separate
block-blob manifest on start/roll/stop. `rollAtBlockCount` is a constructor option so
tests force a roll at 2 - the roll path will otherwise never execute in production and
will rot.

---

---

## Part C - configuration and secrets (no ambient assumptions)

**Governing rule: the bridge ships with zero deployment-specific defaults.** No
organisation, project, storage account, container, subscription, tenant, agent pool
or member name is baked in anywhere - not in source, not in a template, not as a
fallback. Every one is a pipeline parameter or variable. A missing value is a named
`BridgeError` naming the parameter and where to set it, never a guess. A test asserts
no `dev.azure.com/<org>`, `*.blob.core.windows.net` or literal org/project string
appears outside fixtures.

### Configuration precedence

CLI flag > environment variable > repo `bridge.config.json` (**non-secret values
only**) > fail. There is no machine-level or user-level config file: a runner shared
by several projects must not carry ambient state that silently changes which tenant a
sprint talks to.

Parameters the Azure DevOps template exposes (all required unless noted):
`workItems`, `targetBranch`, `baseBranch`, `goal`, `member`, `adoOrgUrl`,
`adoProject`, `repoPath`, `agentPool`; optional `maxCycles`, `budget`,
`requirementsFile`, `awaitPlanTimeout`, `maxCarryOver`, `viewerPort`,
`blobAccountUrl`, `blobContainer` (omit the last two to disable the remote sink).
GitHub and Bitbucket templates expose the same names via their own parameter
mechanisms - the neutral `SprintRequest` is unchanged.

### Secret handling: pipeline secret -> fleet credential store -> `{{secret.NAME}}`

The flow is a single pipeline, and the bridge is never a reader at any point in it:

```
AzDO pipeline secret variable  (variable group, ideally Key Vault-backed)
        |
        v   deposit once, by NAME
apra-fleet credential store    (credential_store_set)
        |
        v   runtime substitution, resolved server-side
execute_command  "... {{secret.azdevops_pat}} ..."   -> the real value only ever
                                                        exists inside the fleet
                                                        server and the child process
```

Consequences that shape the code:

1. **The bridge passes names, not values.** Pipeline parameters carry
   `adoPatSecretName`, `blobSasSecretName` etc. - never the secrets themselves.
   `preflight` verifies presence with `credential_store_list`, which returns names
   and metadata only, so the check is safe by construction.
2. **Deposit is normally out-of-band and one-time**: an operator runs
   `apra-fleet secret --set <name> --persist` on the runner. The pipeline then only
   ever references the name. A pipeline-driven deposit path exists for rotation -
   `credential_store_set` fed from a masked pipeline variable - but it is a
   conduit-only step: the value is never assigned to a bridge variable, logged,
   written to the spool handle, or published to any sink.
3. **Nothing secret is ever an argv element or a persisted field.**
   `log-safe.mjs::redactSecrets` runs over every record before any sink, and a test
   asserts the PAT, the SAS and the supervisor bearer appear in none of: the pipeline
   log, the handle artifact, the local JSONL mirror, the append blob, or a work-item
   comment.

**The load-bearing gotcha:** `{{secret.NAME}}` is **shell-escaped** when substituted
into an `execute_command` string, so it must be placed **bare - never inside quotes**.
Quoting it produces a mangled value with no error. (It is passed raw in dedicated
credential *fields* such as `provision_vcs_auth`'s `pat`, which is the opposite rule -
the two must not be confused.) Encode this in one helper in `beads-client.mjs` rather
than at each call site.

### What this means for `beads-client.mjs` - a hard split

| Call class | Examples | How |
|---|---|---|
| **Local, credential-free** - reads/writes against the local beads DB only | `bd list --json`, `bd show`, `bd create`, `bd update`, dolt health probe | `exec-bd.mjs` in-process on the runner (`execBdSync` for free text, `execBdAsync` for safe-charset args) |
| **Tracker-touching, credential-needing** | `bd ado pull/push`, `bd github pull/push` | `execute_command` on the member, with the PAT injected as `{{secret.<name>}}` **bare** |

This split is what removes the tension entirely: the bridge never holds a tracker
credential, and the calls that need one run exactly the way fleet-sprint's own phases
already run `bd` - dispatched to a member through the fleet server.

**Cross-shell caveat - RESOLVED during implementation.** The member may be
PowerShell, so a POSIX-style inline `VAR=value cmd` assignment is wrong there. The
open question was how a *bare, unquoted* `{{secret.NAME}}` could be valid in both
dialects. Traced through `src/tools/execute-command.ts` and `src/utils/shell-escape.ts`:

`resolveSecretTokens()` matches `{{secret.NAME}}` as literal text in the command
string and substitutes an **already-quoted** literal - `escapeShellArg` produces
`'value'` for POSIX, `escapePowerShellArg` produces `'value'` for PowerShell. That is
precisely *why* the placeholder must be bare: the value arrives pre-quoted for the
target shell, so adding our own quotes would double-quote it. Both forms are then
valid:

- POSIX: `AZURE_DEVOPS_PAT={{secret.NAME}} bd ado pull ...`
- PowerShell: `$env:AZURE_DEVOPS_PAT = {{secret.NAME}}; bd ado pull ...`

> **Trap, and the reason `buildTrackerCommand` does NOT use `wrapForMember()`.**
> `se-os-commands.mjs`'s PowerShell `wrapForMember()` base64-encodes the whole script
> into an opaque `-EncodedCommand` blob **at build time** - before substitution.
> `resolveSecretTokens` only matches literal text in the top-level `command` string,
> so a placeholder routed through `wrapForMember` is hidden inside the base64 and is
> **never substituted at all**. That fails silently: the command runs with the
> literal text `{{secret.NAME}}` as the PAT, which is worse than a quoting error
> because nothing errors. The bridge therefore builds a plain, unencoded one-liner
> and uses `getSeCommands({os, shell})` only to select the dialect.

One more detail that cost a test failure: `getSeCommands` returns **three** shell
identifiers, not two. `gitbash` must be grouped with `posix`, not treated as a third
case or lumped with PowerShell.

### Remaining credentials

| Secret | Source | Delivery |
|---|---|---|
| AzDO REST (work-item comments, build status) | `System.AccessToken`, or a stored PAT by name | Prefer the OAuth token - no stored secret at all. Needs "Allow scripts to access the OAuth token"; verify it authenticates AzDO REST (Basic, empty username) before relying on it |
| Blob write credential | Short-lived user-delegation SAS minted at pipeline time via a service connection, **or** a stored SAS referenced by name | Either way it reaches the sink by name through the same store; never persisted to the spool |
| Supervisor bearer (#493) | Local file `<dataDir>/private/token`, 0600 | Read at call time, loopback only, never logged |
| Fleet-side git/PR credential | Existing fleet credential store | Already `{{secret.NAME}}`; untouched by the bridge |

Azure DevOps footgun to encode in the template: secret variables are **not**
automatically exposed to scripts. They must be mapped explicitly in the step's `env:`
block; omitting it yields an empty string, not an error.

The engine already supports per-sprint credential names via
`azdevops_pat_secret_name` (default `azdevops_pat`), so different projects on one
runner use different stored credentials. The bridge forwards this as a parameter
rather than relying on the default - that is what makes a single runner safe for more
than one Azure DevOps organisation.

---

---

## Part D - the viewer as a blob-hosted SPA

Rather than build a second, worse progress page, reuse the real viewer and swap only
its data source. Two facts make this bounded:

- **There is no build system.** The viewer is one `HTML_TEMPLATE` template-literal
  (`apra-fleet-workflow/src/viewer/index.mjs:21-935`) with ~670 lines of client JS in
  a single inline `<script>`. "Building an SPA" means writing that same string to a
  file instead of an HTTP response.
- **A static mode already exists.** `renderHistoryPageHtml()`
  (`apra-fleet-se/src/supervisor/history-view.mjs:176-178`) is literally
  `HTML_TEMPLATE(extensions, { history: true, state })` - a pure, synchronous
  function fed a plain object from `old_runs/<id>.json`, with the poll loop and SSE
  gated off and Stop/Pause hidden. That is the page shell, already working.

The domain boundary is also already clean: every sprint-specific UI element (beads
tree, progress bar, verdict/PR badge) is injected from `viewer-extensions.mjs` in
`apra-fleet-se` via `.toString()` embedding. `apra-fleet-workflow` stays
domain-neutral, and nothing in Part D changes that.

### D1 - archive SPA (ship first; small)

At `finalize`, export the terminal sprint as a self-contained static site:

```
<container>/sprints/<sprintId>/
  index.html                          renderHistoryPageHtml() output
  activities/<activityId>.json        materialized heavy output
  extensions/<extId>/<itemId>.json    materialized detail (e.g. bead descriptions)
```

This gives a permanent, shareable sprint page with the full real UI, needs no live
infrastructure, and is mostly a call to an existing pure function plus a walk of the
terminal state.

It also **fixes a live bug**: history mode gates the poll loop and SSE but does *not*
gate the lazy-load click handlers, so "more..." on a capped activity and expanding a
bead description already 404 silently on a finished sprint today. Materialising those
per-item blobs fixes it for both the archive page and the live one.

### D2 - live SPA (after D1)

Same page, fed continuously while the sprint runs.

**The data-provider seam** (new; nothing to inject into today). Replace the nine
hardcoded call sites with one injectable object:

```js
dataProvider = {
  getState(),                              // -> leaned state object
  subscribe(onChange),                     // -> unsubscribe
  getActivityOutput(activityId),
  getExtensionDetail(extId, itemId),
  control: { stop(), pause(), resume() } | null,   // null = read-only
}
```

Two implementations: `httpProvider` (today's `fetch`/`EventSource`, behaviour
unchanged) and `blobProvider` (`fetch` the blob + Web PubSub). Call sites:
`index.mjs:363,379,383,457,486,909` and `viewer-extensions.mjs:891`.

> **Hazard to handle in the same change.** `proxy.mjs:85-101`'s `rewriteChildHtml`
> text-patches eight exact single-quoted literals (`'/events'`, `'/state?`,
> `'/stop'`, `'/pause'`, `'/resume'`, `'/save_logs'`, `'/extensions/`,
> `'/activities/`) so a proxied child's calls re-enter under the
> `/sprints/:id/live` prefix. Moving those literals into a provider **silently
> breaks the supervisor proxy** unless they stay byte-identical or
> `rewriteChildHtml` is updated in lockstep. Add a test that loads the rendered
> HTML and asserts each literal is still present and rewritable.

**Change signal.** Today's `/events` SSE carries only a generic
`{type:'update'}` tick whose sole effect is "re-poll `/state`" (plus re-dispatching
`workflow:state:<ns>` CustomEvents). Web PubSub has identical semantics, so
`subscribe()` maps one-to-one and **no rendering code changes at all** -
`renderState`, `renderTreeIncremental` and every formatting helper already just take
a plain object.

**Snapshot, not event-sourcing.** The daemon writes the full **leaned** state
(reusing `lean-state.mjs` unchanged) to a *block* blob `state.json`. The SPA's
`getState()` is then a URL swap, with no replay logic and no state reconstruction.
Block blobs have no 50,000-append cap, so this is unconstrained - the append-blob
`progress.jsonl` from Part B stays alongside as the durable log. Per-item blobs are
materialised continuously in live mode, not just at archive.

**Overwrite on meaningful change, not on a timer.** The daemon polls on a short
interval but writes `state.json` **only when a content hash of the payload changes**,
so the blob advances when the sprint actually advances and a quiet hour costs
nothing. Writes use an `If-Match` ETag so a slow write cannot clobber a newer one.

**The beads tab works, and mostly for free.** The beads panel is an addon tab from
`viewer-extensions.mjs`, fed by `publishState('beads', ...)` - which means the beads
data is already inside `state.extensions.beads` in the very snapshot we are writing.
Nothing extra needs uploading. The one live-path detail: today the SSE handler
re-dispatches `workflow:state:<namespace>` CustomEvents, and the beads panel listens
for `workflow:state:beads` to repaint. So after each refresh the **blob provider must
synthesise those CustomEvents** for each `extensions` namespace whose content
changed. That is a few lines in the provider and leaves `viewer-extensions.mjs`
untouched - which is the right place for it, since the generic package must not learn
what "beads" means. Bead descriptions, being a lazy-load, come from the materialised
`extensions/beads/<beadId>.json` blobs.

### Access model

```
https://<account>.z13.web.core.windows.net/sprints/<id>/#sas=<token>&pubsub=<url>
```

- The **page shell is data-free** in blob mode (unlike history mode, which inlines
  state), so `$web` can serve it without exposing anything. All sprint data sits in a
  **private** container reached with the SAS.
- Credentials go in the **URL fragment**, never the query string: fragments are not
  sent to the server, so they stay out of access logs and `Referer` headers. They are
  still in browser history, so: short TTL, read-only, container-scoped.
- **CORS must be configured.** Nothing in this codebase emits CORS headers today, and
  `z13.web.core.windows.net` is a different origin from `blob.core.windows.net` - so
  an account-level CORS rule allowing the static-website origin is required, or every
  data fetch fails. Easy to miss; put it in the toy-project README checklist.
- The pipeline publishes the assembled URL in its run summary, and `finalize` posts it
  as the work-item comment.

### Sizing and sequencing

A few hundred lines in `apra-fleet-workflow/src/viewer` (the provider seam plus a
blob-export helper), a small parallel change to `viewer-extensions.mjs`'s single
lazy-load fetch, and new publisher wiring. **This is materially larger than Parts A-C
and should not gate them.** Sequence: finish the loop (Parts A-C), then D1, then D2.
D1 alone already delivers a real, shareable sprint page.

---

## Implementation order

Each step ends with something independently testable.

1. **A1 + A2 + A3-A5** - the apra-fleet edits and their tests. First, because
   everything downstream reads `state.extensions.plan`.
2. `contracts.mjs`, `errors.mjs`, `cli/args.mjs` - pure validators mirroring
   `sprint-args.mjs` patterns.
3. `supervisor-client.mjs` - bearer-aware from line one. Second-built because every
   verb depends on it and it is the #493 landmine.
4. `beads-client.mjs` - the sync/async split rule plus `assertNoBareSync`.
5. `adapters/index.mjs` + `lib/native-beads-sync.mjs` + `adapters/azure-devops.mjs`.
6. `preflight` - first user-visible verb; exercises 3-5 end to end.
7. `ingest` - the epic-with->=1-child guarantee and the acceptance-criteria audit.
8. `launch` + `spool.mjs`.
9. `await-gate.mjs` wired into `launch --await-until`, then
   `templates/azure-pipelines.yml` and `examples/azure-devops-toy/` - the example is
   written and run against the toy project in the same step, not afterwards.
10. `snapshot.mjs`, `throttle.mjs`, `sinks/index.mjs`, `sinks/jsonl-file.mjs`, `watch`.
11. `carry-over.mjs` (pure, tested exhaustively) then `finalize`.
12. `daemon` - orchestration over already-tested pieces.
13. `sinks/append-blob*.mjs` - trickiest, built last against fakes.
14. `viewer-proxy.mjs` + `viewer`. *(Phase 3 exit met - the loop works.)*
15. **D1 archive SPA**: per-item blob materialisation + `renderHistoryPageHtml()`
    export at `finalize`, published URL in the work-item comment.
16. **D2 live SPA**: the `dataProvider` seam (with the `rewriteChildHtml`
    lockstep test), the `state.json` snapshot writer, and Web PubSub `subscribe()`.

---

## Verification

**Unit** (`npm test` at root, after A5): the suites above, all with injected fakes -
no live supervisor, blob store, or `bd`. The load-bearing ones are
`carry-over.test.mjs` (pure selection), `await-gate.test.mjs` (each `--await-until`
spec reaches on the right signal; `plan-round` fires on a CHANGES_NEEDED round while
`plan-approved` keeps waiting; a `phase:` regex that never matches times out green
and reports the titles actually seen; terminal-before-milestone is red; timeout never
issues a stop), `append-blob-restart.test.mjs`
(412 absorbed, final blob byte-identical to the local JSONL mirror),
`launch.test.mjs` (asserts `overrideRelaunchGate` is absent from the body unless
flagged), and `viewer-proxy.test.mjs` (pause/resume/stop forwarded, `/api/shutdown`
403).

**Scope of this build: local development and unit tests only.** No credentials are
available yet, so nothing below the line is executed now - no real Azure DevOps, no
real storage account, no Web PubSub, no push. Every test runs against injected fakes
(fake `fetch`, fake `execBd`, fake clock, fake blob HTTP, in-memory fs), which the
design already requires. Work is committed locally and periodically.

This has one concrete design consequence worth stating: **every module must take its
I/O as an injected dependency**, because that is now the only way anything is
testable. A module that reaches for `globalThis.fetch`, `process.env` or the real
filesystem directly is a defect, not a shortcut - there is no integration run to
catch it later.

**Deferred until credentials exist - the integration pass, against the Azure DevOps
toy project:**

1. Register this box in a `fleet-sprints` agent pool; confirm supervisor + fleet
   server survive reboot; register one member with `vcsProvider` set; deposit
   `azdevops_pat`.
2. `fleet-bridge preflight` - then break each precondition in turn and confirm each
   fails with a distinct, actionable message.
3. Trigger `examples/azure-devops-toy/azure-pipelines.yml` selecting 2-3 toy work
   items. Assert: the job holds through the configured milestone, goes **green**, and
   the **sprint is still running after the job ends** - the requirement-critical
   check. Run it at `--await-until plan-round` and again at `plan-approved` and
   confirm the hold durations differ as expected. This run is what validates the
   shipped sample.
3a. **No-ambient-config check**: confirm the pipeline fails with a named, actionable
   error when a required parameter (org URL, project, member, pool) is blank, rather
   than defaulting to anything. Then confirm a secret omitted from the step's `env:`
   block is caught by `preflight` rather than surfacing as an auth failure later.
3b. **Secret hygiene**: grep the completed pipeline log, the published handle
   artifact, the local JSONL mirror and the append blob for the PAT, the SAS and the
   supervisor bearer. All four must be absent.
4. Force the red path: a childless work item must exit red carrying `NOTHING_TO_DO`
   verbatim. Force the timeout path: job green, sprint still alive, no stop issued.
5. Open the LAN viewer URL from a second machine; pause and resume the sprint;
   confirm `POST /api/shutdown` is refused.
6. Let it run to completion. Assert: PR targets the chosen branch with title
   `Auto-sprint [PASS|FAIL]: <branch>`; `docs/sprint-analysis-<slug>.md` committed;
   carry-over items appear as new AzDO work items linked back to the root; beads
   closed during the sprint are absent; `finalize` run twice creates no duplicates.
7. Kill the daemon mid-sprint, restart it, and confirm the append blob has no gap and
   no duplicate lines.

---

8. **D1 archive SPA**: after a finished sprint, open the exported `index.html` from
   blob storage and confirm the beads tree, cost, verdict badge and PR link all
   render, and that "more..." on a capped activity and expanding a bead description
   both resolve from the materialised per-item blobs (these 404 today).
8a. **Beads tab, live**: with the SPA open mid-sprint, close a bead and confirm the
   Tasks tab repaints on the next refresh - i.e. the provider's synthesised
   `workflow:state:beads` CustomEvent works. Confirm `state.json` is *not* rewritten
   during a quiet period (hash unchanged).
9. **D2 live SPA**: open the SPA mid-sprint from a machine outside the LAN using only
   the fragment URL; confirm it updates on Web PubSub messages, that the supervisor
   proxy still works (the `rewriteChildHtml` literals test), and that removing the
   account CORS rule produces a clear failure rather than a blank page.

---

## Out of scope

Phase 4 (GitHub adapter - the neutrality proof), Phase 5 (Bitbucket adapter and the
`vcs-providers/bitbucket.mjs` PR builders), enabling the workflow-engine JSONL
journal in `bin/cli.mjs`, and a `viewer-extensions.mjs` renderer for the new `plan`
namespace.
