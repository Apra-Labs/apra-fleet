## How to wire the beads dependency graph (canonical -- do not restate elsewhere)

**The rule:** `parent-child` (via `--parent`) is for grouping only. `blocks` (via `bd dep
add`) is for ordering only. **Never add a `blocks` edge between a bead and its own
`--parent` ancestor/descendant, in either direction, regardless of issue_type.** A
`parent-child` edge one way plus a `blocks` edge the other way, between the same two
beads, deadlocks both of them -- and `bd dep cycles` will not warn you (it does not check
`parent-child` paths). Always verify with the scoped, ready-work-aware check instead:
`bd list --parent <scope-id> --ready --json` must be non-empty whenever open work exists
under `<scope-id>`; if it's empty, walk the scope's beads for a `blocks` edge pointing at
a `parent-child` ancestor/descendant and remove it.

**How to wire a decomposed item correctly:**
- Parent the subtasks under the item being decomposed: `bd create ... --parent <item-id>`.
- Order subtasks relative to EACH OTHER with `blocks` (e.g. "test task blocked by impl
  task" -- they're siblings, this is fine): `bd dep add <test-task> <impl-task>`.
- Never `bd dep add <item-id> <subtask-id>` or `bd dep add <subtask-id> <item-id>` -- the
  item's "not done until subtasks close" status comes from inspecting its children
  (`dependent_count`, `bd epic status <id>` for epic-typed parents), never from a `blocks`
  edge back onto them.
- `blocks` between an epic and a non-epic is rejected by bd outright ("epics can only
  block other epics, not tasks") -- but this protection does NOT extend to `task`/`bug`/
  `feature`/`chore` parents blocking their own same-type children. Don't rely on bd to
  catch the mistake for you on those types; follow the rule above regardless of type.
- Don't retype a bead just to change its dispatch eligibility (e.g. relabeling a `[bug]`
  task as `epic` so it stops showing up as leaf work) -- `issue_type` has no effect on
  `bd ready`/`--ready` inclusion, so it doesn't even work, and it mislabels the bead. If a
  decomposed item shouldn't be dispatched as leaf work, that's a dispatch-time filter
  (exclude any ready bead whose id appears as another in-scope bead's `.parent` field),
  not a bead-data change.

**Scoping every query to the current sprint, not the whole project:**
- Use `bd list --parent <sprint-root-id> ...` for anything meant to reflect "this sprint's
  work" (ready, open, closed, blocked). Bare `bd ready` / `bd list --status=...` return
  project-wide results, including other sprints/tracks that may be running concurrently.
- `--parent` takes exactly one id per call. If you have more than one sprint-root id,
  query each separately and merge the results yourself -- a comma-joined list
  (`--parent a,b`) is silently treated as one nonexistent id and returns nothing.
- `bd epic status <id>` only produces meaningful output when `<id>` is itself
  `issue_type=epic` -- check the type first (`bd show <id> --json`, read `issue_type`)
  before relying on its output; on a non-epic id it silently lists unrelated epics instead
  of erroring.

**Marking a task as verification work:** prefix its title with `[test]` -- this is a
string convention every consumer (planner, integ-test-runner, the dashboard) matches on
independently; there's no separate bd mechanism for it, so the prefix is the whole
contract.
