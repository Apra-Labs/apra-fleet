# Plan Review — PM Skill Fixes Sprint

> Reviewer: fleet-rev (PM session)
> Date: 2026-03-27
> Plan commit: 3392d94

---

## Coverage: Issues

| Issue | Covered | Plan Tasks | Notes |
|-------|---------|-----------|-------|
| #29 — Execution loop fix | YES | 1.1, 1.2, 1.3 | Front-loaded as Phase 1 (riskiest first). Correct approach: replace "PM reviews" with explicit reviewer dispatch flow. |
| #28 — Template names | YES | 2.1, 2.3 | Correctly distinguishes planning (execute_prompt, no CLAUDE.md), execution (tpl-claude.md), review (tpl-reviewer.md). |
| #18 — Safeguard docs | YES | 3.1, 3.3 | Table format with triggers, actions, limits, escalation criteria. All 4 safeguards documented. |
| #2 — Cleanup command | YES | 4.1, 4.3 | `/pm cleanup` in Available Commands. Covers git rm + rm -f CLAUDE.md on both members. |

## Coverage: Operational Feedback (13 items)

| # | Feedback Item | Plan Task | Status |
|---|--------------|-----------|--------|
| 1 | Pre-flight: verify member state | 2.2 | Covered |
| 2 | Pre-flight: verify reviewer SHA | 2.2 | Covered |
| 3 | Full issue details in requirements | 4.2 | Covered |
| 4 | plan-prompt.md in execute_prompt | 2.1 | Covered |
| 5 | Prep reviewer in parallel | 3.2 | Covered |
| 6 | Fresh session per review | 3.2 | Covered |
| 7 | SHA verification before review | 3.2 + 2.2 | Covered (both pre-flight and reviewer workflow) |
| 8 | Dispatch reviewer at every VERIFY | 1.1 + 1.2 | Covered (same as #29 fix) |
| 9 | CLAUDE.md sent before execution | 2.1 | Covered |
| 10 | Member icons mandatory | 4.2 | Covered |
| 11 | Read sub-documents | 4.2 | Covered |
| 12 | Verify URLs/repos | 4.2 | Covered |
| 13 | PM runs gh CLI directly | 4.2 | Covered |

**All 13 items mapped to specific plan tasks.**

## Structure & Ordering

- Phase ordering is correct: #29 (riskiest) → #28 (template refs) → #18 (safeguards) → #2 (cleanup + remaining)
- Every phase ends with a VERIFY checkpoint
- progress.json matches PLAN.md structure (4 phases, 12 tasks, 4 verify gates)
- Risk register identifies 4 risks with mitigations

## Findings

### 1. Minor: doer-reviewer.md Flow section line numbers are off

Plan says "lines 16-25" for the Flow section. Actual file has Flow at lines 14-24. Not a blocker — the plan describes the correct content and the rewrite will target the right section.

**Action:** Doer should use section headers (## Flow) to locate content, not line numbers.

### 2. Note: #28 current file state differs from bug description

Requirements #28 says both entries say `tpl-claude.md`, but the current `doer-reviewer.md` line 9 already reads:
```
Doer: plan-prompt.md (planning) or tpl-claude.md (execution)
```

The real issue is that this line still implies "send plan-prompt.md as CLAUDE.md for planning", which is incorrect (plan-prompt.md goes in execute_prompt, not as CLAUDE.md). The plan's Task 2.1 rewrite handles this correctly regardless.

**Action:** Doer should note the current file state already has `plan-prompt.md` in the text. The fix is still needed — the problem is the _implication_ that it's sent as CLAUDE.md, not the template name itself.

### 3. Consistency: troubleshooting.md aligns with safeguard escalation

troubleshooting.md line 9 ("Stuck after reset → escalate model haiku→sonnet→opus → flag user") matches the safeguard chain in Task 3.1. No conflict.

### 4. Consistency: SKILL.md monitoring section aligns

SKILL.md lines 66-69 mention session reset, model escalation, and blown checkpoints — all consistent with planned safeguard documentation. No contradictions.

### 5. Good: Single-member pair preservation noted

Risk register item 4 correctly flags that the setup checklist rewrite (#28) must preserve the single-member pair paragraph (doer-reviewer.md line 12). Plan explicitly calls this out.

## Quality Gate Pre-check

- [x] Plan covers all 4 issues
- [x] Plan covers all 13 feedback items
- [x] Riskiest fix front-loaded
- [x] Each phase has a VERIFY gate
- [x] No internal contradictions
- [x] Line references are close enough (section-level accuracy)
- [x] Risk register is reasonable

## Verdict

No blocking issues found. Two minor notes for the doer (line numbers, current file state for #28) — neither affects the plan's correctness.

---

APPROVED
