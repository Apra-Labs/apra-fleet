#!/bin/bash

# Remove fleet task files (untracked)
rm -f .fleet-task*.md

# Force-remove control files from index+worktree (ignore if not tracked)
git rm --force --ignore-unmatch PLAN.md progress.json feedback.md requirements.md design.md

# For CLAUDE.md / AGENTS.md: restore from main if present there, else remove
for file in CLAUDE.md GEMINI.md AGENTS.md COPILOT-INSTRUCTIONS.md; do
  if git cat-file -e origin/main:"$file" 2>/dev/null; then
    git checkout origin/main -- "$file"
  else
    git rm --force --ignore-unmatch "$file"
  fi
done

echo "=== Staged changes ==="
git diff --cached --name-only

git commit -m "cleanup: remove fleet control files"
git push origin sprint/session-lifecycle-oob-fix
