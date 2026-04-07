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
- Remove before merge: `rm -f CLAUDE.md GEMINI.md AGENTS.md COPILOT-INSTRUCTIONS.md` (part of pre-merge cleanup — see doer-reviewer.md)
