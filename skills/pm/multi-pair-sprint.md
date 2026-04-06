# Multi-Pair Sprint

A multi-pair sprint assigns multiple doer/reviewer pairs to the same sprint, each working on a separate git branch (worktree). Use this when the work can be cleanly partitioned into independent tracks.

## When to use

- Large sprint where tasks can be split into independent, low-coupling tracks
- Two or more pairs can work in parallel without blocking each other
- Each track has a clear boundary (e.g. frontend / backend, service A / service B)

Use a single-pair sprint (sprint.md) if the work is sequential or tightly coupled.

## Branching Strategy

Each pair works on its own feature branch off the sprint base branch:

```
main
 └── sprint/<name>          ← sprint base branch (integration branch)
      ├── sprint/<name>/pair-1   ← pair 1's working branch
      └── sprint/<name>/pair-2   ← pair 2's working branch
```

- PM creates the sprint base branch before dispatching any pair
- Each pair's doer works only on their own branch — never the base or another pair's branch
- Pairs do not merge into the base branch themselves — PM handles integration

## Coordination Rules

- Assign tracks at sprint start — document in `<project>/status.md` which pair owns which tasks
- Pairs work independently; PM monitors all pairs in parallel
- If pair 2 depends on output from pair 1: pair 2 does not start until pair 1's track is reviewed and merged into the sprint base branch
- PM handles cross-pair git sync: `git merge sprint/<name>/pair-1 into sprint/<name>/pair-2` when needed

## Integration Flow

1. Each pair follows the standard doer-reviewer loop (see doer-reviewer.md) on their own branch
2. When a pair's track is APPROVED: PM merges that pair's branch into the sprint base branch via `execute_command`
3. PM notifies dependent pairs to rebase: `git fetch origin && git rebase origin/sprint/<name>`
4. Once all pairs are APPROVED and merged into the sprint base branch: run cleanup on all members, then raise a single PR from the sprint base branch to main (see cleanup.md)

## Reviewer Scope

- Each reviewer reviews their own pair's deliverables only
- A cross-pair integration review is optional but recommended before raising the final PR — assign one reviewer to review the merged sprint base branch diff against main

## Status Tracking

Record all pairs in `<project>/status.md`:

```
| Pair | Doer | Reviewer | Track | Branch | Status |
|------|------|----------|-------|--------|--------|
| 1    | dev1 | rev1     | API   | sprint/x/pair-1 | in-progress |
| 2    | dev2 | rev2     | UI    | sprint/x/pair-2 | waiting-pair-1 |
```
