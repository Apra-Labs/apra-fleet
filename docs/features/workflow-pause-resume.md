# Workflow Pause/Resume

A generic, cooperative pause/resume capability for any `apra-fleet workflow`
run, plumbed end to end: the workflow engine's own gate, the per-run viewer's
UI, the multi-sprint supervisor's dashboard and watchdog, and (as the first
consumer with real domain state to protect) fleet-sprint's git/beads sync and
member-reservation handling.

The design goal throughout is that the **engine primitive stays generic** --
it knows nothing about git, beads, or member reservations -- while each layer
above it adds exactly the domain-specific behavior it needs on top of the same
three events (`pause:requested`, `paused`, `resumed`). See
`packages/apra-fleet-workflow/docs/apra-fleet-workflow-architecture.md`
sections 4.7 and 7 for the engine/viewer-level contract this feature is built
on; this document covers how the layers above it use that contract.

## Layering

```
Engine (FleetWorkflow)      requestPause/requestResume/setPauseGuard,
                             pause:requested/paused/resumed events.
        |
Viewer (per-run dashboard)  Pause/Resume buttons forward to the engine only;
                             button state + "paused since" badge are derived
                             from state.pause, never from the click.
        |
Supervisor (multi-sprint    Row-level Pause/Resume buttons proxy to the
dashboard + watchdog)       child viewer's own /pause and /resume (never the
                             kill+force-release path Stop uses); watchdog
                             adds a PAUSED classification alongside its
                             existing PID/HTTP liveness checks; a base-drift
                             indicator shows how far a (possibly long-)paused
                             branch has fallen behind its base branch.
        |
fleet-sprint (a workflow    Registers a pause guard so a pause only ever
script)                     lands at a clean git/dolt-sync boundary; releases
                             its member reservations on pause and re-acquires
                             (owner-checked) plus re-syncs them on resume.
```

## Engine gate: deferred, not immediate

A requested pause does not take effect the instant it's requested. It engages
only once every in-flight `agent()`/`command()` dispatch has drained to zero
*and* an optional caller-supplied guard predicate returns true. This
two-part condition is what lets a workflow script guarantee a pause never
lands mid-way through a multi-step operation it considers atomic -- the
guard is the script's own definition of "clean state," which the engine has
no way to infer on its own.

A `requestStop()` while paused supersedes the pause: every dispatch parked at
the gate is rejected with a cancellation error so the run tears down instead
of hanging indefinitely.

## Viewer and supervisor: state always follows engine events, never the click

Both the per-run viewer's Pause/Resume button and the supervisor dashboard's
row-level controls follow the same rule the existing Stop button already
established: a `POST` to a pause/resume route only forwards the request to
the engine (or, at the supervisor layer, proxies it through to the child
viewer's own route) -- it never mutates displayed state directly. All visible
state (button label/enabled-ness, "paused since" badge, watchdog
classification) is derived from the engine's own
`pause:requested`/`paused`/`resumed` events on the next poll/SSE tick. This
keeps the UI honest about what the engine has *actually* done, including the
deferred window between "pause requested" and "pause engaged," rather than
optimistically reflecting the click.

The supervisor's watchdog folds a paused child into its liveness
classification as a distinct, healthy, live state -- never conflated with a
stalled or crashed process, and never subject to the watchdog's automatic
reservation-release/cleanup behavior that applies to a genuinely dead
process. A probe failure when checking a child's pause status is treated as
"unknown," never silently interpreted as "not paused" or "paused" -- an
absent signal must not be conflated with a confirmed one in either
direction.

The supervisor dashboard's base-drift indicator (commits on the base branch
not yet reachable from the sprint branch) exists specifically because a long
pause is exactly the situation where a sprint branch can silently fall
behind its base while parked -- surfacing that drift lets an operator decide
whether a resume needs a rebase/merge first.

## fleet-sprint: the first consumer with real state to protect

fleet-sprint is a workflow script running on top of the generic engine, so
its pause-awareness is entirely additive on top of the primitives above --
the engine itself remains fleet-sprint-agnostic.

**Clean-state guard.** fleet-sprint registers a pause guard that only permits
a pause to engage when it is not currently inside a git-sync or beads-sync
"bracket" (pull-then-work-then-push style sequences). Every such
bracket increments an open-bracket counter on entry and decrements it
(unconditionally, even on failure) on exit; the guard is simply "the counter
is zero." This prevents a pause from ever landing between a pull and its
matching push, or mid-database-sync, which would otherwise leave a member's
working tree or beads clone in an inconsistent state to resume from or to be
inspected by an operator while paused.

**Reservation release/re-reserve.** Holding a member reservation for the
full duration of a pause would keep that member unusable by any other sprint
for as long as the pause lasts, which can be arbitrarily long (a pause is,
by design, meant to support long-lived human-in-the-loop or multi-day
waits). So on pause, fleet-sprint releases every member reservation it
holds; on resume, it re-acquires them. The re-acquire is **owner-checked**:
if a member was claimed by a different sprint while this one was paused, the
resume fails loudly, naming exactly which members are unavailable, rather
than silently continuing to operate as though it still owned them. A partial
re-acquire (some members grabbed, others not) is rolled back -- the newly
re-acquired members are released again -- so a failed resume never leaves the
sprint holding an unusable partial reservation set.

**Unconditional resync on resume.** Every member that is successfully
re-acquired on resume is resynced before any further work is dispatched to
it: fetch the base and sprint branches, reconcile the local branch to the
remote tip via the same decision logic the initial "ensure sprint branch"
step uses (aborting rather than touching git if the fetch failed for a real
reason or the tips have diverged, since resuming onto a diverged branch
could silently discard pushed work), and pull the beads database. This is
unconditional -- never gated on a "looks unchanged" heuristic -- because
while paused, both the git remote and the beads database can have moved
independently of this sprint (another sprint's work, a human push).

**Known limitation: resume re-reserve/resync is best-effort, not a hard
barrier.** Because the engine emits `resumed` synchronously and releases
gate waiters in the same tick, fleet-sprint's resume-time reservation
re-acquire and resync work is dispatched as an async task that *races* the
very first post-resume dispatch rather than strictly completing ahead of it.
The actual safety net against dispatching to a member this sprint no longer
owns is the dispatch-time ownership check the fleet execution layer already
performs independently of this feature. Closing this gap with a true
pre-resume barrier would require an engine-level affordance (e.g. an
awaitable pre-resume hook) that does not exist yet.

## Distinguishing exit-code truth from a rejection flag

A recurring pitfall this feature had to get right: when re-deriving pass/fail
from a lower-level command execution result, the correct signal is the
command's real exit code, not a higher-level "was this call rejected" flag
that the underlying tool does not set on a merely-nonzero exit. This matters
most for a git ancestor-check command, where a nonzero exit is the
*meaningful* result (not an error) -- misreading it as success would
silently treat a diverged branch as merely-behind and risk discarding
committed-but-unpushed work during the resume's branch reconciliation.
Anywhere this feature (or anything built on top of it) needs to classify a
shelled-out command's outcome, prefer the structured exit code over any
higher-level error flag, and only fall back to the flag when no exit code is
recoverable at all.
