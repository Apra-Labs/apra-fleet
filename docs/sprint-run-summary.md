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

- Pull (not push) keeps the supervisor stateless about progress rules; the cost is a bounded
  per-row HTTP call, mitigated by concurrency, the 2 s timer and the cache.
- Saved history-view runs from before this change have no `summary` key and render
  "no summary yet" rather than their old progress.
- The viewer's SSE handler dispatches the beads state event without first dispatching the
  summary event, so until the coalesced poll runs the panel can show new tasks with the
  previous summary. This contradicts the ordering intended in `viewer-extensions.mjs`.

## Invariants

- Do not compute progress in the supervisor or the browser; extend `summarize()` instead.
- A summary consumer must treat absence/unknown shape as a degradation state, never as zero
  progress.
- Tests: `viewer-run-summary.test.mjs` (workflow), `viewer-run-summary-e2e.test.mjs` and
  `supervisor-dashboard-pulled-summary.test.mjs` (against a real stub child).
