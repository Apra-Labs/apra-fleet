# Simple Sprint

Short task (1-3 items) for one member. No `PLAN.md` or `progress.json`.

## When to Use
- Small scope, low risk.
- 1 session work.

## Flow
1. Write `<project>/requirements.md`.
2. Dispatch doer (`execute_prompt`) with requirements.
3. Doer works, commits, pushes.
4. Dispatch reviewer (`resume=false`).
5. **APPROVED** → `backlog.md` → `cleanup.md` → PR.
6. **CHANGES NEEDED** → Feedback to doer → loop.

## Rules
- Pair doer/reviewer.
- Use `status.md` for tracking.
- Context file required.

## Recovery
1. Check `git log` and `status`.
2. **Work committed** → Proceed.
3. **Checkpoint** → Review.
4. **Unknown changes** → Flag user.
5. **No progress** → Restart.