# Supervisor Dashboard: Live Refresh

The always-on supervisor serves one multi-sprint dashboard (`GET /`) listing
every currently-running sprint as a "Sprint Stack" of rows, plus a Backlog
tab. Historically this was a single monolithic server-rendered page: the only
way to see any change (a new sprint launched, a status flip, a progress-bar
tick) was a full page reload. Each individual sprint already had its own
per-run viewer with a lightweight incremental-refresh architecture (a lean
JSON state endpoint plus a change-signal stream driving a debounced client
poll). The supervisor dashboard now adopts that **same** architecture for its
own Sprint Stack, rather than inventing a second, divergent one -- so there is
exactly one live-refresh pattern in the codebase for anyone to learn, extend,
or debug.

## Design goal

Reuse, don't reinvent. Every piece of this feature intentionally mirrors the
per-run viewer's own mechanism:

- A lean JSON poll endpoint alongside the full HTML page, built from the
  identical view-model computation the HTML render already does -- one
  "what does the sprint stack currently look like" implementation, formatted
  two ways, never two independent computations that could drift apart.
- A change-signal stream that a client-side loop treats generically: every
  signal (however it arrived) just means "go refetch and re-render."
- A single, debounced client poll loop fed by two independent triggers (a
  push-style signal and a fixed-interval heartbeat), never two separate
  pollers that could race or double-fetch.
- Re-rendering in place, DOM-diffed by row, using the exact same
  row-rendering function the server used for the initial page load -- so a
  live-refreshed row can never visually drift from what a fresh full load
  would have produced.

## HTTP surface

- `GET /` -- the full HTML page (header, tab bar, Sprint Stack panel, Backlog
  panel, Launch Sprint form). Unchanged in shape; still the one page the
  supervisor serves.
- `GET /state` -- a lean `application/json`, `no-store` response shaped
  `{ generatedAt, runningCount, sprints: [...] }`, where each entry in
  `sprints` carries the same fields the HTML rows render (id, branch, goal,
  status, claimed issue roots, claimed bead count, progress, members, base
  branch, base-drift). It is built by projecting the same sprint-view-model
  list the full page render already computes -- the endpoint is a formatter,
  not a second data source.
- `GET /events` -- a Server-Sent-Events stream (`text/event-stream`, one
  held-open connection per client). The supervisor has no single internal
  event bus the way one workflow run does (its view model instead changes
  via many disjoint HTTP mutation routes -- launch, force-release, pause,
  resume -- plus watchdog reclassification on the next render), so rather
  than threading a notify() call into every one of those call sites, this
  stream emits the same generic "state may have changed, go poll `/state`"
  signal on a fixed cadence, plus once immediately on connect (so a
  freshly-opened stream doesn't wait a full cadence for its first signal).
  A periodic signal is indistinguishable to the client from a genuine
  per-mutation push, which is the point: the client never inspects the
  message payload, it just triggers a poll.

## Client refresh loop

The Sprint Stack's live-refresh script runs one polling pipeline:
`schedulePoll()` debounces (coalesces bursts of triggers into a single
in-flight fetch), and `poll()` fetches `/state` and re-renders. Two
independent sources feed `schedulePoll()`:

1. Every message from the `/events` SSE stream.
2. A fixed-interval heartbeat, so a dropped, unavailable, or silently-stalled
   `EventSource` connection still keeps the dashboard from going stale --
   the heartbeat does not depend on `EventSource` having ever connected.

Re-rendering reconciles the Sprint Stack's rows by a stable per-row identity
attribute rather than replacing the whole container: an existing row is
replaced in place, a newly-appeared sprint is appended, and a row whose
sprint is no longer present (finished, force-released, or restarted away) is
removed, falling back to the same empty-state message the server-side render
uses when the list is empty. Because row markup is produced by the identical
rendering function on both the server (initial load) and the client (poll
re-render) -- embedded into the page's inline script literally via
`.toString()` on the same function object -- there is exactly one
implementation of "what does a Sprint Stack row look like," so the two paths
can never drift into visually different output. Per-row controls (Stop,
Restart, Pause/Resume) are wired via event delegation on the document rather
than on the button elements themselves, so a row rebuilt by a poll keeps
working controls with no re-wiring step.

## Tab-activation refresh

Each dashboard tab (Sprints, Backlog) independently tracks when it last
fetched its own data and exposes a `refreshIfStale(maxAgeMs)` hook. Switching
to a tab calls that tab's own hook through the exact same fetch/poll plumbing
the tab already uses elsewhere -- never a separate one-off fetch path -- and
only actually issues a new fetch when the last one exceeds a staleness
threshold. That threshold is set below the heartbeat's own interval so an
idle tab switch shortly after a heartbeat poll doesn't double-fetch, while a
tab that has been inactive for a while still gets a genuinely fresh view on
activation rather than showing markup from whenever it was last rendered.
There is no full-page reload anywhere in this path.

## Performance: in-memory scope expansion

Each Sprint Stack row's "claimed scope" (used for both the raw bead count and
the progress bar) is the full parent-child subtree under that sprint's root
issue(s). The original implementation expanded that subtree by issuing one
subprocess call per discovered graph node, which made a full dashboard render
take tens of seconds once more than a few sprints (each with a non-trivial
subtree) were running concurrently. The fix: fetch the full bead list exactly
once per render, build an in-memory parent-to-children index from that single
fetch, and expand every sprint's scope by walking that index in memory (same
breadth-first algorithm, same result set, zero additional subprocess spawns).
The one-fetch-per-render discipline is applied project-wide within the
render, not just for scope expansion -- a decomposed-parent lookup used for
progress-bar filtering is derived from the same single fetch as well, so a
render's cost no longer scales with the number of sprints or the size of
their subtrees.

A bulk-fetch failure degrades gracefully to per-row placeholders (never a
thrown page render); a scope-expansion failure for one row is isolated to
that row rather than aborting the whole render.

## Progress-widget labeling

The dashboard shows two different counters for the same sprint that can
legitimately disagree: a raw "claimed scope" count (every bead in the
subtree, unfiltered -- can grow over a sprint's life as planners/reviewers
add tasks) and a "Required" progress-bar count (filtered to the sprint's
goal priority band). Both counters are explicitly labeled with what they
represent, so a growing raw count against a flat "Required" count reads as
expected scope growth rather than a bug, and an operator never has to guess
which of the two disagreeing numbers is the "real" one.

## Base-drift indicator

A per-row indicator reports how many commits a sprint's base branch has
picked up that are not yet reachable from the sprint's own branch (how far
the branch has fallen behind since it forked), computed via a single git
invocation using an argument array (never shell string interpolation, so it
is not exposed to shell-injection regardless of what a branch name might
contain). "Unknown" (missing branch/base metadata, or the git check failing
because a ref cannot be resolved locally) is always rendered distinctly from
a confirmed zero-drift result -- the two are never conflated.

## Testing implication

Every dashboard client-side behavior (button handlers, the live-refresh
loop, tab-activation refresh) is authored as a plain, named function and
inlined into the page via `.toString()` rather than hand-written as an
inline `<script>` string. This means the exact function under unit test is
the exact code shipped to the browser, with no separate test-copy to drift
out of sync with what actually ships.
