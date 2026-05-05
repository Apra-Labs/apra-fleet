# Multi-Pair Sprint

Multiple doer/reviewer pairs work on separate git branches (worktrees). Use when work partitions into independent tracks.

## Usage

- Large sprint, independent low-coupling tracks.
- Parallel work without blocking.
- Clear boundaries (frontend/backend).

Sequential or tightly coupled? Use `single-pair-sprint.md`.

## Branching

Branches off sprint base (integration branch):
```
main → sprint/<name> (base) → sprint/<name>/pair-N (working)
```

- PM creates base branch before dispatch.
- Doer works only on their pair branch.
- PM handles integration.

## Contracts

PM identifies shared interfaces (APIs, models) in `<project>/contracts.md`. Sent via `send_files`.
Immutable during sprint. Changes? Notify PM. PM assigns revision to one pair; other waits for approval/merge.

## Coordination

- Assign tracks at start. Document in `<project>/status.md`.
- Monitor pairs in parallel.
- Dependencies? Pair waits for review/merge into base.
- PM handles cross-pair sync (merge/rebase).

## Integration

1. Pair follows `doer-reviewer.md` loop on their branch.
2. APPROVED? PM merges into base.
3. PM notifies others to rebase.
4. All merged? Update `backlog.md`, cleanup members, raise one PR to main.

## Reviewer Scope

- Review own pair's deliverables.
- Optional: cross-pair integration review before final PR.

## Status

Record in `<project>/status.md`:
| Pair | Doer | Reviewer | Track | Branch | Status |
|------|------|----------|-------|--------|--------|
