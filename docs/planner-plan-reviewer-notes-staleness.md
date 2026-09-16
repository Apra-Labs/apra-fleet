# Decomposition vs. NOTES corrections: guidance + a tooling staleness signal

## Problem

A bead's NOTES section functions as an append-only changelog: corrections,
amendments, and design-review findings accumulate there over the bead's
lifetime, frequently after its DESCRIPTION was originally written. Nothing in
the planner's decomposition process guaranteed that a later NOTES entry
superseded an earlier, now-stale DESCRIPTION passage it contradicted. In
practice this produced children that were faithful to the original
DESCRIPTION but silently reintroduced an approach a later NOTES correction had
already rejected -- and it was caught only by a manual adversarial review, not
by the normal plan/review loop. The fix has two independent layers, because
prompt instructions alone are known to be an unreliable enforcement point (the
model has to remember to look; the original miss happened precisely because
nothing prompted it to).

## Layer 1 -- role-prompt guidance

**Planner** (`packages/apra-fleet-se/apra-pm/agents/planner.md`): before
decomposing any bead with a non-empty NOTES section, read NOTES in full, in
chronological order, as part of understanding current scope -- not as
optional background. A NOTES entry recognizable by language such as
"CORRECTION", "AMENDMENT", "SUPERSEDES", "REVISED", or an explicit "do X, not
Y" statement is treated as authoritative over the DESCRIPTION passage it
contradicts. When writing a child's own DESCRIPTION/acceptance criteria, the
planner does not copy stale DESCRIPTION language verbatim if a later NOTES
entry corrected it, and is encouraged to have the child explicitly cite which
correction it incorporates so a later reader does not need to cross-reference
the parent's full history. This is additive: a bead with empty or purely
procedural NOTES (claim/close log lines) decomposes exactly as before.

**Plan-reviewer** (`packages/apra-fleet-se/apra-pm/agents/plan-reviewer.md`):
gained an explicit review criterion (numbered after the existing task-sizing
and DAG-coverage checks) that checks each child under review against its
parent's NOTES for the same correction-marker vocabulary the planner now
looks for. If a child's text contradicts a recorded correction -- reintroduces
a rejected approach, or omits a requirement the correction added -- that is a
CHANGES_NEEDED finding. The finding must quote the exact conflicting text from
*both* the parent's correction and the child's contradicting passage; a vague
"may not be aligned with parent notes" does not satisfy the check, because the
finding has to be falsifiable by inspection. This finding type maps to the
`other` kind in the reviewer's closed verdict vocabulary, since no dedicated
kind exists for it.

Both additions are fully generic (no target-repo-specific wording), consistent
with these prompts driving a general-purpose engine across different target
repos; see `docs/generic-engine-boundary.md` for the boundary rule and its
enforcement script.

## Layer 2 -- tooling-computed staleness signal

`packages/apra-fleet-se/fleet-sprint/parent-notes-staleness.mjs` adds a
structural signal that does not depend on the model remembering to check.
Once per Plan phase (before the planner/plan-reviewer round loop begins), the
Plan phase computes, for every in-scope bead, whether that bead's NOTES were
last updated *after* its most recently created child. If so, both the planner
and plan-reviewer dispatch prompts receive a prominent, generic advisory block
naming the specific bead(s) flagged -- turning "remember to check for a stale
decomposition" into "here is a bead the tooling already flagged, go look".

Key design points, since they are not obvious from the acceptance criteria
alone:

- **The timestamp source is `bd history <id> --json`, not the bead's
  `updated_at` field.** beads stores `notes` as a single text field with no
  notes-specific timestamp, and `updated_at` moves on *any* mutation (status
  change, priority change, claim, close) -- using it as a proxy for "notes
  last changed" would false-positive on routine bead churn that never touched
  NOTES. The staleness module instead walks the full history oldest-first and
  records the commit at which the notes text actually last changed, ignoring
  commits that carried the same notes text forward unchanged.
- **The signal is strictly advisory.** It only adds a note to the dispatch
  prompt; it never blocks a dispatch, fails a plan, or is itself treated as a
  defect. Any failure while computing it (a `bd` call errors, history is
  empty, no child has a parseable creation timestamp) degrades silently to no
  note for that bead -- the phase falls back to the pre-existing prompt-only
  behavior, never to a hard failure.
- **No-false-positive requirements shape the decision logic.** A bead with no
  children, a bead whose NOTES predate every child, or a bead where NOTES and
  the newest child are exactly co-timed, produces no note. Only NOTES
  strictly newer than the most recently created child fires the signal.
- **Command-surface registration.** Because the collector issues two
  `member_name`-bearing `command()` calls per bead (`bd list --parent <id>
  --json` and `bd history <id> --json`), the module is registered in
  `guarded-modules.mjs` alongside the rest of the dispatch-safety-guarded
  command surface, with its own explicit expected-command-count baseline in
  the guard's test suite -- a bare addition of `command()` call sites without
  updating that baseline is caught by the guard rather than silently
  expanding what runs against a live member unnoticed.

### Known limitation: closed children are invisible to the collector

The collector's child-listing call (`bd list --parent <id> --json`) does not
pass `--status all`, and `bd list` excludes closed issues by default. This
means a bead's *closed* children are invisible to the "most recently created
child" calculation. Two concrete consequences:

1. **False negative** -- once every child of a decomposed bead closes, the
   collector sees zero children for that bead and the signal permanently stops
   firing for it, even if NOTES are edited again afterward.
2. **False positive** -- if the most-recently-created child happens to be
   closed while an older sibling remains open, and the parent's NOTES were
   updated at a time between the two children's creation timestamps, the
   collector picks the open (older) child as "most recent" and fires the
   signal even though NOTES actually predate the *true* most recent child.

The existing unit coverage stubs the `bd list --parent` command directly and
therefore does not exercise this default-filtering behavior, so it did not
catch the gap. This is tracked as low-priority backlog (advisory-only impact)
rather than fixed in the same change; the fix is scoped as: pass `--status
all` (or otherwise include closed children) in the collector's list call, and
add a test that stubs a mixed open/closed child set so a future regression on
this exact behavior is caught.

## Test-suite note: mock-sprint beads-health-gate flakiness under full concurrency

Two `real-bd` mock-sprint scenarios (`mock-sprint-beads-health-gate-empty-
remote` and `mock-sprint-beads-health-gate-diverged`) pass reliably in
isolation but can fail under the full test suite's default concurrency. This
matches an existing documented flake pattern for resource-contention-sensitive
real-bd suites elsewhere in the test tree, and is tracked as backlog work to
move these two scenarios into the slow/serialized bucket or give them
contention-scaled timeouts, rather than something a single sprint change
should mask by loosening assertions.
