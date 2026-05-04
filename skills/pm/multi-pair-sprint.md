# Multi-Pair Sprint

Multiple doer/reviewer pairs on separate branches. Use for independent tracks.

## Branching
```
main
 └── sprint/<name> (base)
      ├── sprint/<name>/pair-1
      └── sprint/<name>/pair-2
```
- PM creates base branch.
- Each pair works on its own branch.
- PM handles integration.

## Contracts
Identify shared interfaces (APIs, models) first. Document in `<project>/contracts.md`. Both doers receive via `send_files`. Contracts immutable unless PM approves revision.

## Rules
- Assign tracks in `status.md`.
- Pairs work independently.
- PM handles cross-pair sync (merges).

## Integration
1. Each pair follows `doer-reviewer.md`.
2. Pair APPROVED → PM merges into base.
3. Dependents rebase: `git fetch` + `rebase origin/sprint/<name>`.
4. All APPROVED → `backlog.md` update → `cleanup.md` → raise single PR to `main`.

## Review
Reviewers check their own pair's work. Optional integration review of base branch.

## Status
Track in `status.md`.