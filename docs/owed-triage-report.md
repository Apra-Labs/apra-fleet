# Owed triage report and stable beads trees

## Owed triage report

A sprint verdict of PASS does not mean nothing is left to do. At the end of a
sprint the engine builds an "owed triage" list, which is a report only. It
never closes or edits beads.

`fleet-sprint/owed-triage.mjs` is a pure module (no I/O; it takes the bead
snapshot as input). It lists four kinds of owed item:

1. Follow-ups that no lane will pick up (open, parent-less or out of scope).
2. Rollups (features/epics) whose children are all closed but which are still open.
3. Findings that were rejected.
4. Beads closed with a `blocked:` reason.

"Closed during this sprint" is decided by comparing against the set of ids
already closed when the sprint started (taken from the cached snapshot), never
by clock time. This adds no extra `bd` command.

The runner returns `owedTriage` plus a `clean` flag. `clean` is true only when
the verdict is PASS, nothing is owed, and the bead read succeeded. A failed
bead read marks the report incomplete, so an unreadable graph can never be
reported as clean. The PR body gets an "Owed triage" section and a
"PASS is NOT clean" heading when anything is owed.

Known limit: the owed-triage section in the PR body is not size-bounded. The PR
layer truncates the body, so a long list can cut off the tail of the list and
the run-history marker that later runs read back.

## Features stranded when Integration Test is skipped

When the Integration Test phase is skipped (no playbook, or the deploy
failed), features whose children are all closed would otherwise sit open with
no explanation. The engine lists every such feature in the owed triage report
with the skip reason. It lists rather than auto-closes, because closing needs
a passing integration run as acceptance. A later cycle that does run
Integration Test drops the stale reason.

## Beads tree state across refresh (Tasks view and Backlog)

The Tasks view (`viewer-extensions.mjs`) and the Backlog tab
(`src/supervisor/backlog.mjs`) re-render their beads tree from polled data.
Rebuilding naively resets what the user opened or collapsed. The invariants:

- Open descriptions are kept in a client-side set of expanded ids and passed
  into the renderer, so a rebuild reproduces them.
- Collapsed-node state is not cleared on refetch.
- Payload-driven rebuilds are skipped when the payload is unchanged, and are
  throttled to at most one per 15 seconds (one delayed render picks up the
  latest data). Previously the tree rebuilt on every poll.
- A loading flag prevents two concurrent fetches of the same description.
- The Backlog tab has its own 30 second refresh threshold, separate from the
  short threshold other tabs share.
