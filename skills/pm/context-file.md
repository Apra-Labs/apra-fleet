# Agent Context File

Each fleet member requires a provider-specific agent context file in their `work_folder` root. This file is the member's persistent execution model and survives across session resumes.

## Provider Filename

Use `member_detail` → `llmProvider` to determine the target filename:

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

- Select the correct template based on role and target filename based on provider.
- Copy the template to the local project folder and update with project details. Fill in `{{branch}}` and `{{base_branch}}` with the sprint branch and base branch before delivery.
- Send to member via `send_files` to the member's `work_folder` root before dispatch.
- Do not commit to git. On first send, add the Agent Context File filename to the member's `.gitignore` via `execute_command → echo '<filename>' >> .gitignore`.
- On role switch (doer ↔ reviewer), send the new context file before dispatch.
- Remove before merge: use the cleanup command in `cleanup.md`. This command restores the file from `origin/<base_branch>` if it existed there before the sprint, and only deletes it if it was a pure sprint artifact. **Never use `rm -f` or `git rm -f`** on these files to avoid wiping a tracked project file.

**If the agent context file was accidentally committed mid-sprint**, recover with:
```bash
git rm --cached CLAUDE.md          # un-track without deleting from disk
git checkout origin/<base_branch> -- CLAUDE.md   # restore the project original
git add CLAUDE.md
git commit -m "fix: restore project CLAUDE.md, un-track agent context file"
git push
```
