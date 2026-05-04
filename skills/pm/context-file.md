# Agent Context File

Fleet members need a provider-specific context file in `work_folder` root. Persistent model.

## Filenames

| Provider | Filename |
|---|---|
| Claude | `CLAUDE.md` |
| Gemini | `GEMINI.md` |
| Codex | `AGENTS.md` |
| Copilot | `COPILOT-INSTRUCTIONS.md` |

## Templates

- Doer: `tpl-doer.md`
- Reviewer: `tpl-reviewer.md`

## Rules

- Pick template (role) and filename (provider).
- Fill `{{branch}}`, `{{base_branch}}`.
- `send_files` to member root before dispatch.
- **Never commit.** Add to `.gitignore`.
- Role switch: send new file before dispatch.
- **Remove before merge:** Use `cleanup.md`. Restores from `origin/<base_branch>` if tracked. **Don't `rm -f`** — wipes tracked files.

**Recover committed:**
```bash
git rm --cached <file>
git checkout origin/<base_branch> -- <file>
git add <file>
git commit -m "fix: restore project file"
git push
```