# Sprint run summary: publish once, pull everywhere

The supervisor dashboard and the sprint live view both show a per-sprint progress bar.
Progress is computed exactly once, by the process that owns the sprint's data, and every
consumer reads the published result. No consumer recomputes it.

## Design

### Generic core (workflow viewer)

- The viewer (`packages/apra-fleet-workflow/src/viewer/run-summary.mjs`, wired in
  `index.mjs`) lets a namespace extension register an optional `summarize()` hook.
- The hook runs only from the workflow `state` event, through `applyExtensionSummary`, and only
  for the extension whose namespace matches. It therefore runs once per published state, not
  once per HTTP request.
- `GET /state?summary=1` returns only the stored `state.summary` and never calls a hook.
  Ten summary requests cause exactly one summarize call.
- Plain `GET /state` is unchanged; the summary is attached after the lean-ification pass.
- The summary carries a `summaryVersion` and a per-namespace entry (e.g. `beads`).

### Beads extension (fleet-sprint)

- `summarize()` in `viewer-extensions.mjs` computes sprint progress. Its `computed_at` is the
  runner's `fetchedAt` (the time the beads snapshot was read in `updateDashboard`), not the
  time summarize happened to run, so "as of" reflects data freshness.
- The live view bar renders the published summary instead of recomputing in the browser.

### Supervisor dashboard

- `src/supervisor/dashboard.mjs` no longer imports or calls the progress computation. Each
  sprint row pulls the child's `GET /state?summary=1`.
- Pull bounds: 2 s overall timer and a 1 MB response cap. Pulls start before the bulk `bd`
  fetch so rows run concurrently with it and with each other.
- A last-good cache per sprint is kept; entries are evicted when a sprint leaves the ledger.
- The child's `runId` must equal the sprint id (the spawner forwards `--run-id`; the CLI passes
  it to `createDashboardViewer`). A mismatch is rejected and never cached, so a recycled port
  cannot show another sprint's bar.
- Port resolution lives in one shared module (`child-port.mjs`) used by both the reverse
  proxy and the dashboard, so they cannot disagree about where a child listens.

### Degradation states (what a row shows)

| Situation | Row shows |
|---|---|
| 404, non-JSON body, or no `summaryVersion` | "status unavailable" |
| Summary present but no beads entry | "no summary yet" |
| Child unreachable, a good summary cached | last good bar + "as of" + "unreachable" marker |
| Child unreachable, nothing cached | "status unavailable" |
| `runId` mismatch | rejected, not cached |

## Trade-offs and known limits

- Rationale: the supervisor's own beads clone does not see child beads that sprint members
  create and push from their clones, so locally computed progress diverged from the sprint's
  live view (two sources of truth). The sprint is now the single source of truth; the cost is a
  bounded per-row HTTP call, mitigated by concurrency, the 2 s timer and the cache.
- Runs archived before the summary existed have no `summary` key on disk. The History view
  backfills them on read (see below) instead of showing "no summary yet".

## History backfill and the live SSE frame

- `backfillExtensionSummaries(state, extensions, logger)` (in `run-summary.mjs`) is called by
  the viewer's history branch, so every history consumer gets summaries for old runs. Live mode
  is unchanged.
- It is pure: it returns a new object and never mutates its input. A namespace that already has
  an entry is never overwritten (checked with `hasOwnProperty`).
- It reuses `applyExtensionSummary`, so a throwing `summarize()` is logged and leaves no entry
  rather than failing the view. If the state has no summary at all, one is built with
  `createRunSummary` + `refreshSummaryCore`. `publishedAt` falls back from `endedAt` to
  `updatedAt` to `null`.
- Archived run files hold the full state (not the lean `$ref` form), so `summarize()` sees real
  data. Core code still names no extension.
- The server's live SSE state frame now carries the namespace summary:
  `{...stateData, summary: state.summary.extensions[ns] ?? null}`, built as a new object. The
  client dispatches `workflow:summary:NS` (null when absent) BEFORE `workflow:state:NS`, so
  renderers have the summary when the state event fires. The frame's `namespace`/`data` fields
  are unchanged for other readers.
- Tests: backfill and SSE cases in `viewer-run-summary.test.mjs`; the History HTTP route with
  the real beads extension in `supervisor-history-view.test.mjs`.

## Invariants

- Do not compute progress in the supervisor or the browser; extend `summarize()` instead.
- A summary consumer must treat absence/unknown shape as a degradation state, never as zero
  progress.
- Tests: `viewer-run-summary.test.mjs` (workflow), `viewer-run-summary-e2e.test.mjs` and
  `supervisor-dashboard-pulled-summary.test.mjs` (against a real stub child).
