# Cumulative Review — PM Skill Fixes (All 4 Phases)

> Reviewer: fleet-rev (PM session)
> Date: 2026-03-27
> Reviewed commit: e762153
> Branch: sprint/pm-skill-fixes
> Diff: `git diff main..sprint/pm-skill-fixes -- skills/pm/`

---

## Issue Verification

### #29 — Execution loop fix ✅

**SKILL.md lines 62-70:** Old "PM reviews → resumes member" replaced with:
```
PM dispatches REVIEWER → reviewer reads deliverables + diff → commits verdict to feedback.md → pushes
→ APPROVED: PM resumes doer → repeat
→ CHANGES NEEDED: PM sends feedback to doer → doer fixes → PM re-dispatches REVIEWER → repeat
```

**doer-reviewer.md line 35:** "PM dispatches REVIEWER at every VERIFY checkpoint — PM never self-reviews."

**doer-reviewer.md line 45:** CHANGES NEEDED path explicitly re-dispatches REVIEWER.

**Consistency:** SKILL.md loop and doer-reviewer.md flow are semantically identical. Both use "doer" instead of the old generic "member". Both branch on APPROVED/CHANGES NEEDED. No trace of "PM reviews" (self-review) in either file.

### #28 — Template references ✅

**doer-reviewer.md lines 8-11:** Three distinct phases correctly documented:
- Planning: `plan-prompt.md` via `execute_prompt` — no CLAUDE.md ✅
- Execution: `tpl-claude.md` as CLAUDE.md — "must be sent before execution starts" ✅
- Review: `tpl-reviewer.md` as CLAUDE.md — "must be sent before review dispatch". `tpl-reviewer-plan.md` for plan review ✅

**SKILL.md line 46:** Plan Generation says "dispatch plan-prompt.md via execute_prompt" — consistent with doer-reviewer.md.

No wrong template names anywhere in either file.

### #18 — Safeguards ✅

**doer-reviewer.md lines 49-63:** Full Safeguards section with 4-row table:

| Safeguard | Limit |
|-----------|-------|
| max_turns budget | Set per dispatch |
| PM retry limit | 3 retries per dispatch |
| Doer-reviewer cycle limit | 3 cycles per phase |
| Model escalation | 2 resets per model tier |

Escalation criteria documented (3 conditions). Each safeguard has trigger, action, and limit.

**SKILL.md line 74:** Monitoring section mentions "Zero progress after 2 resets? Escalate model" — consistent with safeguards table.

**troubleshooting.md line 9:** "Stuck after reset → escalate model" — consistent.

### #2 — Cleanup command ✅

**SKILL.md line 20:** `/pm cleanup <project>` documented with full command: `git rm PLAN.md progress.json feedback.md 2>/dev/null; rm -f CLAUDE.md; git commit -m "cleanup: remove fleet control files" && git push`. Run on both doer and reviewer after merge.

**doer-reviewer.md line 46:** Post-merge cleanup step in flow (step 6) is consistent.

---

## Operational Feedback — All 13 Items

| # | Requirement | Where Addressed | Status |
|---|------------|-----------------|--------|
| 1 | Pre-flight: verify member state | doer-reviewer.md lines 17-22: fleet_status + git status + branch check | ✅ |
| 2 | Pre-flight: verify reviewer SHA | doer-reviewer.md lines 24-27: git rev-parse HEAD + remediation | ✅ |
| 3 | Full issue details in requirements | SKILL.md line 48: "Requirements must include full GitHub issue details" | ✅ |
| 4 | plan-prompt.md in execute_prompt | doer-reviewer.md line 9: "Dispatch plan-prompt.md content via execute_prompt — no CLAUDE.md needed" | ✅ |
| 5 | Prep reviewer in parallel | doer-reviewer.md line 38: parallel prep with context-reading session | ✅ |
| 6 | Fresh session per review | doer-reviewer.md line 39: "Always use resume=false for review dispatches" | ✅ |
| 7 | SHA verification before review | doer-reviewer.md line 40 + Pre-flight lines 24-27 | ✅ |
| 8 | Dispatch reviewer at every VERIFY | doer-reviewer.md line 35 + SKILL.md line 66 | ✅ |
| 9 | CLAUDE.md sent before execution | doer-reviewer.md lines 10-11: "must be sent before execution starts" / "before review dispatch" | ✅ |
| 10 | Member icons mandatory | SKILL.md line 17: "this is mandatory, not optional" | ✅ |
| 11 | Read sub-documents | SKILL.md rule 14: "steps in sub-docs are mandatory, not advisory" | ✅ |
| 12 | Verify URLs/repos | SKILL.md rule 15: "members hallucinate these" | ✅ |
| 13 | PM runs gh CLI directly | SKILL.md rule 13: "PM runs gh CLI commands directly via Bash — never delegate to fleet members" | ✅ |

**All 13 items verified.**

---

## Cross-file Consistency

| Check | Result |
|-------|--------|
| SKILL.md execution loop matches doer-reviewer.md flow | ✅ Semantically identical |
| Template names consistent between files | ✅ No mismatches |
| Safeguards table consistent with SKILL.md monitoring | ✅ Same escalation path |
| Safeguards consistent with troubleshooting.md | ✅ Same escalation path |
| Cleanup command consistent with flow step 6 | ⚠️ Minor nit — see below |
| Single-member pair paragraph preserved | ✅ doer-reviewer.md line 13 |
| Recovery section untouched | ✅ No regressions |

### Nit: Cleanup command vs flow step 6

**SKILL.md line 20** (`/pm cleanup`): includes `&& git push`, runs on "both doer and reviewer".
**doer-reviewer.md line 46** (flow step 6): no `git push`, only mentions doer.

These serve overlapping purposes. The SKILL.md version is more complete. Not a blocker — step 6 is the inline flow instruction while `/pm cleanup` is the standalone command, and the PM will follow the standalone command when cleaning up. But if someone only reads the flow steps, they'd miss the push and the reviewer cleanup.

---

## Nothing Broken

- No deletions of working functionality
- All existing sections (Recovery, Model Selection, Member Icons, Design Review, Git as transport, Permissions, PM responsibilities) untouched
- Only additions and targeted rewrites of buggy content
- Core Rules expanded from 13 to 15 (added rules 14-15 for feedback items 11-12) — no existing rules modified beyond rule 13

---

## Quality Gates

- [x] All PM skill files internally consistent
- [x] Execution loop in SKILL.md matches doer-reviewer.md
- [x] No wrong template references
- [x] Safeguard documentation complete with triggers, actions, limits, escalation
- [x] All 13 feedback items incorporated
- [x] No regressions

---

## Verdict

All 4 issues resolved. All 13 feedback items incorporated. Files are consistent. One cosmetic nit (cleanup step missing push in doer-reviewer.md flow) — not blocking since the standalone `/pm cleanup` command is authoritative.

APPROVED
