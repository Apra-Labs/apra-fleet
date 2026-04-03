# Project Manager Skill — Requirements

## 1. Overview

### 1.0 Purpose of This Document

This is a design specification, not the skill itself. It captures the requirements, patterns, and open decisions that will inform two deliverables:
1. **The PM skill prompt** — the instruction set Claude follows when acting as PM
2. **Supporting tooling** — any new fleet MCP tools, helpers, or conventions needed to keep the skill prompt simple and the workflow reliable

The goal is to figure out what the skill needs *before* writing it, and to identify what infrastructure should be built into the MCP server so the skill prompt can stay concise rather than encoding complex logic in natural language instructions.

### 1.1 The Problem

A seasoned architect working with Claude Code hits a bottleneck: they can only drive one thread of work at a time. While Claude is implementing feature A, the architect stares at a screen waiting. Feature B, the test suite, the CI pipeline — all sit idle. The architect has the vision, can make fast technical decisions, but is gated on serial execution.

The fleet MCP server solves the infrastructure problem — it can run Claude on multiple machines. But the coordination problem remains: who decides what each member works on, tracks progress, handles failures, and integrates the results? Doing this manually across 5 members is a full-time job.

**The PM skill makes the architect's single Claude session the coordination hub.** The architect brainstorms and approves the plan. PM fans out work to members in parallel. While members grind on implementation, the architect can either observe status or continue brainstorming the next phase. Every member pushes its own ball forward independently. The architect's engagement is limited to one screen, one Claude session — everything else happens in the background.

### 1.2 Communication Model

Hub-and-spoke. Every member answers only to the PM. No member-to-member messaging. The PM is the single source of truth for project state.

### 1.3 Infrastructure

The PM skill is a prompt/workflow layer on top of existing fleet MCP tools (`execute_prompt`, `send_files`, `execute_command`, `list_members`, `fleet_status`, etc.). Where the existing tools are insufficient, this document identifies **new tooling to build** rather than encoding workarounds in the skill prompt.

### 1.4 Separation of Concerns — The Cardinal Rule

Every participant in the system operates at exactly one level of abstraction. No one reaches into a layer that isn't theirs.

**The PM knows:**
- Task status: done or not done
- Test results: pass or fail (as a measure of real progress)
- Dependencies: what blocks what
- Resources: which members are idle, which are working
- Branches: which member is on which branch
- Phase progression: where we are in the overall plan

**The PM does NOT know:**
- What the code looks like
- How a task is implemented
- Why a test failed (only that it failed)
- How to fix anything

When something fails — a test, a merge, a build — PM does not diagnose. It assigns a specialist. If integration fails, PM assigns an integrator to fix it, even if "fix it" means rolling back. If tests fail, PM assigns a developer to fix the failures. PM's only tool for measuring real progress is test results: green means forward, red means backward.

**Each member knows:**
- Its assigned specialty (Python development, devops, testing, UX design, etc.)
- The tasks in its plan.md
- How to verify its own work

**Each member does NOT know:**
- The overall project plan
- What other members are doing
- Which phase the project is in
- Who else is on the team

This creates clean layers:
```
User/Architect ── makes strategic decisions, approves plans
       │
      PM ────────── tracks status, assigns work, measures progress via tests
       │
  Members ──────── execute tasks within their specialty, report done/not-done
```

Each layer communicates only through narrow interfaces: the user talks to PM in natural language, PM talks to members via plan.md files and prompts, members talk back via task completion status and test results. No layer leaks into another.

---

## 2. Lifecycle

### 2.1 Brainstorming Phase

The user and PM collaborate to define the project scope. PM produces a `project_plan.md` file that captures:
- Features and tasks grouped by phase
- Role assignments (which type of specialist owns each task)
- Dependencies between tasks (what blocks what)
- Quality gate checklist (see 2.3)
- Available members from the fleet

The user drives this conversation. PM structures and records it. The brainstorming phase ends when the user approves the plan.

### 2.2 Execution Phase

PM assigns work to members in parallel where dependencies allow. Each member receives a `plan.md` containing its specific tasks. Members work through their plans, marking tasks done. PM monitors progress and loops until all tasks are complete.

### 2.3 Quality Gate — The Automatic Pipeline

This is the key to keeping members productive without user engagement. When dev tasks complete, PM does NOT stop and wait for the user. Instead it automatically dispatches reviewers — a predictable sequence of specialist evaluations that requires no human decisions.

**The do→review pipeline:**

```
Stage 1: Development (parallel, doers)
  backend-dev, frontend-dev, devops, test-dev — work their plan.md tasks
      ↓ all plans complete

Stage 2: Review (parallel, reviewers, automatic)
  security-reviewer → audit code, commit feedback-security.md to doer's branch
  code-reviewer     → DRY/quality analysis, commit feedback-code-review.md
  tester            → run test suites, commit feedback-tester.md with results
  ci-pipeline       → build/lint/test (PM interprets results as feedback)
      ↓ all reviews complete

Stage 3: PM evaluates feedback (automatic)
  Check quality goals:
    No HIGH security findings? No HIGH bugs? All tests passing? Clean build?
  all goals met → stage complete, move to integration
  goals not met → PM converts feedback.md findings to plan.md tasks for doers
      ↓

Stage 4: Fix cycle (doers, automatic)
  doers receive updated plan.md with fix tasks → work through fixes
      ↓ fixes complete
  loop back to stage 2 (re-review)
      ↓ max iterations reached without meeting goals
  PM stops, reports remaining issues to user

Stage 5: Report to user — only decisions that need human judgment
```

**Why this matters:** In the current manual workflow, an architect pushes work to members before sleeping. Members finish dev tasks in 1-2 hours and sit idle for 4-5 hours because no one dispatches the review cycle. The architect wakes up and manually runs the same checklist every morning: "security audit," "DRY check," "run integration tests." PM automates this entire post-dev pipeline, keeping members productive through the night.

**The quality gate is configurable per project.** During brainstorming, the architect defines which reviews apply and the exit criteria:

```markdown
## Quality Gate
Reviews:
- [ ] Security review (security-reviewer, premium)
- [ ] Code quality review (code-reviewer, sonnet)
- [ ] Run test suites (tester, haiku)
- [ ] CI pipeline (devops triggers, haiku)

Quality Goals:
- No HIGH severity security findings
- No HIGH severity bugs
- All unit tests passing
- All integration tests passing
- Clean build, no errors

Iteration limit: 3 do→review cycles, then escalate to user
```

Some projects may skip security reviews. Some may add performance benchmarks. The architect decides once during planning; PM executes it automatically on every phase completion.

**The quality gate is what turns the PM from a task dispatcher into a pipeline manager.** Without it, PM is just a fancy way to send plan.md files. With it, PM keeps the assembly line running while the architect sleeps.

### 2.4 Integration Phase

When a phase's dev tasks and quality gate are complete, PM orchestrates the merge of feature branches into `development` via pull requests. This produces a milestone build.

### 2.5 Iteration

After integration, PM can start the next development phase on new branches. If integration or post-merge tests fail, PM creates fix tasks and assigns them — the quality gate loop applies again. The architect only gets involved when PM exhausts its automatic fix attempts or encounters a decision that requires human judgment.

---

## 3. State Management

### 3.1 project_plan.md — The Master State File

All PM state lives in `.claude/project_plan.md`. This is the single source of truth. When the user returns after closing their terminal, PM reconstructs its understanding entirely from this file. The `.claude/` directory keeps PM artifacts separate from project source.

**Nothing lives only in Claude's context.** Every decision, assignment, and status update is persisted to this file.

Structure:

```markdown
# Project Plan: <project name>

## Fleet Resources
| Member | Role | Branch | Status | Session ID | Current Plan |
|--------|------|--------|--------|------------|--------------|
| agent-lin-1 | backend | feature_auth-api | working | sess_abc123 | plan-backend-p1.md |
| agent-mac-1 | frontend | feature_user-dashboard | idle | — | — |

## Phase 1: <name>
### Stage 1: Development
- [x] TASK-001: Set up project scaffolding (devops) [agent-win-1, branch: feature_ci-pipeline]
- [ ] TASK-002: Implement auth API (backend) [agent-lin-1, branch: feature_auth-api]
  - depends on: TASK-001
- [ ] TASK-003: Auth UI components (frontend) [unassigned]
  - depends on: TASK-002

### Stage 2: Review (auto-dispatched when stage 1 completes)
- [ ] Security review of backend branch (security-reviewer, premium) → feedback-security.md
- [ ] Code quality review of backend branch (code-reviewer, sonnet) → feedback-code-review.md
- [ ] Code quality review of frontend branch (code-reviewer, sonnet) → feedback-code-review.md
- [ ] Run test suites (tester, haiku) → feedback-tester.md
- [ ] CI pipeline (devops, haiku) → pass/fail

### Stage 3: Fix cycle (if quality goals not met, max 3 iterations)
- Iteration 1: 2 HIGH security findings → fix tasks sent to backend-dev
- Iteration 2: (pending re-review)

### Stage 4: Integration (when quality goals met)
- [ ] All phase 1 feature branches merged to development via PRs
- [ ] Post-merge integration tests pass

## Phase 2: <name>
...

## Backlog (from quality gate / testing)
- BUG-001: Auth token not refreshing (found by tester, phase 1)
- DRY-001: Duplicated validation logic in auth and user modules (found by reviewer, phase 1)
- SEC-001: SQL injection in search endpoint (found by security, phase 1)
```

### 3.2 Member Plan Files (plan.md)

Each member receives a `plan.md` via `send_files` (to avoid conflicts — PM is the sole author of new plan.md files). This is a subset of the master plan — only the tasks assigned to that member. The member works through it sequentially, marking tasks done and committing the updated plan.md to the branch.

**All three member artifact types are committed to git on the feature branch:**
- `plan.md` — PM sends via `send_files`, member marks tasks [x] and commits. PM reads back (via `execute_command` or `read_remote_file`) to update its own `project_plan.md`.
- `learnings.md` — member creates/updates and commits. Persists across checkpoint loops via git.
- `feedback-{type}.md` — reviewer creates and commits. Doer reads on next assignment.

PM's `.claude/project_plan.md` is the master rollup — it lives on the local machine and is never sent to members. PM updates it by reading the small member-level `plan.md` files from branches.

```markdown
# Plan: backend — Phase 1
Member: agent-lin-1
Branch: feature_auth-api

## Onboarding
Read and analyze these before starting tasks:
- learnings.md (if it exists — your notes from previous sessions)
- docs/api-conventions.md
- docs/csharp-conventions.md
- src/types/auth.ts (interface you're implementing against)
- src/middleware/auth-middleware.ts (existing auth pattern to follow)

## Tasks
- [x] Implement user model and migrations
- [x] Implement auth endpoints (login, register, refresh)
- [ ] Add input validation and error handling
- [ ] Write unit tests for auth endpoints

## Verification
- All tests pass: `npm test`
- No lint errors: `npm run lint`
- Branch compiles cleanly: `npm run build`

## Instructions
- Work through tasks in order. Mark each [x] when done.
- After each task, commit your changes to the branch.
```

**Onboarding is member-level context channeling, not a PM phase.** In large codebases, letting a member explore freely wastes context on irrelevant code. The Onboarding section tells the member exactly what to read and analyze before starting work — convention files, interfaces it implements against, existing patterns it should follow, and its own learnings.md from previous sessions.

**PM curates Onboarding per role and task group during PLAN mode.** The architect identifies which files matter for each task group (e.g., backend → `api-conventions.md` + `csharp-conventions.md` + the relevant interface files, frontend → `react-conventions.md` + `ux-conventions.md` + the component library). PM includes only the relevant subset — a frontend member doesn't read API conventions it will never use.

**Status reporting: checkpoint file on disk (decided).** PM does not parse the member's response for task-level status. It re-sends the same prompt; the member reads plan.md from disk, skips done tasks, continues. PM only needs to know "all tasks complete" vs "not all complete" from the member's natural language response. The plan.md file on disk *is* the state.

---

## 4. Roles

Roles split into two categories with fundamentally different permissions: **doers** who write code, and **reviewers** who evaluate code and produce feedback. This separation is strict — reviewers never write application code, and doers never review their own work.

### 4.1 Doers — Own Code, Own Branches

Doers create and modify source code. They own their branch and are responsible for making it work. When a reviewer gives feedback, the doer is the one who fixes it.

| Role | Specialty | Owns | Does NOT do |
|------|-----------|------|-------------|
| interface-designer | API contracts, schemas, type definitions | Define interfaces between components | Implement the components themselves |
| backend-dev | Server logic, data models, APIs | Implement backend behind defined interfaces | Touch frontend code |
| frontend-dev | UI components, UX, client logic | Implement UI against defined interfaces | Modify API implementations |
| devops | CI/CD, build tooling, infrastructure | Build pipelines, deploy scripts, env setup | Write application code |
| test-dev | Test suite development | Write unit tests, integration tests, test fixtures | Fix the application code that fails tests |
| integrator | Branch merging, conflict resolution | Merge branches, resolve conflicts, verify build | Write new features |

### 4.2 Reviewers — Evaluate Code, Produce Feedback

Reviewers read code and produce a `feedback.md` file committed to the doer's branch. They never modify application source code. Their output is structured findings that PM converts into tasks for the doer.

| Role | Evaluates | Output | Does NOT do |
|------|-----------|--------|-------------|
| security-reviewer | Vulnerability scanning, threat modeling | feedback.md with severity-rated findings | Fix the vulnerabilities |
| code-reviewer | Quality, style, DRY, correctness | feedback.md with refactoring suggestions | Rewrite the code |
| tester | Run existing test suites, report results | feedback.md with pass/fail results, failure details | Fix failing tests or application code |
| ci-pipeline | Build, lint, test via CI (GitHub Actions, etc.) | Build/test results (PM interprets as feedback) | Fix anything — it's a machine |

**DevOps is a special case:** DevOps is a doer for CI/CD files (workflow YAMLs, Dockerfiles, build scripts). But when a CI pipeline failure is caused by application code, devops produces a `feedback.md` for the responsible developer. DevOps fixes what it owns (infrastructure), and creates feedback for what it doesn't.

### 4.3 The Feedback Loop

**Key principle: members are stateless and fungible. The branch is the continuity, not the member.**

A member checks out a branch, does its job, pushes, and is immediately free for reassignment. The "doer" who fixes feedback may be a completely different physical member than the one who wrote the original code. It doesn't matter — everything the next member needs is in git (code, plan.md, learnings.md, feedback.md).

Branch ownership is sequential for doers — at any given time, exactly one doer is modifying code on a branch. Reviewers can run in parallel on the same branch because they are read-only on application code and each writes to its own feedback file.

```
1. PM assigns idle member as doer → member checks out branch, works plan.md, pushes
   Member is now free. PM can reassign it immediately.

2. PM assigns idle member as reviewer → member checks out same branch, reviews code,
   commits feedback-{reviewer-type}.md, pushes.
   Member is now free.

3. PM reads feedback-{reviewer-type}.md (via read_remote_file or execute_command on any member
   that has the branch). If quality goals not met:

4. PM sends updated plan.md (with fix tasks from feedback) to branch via send_files.
   PM assigns idle member as doer → member checks out branch, reads feedback.md
   and updated plan.md, fixes issues, pushes.
   Member is now free.

5. Loop to step 2 until quality goals met or iteration limit hit.
```

**Feedback file naming:** Each reviewer type writes to its own file — `feedback-security.md`, `feedback-code-review.md`, `feedback-tester.md`. This prevents overwrites when multiple reviewers run in parallel on the same branch. Each reviewer writes only its own file, so concurrent reviews are safe.

**feedback-{reviewer-type}.md format:**
```markdown
# Review Feedback: security-reviewer
Branch: feature_auth-api
Reviewed: 2026-02-28

## Findings
- [HIGH] SQL injection in `src/routes/search.ts:42` — user input passed directly to query
- [HIGH] Hardcoded secret in `src/config.ts:15` — API key in source
- [LOW] Missing rate limiting on login endpoint

## Summary
2 HIGH, 0 MEDIUM, 1 LOW
```

PM copies HIGH findings verbatim into the doer's plan.md as fix tasks. PM is a passthrough — it does not rephrase or add implementation guidance (it doesn't understand code). The doer interprets the finding and decides how to fix it.

```markdown
- [ ] [HIGH] SQL injection in `src/routes/search.ts:42` — user input passed directly to query
- [ ] [HIGH] Hardcoded secret in `src/config.ts:15` — API key in source
```

PM does NOT create tasks for LOW severity findings (unless the quality gate specifies otherwise). The quality goals determine the threshold.

**Re-review scoping:** On subsequent review rounds, the reviewer reads its own previous `feedback-{type}.md` first, then examines the git diff since last review to understand what changed. The reviewer can find new HIGH issues missed in the first pass — this is expected and healthy. The goal is to remove bugs, not to rubber-stamp prior work.

**Tech-debt marking:** The user (manual PM) can mark specific feedback items as `[TECH-DEBT]` in the feedback file or project_plan.md backlog. Reviewers skip items marked as tech-debt — these represent agreed known issues or deferred fixes that should not block the do→review loop. This prevents infinite iteration on items the architect has consciously accepted.

```markdown
## Findings
- [TECH-DEBT] [HIGH] Missing rate limiting on all endpoints — accepted, deferred to phase 2
- [HIGH] New: Unvalidated redirect in OAuth callback — must fix
```

### 4.4 Quality Goals

Defined during brainstorming, these are the exit criteria for the do→review loop:

```markdown
## Quality Goals
- No HIGH severity security findings
- No HIGH severity bugs
- All unit tests passing
- All integration tests passing
- Clean build with no errors
- Max do→review iterations: 3 (then flag to user)
```

PM checks quality goals after each review cycle. When all goals are met, the phase stage is complete. When the iteration limit is reached without meeting goals, PM stops and reports the remaining issues to the user.

### 4.5 Model Selection by Role

Not all roles require the same reasoning depth. PM selects the model tier for each `execute_prompt` based on the role's cognitive demands.

| Tier | Model | Roles | Rationale |
|------|-------|-------|-----------|
| Deep | premium | interface-designer, code-reviewer, security-reviewer, integrator | Architectural reasoning, cross-cutting analysis, conflict resolution |
| Standard | sonnet | backend-dev, frontend-dev, test-dev | Feature implementation within a defined plan |
| Fast | haiku | devops, tester (runner) | Scripting, running commands, reporting results |

PM can escalate a role's model tier when a member makes zero progress — retry with a higher-tier model before flagging to the user.

**Role assignment:** PM assigns roles to members dynamically based on available fleet resources and task requirements. The role is embedded in every prompt — members do not carry implicit role state between sessions. A member can be a doer in one assignment and a reviewer in the next.

---

## 5. Work Assignment Loop

This is the core execution mechanism.

### 5.1 Assigning Work to a Member

```
1. PM reads project_plan.md — sees task statuses and test results
2. PM identifies next parallelizable tasks (dependencies satisfied = predecessor done + tests green)
3. PM selects an idle member, assigns it a role
4. PM generates a plan.md for that member's tasks
5. PM sends plan.md to member via send_files
6. PM runs execute_prompt via a Task subagent:
     "You are a {role}. Your branch is {branch}.
      Read plan.md in your working directory.
      Work through the uncompleted tasks.
      Mark each done as you complete it.
      Commit after each task.
      When finished or exiting, run verification and report your plan status."
7. Subagent returns response to PM
8. PM checks: all tasks done?
   - Yes → mark member as idle, update project_plan.md
   - No  → repeat from step 6 (same prompt, member reads plan.md, skips done tasks)
```

**PM decision inputs are strictly:**
- Task checkbox status (done/not-done) — determines what to assign next
- Test/verification results (pass/fail) — determines if progress is real
- Dependency graph — determines what can run in parallel
- Member availability — determines who gets the work

PM never reads code, never reviews implementations, never debugs. If tests pass, the task is done. If tests fail, PM assigns a fix task to a specialist. Test results are the only objective measure of progress.

### 5.2 The Checkpoint Pattern

The plan.md on the member's disk is a checkpoint file. If a member exits after completing 3 of 10 tasks (timeout, turn limit, error), those 3 tasks remain marked `[x]` in the file. PM re-sends the same prompt. The member reads plan.md, sees tasks 1-3 are done, picks up at task 4. No special recovery logic needed.

**Failure mode:** The only true failure is zero progress — the member completes no tasks across multiple loops. PM detects this by comparing completed task count before and after each loop.

**Stall detection: 2 + 1 escalation.** If a member makes zero progress across 2 consecutive loops at its assigned model tier, PM retries once with the next higher model tier (e.g., standard → premium). If still zero progress after the escalation attempt, PM flags to the user. Total: 3 attempts before user escalation.

### 5.3 Parallel Execution

PM uses Task subagents to run multiple `execute_prompt` calls concurrently. Each subagent manages one member's work loop independently. PM can launch as many parallel subagents as there are idle members with parallelizable work.

```
PM spawns subagents in parallel:
  ├── Subagent A → execute_prompt(agent-lin-1, backend tasks) → loop until done
  ├── Subagent B → execute_prompt(agent-mac-1, frontend tasks) → loop until done
  └── Subagent C → execute_prompt(agent-win-1, devops tasks) → loop until done
```

**Decided: Option B — Task subagents with `run_in_background`.** PM launches each member's work loop as a background Task subagent. Each subagent wraps one `execute_prompt` call (or a checkpoint loop of calls) for one member. The user's PM session stays interactive — they can brainstorm the next phase, check status, or walk away.

### 5.4 Session-ID Persistence and Crash Recovery

PM persists the session-id of every in-use member to `project_plan.md` (in the Fleet Resources table or a dedicated section). This enables crash recovery:

```
PM crashes or user closes terminal
  ↓ hours pass
PM restarts, reads project_plan.md
  ↓
For each member with a persisted session-id:
  PM sends execute_prompt with --resume <session-id>:
    "Please provide a status report. Summarize the status of your tasks
     in plan.md — which are complete, which are in progress, and which
     remain. Report any errors or blockers."
  ↓
PM collects responses, reconstructs current state, updates project_plan.md
  ↓
PM resumes normal operation — assigns new work, dispatches reviews, etc.
```

**Why this works:** Member sessions persist independently of PM's session. The member may have finished all tasks, stalled partway, or hit an error — doesn't matter. The `--resume` prompt asks for a status report, and the member reads its own plan.md checkpoint to answer accurately. Hours are lost (the member sat idle waiting for PM), but recovery is guaranteed — no work is lost, no state is corrupted.

**What PM persists per member:**
- Member name (fleet identifier)
- Session-id (for `--resume`)
- Assigned role and branch
- Last known task status (for comparison after recovery)

This also solves the overnight/batch mode problem (Gap #21). PM doesn't need to stay alive all night. It persists session-ids, the user closes their terminal, and next morning PM resumes each member's session to collect results.

---

## 6. Git Workflow

### 6.1 Branch Model

The project uses a `development` branch as the main integration target. `main`/`master` is reserved for production releases and hotfixes — it plays no role in the PM workflow.

All feature work branches from `development`. All PRs target `development`. This is the single source of truth for in-progress work.

### 6.2 Branch Naming Convention

```
feature_{feature-name}
```

Examples:
- `feature_auth-api`
- `feature_user-dashboard`
- `feature_ci-pipeline`

Branch names are feature-centric, not member-centric. This aligns with stateless fungible members — the branch tracks the *work*, not the *worker*. Any idle member can be assigned to any feature branch.

### 6.3 Repo Bootstrapping

Before a member can work, it needs the repo cloned (one-time) and its branch set up. PM handles this via `execute_command`:

```
First time only:
1. execute_command: git clone <repo-url> <work-folder>

Then, per assignment, one of three git operations:

(a) Doer starting new feature:
   execute_command: cd <work-folder> && git fetch origin && git checkout -b feature_<name> origin/development

(b) Reviewer switching to a feature branch:
   execute_command: cd <work-folder> && git fetch origin && git checkout feature_<name> && git pull

(c) Doer picking up after reviewer added feedback:
   execute_command: cd <work-folder> && git checkout feature_<name> && git pull --rebase origin feature_<name>
```

After the git operation, PM sends plan.md (for doers) or the review prompt (for reviewers) and runs `execute_prompt`.

### 6.4 Integration via Pull Requests

PM owns `development`. Feature branches merge into `development` via pull requests, initiated by PM after all quality gate feedback has been accepted. PRs are merged sequentially — one at a time — with tests run on `development` after each merge to attribute failures.

```
PR queue: [feature_auth-api, feature_user-dashboard, feature_ci-pipeline]
All three have passed their quality gate (reviews accepted, tests pass on branch).

1. PM creates PR: feature_auth-api → development
2. PR has no conflicts → PM merges
3. PM assigns tester to run tests on development
   Pass → continue to next PR
   Fail → revert merge, assign fix task to feature_auth-api doer, move to back of queue
4. PM creates PR: feature_user-dashboard → development
5. PR has conflicts (development advanced after step 2):
   - PM assigns doer to rebase feature_user-dashboard on development and resolve
   - Doer pushes resolved branch, PR updates automatically
6. PM merges, runs tests on development
   ...
7. All PRs merged, all tests green → phase integration complete
8. PM updates project_plan.md
```

**Why sequential:** Merge is cheap (seconds). The test run after each merge is what takes time — but it makes failures attributable. If tests break after merging feature X, PM knows exactly which doer to assign the fix to. Parallel merging saves 30 seconds but costs hours of debugging when something breaks.

**Conflict resolution:** When a PR conflicts because `development` has advanced, PM assigns the doer whose PR conflicts to rebase on `development` and resolve. The doer understands their own code best. The architect's task slicing should minimize file overlap, making conflicts rare.

**Tests on `development` are the real progress measure.** Feature branch tests prove isolated correctness. Only tests on `development` prove integration correctness. PM treats `development` test results as the authoritative signal.

### 6.5 Rebase

PM-triggered action when `development` has advanced and feature branches need to catch up:

```
execute_command: cd <work-folder> && git fetch origin && git rebase origin/development
execute_prompt: "Your branch has been rebased. Re-run verification: <commands>. Report any failures."
```

If rebase produces conflicts, the member reports them. PM flags conflicting members to the user for resolution guidance.

---

## 7. Testing and Bug Lifecycle

### 7.1 Test Phase

Tests run on `development` after each sequential PR merge (see Section 6.4). This is not a separate phase — it's part of integration. Each merge is immediately validated, and failures are attributed to the last-merged PR.

After all PRs for a phase are merged and green, PM runs a final full test suite on `development` as the milestone validation:
1. PM assigns tester to run full test suites against `development`
2. Tester reports failures and issues
3. PM collects results into the Backlog section of project_plan.md

### 7.2 Bug Fixing

PM creates fix tasks from backlog items, assigns them to available members on new branches (e.g., `feature_fix-auth-refresh`). These follow the same plan.md checkpoint loop.

### 7.3 Phase Overlap

While testers work on phase N, PM can start assigning phase N+1 development tasks on new branches. This keeps members productive. Phase N+1 branches are created from `development` as-is — they don't wait for phase N to merge. When phase N merges into `development`, PM triggers a rebase of in-progress N+1 branches (see Section 6.5) so they pick up the new code.

---

## 8. Skill Interface

The PM skill is invoked as a Claude Code slash command. The user interacts with it conversationally.

**Skill invocation (decided):** Single `/pm` command. PM reads `project_plan.md` on every invocation to reconstruct state, then infers intent from the user's natural language message. No sub-commands — PM asks for clarification if intent is ambiguous.

**Two operating modes:**

**Interactive (daytime):** Architect brainstorms with PM, reviews status, makes decisions, course-corrects. PM fans out work between conversations. The architect's time is spent on decisions, not waiting.

**Batch (overnight):** Architect approves a plan, kicks off all parallelizable work, and walks away. PM runs all member loops to completion (or stall), updates project_plan.md with final status. Architect reads the morning report next day — a summary of what completed, what stalled, and what needs decisions.

```
Interactive session:
  User: /pm
  PM: [reads project_plan.md, presents current status]
  User: "Start phase 1. Assign backend and devops in parallel."
  PM: [generates plan files, fans out to members]
  User: "Status?"
  PM: [checks members, reports progress]
  User: "Backend is done. Start frontend."
  PM: [assigns frontend tasks to idle member]

Batch session:
  User: "Run all phase 1 tasks overnight. I'll check in tomorrow."
  PM: [fans out all parallelizable work, loops until done or stalled]
  --- next morning ---
  User: /pm
  PM: [reads project_plan.md]
  PM: "Phase 1 status: 18/24 tasks done. 3 members completed their plans.
       agent-lin-1 stalled on TASK-012 (zero progress after 3 loops).
       agent-mac-1 tests failing: 2 failures in auth suite.
       Decisions needed: [list]"
```

---

## 9. Context Slicing — The Economic Foundation

The single biggest cost driver is members re-reading context they've already seen. This applies to both token cost (API billing) and rate limits (Claude Max). The PM design must treat context as a scarce resource.

### 9.1 The Principle

Every task must be completable with small context: `plan.md` + `learnings.md` + the specific files being changed. If a task requires understanding the whole project, the architect sliced it wrong.

This is the architect's primary job during brainstorming — not just decomposing features into tasks, but decomposing them so each task's **context boundary** is small and self-contained.

### 9.2 learnings.md — Durable Member Knowledge

Each member maintains a `learnings.md` in its work folder. This file captures timeless, non-transient knowledge about the codebase: project structure, naming conventions, key abstractions, dependency patterns, gotchas.

**What goes in learnings.md:**
- Project structure and key file locations
- Naming conventions and coding style
- Framework patterns used (e.g., "this project uses repository pattern for data access")
- Important architectural constraints
- Common pitfalls discovered during work

**What does NOT go in learnings.md:**
- Transactional details (current task status, in-progress work)
- Low-level function signatures (that's what the code is for)
- Git commit history (that's in git)

The member reads learnings.md at the start of every session. This means checkpoint loops get cheaper over time — the member doesn't re-explore the codebase, it reads its own notes. On the first loop, it explores and builds learnings.md. On loops 2-5, it skips exploration and goes straight to work.

### 9.3 Context Slicing Patterns for Plan Tasks

The architect should decompose tasks using these patterns:

**File-scoped tasks:** "Implement the UserRepository class in `src/repositories/user.ts`" — the member only needs to read that file and its imports.

**Interface-bounded tasks:** "Implement the auth API endpoints matching the interface in `src/types/auth.ts`" — the member reads the interface file and implements against it. Doesn't need to understand the rest of the system.

**Test-scoped tasks:** "Write tests for `src/services/auth.ts` covering login, register, and refresh flows" — the member reads the source file and writes tests. Small context.

**Anti-pattern:** "Implement the authentication system" — too broad. The member needs to understand the full project to decide what to build, where to put it, and how it connects. This should be 4-5 smaller tasks.

### 9.4 Convention Files and Onboarding

Convention files are permanent project artifacts committed to the repository — they belong to the project, not to PM. The architect creates them during project setup (e.g., `react-conventions.md`, `csharp-conventions.md`, `devops-conventions.md`, `ux-conventions.md` — the set varies per project).

Convention files are one part of the broader **Onboarding section** in each member's plan.md (see Section 3.2). During PLAN mode, PM maps roles to their relevant convention files, interface definitions, and existing code patterns. When generating plan.md, PM curates the Onboarding section with only the files relevant to that member's tasks — conventions, interfaces to implement against, existing patterns to follow, and `learnings.md`. The member reads them from the repo — already on disk, no `send_files` needed. Convention updates propagate naturally via git (rebase/pull picks them up).

The prompt template (Section 10) stays generic — it tells the member to read plan.md, which carries the role-specific onboarding references.

---

## 10. Member Prompt Template

Standard prompt sent to members when assigning work:

```
You are a {role} working on project "{project_name}".
Your working branch is: {branch_name}
Your working directory is: {work_folder}

Read "plan.md" in your working directory. Start with the Onboarding section —
read and analyze every file listed there before writing any code. This includes
learnings.md (your notes from previous sessions) and the convention/interface
files relevant to your tasks.

Then work through the Tasks that are not yet marked [x]. For each task:
1. Implement the required changes
2. Mark the task [x] in plan.md
3. Commit your changes to your branch with a descriptive message

After completing all tasks, or if you are about to exit:
- Run the verification steps listed in plan.md and report results
- Update learnings.md with any durable knowledge about the codebase you
  discovered during this session (project structure, patterns, conventions,
  gotchas — not transient task details)

Do not wait for instructions between tasks. Work through the entire plan autonomously.
```

**Permission model (decided):** Role-specific `<work_folder>/.claude/settings.local.json` deployed per assignment via `send_files`, not blanket `dangerously_skip_permissions`.

PM maintains permission templates per role category. The file uses the standard Claude Code settings schema:

```json
{
  "permissions": {
    "allow": [
      "Read", "Write", "Edit", "Glob", "Grep",
      "Bash(git:*)",
      "Bash(npm test:*)",
      "Bash(npm run build:*)"
    ]
  }
}
```

| Category | `permissions.allow` entries | Rationale |
|----------|---------------------------|-----------|
| Doer | `Read`, `Write`, `Edit`, `Glob`, `Grep`, `Bash(git:*)`, build/test commands | Full code editing + git + build/test |
| Reviewer | `Read`, `Glob`, `Grep`, `Bash(git checkout:*)`, `Bash(git commit:*)`, `Bash(git push:*)`, `Bash(git diff:*)`, `Bash(git log:*)` | Read-only on app code, write only feedback-*.md + git ops |
| Tester | `Read`, `Glob`, `Grep`, `Bash(git:*)`, test runner commands | Runs tests, reads code, commits feedback-tester.md |
| DevOps | `Read`, `Write`, `Edit`, `Glob`, `Grep`, `Bash(git:*)`, `Bash(docker:*)`, `Bash(npm:*)` | Broader access for infrastructure files |

`dangerously_skip_permissions` is the opt-in fallback — only when the architect explicitly enables it (e.g., for trusted unattended workloads where the permission templates are too restrictive). It is never the default.

---

## 11. Tooling Implications

This section identifies what should be **built into the fleet MCP server** versus left to the skill prompt. The guiding principle: if the skill prompt needs more than a sentence to describe a behavior, it probably belongs in tooling.

### 11.1 Existing tools that the PM skill will use as-is
- `list_members` / `fleet_status` — resource inventory
- `execute_prompt` — assign work (with new `model` param)
- `send_files` — deliver plan.md to members
- `execute_command` — git operations (clone, branch, rebase)
- `member_detail` — check individual member state

### 11.2 Potential new tools or tool enhancements

| Need | Why skill prompt can't handle it | Possible tool |
|------|----------------------------------|---------------|
| **Read remote file** | PM may need to read a member's plan.md or feedback files. For text files, `execute_command` with `cat` suffices. A dedicated `read_remote_file` tool would add binary file support (tar.gz, screenshots) — deferred to backlog. | `execute_command` + `cat` (now). `read_remote_file` for binary files (backlog). |
| **Member git status** | PM needs to know branch state (current branch, clean/dirty, ahead/behind) without running execute_prompt. | Could be a specialized `execute_command` usage, or a dedicated `git_status` tool that returns structured data. |
| **Project state helpers** | PM reads/writes project_plan.md frequently. Parsing markdown tables and task lists in natural language is error-prone. | Possibly out of scope — this might be better handled by the skill prompt using standard read/write tools on the master machine. But if parsing reliability becomes a problem, structured state (JSON) with a render-to-markdown tool could help. |

*Note: `execute_prompt_batch` was considered but dropped — parallelism is handled by Task subagents with `run_in_background` (Section 5.3). This keeps the MCP server simple and leverages Claude Code's built-in concurrency.*

### 11.3 What stays in the skill prompt
- Brainstorming conversation with the user
- Task decomposition and dependency analysis (user-driven)
- Deciding what to assign to whom (scheduling logic)
- Interpreting member responses (done/not-done)
- Presenting status to the user

**Parallelism (decided):** Task subagents with `run_in_background` — see Section 5.3. Session-id persistence for crash recovery — see Section 5.4.

---

## 12. Open Gaps Summary

| # | Gap | Options | Status |
|---|-----|---------|--------|
| 1 | State file location | `.claude/project_plan.md` | **Decided: B** |
| 2 | Status reporting format | C: just loop (checkpoint file on disk) | **Decided: C** |
| 3 | Role prompting strategy | A: every prompt, B: initial only + resume | **Decided: A** |
| 4 | Subagent management | B: background + poll, user asks for status | **Decided: B** |
| 5 | Repo source / git workflow | Clone once, then: (a) branch from development, (b) checkout feature branch, (c) pull rebase. PRs to development. | **Decided: Section 6** |
| 6 | Who merges branches | PM-initiated sequential PRs to development, test after each merge. Doer resolves conflicts. | **Resolved: Section 6.4** |
| 7 | Skill invocation style | A: single `/pm` — PM infers intent from natural language + project_plan.md state. | **Decided: A** |
| 8 | Member permissions | Role-specific settings.json per assignment. dangerously_skip_permissions is opt-in fallback only. | **Resolved: Section 10** |
| 9 | Failure detection | 2 loops zero-progress at assigned tier + 1 escalation attempt. 3 total before user flag. | **Resolved: Section 5.2** |
| 10 | Conflict resolution on rebase | Doer rebases their own branch on development and resolves. | **Resolved: Section 6.4** |
| 11 | Model selection granularity | C: role default + escalation on stall (ties into gap #9 stall detection). | **Decided: C — Section 4.5** |
| 12 | Where does parallelism live | B: Task subagents with run_in_background. Session-id persistence for crash recovery. | **Decided: B — Section 5.3** |
| 13 | Plan.md immutability | Immutable during member session. PM replaces between sessions freely. Urgent fixes = new plan.md on next loop. | **Resolved** |
| 14 | Pre-test verification | Quality gate handles this — build+lint before tests exist | **Resolved: Section 2.3** |
| 15 | Member workspace lifecycle | New repo = new member folder. Same repo new project = branch switch + clean PM artifacts (plan.md, learnings.md, feedback-*.md). | **Resolved** |
| 16 | Git credentials on members | Same pattern as provision_auth — deploy PM's git token to members. New MCP tool needed (backlog). | **Resolved: Backlog** |
| 17 | Task granularity heuristic | Each task completable with small context (plan.md + learnings.md + target files) | **Resolved: Section 9** |
| 18 | Shared conventions across members | Convention files live in the repo (committed). Member prompts reference them by path. No send_files needed. | **Resolved** |
| 19 | Shared code propagation | Interface definition is an early phase task — committed to `development` (with mock tests). Members pick up interfaces via rebase on `development`. | **Resolved** |
| 20 | Architect correction path | Architect declares intent to PM ("I'm taking member X on branch Y"), PM records in project_plan.md. Architect works interactively, tells PM when done. Branch enters normal PR merge queue. | **Resolved** |
| 21 | Batch/overnight mode | Session-id persistence + --resume on restart. PM doesn't need to stay alive. | **Resolved: Section 5.4** |
| 22 | Do→review iteration limit | Configurable per project, default 3 | **Resolved: Section 4.4** |
| 23 | Quality gate customization | Per-project gate definition during brainstorming | **Resolved: Section 2.3** |
| 24 | feedback.md on same branch | Reviewer checks out doer's branch, commits feedback-{type}.md, pushes. Sequential ownership. | **Resolved: Section 4.3** |
| 25 | Re-review scoping | Reviewer reads previous feedback + git diff. Can find new HIGHs. | **Resolved: Section 4.3** |
| 26 | Tech-debt marking | PM/user marks items [TECH-DEBT], reviewers skip them. | **Resolved: Section 4.3** |
| 27 | Multiple reviewer feedback files | feedback-security.md, feedback-code-review.md, feedback-tester.md — no overwrites. | **Resolved: Section 4.3** |
