# Agent Context File

Provider-specific file in `work_folder` root. Persistent execution model.

## Filename (via `llmProvider`)

| Provider | Filename |
|----------|----------|
| Claude | CLAUDE.md |
| Gemini | GEMINI.md |
| Codex | AGENTS.md |
| Copilot | COPILOT-INSTRUCTIONS.md |

## Templates

| Role | Template |
|------|----------|
| Doer | `tpl-doer.md` |
| Reviewer | `tpl-reviewer.md` |

## Rules

- Copy template to project folder. Update `{{branch}}`, `{{base_branch}}`.
- `send_files` to member `work_folder` root before dispatch.
- **Never commit**. add filename to `.gitignore` via `execute_command`.
- Role switch: send new context file before dispatch.
- Cleanup: see `cleanup.md`. Restores from `origin/<base_branch>` if existed. **Never use `rm -f` / `git rm -f`**.

**If accidentally committed**:
```bash
git rm --cached CLAUDE.md
git checkout origin/<base_branch> -- CLAUDE.md
git add CLAUDE.md
git commit -m "fix: restore project file, un-track context file"
git push
```
