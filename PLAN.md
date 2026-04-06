# Skill Refactor: Extract Fleet Mechanics from PM Skill

## Goal
Separate fleet mechanics (tool usage, member management, permissions, onboarding, provider awareness) from PM workflow logic (planning, execution loops, doer-reviewer orchestration, recovery). The PM skill should express *what* to do; the fleet skill should express *how* to interact with fleet infrastructure.

## Branch
`sprint/skill-refactor` off `main`

## Risk
The `@fleet` cross-skill reference mechanism is the riskiest unknown. Claude Code skills reference each other via natural language ("follow the fleet skill") and the skill loader resolves them. Task 1 validates this works before any content moves.

---

## Phase 1: Create Fleet Skill & Refactor PM Skill

### Task 1 — Investigate @fleet reference mechanism and create skills/fleet/SKILL.md skeleton
**Type:** task  
**Risk:** HIGH — if cross-skill references don't work, the entire split strategy changes  

**Steps:**
1. Create `skills/fleet/` directory
2. Create `skills/fleet/SKILL.md` with frontmatter (`name: fleet`, `description: Fleet infrastructure mechanics — member management, permissions, onboarding, provider awareness, tool usage patterns, and git-as-transport`) and a minimal body referencing fleet tools
3. Test that the PM skill can reference fleet skill via "See the fleet skill" / "Follow the fleet skill" prose pattern (same pattern as `tpl-claude-pm.md` uses: "follow the pm skill")
4. If the skill loader does NOT resolve cross-skill references: document the limitation and use explicit file-path references (`See skills/fleet/SKILL.md`) as fallback

**Acceptance:** `skills/fleet/SKILL.md` exists with valid frontmatter. Reference mechanism documented.

---

### Task 2 — Populate skills/fleet/SKILL.md with fleet mechanics extracted from PM skill
**Type:** task  

**Content to extract from `skills/pm/SKILL.md` → `skills/fleet/SKILL.md`:**

1. **Rule 3** (line 26): "All fleet operations run as background subagents" → fleet skill's "Dispatch Rules" section
2. **Rule 4** (line 27): "Before dispatch: member must be idle (`fleet_status`) and have completed onboarding.md" → fleet skill's "Pre-dispatch Checks" section
3. **Rule 8** (line 31-32): Permission composition via `compose_permissions`, provider-native config, mid-sprint denial handling → fleet skill's "Permissions" section (absorb `permissions.md` content)
4. **Rule 11** (line 34): "Local members: ALWAYS use fleet tools" → fleet skill's "Core Principle" section
5. **Rule 13** (line 36): "PM runs `gh` CLI commands directly via Bash — never delegate to fleet members" → fleet skill's "Tool Boundaries" section
6. **Task Harness** section (lines 53-59): File generation and `send_files` mechanics → fleet skill's "Task Harness Delivery" section
7. **Monitoring** section (lines 87-91): `execute_command` usage patterns, model escalation → fleet skill's "Monitoring" section
8. **Model Selection** section (lines 115-116): Tier resolution via server → fleet skill's "Model Tiers" section
9. **Member Icons** section (lines 118-119): Icon assignment via server → fleet skill's "Member Icons" section
10. **Provider Awareness** table (lines 127-138): Provider-specific handling → fleet skill's "Provider Awareness" section

**Also move these full files from `skills/pm/` → `skills/fleet/`:**
- `onboarding.md` — entirely fleet mechanics (SSH keys, CLI install, VCS auth, attribution)
- `permissions.md` — entirely fleet mechanics (`compose_permissions` usage)
- `troubleshooting.md` — entirely fleet tool troubleshooting
- `skill-matrix.md` — skill installation is fleet infrastructure
- `auth-github.md`, `auth-bitbucket.md`, `auth-azdevops.md` — VCS auth provisioning

**Acceptance:** `skills/fleet/SKILL.md` contains all fleet mechanics. Moved files are in `skills/fleet/`.

---

### Task 3 — Refactor skills/pm/SKILL.md to remove fleet mechanics, add @fleet references
**Type:** task  

**Changes to `skills/pm/SKILL.md`:**

1. **Rule 3** → Replace with: "All fleet operations run as background subagents — see the fleet skill for dispatch mechanics."
2. **Rule 4** → Replace with: "Before dispatch: member must be idle and onboarded — see the fleet skill for pre-dispatch checks and onboarding."
3. **Rule 8** → Replace with: "NEVER use `dangerously_skip_permissions`. Before every sprint, compose and deliver permissions per the fleet skill. Mid-sprint denial? See the fleet skill."
4. **Rule 11** → Replace with: "Local members: ALWAYS use fleet tools — see the fleet skill for tool boundaries."
5. **Rule 13** → Replace with: "PM runs `gh` CLI directly (not fleet members) — see the fleet skill for tool boundary rules."
6. **Task Harness** section → Keep the 3-file list and member instruction, but replace `send_files` mechanics with: "Deliver via the fleet skill's task harness delivery process."
7. **Monitoring** section → Keep PM decision logic (when to escalate, when to reset), replace `execute_command` usage patterns with: "See the fleet skill for monitoring commands."
8. **Model Selection** section → Replace with: "Use model tiers (`cheap`/`standard`/`premium`) — see the fleet skill for tier resolution."
9. **Member Icons** section → Replace with: "Icons are managed by the fleet — see the fleet skill. Prefix every member reference with their icon."
10. **Provider Awareness** table → Replace entire table with: "All provider differences handled by the fleet — see the fleet skill for provider-specific config paths, CLI commands, and timeout guidance."
11. **References to moved files** → Update: `onboarding.md` → `fleet skill's onboarding`, `permissions.md` → `fleet skill's permissions`, `troubleshooting.md` → `fleet skill's troubleshooting`, `skill-matrix.md` → `fleet skill's skill matrix`, `auth-*.md` → `fleet skill's auth guides`.

**Acceptance:** No fleet tool mechanics remain inline in `skills/pm/SKILL.md`. All fleet references point to the fleet skill.

---

### Task 4 — Trim doer-reviewer.md of fleet tool mechanics
**Type:** task  

**Content to move from `skills/pm/doer-reviewer.md` → `skills/fleet/SKILL.md` (or its sub-docs):**

1. **Setup Checklist item 3** (line 3): "Compose and deliver permissions per permissions.md for each member's role" → Replace with: "Compose and deliver permissions per the fleet skill."
2. **Setup Checklist item 4** (lines 4-11): Provider-specific instruction file naming (`member_detail → llmProvider`) → Move provider lookup logic to fleet skill's "Provider Awareness". Keep: "Configure role-specific instruction file" with reference to fleet skill for provider-specific file naming.
3. **Pre-flight Checks** section (lines 18-29): `fleet_status`, `execute_command → git status`, `git rev-parse HEAD` on reviewer → Move fleet command patterns to fleet skill's "Pre-flight Checks". Keep: the intent (verify branch, clean tree, matching SHA) with reference to fleet skill.
4. **Flow step 2** (lines 39-41): "PM handles git transport via `execute_command`" → Move `execute_command` patterns to fleet skill. Keep: "PM handles git transport between doer and reviewer" with fleet skill reference.
5. **Flow step 3** (lines 42-47): `send_files` usage, `resume=false` dispatch → Move `send_files`/dispatch mechanics to fleet skill. Keep: "PM dispatches reviewer at every VERIFY checkpoint" with fleet skill reference.
6. **Post-dispatch Token Tracking** section (lines 58-69): `update_task_tokens` regex parsing, tool call details → Move entirely to fleet skill's "Token Tracking" section. Keep one-line reference: "Track tokens after every dispatch — see the fleet skill."
7. **Permissions** section (lines 109-111): `compose_permissions` mention → Replace with fleet skill reference.
8. **Git as transport** section (lines 103-107): Keep commit responsibility rules (doer commits deliverables, reviewer commits feedback). Move `.gitignore` mechanics to fleet skill.

**Acceptance:** `doer-reviewer.md` contains only PM workflow decisions (when to dispatch, what verdict means, cycle limits). All fleet tool patterns moved out.

---

### Task 5 — Verify the split is complete
**Type:** task  

**Checks:**
1. Grep `skills/pm/` for fleet tool names: `execute_command`, `execute_prompt`, `send_files`, `receive_files`, `fleet_status`, `register_member`, `remove_member`, `update_member`, `compose_permissions`, `provision_auth`, `provision_vcs_auth`, `setup_ssh_key`, `setup_git_app`, `monitor_task`, `update_task_tokens`, `cloud_control`, `member_detail`, `list_members`. None should appear as inline usage instructions (backtick-quoted commands). Brief mentions in context ("see the fleet skill for `execute_command` patterns") are OK.
2. Grep `skills/fleet/` for PM workflow terms: `doer-reviewer loop`, `/pm`, `APPROVED`, `CHANGES NEEDED`, `plan generation`, `lifecycle`. None should appear — fleet skill must be workflow-agnostic.
3. Verify all files moved from `skills/pm/` to `skills/fleet/` are no longer in `skills/pm/`.
4. Verify `skills/fleet/SKILL.md` has valid frontmatter and loads correctly.
5. Verify all cross-references between pm and fleet skills are bidirectional where needed.

**Acceptance:** Clean separation confirmed. Fix any violations found.

---

### Task 6 — VERIFY checkpoint
**Type:** verify  

1. Run build/lint if applicable
2. Confirm all Tasks 1-5 completed correctly
3. Push to `origin/sprint/skill-refactor`
4. **STOP** — PM reviews
