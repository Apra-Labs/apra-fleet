# Plan Generation Prompt

Send to member via `execute_prompt`:

---

Generate implementation plan. Read `requirements.md`.

### Phase 0: Explore
1. Read source + tests.
2. `git log --oneline -20`.
3. List assumptions. Verify **Existence** (it's there) and **Accessibility** (it's reachable).
4. Report patterns and constraints.

### Phase 1: Draft
Each task:
- Files to change.
- Specific change (not vague).
- "Done" criteria.
- Blockers.
- **Tier:** `cheap` (mechanical), `standard` (typical), `premium` (complex).

**Rules:**
- **Phases by cohesion:** reviewable, testable units. Natural boundaries.
- **One session, one commit** per task.
- **Order by dependency.**
- **Plan = Elaboration:** Resolve all ambiguity.
- **Monotonic tiers:** Within phase, order `cheap` → `standard` → `premium`. No downgrades. Split phase if tier drops.

### Phase 2: Foundations First
1. Abstractions/interfaces.
2. Riskiest assumptions.
- Follow DRY.

### Phase 3: Critique
- High cohesion, low coupling.
- No vague/large tasks.
- Early verification.
- Correct order.
- Tracked work: every "must change" needs a task.
- Tier order: check for downgrades in phase.

### Phase 4: Refine
Rewrite per critique.

### Phase 5: Branch & Commit
1. `git fetch origin`.
2. `git checkout -b <branch> origin/<base>`.
3. Commit plan to branch.
4. `git push`.

Output in `tpl-plan.md` format.