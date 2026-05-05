# Multi-Pair Sprint

A multi-pair sprint assigns multiple doer/reviewer pairs to the same sprint, each working on a separate git branch. Use this when the work can be partitioned into independent tracks.

## When to use

- Large sprints where tasks can be split into independent, low-coupling tracks.
- Two or more pairs can work in parallel without blocking each other.
- Each track has a clear boundary, such as frontend and backend or service A and service B.

Use a single-pair sprint (single-pair-sprint.md) if the work is sequential or tightly coupled.

## Branching Strategy

Each pair works on its own feature branch off the sprint base branch:

```
main
 └── sprint/<name>          ← sprint base branch (integration branch)
      ├── sprint/<name>/pair-1   ← pair 1's working branch
      └── sprint/<name>/pair-2   ← pair 2's working branch
```

- The PM creates the sprint base branch before dispatching any pair.
- Each pair's doer works on their own branch; they never use the base or another pair's branch.
- Pairs do not merge into the base branch; the PM handles integration.

## Contracts

Before dispatching either pair, the PM identifies shared interfaces such as APIs, data models, file formats, and event schemas that both tracks will depend on. These are documented in `<project>/contracts.md` and sent to both doers via `send_files`.

Both pairs treat contracts as immutable during the sprint. If a pair discovers a contract change is necessary, they stop and notify the PM. The PM assigns the contract revision to one pair; the other waits until it is APPROVED and merged before continuing.

## Coordination Rules

- Assign tracks at sprint start; document in `<project>/status.md` which pair owns which tasks.
- Pairs work independently; the PM monitors all pairs in parallel.
- If pair 2 depends on output from pair 1, pair 2 does not start until pair 1's track is reviewed and merged into the sprint base branch.
- The PM handles cross-pair git sync, such as `git merge sprint/<name>/pair-1 into sprint/<name>/pair-2` when needed.

## Integration Flow

1. Each pair follows the standard doer-reviewer loop (see doer-reviewer.md) on their own branch.
2. When a pair's track is APPROVED, the PM merges that pair's branch into the sprint base branch via `execute_command`.
3. The PM notifies dependent pairs to rebase: `git fetch origin && git rebase origin/sprint/<name>`.
4. Once all pairs are APPROVED and merged into the sprint base branch: update `<project>/backlog.md` with unresolved findings or deferred items, run cleanup on all members, and raise a single PR from the sprint base branch to main (see cleanup.md).

## Reviewer Scope

- Each reviewer reviews their own pair's deliverables only.
- A cross-pair integration review is optional but recommended before raising the final PR. Assign one reviewer to review the merged sprint base branch diff against main.

## Status Tracking

Record all pairs in `<project>/status.md`:

```
| Pair | Doer | Reviewer | Track | Branch | Status |
|------|------|----------|-------|--------|--------|
| 1    | dev1 | rev1     | API   | sprint/x/pair-1 | in-progress |
| 2    | dev2 | rev2     | UI    | sprint/x/pair-2 | waiting-pair-1 |
```
