# Agent Context File

Each fleet member needs a provider-specific agent context file in their `work_folder` root. It is the member's persistent execution model and survives across session resumes.

## Provider Filename

Use `member_detail` → `llmProvider` to determine the correct target filename:

| Provider | Filename |
|----------|----------|
| Claude | CLAUDE.md |
| Gemini | GEMINI.md |
| Codex | AGENTS.md |
| Copilot | COPILOT-INSTRUCTIONS.md |

## Role Templates

| Role | Template |
|------|----------|
| Doer | `tpl-doer.md` |
| Reviewer | `tpl-reviewer.md` |

## Rules

- Pick the correct template based on role and correct target filename based on provider
- Make a copy of the template to the local project folder, update it with project details — fill in `{{branch}}` and `{{base_branch}}` with the sprint branch and base branch before delivering
- Send to member via `send_files` to the member's `work_folder` root before dispatch
- Never commit to git — on first send, add the Agent Context File filename to the member's `.gitignore` via `execute_command → echo '<filename>' >> .gitignore` (`.fleet-task.md` is covered by onboarding Step 7)
- On role switch (doer ↔ reviewer): send the new context file before dispatch
- Remove before merge: use the cleanup command in `cleanup.md` — it restores the file from `origin/<base_branch>` if it existed there before the sprint (project deliverable), and only deletes it if it was a pure sprint artifact. **Never use plain `rm -f` or `git rm -f`** on these files — you will silently wipe a tracked project file.

**If the agent context file was accidentally committed mid-sprint**, recover with:
```bash
git rm --cached CLAUDE.md          # un-track without deleting from disk
git checkout origin/<base_branch> -- CLAUDE.md   # restore the project original
git add CLAUDE.md
git commit -m "fix: restore project CLAUDE.md, un-track agent context file"
git push
```
