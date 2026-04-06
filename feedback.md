# Skill Refactor Plan Review — feedback.md

**Reviewer:** sprint/ux-quality-fixes member  
**Date:** 2026-04-05  
**Verdict:** APPROVED

---

## Evaluation

### 1. Content split correctness (SKILL.md + doer-reviewer.md vs requirements)

**Pass.** The plan correctly identifies all fleet mechanics in `skills/pm/SKILL.md`:
- Rules 3, 4, 8, 11, 13 — all fleet infrastructure (dispatch, onboarding, permissions, tool boundaries)
- Task Harness `send_files` mechanics, Monitoring `execute_command` patterns, Model Selection tier resolution, Member Icons server assignment, Provider Awareness table — all fleet concerns
- Files to move (onboarding.md, permissions.md, troubleshooting.md, skill-matrix.md, auth-*.md) — all entirely fleet mechanics with zero PM workflow content

What correctly stays in PM: Rules 1, 2, 5-7, 9-10, 12, 14-15, Lifecycle, Plan Generation, Execution Loop logic, Recovery, Design Review, Commands. These are all workflow orchestration.

### 2. @fleet reference mechanism

**Pass.** The plan correctly identifies this as the riskiest unknown and front-loads it in Task 1. The prose reference pattern ("see the fleet skill") matches how `tpl-claude-pm.md` already references the pm skill ("follow the pm skill"). The fallback to explicit file-path references (`See skills/fleet/SKILL.md`) is pragmatic. Validating before any content moves is the right call.

### 3. Task ordering and risk front-loading

**Pass.** Order is correct:
- Task 1 (HIGH risk): Validate reference mechanism before anything moves
- Task 2: Populate fleet skill — must exist before PM skill can reference it
- Task 3: Refactor PM skill — depends on Task 2
- Task 4: Trim doer-reviewer.md — depends on Task 2 (fleet skill must be populated)
- Task 5: Verify — must be last content task
- Task 6: VERIFY checkpoint — standard gate

No reordering needed.

### 4. Task 5 verification thoroughness

**Pass with minor note.** The 5 checks cover:
- Forward contamination (fleet tool names in pm/) — good
- Backward contamination (PM workflow terms in fleet/) — good
- File move completeness — good
- Frontmatter validity — good
- Bidirectional cross-references — good

**Minor note:** `tpl-deploy.md` has one `execute_command` reference in a comment (line 4). Task 5's grep will catch this — it's a legitimate brief mention in context, not inline usage instructions, so it should pass the "backtick-quoted commands" filter. No action needed, just flagging for awareness.

### 5. Missed content check

**Pass.** Checked all files in `skills/pm/`:
- `init.md` — PM workflow (project folder setup, template population). No fleet tool mechanics. Correctly stays in PM.
- `plan-prompt.md` — PM planning workflow. Stays in PM. ✓
- `tpl-*.md` — PM templates. Stay in PM. ✓
- `profiles/` — Permission profiles used by `compose_permissions`. These could arguably move to fleet, but they're consumed by the fleet tool server-side, not by the skill docs. Keeping them in pm/ is fine — they're project configuration, not fleet mechanics documentation.

No content missed.

---

## Summary

The plan is well-structured, correctly scoped, and risk-ordered. The content split accurately separates fleet infrastructure mechanics from PM workflow orchestration. All files that should move are identified, and the replacement references are appropriately concise. No changes needed.
