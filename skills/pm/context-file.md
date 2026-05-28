# Agent Context File

Each fleet member needs a provider-specific agent context file in their `work_folder` root. It is the member's persistent execution model and survives across session resumes.

## Provider Filename

Use `member_detail` -> `llmProvider` to determine the correct target filename:

| Provider | Filename |
|----------|----------|
| Claude | CLAUDE.md |
| Antigravity (agy) | AGY.md |
| Gemini | GEMINI.md |
| Codex | AGENTS.md |
| Copilot | COPILOT.md |

## Role Agents

| Role | Agent file (repo source) |
|------|--------------------------|
| Doer | `agents/doer.md` |
| Reviewer | `agents/reviewer.md` |

Installed by the apra-fleet installer at `~/.claude/agents/<name>.md` (Claude) and `~/.gemini/agents/<name>.md` (Gemini).

## Rules

- Activate the doer role by passing `agent: "doer"` to `execute_prompt`. Runtime parameters (branch, base_branch) flow via `substitutions` on the dispatch prompt -- not embedded in a context file.
- Activate the reviewer role by passing `agent: "plan-reviewer"` (plan review) or `agent: "reviewer"` (code review) to `execute_prompt`.
- The correct provider filename is still determined by `llmProvider` (see table above) but the file is installed on the member, not sent by PM.
- Never commit to git -- on first send, add the Agent Context File filename to the member's `.gitignore` via `execute_command -> echo '<filename>' >> .gitignore` (`.fleet-task.md` is covered by onboarding Step 7)
- On role switch (doer <-> reviewer): send the new context file before dispatch
- Remove before merge: use the cleanup command in `cleanup.md` -- it restores the file from `origin/<base_branch>` if it existed there before the sprint (project deliverable), and only deletes it if it was a pure sprint artifact. **Never use plain `rm -f` or `git rm -f`** on these files -- you will silently wipe a tracked project file.

**If the agent context file was accidentally committed mid-sprint**, recover with:
```bash
git rm --cached CLAUDE.md          # un-track without deleting from disk
git checkout origin/<base_branch> -- CLAUDE.md   # restore the project original
git add CLAUDE.md
git commit -m "fix: restore project CLAUDE.md, un-track agent context file"
git push
```
