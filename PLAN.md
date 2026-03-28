# PM Skill Fixes — Implementation Plan

> Sprint: pm-skill-fixes
> Branch: `sprint/pm-skill-fixes` from `main`
> Scope: `skills/pm/*.md` only

---

## Phase 1 — Fix Execution Loop (#29 + Feedback #8)

**Why first:** This is the foundational flow description. If it's wrong, all other changes build on a broken mental model. Riskiest assumption: the corrected flow in requirements.md is complete and accurate.

### Task 1.1 — Fix execution loop diagram in SKILL.md

- **File:** `skills/pm/SKILL.md` lines 57-63
- **Change:** Replace the execution loop diagram. Current says "PM reviews → resumes member". Replace with the correct flow: PM dispatches REVIEWER at every VERIFY checkpoint, reviewer commits verdict, PM acts on verdict (APPROVED → resume doer, CHANGES NEEDED → send feedback to doer).
- **Done:** The execution loop diagram explicitly shows: member stops → PM dispatches reviewer → reviewer verdicts → PM routes based on verdict. The words "PM reviews" do not appear in the loop.
- **Blocker:** None — this is a documentation fix.

### Task 1.2 — Fix flow section in doer-reviewer.md

- **File:** `skills/pm/doer-reviewer.md` lines 16-25
- **Change:** Ensure step 2-5 of the Flow section explicitly state that PM dispatches the reviewer (not self-reviews). Add clarity that at every VERIFY checkpoint the reviewer is dispatched, not just at plan review and final review. The current flow already mentions "dispatches reviewer" in step 3 but step 1-2 don't make it clear this happens at every checkpoint.
- **Done:** Flow section matches SKILL.md execution loop exactly. Every VERIFY checkpoint triggers reviewer dispatch.
- **Blocker:** None.

### Task 1.3 — VERIFY: Execution loop consistency

- **Type:** verify
- **Done:** SKILL.md execution loop and doer-reviewer.md flow section describe identical behavior. No references to "PM reviews" (meaning PM self-reviews) remain in either file.

---

## Phase 2 — Fix Template References (#28 + Feedback #4, #9)

### Task 2.1 — Fix setup checklist in doer-reviewer.md

- **File:** `skills/pm/doer-reviewer.md` lines 3-12
- **Change:** Rewrite the setup checklist item 4 to clarify three distinct phases:
  - **Planning:** `plan-prompt.md` content is dispatched via `execute_prompt` — no CLAUDE.md file needed
  - **Execution:** Send `tpl-claude.md` as CLAUDE.md to doer via `send_files` (persists across session resumes)
  - **Review:** Send `tpl-reviewer.md` as CLAUDE.md to reviewer via `send_files` (persists across session resumes)

  Also add explicit note: "CLAUDE.md must be sent before execution starts" (feedback #9).
- **Done:** Setup checklist correctly distinguishes planning (execute_prompt, no CLAUDE.md) from execution (tpl-claude.md as CLAUDE.md) and review (tpl-reviewer.md as CLAUDE.md). No reference to sending plan-prompt.md as CLAUDE.md.
- **Blocker:** None.

### Task 2.2 — Add pre-flight checklist (Feedback #1, #2)

- **File:** `skills/pm/doer-reviewer.md` (new section after Setup Checklist, before Flow)
- **Change:** Add a "Pre-flight Checks" section with two sub-sections:
  1. **Before any dispatch:** verify member branch, clean working tree, idle status via `fleet_status` + `execute_command → git status && git branch --show-current`
  2. **Before review dispatch:** verify reviewer is on correct branch at correct SHA via `execute_command → git rev-parse HEAD`
- **Done:** Pre-flight section exists with concrete commands for each check.
- **Blocker:** None.

### Task 2.3 — VERIFY: Template and pre-flight accuracy

- **Type:** verify
- **Done:** Setup checklist has no wrong template references. Pre-flight checklist has concrete commands. SKILL.md plan generation section (line 43) is consistent with doer-reviewer.md setup checklist.

---

## Phase 3 — Safeguard Documentation (#18) + Reviewer Workflow (Feedback #5-7)

### Task 3.1 — Add safeguards section

- **File:** `skills/pm/doer-reviewer.md` (new section: "Safeguards")
- **Change:** Document the full safeguard chain with triggers, actions, and escalation:

  | Safeguard | Trigger | PM Action | Limit |
  |-----------|---------|-----------|-------|
  | max_turns budget | execute_prompt dispatch | Session ends naturally | Per-dispatch (set in execute_prompt) |
  | PM retry limit | Same dispatch fails | Retry up to 3×, then pause sprint + flag user | 3 retries |
  | Doer-reviewer cycle limit | Reviewer returns CHANGES NEEDED | Re-dispatch doer with feedback, up to 3 cycles. If 3 cycles don't resolve all HIGH items, pause sprint + flag user | 3 cycles per phase |
  | Model escalation | Zero progress after session resets | haiku→sonnet→opus. Still zero after opus? Flag user | 2 resets per model tier |

  Add "When to escalate to user" summary: after 3 retries, after 3 review cycles with unresolved HIGHs, after opus still shows zero progress.
- **Done:** Safeguards section exists with table, triggers, actions, limits, and escalation criteria. All 4 safeguards documented.
- **Blocker:** None.

### Task 3.2 — Add reviewer workflow improvements (Feedback #5-7)

- **File:** `skills/pm/doer-reviewer.md` (in Flow section or new sub-section)
- **Change:** Add three rules to reviewer workflow:
  1. **Prep reviewer in parallel:** While doer works, send requirements + set up branch + start context-reading session on reviewer. Use session resume to send updated docs at handoff. (Feedback #5)
  2. **Fresh session per review:** Always use `resume=false` for review dispatches — never resume a stale review session. (Feedback #6)
  3. **SHA verification before review:** `execute_command → git rev-parse HEAD` on reviewer must match doer's pushed HEAD. (Feedback #7 — supplements pre-flight from Task 2.2)
- **Done:** All three reviewer rules are documented in doer-reviewer.md.
- **Blocker:** None.

### Task 3.3 — VERIFY: Safeguards and reviewer workflow

- **Type:** verify
- **Done:** Safeguard chain is complete (4 safeguards documented). Reviewer workflow rules are present. Troubleshooting.md is consistent with safeguard escalation path. SKILL.md monitoring section (lines 66-69) doesn't contradict new safeguard docs.

---

## Phase 4 — Cleanup Command (#2) + Remaining Feedback (#3, #10-13)

### Task 4.1 — Add `/pm cleanup` command

- **File:** `skills/pm/SKILL.md` (Available Commands section)
- **Change:** Add `/pm cleanup <project>` command that:
  - On each member (doer + reviewer): `execute_command → git rm PLAN.md progress.json feedback.md 2>/dev/null; rm -f CLAUDE.md; git commit -m "cleanup: remove fleet control files" && git push`
  - Run after merge, on both doer and reviewer members
  - Note: this formalizes the post-merge cleanup already in doer-reviewer.md step 6 as an explicit command
- **Done:** `/pm cleanup` appears in Available Commands with clear steps. Consistent with doer-reviewer.md post-merge cleanup.
- **Blocker:** None.

### Task 4.2 — Incorporate remaining feedback items

- **Files:** `skills/pm/SKILL.md`, `skills/pm/doer-reviewer.md`
- **Changes:**
  1. **Feedback #3** (full issue details in requirements) — Add to SKILL.md Plan Generation section: "Requirements must include full GitHub issue details — code locations, root causes, impact data. Never summarize into 2-3 line descriptions."
  2. **Feedback #10** (member icons mandatory) — Already stated in doer-reviewer.md line 2 and SKILL.md line 17. Add "This is mandatory, not optional" emphasis if not already present. (doer-reviewer.md line 2 already says "This is not optional" — verify SKILL.md pair command says the same.)
  3. **Feedback #11** (read sub-documents before executing) — Add to SKILL.md Core Rules: "Always read referenced sub-documents (doer-reviewer.md, permissions.md, etc.) before executing PM commands — steps in sub-docs are mandatory, not advisory."
  4. **Feedback #12** (verify URLs/repo names in generated content) — Add to SKILL.md Core Rules: "Verify URLs, repo names, and install methods in member-generated content before publishing — members hallucinate these."
  5. **Feedback #13** (PM runs gh CLI directly) — Already in SKILL.md rule 13. Verify wording is clear. If needed, strengthen: "PM runs gh CLI commands directly via Bash — never delegate to fleet members (they may lack permissions)."
- **Done:** All 5 remaining feedback items are incorporated. Each is traceable to a specific line in SKILL.md or doer-reviewer.md.
- **Blocker:** None.

### Task 4.3 — VERIFY: Final consistency check

- **Type:** verify
- **Done criteria (quality gates from requirements.md):**
  - [ ] All PM skill files are internally consistent
  - [ ] SKILL.md execution loop matches doer-reviewer.md flow exactly
  - [ ] No references to wrong template names anywhere
  - [ ] Safeguard documentation is complete and actionable
  - [ ] All 13 feedback items incorporated (checklist against requirements.md)
  - [ ] No "PM reviews" (self-review) language remains
  - [ ] `/pm cleanup` command documented and consistent with doer-reviewer.md post-merge cleanup

---

## Risk Register

| Risk | Impact | Mitigation |
|------|--------|------------|
| Execution loop fix (#29) creates inconsistency with other sections | HIGH — cascading confusion | Task 1.3 verify explicitly checks cross-file consistency |
| Safeguard limits (3 retries, 3 cycles) may not match actual tool behavior | MEDIUM — misleading docs | Verify against execute_prompt max_turns parameter and existing troubleshooting.md |
| Feedback items overlap with existing text, causing duplication | LOW — redundant text | Each task checks existing content before adding |
| Setup checklist rewrite (#28) breaks the single-member pair flow | MEDIUM — edge case regression | Task 2.1 must preserve the single-member pair paragraph |
