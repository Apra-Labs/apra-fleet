# Dedup-before-create evidence for sprint-filed beads

Roles that propose or file new beads during a fleet-sprint run must prove they
searched the backlog first. The engine checks the proof mechanically where it
can, and flags it loudly where it cannot.

## Rule for the roles

Before creating a bead, search OPEN items across the ENTIRE backlog, not only
the current sprint's scope. Prefer refining an existing item or adding a child
under it over creating a duplicate. The instruction lives in the planner,
reviewer and integ-test-runner role prompts and in the repo agent-context files
(CLAUDE.md, with AGENTS.md and AGY.md regenerated from it by
`scripts/sync-agent-docs.mjs`). The plan-reviewer and harvester prompts are
deliberately unchanged: they do not create backlog beads.

## Evidence shape

Evidence is `{ query, candidateIds, verdict }`:

- `query`: the search actually run (non-blank).
- `candidateIds`: ids of beads found to overlap (may be empty).
- `verdict`: `no-overlap` or `overlap`.

## Reviewer newTasks (enforced)

The reviewer does not create beads itself; the orchestrator creates them from
the `newTasks` in the verdict. Each newTask carries a `dedupCheck`.
`validateNewTask` (fleet-sprint/abort.mjs) rejects an item whose `dedupCheck`
is missing or malformed. `validateNewTaskWithDedup` is the entry point used by
all three creation sites (review, re-review, final-review):

- `no-overlap`: normal creation.
- `overlap`: the first candidate is probed with `bd show --json`. If it exists
  and is not closed, the proposed finding is appended to that bead's notes
  (append semantics, via the member-side staged body file, never shell
  interpolation) and NO new bead is created. A missing, closed or unsafe
  candidate id rejects the item.

Rejections use the existing per-item rejection and resurfacing path, so one bad
item never fails the whole verdict. For that reason `dedupCheck` is declared
loosely (an unconstrained object) in the canonical reviewer output schema and in
both fallback contracts; strictness is applied per item by the validator, not by
the schema.

## Integ-test-runner bugs (flagged, not blocked)

The integ-test-runner files bug beads directly, so creation cannot be
intercepted. Instead its report must include `dedupChecks`, one entry per filed
bug (`beadId` plus the evidence fields). The field is required in the runner's
output schema, its fallback, the auto-sprint workflow's schema copy and the
synthesized infra-failure stub.

After the report is parsed, `flagUnverifiedBugDedup` checks every id in
`bugsFiled`. An id is flagged when it has no entry, a blank query, or an
`overlap` verdict (a bead filed despite a found overlap). A flag is a WARN log
line plus an appended note beginning `[dedup-unverified]` on that bead, for
human review. It never fails the sprint and is skipped for an infra-inconclusive
stub, which files nothing.

## Invariants

- Keep the `dedupChecks` shape identical across the runner schema, the
  workflow's schema copy and fallbacks; a drift test in apra-pm guards this.
- Notes are only ever appended (`bd note`), never replaced.
- Bead ids and bodies reach the member shell only through validated ids and
  staged files.

## Known gap

A single malformed `dedupChecks` entry can still degrade the whole integ report
because the runner-side schema is stricter than the per-item handling; this is
tracked in the backlog.
