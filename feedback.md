# Skill Refactor Implementation Review — Issue #66

**Reviewer:** sprint/skill-refactor reviewer  
**Date:** 2026-04-06  
**Verdict:** APPROVED

---

## Review Checklist

### 1. Completeness — fleet/SKILL.md contains all required fleet mechanics

| Mechanic | Status | Location |
|----------|--------|----------|
| Provider awareness table | PASS | Lines 174-185 — covers instruction file naming, permissions, model tiers, CLI commands, attribution, timeouts |
| Model tiers | PASS | Lines 157-161 — cheap/standard/premium, server resolves via modelTiers() |
| execute_prompt mechanics | PASS | Lines 56-57 — background subagent dispatch, run_in_background=true |
| execute_command tunnel rule | PASS | Lines 50-53 — tool boundaries, fleet tools are canonical interface |
| send_files/receive_files | PASS | Lines 80-94 — task harness delivery + delivery mechanics sections |
| compose_permissions mechanics | PASS | Lines 150-154 + permissions.md sub-document |
| Background subagent requirement | PASS | Line 57 — "Never block on a dispatch — always fire and monitor" |
| dangerously_skip_permissions ban | NOTE | Not in fleet skill. Currently only in pm/SKILL.md rule 8. Non-blocking — see observation below. |

**Sub-documents present:** onboarding.md, permissions.md, troubleshooting.md, skill-matrix.md, auth-github.md, auth-bitbucket.md, auth-azdevops.md — all moved from pm/ to fleet/.

### 2. Clean PM skill — zero fleet tool mechanics

**PASS.** Grep for all 21 fleet tool names (execute_prompt, execute_command, send_files, receive_files, compose_permissions, monitor_task, register_member, remove_member, update_member, fleet_status, member_detail, list_members, provision_auth, provision_vcs_auth, setup_ssh_key, setup_git_app, cloud_control, shutdown_server, update_llm_cli, update_task_tokens, revoke_vcs_auth) returned **zero matches** in pm/SKILL.md.

PM references fleet mechanics exclusively via "see the fleet skill" prose pattern.

### 3. No duplication

**PASS.** Same grep across pm/SKILL.md and doer-reviewer.md — no fleet tool names appear as inline mechanics. All references are cross-skill pointers ("see the fleet skill").

### 4. Fleet skill is self-contained

**PASS.** An agent loading only skills/fleet/SKILL.md gets everything needed to operate fleet tools:
- Complete tool table (21 tools)
- Dispatch rules (background subagent requirement)
- Pre-dispatch and pre-flight checks
- Task harness delivery mechanics
- Monitoring and recovery commands
- Git-as-transport protocol
- Cleanup commands
- Permissions (with sub-doc)
- Model tiers
- Member icons
- Provider awareness table
- 7 sub-documents for detailed procedures

### 5. PM skill still complete

**PASS.** All PM commands present: /pm init, plan, start, status, resume, pair, deploy, recover, cleanup. Lifecycle phases (vision → requirements → design → plan → development → testing → deployment), execution loop, doer-reviewer flow, recovery procedure, and all 15 core rules intact. Cross-skill references are correct and consistent.

### 6. Cross-contamination check

**PASS.** 
- No PM orchestration content (commands, lifecycle, execution loop, doer-reviewer workflow) found in fleet/SKILL.md
- No fleet tool mechanics (tool names as inline instructions) found in pm/SKILL.md or doer-reviewer.md
- "Task Harness Delivery" in fleet (lines 80-88) correctly describes the *delivery mechanism* (how to use send_files); PM describes *what* to deliver and *when* — proper separation of concerns
- "Recovery Commands" in fleet (lines 106-111) correctly describes the *commands to run*; PM's Recovery section describes the *decision workflow* — proper separation

---

## Minor Observation (non-blocking)

The `dangerously_skip_permissions` ban lives only in pm/SKILL.md rule 8. If the fleet skill is ever consumed by a non-PM agent, that agent wouldn't see this ban. Consider adding a one-liner to fleet's permissions section or tool boundaries section in a future pass. This does not block approval — PM is currently the only consumer, and the ban is present there.

## Cross-Skill Reference Mechanism

The "See the fleet skill" prose pattern is documented with an explicit file-path fallback (fleet/SKILL.md lines 10-14). Pragmatic and resilient.

---

## Summary

The split is clean, complete, and well-executed. Fleet mechanics are fully extracted into skills/fleet/SKILL.md with 7 supporting sub-documents. The PM skill contains zero fleet tool mechanics — all references use the cross-skill prose pattern. No duplication, no cross-contamination. Both skills are self-contained for their respective concerns.

---

# Install Order & --skill Flag Review — Commit 8e181f8 (#82)

**Reviewer:** sprint/skill-refactor reviewer  
**Date:** 2026-04-06  
**Verdict:** APPROVED

---

## Review Checklist

### 1. No PM refs in fleet skill

**PASS.** Grep for `\bpm\b`, `/pm`, `@pm` in `skills/fleet/` returned zero matches. Fleet skill is fully self-contained with no PM dependencies.

### 2. Install order — fleet before PM

**PASS.** `install.ts:438-451` installs fleet at step 6, PM at step 7. `totalSteps` dynamically adjusts: 5 (no skills), 6 (fleet only), 7 (fleet+pm). The `fleet-before-pm order` test (line 525-546) explicitly verifies `mkdirSync` call ordering.

### 3. --skill flag values

**PASS.** All modes work correctly:
- `install` (no flag) → `skillMode='none'` → no skills installed
- `--skill` (no value) → `skillMode='all'` → both fleet + pm
- `--skill all` → both fleet + pm
- `--skill fleet` → fleet only
- `--skill pm` → fleet + pm (with warning)
- `--skill=<value>` equals form also works for all values
- `--skill=invalid` → exits with error

Parsing logic at lines 325-345 handles both `--skill=<val>` and `--skill <val>` forms correctly, including bare `--skill` defaulting to `'all'`.

### 4. --help output

**PASS.** `index.ts:18-21` documents all four install variants clearly:
- `install` — base install only
- `install --skill [all]` — both skills
- `install --skill fleet` — fleet only
- `install --skill pm` — PM (also installs fleet)

### 5. --skill pm installs fleet too

**PASS.** Line 435-437 prints warning: "PM skill depends on fleet skill — installing fleet skill first." Line 347 includes `'pm'` in the `installFleet` boolean. Test at line 456-477 confirms both directories are created.

### 6. Tests pass

**PASS.** All 41 test files pass (628 tests, 0 failures). New test file `install-multi-provider.test.ts` adds 27 tests covering all --skill flag modes, fleet-before-pm ordering, equals-form parsing, and error cases.

---

## Summary

Clean implementation. The --skill flag parsing is robust (both equals and space forms, bare flag defaults to all, invalid values rejected). Fleet-before-pm ordering is correctly enforced in code and verified in tests. The --skill pm auto-installs fleet with a clear dependency warning. Help text accurately documents all modes.
