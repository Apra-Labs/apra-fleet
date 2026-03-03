# PMO — Project Management Office

## What It Is
The PMO is an office assistant, not a project manager. It keeps tabs on multiple independent, unrelated projects running on different fleet agents. Each agent works on its own project — they are not collaborating on the same codebase or doing dependent tasks. The PMO's job is to:
- Know who is doing what across all projects
- Help the user context-switch between projects without losing track
- Gather status from any agent on demand
- Identify what each project needs to move forward
- Organize findings so the user can pick up any project after days/weeks away

## Concept
A central Claude Code session (the "PMO") sits above multiple fleet agents, each working on its own independent project. The PMO never writes application code directly — it delegates to agents, collects results, maintains per-project state, and helps the user stay on top of everything. Think of it as a desk with multiple project folders open — the PMO helps you flip between them efficiently.

## Core Patterns

### 1. Agent Registration & Bootstrapping
- Register agents with password auth first, then immediately switch to SSH key-based auth for security and reliability.
- Provision OAuth credentials (`provision_auth`) right after registration so agents are ready to run Claude.
- Keep Claude CLI updated on all agents.
- One physical machine can host multiple agents with different work folders (e.g., two agents on the same Mac for two different repos).

### 2. Always Use Background Agents
- All fleet operations (execute_command, execute_prompt) run via background subagents (`run_in_background: true`).
- This keeps the opcenter responsive — the user can issue new commands, ask questions, or launch parallel work while agents run.
- Multiple agents can run simultaneously on different machines for true parallelism.

### 3. Project Context Recovery
- When reviving a stale project, use `claude -c -p` on the remote agent to ask for a status report. The remote Claude has conversation history and codebase access.
- Ask for structured output: phase-by-phase breakdown, what's done, what's partial, what's not started, bugs, blockers, and next steps.
- Save these reports locally as reference docs so the opcenter (and future sessions) can reason about project state without re-querying.

### 4. Local File Organization
- Maintain a subfolder per agent/project in the opcenter directory to avoid file collisions.
- Store status reports, analysis results, and reference docs in the appropriate subfolder.
- Update CLAUDE.md with the folder structure so future sessions know where to find/save things.

### 5. CLAUDE.md as Operational Memory
- Use CLAUDE.md to record durable operational rules (e.g., "always use background agents").
- Document each agent's purpose, remote path, and what skills/tools to use with it.
- Reference status files by path so future sessions can pick up where you left off.

### 6. Parallel Information Gathering
- When you need status from multiple agents, launch all queries simultaneously as parallel background agents.
- Each agent writes to its own file — no conflicts, results arrive independently.
- Summarize results to the user as they arrive rather than waiting for all to complete.
- Agents work on unrelated projects — parallelism is about the user's time, not task dependencies.

### 7. Context Switching
- The user may jump between projects at any time. The PMO must be able to brief them on any project instantly.
- Status files in each project subfolder serve as the "handoff doc" — read them to get up to speed without querying the agent again.
- When the user says "what's going on with X?" — check the local status file first, only query the remote agent if the file is stale or missing.

### 8. Skill Associations
- Certain agents have domain-specific skills (e.g., streamsurv_avms + lvsm-log-analyzer-skill).
- Document these associations in CLAUDE.md so the opcenter knows which skill to invoke when working with that agent.

### 9. Handling Agent Failures
- If `execute_prompt` returns empty or the agent seems stuck, check auth token expiry first — re-provision if needed.
- For long-running prompts, use generous timeouts (300-600s). The default may not be enough for complex analysis tasks.
- When a local agent blocks on permissions (file reads, command execution), improve the prompt to be more specific, or use `execute_command` with `--dangerously-skip-permissions` for trusted workloads.
- Don't assume one method (execute_prompt vs execute_command with `claude -c -p`) is inherently faster or more reliable — they both run Claude on the agent. Diagnose the actual failure before switching approaches.
- If an agent's session is corrupted, use `reset_session` and retry with `resume: false`.
- `dangerously_skip_permissions` does NOT create a fresh session — it simply skips permission prompts. Session loss happens when `resume: false` is set. Don't confuse the two.
- When agents need to write files, include `dangerously_skip_permissions: true` from the start if the task is trusted, rather than retrying after permission denials.
- When retrying a failed task, use `resume: true` to preserve the agent's context and prior work.
- **Empty responses don't always mean failure.** The agent may have been working and hit max_turns, or the session may have context issues. Before assuming failure: (1) use `execute_command` to check `progress.json` and `git log` to see what actually happened, (2) the agent may have completed more work than expected — it can blow past verify checkpoints if the CLAUDE.md instructions aren't strict enough.
- **Agents may chew through more tasks than intended.** If the agent doesn't stop at verify checkpoints, it means the session's context grew large enough that the verify-stop instruction was diluted. Check progress.json via `execute_command` (cheap, fast) before assuming the worst.
- **Track session IDs per agent.** Session IDs are durable — they are never lost even after `reset_session`. You can always resume a previous session with `--resume <session-id>`. Store recent session IDs in the agent's status file so you can recover context if needed.

### 10. Design-to-Deployment Pipeline
When building new capabilities (tools, features), the PMO should drive the full lifecycle without pausing for approval between stages:
1. **Brainstorm** — discuss approach with user, consider alternatives
2. **Design doc** — write a proposal doc in the project's `docs/` folder
3. **Task file** — send agent to create detailed implementation tasks
4. **Implement** — immediately kick off the agent to build (don't wait for user go-ahead)
5. **Test** — run build + tests, report results
6. **Security audit** — run in parallel with commit (use a separate local read-only agent)
7. **Fix findings** — action security fixes immediately, especially quick wins
8. **Deploy** — pull to deployment folder, rebuild, restart server
9. **Update docs** — document new tools/features (part of definition of done)
10. **Clean backlog** — remove completed items, add new findings

The PMO should pipeline these stages — e.g., start security audit while commit is in progress, queue docs task while security fixes are running. Never let an agent sit idle between stages.

### 11. Security as First-Class Workflow
- Security audit should happen on every significant feature, not just when asked.
- Quick fixes (input validation, token masking, escaping) should be actioned immediately — "security can not wait."
- Medium fixes (cleanup tools, ACLs) go to backlog as High Priority.
- Audit findings format: severity (Critical/High/Medium/Low/Info), file:line, description, recommendation.
- Run audits by reading source locally (fast, doesn't block the fleet agent).

### 12. Build-Deploy Awareness
The PMO must track the full pipeline from code to running software:
- **Agent builds code** → committed and pushed (agent's repo)
- **Deployment folder** is separate from the dev repo (e.g., `~/.claude-fleet-mcp` vs `C:\akhil\git\claude-code-fleet-mcp`)
- After push: pull in deployment folder → `npm install` → `npm run build` (or use `install.sh`)
- MCP servers need restart to pick up new code — use `shutdown_server` tool then `/mcp` to reconnect
- **Local agent = same filesystem.** Don't `git pull` on a local agent's repo — the code is already there. Pull is only needed in the deployment folder or for remote agents.

### 13. Agent Momentum — Never Let Agents Sit Idle
- After task planning completes, immediately kick off implementation. Don't wait for user approval.
- After verification checkpoints, PMO reviews and resumes immediately.
- After one task completes, queue the next task before reporting to user.
- Use PLAN.md in the agent's work folder to queue upcoming tasks so the agent can self-serve when resumed.
- If the agent finishes early and there's more work, it should find PLAN.md and continue.

### 14. Backlog Hygiene
- Completed items must be removed immediately, not left as "done."
- New findings (security, bugs, improvements) go to backlog immediately with priority.
- Status labels: In Progress, High Priority, Medium Priority, Low Priority.
- Each backlog item should link to relevant design docs or task files.
- Duplicate entries must be caught and merged.

### 15. Ad-hoc vs Structured Execution
- **Ad-hoc prompts** work for 1-3 step tasks (quick fixes, single-file changes, build/test/push).
- **Structured plan model** (CLAUDE.md + PLAN.md + progress.json) is needed for 4+ step tasks.
- **Hybrid**: Even without full plan model, a PLAN.md in the work folder gives the agent a queue to work through across resume cycles.
- When you realize mid-flight that you should have used the structured model, add PLAN.md to the work folder — it's never too late.

### 16. Multi-Project Token/Credential Management
- Tokens are short-lived (1hr for GitHub App installation tokens) — factor this into task timing.
- Mint tokens just-in-time, not ahead of time.
- Always clean up tokens from git remote URLs after use (`git remote set-url origin` back to tokenless).
- The PMO can mint tokens locally (no need to involve an agent) and deploy them to agents via `execute_command`.
- Credential helpers on agents should be cleaned up after use to limit blast radius.

## Anti-Patterns to Avoid
- **NEVER run two concurrent subagents against the same fleet agent** — one agent, one task at a time. This can corrupt sessions, cause race conditions, and produce unpredictable results. Wait for completion before sending another task to the same agent.
- **Don't run fleet operations in foreground** — blocks the conversation while waiting.
- **Don't duplicate work** — if a background agent is researching something, don't also search for it in the opcenter.
- **Don't store all project files flat** — use subfolders per project to prevent naming collisions.
- **Don't rely on memory alone** — always persist status reports and key findings to files so they survive across sessions.
- **Don't say "it's live" without verifying the deployment** — code committed ≠ code deployed. Check: is the deployment folder updated? Is the server rebuilt? Does `/mcp` show the new tools?
- **Don't wait for user approval between pipeline stages** — the user said "never wait for me to approve, it is your job to push work." After planning, start building. After building, start testing. After testing, start deploying.
- **Don't send ad-hoc prompts for multi-step work** — if you're about to send 3+ sequential prompts to the same agent, stop and create a PLAN.md instead. The agent can self-serve from the plan across session boundaries.
- **Don't confuse dev repo with deployment folder** — the agent develops in `C:\akhil\git\claude-code-fleet-mcp`, the server runs from `C:\Users\akhil\.claude-fleet-mcp`. These are different.
- **Don't forget docs as part of definition of done** — new tools need documentation updated. This should be in the task list from the start, not remembered after the fact.
- **Don't leave completed items in the backlog** — remove them immediately to keep the backlog actionable.
- **Don't `git pull` on local agents** — local agents write directly to the filesystem. The code is already there.

## Long-Running Plan Execution Model

When an agent has a large, multi-step task (10+ steps), use the structured plan execution model instead of ad-hoc prompts.

### The 3-File Pattern
Push three files to the agent's work_folder root:

1. **CLAUDE.md** — Instructs the agent to follow the plan execution model. Contains: context recovery (read recent git log), task loop (read progress.json → read PLAN.md → execute → commit → update progress.json → continue), verification checkpoint rules, and the rule to NEVER commit these 3 control files.

2. **PLAN.md** — The full implementation plan with detailed instructions per task. Organized by phases, each phase ending with a verification checkpoint.

3. **progress.json** — Machine-readable task tracker. Each task has: `id`, `step` (title), `type` ("work" or "verify"), `status` ("pending"/"completed"/"blocked"), `commit` (hash after completion), and `notes`.

### Verification Checkpoints
Insert "verify" tasks between phases. When the agent hits a verify task, it:
- Runs the full test suite
- Confirms all prior tasks in the phase work correctly
- Updates progress.json with results
- **STOPs** — does not continue. Reports back to PMO for review.

This gives the PMO natural review points to catch issues early rather than discovering problems 10 tasks later. **PMO should review verification results and immediately resume the agent into the next phase — never wait for user approval at checkpoints.**

### Setup Steps
1. Add `CLAUDE.md`, `PLAN.md`, `progress.json` to the agent's `.gitignore`
2. Transfer the 3 files to the work_folder root (overwrite any existing CLAUDE.md)
3. Start the agent with `execute_prompt` — it reads progress.json and begins

### Resuming Work
The agent is designed to be resumable. On each invocation it reads progress.json to find where it left off. If context is lost (session reset), the git log + progress.json provide enough state to continue.

### Templates
Reusable templates live at `templates/long-running-plan/`:
- `CLAUDE.md.template`
- `PLAN.md.template`
- `progress.json.template`

Fill in `{{PROJECT_NAME}}`, task details, and phase structure for each new plan.

## PMO Skill — Extracted Requirements

These patterns were manually executed today and should be automated by the PMO skill:

### Plan Generation
- User describes a feature/task in natural language
- PMO generates PLAN.md with phases, tasks, verify checkpoints
- PMO generates progress.json with machine-readable task list
- PMO generates CLAUDE.md with execution model instructions
- PMO pushes all 3 files to agent's work_folder, updates .gitignore

### Execution Loop
- PMO kicks off agent (`execute_prompt`) — agent reads progress.json and starts
- On verify checkpoint: agent stops, PMO reads progress.json via `execute_command`
- PMO reviews results, resumes agent into next phase (no user approval needed)
- On empty response / timeout: PMO checks progress.json + git log to assess actual state
- On completion: PMO reports summary to user

### Design-to-Deploy Pipeline
- Brainstorm → design doc → task file → implement → test → audit → fix → deploy → docs → backlog cleanup
- Each stage flows into the next automatically
- Security audit runs in parallel with commit (local file read, doesn't block agent)
- Deployment step: pull → install → build → restart server → verify tools loaded

### Credential Management
- Before git operations: PMO mints scoped token, deploys to agent
- After git operations: PMO cleans up token from agent
- Token lifetime awareness: don't mint too early, factor 1hr expiry into task planning
- Use `provision_git_auth` tool when available, manual mint when not

### Quality Gates
- Build must pass before commit
- All tests must pass before push
- Security audit on every significant feature
- Quick security fixes actioned immediately
- Docs updated as part of definition of done
- Backlog updated: completed items removed, new findings added

## Workflow Template
1. **Orient** — List agents, check which are online, review existing status files.
2. **Query** — Launch background agents to gather current project state.
3. **Organize** — Save results into project subfolders, update CLAUDE.md.
4. **Decide** — Review reports with the user, agree on next steps.
5. **Delegate** — Send work to agents via execute_prompt or execute_command.
6. **Monitor** — Track background agent completion, summarize results as they arrive.
7. **Record** — Update status files and learnings after each work cycle.
