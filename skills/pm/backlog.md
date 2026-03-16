# PM Skill — Backlog

## Done

- **G1** — Project folder structure & multi-project awareness. `tpl-claude-pm.md`, `tpl-projects.md`, `init.md`, `tpl-design.md` created. SKILL.md, doer-reviewer.md updated.
- **G2** — Force push/pull handoff via `execute_command`. doer-reviewer.md step 2, tpl-claude.md verify checkpoint updated.
- **G3** — Reviewer gets full context BEFORE review. doer-reviewer.md step 3, tpl-reviewer.md, tpl-reviewer-plan.md updated.
- **G4** — Rebase discipline. tpl-claude.md Branch Hygiene section, SKILL.md drift check added.
- **G5** — Decision filtering at checkpoints. SKILL.md Rule 7 updated.
- **G7** — Troubleshooting playbook. `troubleshooting.md` created, referenced from SKILL.md.
- **G8** — Pre-flight access checks. SKILL.md Rule 4 updated.
- **G9** — Session ID tracking. SKILL.md Rule 2 updated.
- **#16** — White-label attribution. Onboarding Step 2 writes `.claude/settings.json` with attribution disabled.

## Closed

- **G6** — Won't do. Hybrid PLAN.md-only model doesn't save enough to justify reliability risk. Agents need CLAUDE.md for checkpoint discipline regardless, and progress.json is cheap. Two tiers (ad-hoc vs full harness) are sufficient.

## Open

- **G10** — Proactive permission provisioning (High). Members hit permission denials mid-sprint, stalling work. PM should analyze the plan before `/pm start` and predict which tools/commands each member will need (build tools, test runners, git ops, file writes). Deliver `.claude/settings.local.json` with appropriate permissions BEFORE execution starts. Mid-sprint: when a member hits a denial, PM should grant and also update the baseline for future sprints. Goal: zero permission interrupts during execution.
- **G11** — Installer should pre-approve fleet tools (High). Currently, fleet tools (`execute_command`, `execute_prompt`, `send_files`, etc.) and related commands (`ssh`, `git`) require manual approval on first use. The installer should add these to the user-level allow list in `~/.claude/settings.json` so the PM can operate without interruption from the first session. See MCP-BACKLOG for implementation.
