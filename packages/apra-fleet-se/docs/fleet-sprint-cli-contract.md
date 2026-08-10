# fleet-sprint Engine Contract: CLI Flags and Issue-Scope Resolution

This is the wire/argument-level contract for the fleet-sprint engine: the
exact CLI flags `bin/cli.mjs` accepts, how they map onto the runner's own
`validateArgs()` contract (`fleet-sprint/runner.js`), and -- in detail --
the `--issue` scope-resolution algorithm (`bdListScoped()`), which is not
documented precisely anywhere else in this package.

For the full flag table (types, defaults, descriptions), preconditions
`main()` runs before any dispatch, and fleet-server/schema resolution, see
`docs/cli-reference.md` -- **do not duplicate that here**. This document
covers only:

1. The `--issue` -> `target_issues` mapping detail (a gap in cli-reference.md).
2. The runner's own `validateArgs()` contract, as distinct from the CLI's
   pre-validation of the same fields (two layers, same regexes).
3. The `--issue` scope-resolution algorithm (`bdListScoped()`), worked
   examples included.

## 1. `--issue` is comma-separated at the CLI, an array at the runner

`bin/cli.mjs` (`parseCliArgs()`, around line 468):

```js
const targetIssues = values.issue.split(',').map(s => s.trim()).filter(Boolean);
```

So `--issue epic-1,epic-2` becomes `['epic-1', 'epic-2']`, and this array is
forwarded to the runner as `target_issues` (`buildRunnerArgs()`, line ~306-308).
**The CLI supports multiple target issues.** This is a different contract
from the supervisor's `POST /api/sprints` HTTP endpoint, whose `issue` field
is a single string passed straight to `validateIssueId()` (which rejects a
comma as an invalid character) -- see `packages/apra-fleet-se/docs/supervisor-api.md`
and the filed gap `apra-fleet-ymf`. If you need multi-issue scope over HTTP
today, there is no supported field for it; only the CLI (`--issue a,b`) and
the raw runner arg (`target_issues: ['a','b']`) accept more than one id.

## 2. Two validation layers, one set of regexes

Both `bin/cli.mjs` and `fleet-sprint/runner.js` validate issue ids and
branch names against the SAME patterns (`runner.js` exports
`validateIssueId`/`validateBranchName`; the CLI imports and reuses them --
single source of truth, not two independently-maintained regexes):

- `ISSUE_ID_PATTERN = /^[A-Za-z0-9._-]+$/` -- letters, digits, `.`, `_`, `-` only. No commas, no slashes, no spaces.
- `BRANCH_NAME_PATTERN = /^[A-Za-z0-9._/-]+$/` -- same, plus `/`.
- `GOAL_PATTERN = /^P[1-3](\/P[1-3]){0,2}$/` -- `P1`, `P1/P2`, `P1/P2/P3`, etc, checked only in the runner's `validateArgs()` (the CLI's `--goal` help text documents the same pattern but does not itself re-check it before forwarding).

The CLI checks these BEFORE opening the fleet MCP connection (defense in
depth: a malformed id never reaches a shell interpolation even if this CLI
layer were bypassed and the runner invoked directly -- which is exactly what
`fleet-sprint/runner.js`'s own `validateArgs()` re-checks, again, as the
final gate before any `command()`/`agent()` dispatch). Both layers throw the
same `[Arg Contract] Invalid issue id "..."` / `[Arg Contract] Invalid ...
branch name "..."` message shape.

### Runner's own `validateArgs()` contract (`fleet-sprint/runner.js`, ~line 2421)

Called once, at the top of `main(context)`, on the raw `args` object passed
in (by the CLI's `engine.executeFile()` call, or directly by a test/other
caller). Rejects unknown keys outright (`KNOWN_ARG_KEYS` is an explicit
allowlist -- see the list in the source for every key the engine currently
recognizes, including test-only/programmatic-only keys like
`doer_worklist_mode` that have no CLI flag).

Required:
- `target_issues` (non-empty string array) OR legacy `target_issue` (string) -- at least one of the two; `target_issues` is preferred. Each entry validated with `validateIssueId`.
- `members` (non-empty string array, every entry a non-empty string).
- `branch` (string, `validateBranchName`).
- `base_branch` (string, `validateBranchName`).

Optional (defaults applied inside `validateArgs()`):
- `goal` -- default `'P1/P2'`; must match `GOAL_PATTERN`.
- `max_cycles`, `requirementsFile`, `roleMap`, `budget`, `dispatch_timeout_s`, `serviceUrl`, `assignee`, `doer_worklist_mode`, `resume_model_switch`, `worklist_effort_budget`, `callTool` -- see `KNOWN_ARG_KEYS` in the source for the authoritative, currently-recognized set and which of these have a CLI flag vs. are programmatic-only.

An unknown key throws `[Arg Contract] Unknown arg(s): <keys>. Known args: <allowlist>.` immediately -- this is the fastest way to discover whether a given engine feature (e.g. `assignee`, `doer_worklist_mode`) is wired to a CLI flag yet: if `bin/cli.mjs` never sets it, it stays at its default forever for CLI-launched sprints.

## 3. `--issue` scope resolution (`bdListScoped()`, `fleet-sprint/runner.js` ~line 5099)

This is the algorithm that turns the sprint's target issue id(s) into the
set of beads every dispatch (planner, doer, reviewer) is allowed to see and
work. It backs every `bd list`-shaped query the engine issues internally
(ready beads, status checks, closure checks, etc) -- there is no other way
in or around it.

### Why it exists (not `bd list --parent`)

`bd list --parent <id>` accepts exactly one id per invocation (a
comma-joined list is treated as one nonexistent id and returns `[]`), and
it is single-level only -- it returns direct children, never grandchildren.
A level-3+ descendant of a target issue would therefore be invisible to
dispatch scope, not just to the dashboard tree. `bdListScoped()` avoids this
by fetching the WHOLE project's beads once (`bd list --all --limit 0
--json` -- `--all` because closed issues are excluded by default, which
would orphan a closed node's subtree from discovery; `--limit 0` because
the default row cap could silently truncate a large scope) and then doing
the descendant walk itself, in memory.

### The algorithm

1. Fetch every bead in the project once per call (cached/coalesced across
   concurrent callers via `fetchAllBeadsShared()` / `allBeadsSnapshot`).
2. Build a `parent id -> [children]` map from every bead's `.parent` field.
3. **BFS from every target issue id** (`targetIssues`, i.e. every id passed
   via `--issue`/`target_issues`): starting with the target ids as the
   initial frontier, repeatedly add each frontier bead's children (any
   status, any depth) to `scopeIds` and to the next frontier, until no new
   ids are discovered. This finds every descendant at any depth, for every
   target, in one pass -- multi-target scopes are just the union, with no
   separate code path.
4. **Childless-leaf seeding**: after the BFS, for every target issue id
   that has NO children (`!childrenOf.has(id)` or an empty children array),
   add that id itself to `scopeIds`. The BFS only ever adds descendants,
   never the targets themselves, so without this step a sprint aimed at a
   single undecomposed issue would resolve to an EMPTY scope.
5. **A target WITH children is a pure grouping node**: its own id is
   deliberately left OUT of `scopeIds` (only its descendants are in-scope).
   It still shows up in the scope indirectly, because it is some child's
   `.parent`, and `readyLeafBeads()`'s decomposed-node guard already
   excludes any bead that is itself somebody else's parent from being
   selected as leaf work. The net effect: an epic/feature target is never
   independently dispatched as a work item, only its leaf descendants are.
6. If `scopeIds` ends up empty, `bdListScoped()` returns `[]` immediately
   (every subsequent `bd list` call for this sprint short-circuits to no
   results).
7. With no extra filter args (`bdListScoped('')`), the result is simply
   every fetched bead whose id is in `scopeIds`.
8. With filter args (e.g. `bdListScoped('--ready --json')`), a SECOND,
   project-wide `bd list <args> --limit 0` query is issued (because
   readiness and other bd-computed properties cannot be reliably
   replicated by an in-memory filter over the already-fetched snapshot),
   and its results are intersected with `scopeIds`. When the sprint has an
   `assignee` configured, `--assignee <id>` is appended to this query so
   two sprints working the same project never select the same bead.

### Worked examples

**Example A -- epic with a 2-level hierarchy.** Epic `X` has children `A`
and `B`; `B` has child `C` (a grandchild of `X`). `--issue X`:
- BFS frontier: `[X]` -> discovers `A`, `B` -> pushes `A`, `B` -> discovers
  `C` (child of `B`) -> pushes `C` -> no further children.
- `scopeIds = { A, B, C }`.
- `X` has children, so it is NOT added by the childless-leaf seeding step;
  `X` itself never appears in `scopeIds`.
- Result: the sprint's dispatch scope is `{A, B, C}`. If `A` and `C` are
  leaf tasks and `B` is itself decomposed (has child `C`), `readyLeafBeads()`
  further excludes `B` (it is `C`'s parent) -- only `A` and `C` are
  independently dispatchable leaf work; `X` and `B` are pure grouping nodes.

**Example B -- a single undecomposed issue.** Issue `Y` has no children.
`--issue Y`:
- BFS frontier: `[Y]` -> no children found -> `scopeIds` stays empty after
  the BFS.
- Childless-leaf seeding: `Y` has no children, so `Y` is added to
  `scopeIds`.
- Result: `scopeIds = { Y }`. The sprint's entire scope is just `Y` itself,
  and it is directly dispatchable as leaf work (nothing else has it as a
  parent).

**Example C -- multi-target union.** `--issue X,Y` (epic `X` as in Example
A, plus standalone `Y` as in Example B):
- The BFS frontier starts as `[X, Y]`; the walk and the childless-leaf
  seeding step both run per-target as described above, and results union
  naturally since `scopeIds` is a single `Set` accumulated across every
  target.
- Result: `scopeIds = { A, B, C, Y }`.

### Practical implication for `--issue`

Pointing `--issue` at an epic/feature pulls in its ENTIRE subtree (every
descendant, any depth, any status) as the sprint's working scope, but the
epic/feature node itself is never directly dispatched -- only its leaf
descendants are. Pointing `--issue` at a leaf (childless) issue scopes the
sprint to exactly that one issue. There is no flag to scope to "this node
only, not its descendants" when the node has children -- targeting a
grouping node always pulls in its full subtree.
