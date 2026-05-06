#!/bin/bash
set -e

# Remove fleet task files (untracked)
rm -f .fleet-task*.md

# Remove control files that are tracked on this branch
for file in PLAN.md progress.json feedback.md requirements.md design.md; do
  if git ls-files --error-unmatch "$file" 2>/dev/null; then
    git rm --force "$file"
  else
    rm -f "$file"
  fi
done

# For CLAUDE.md / AGENTS.md etc: restore from main if present, else remove
for file in CLAUDE.md GEMINI.md AGENTS.md COPILOT-INSTRUCTIONS.md; do
  if git show origin/main:"$file" > /dev/null 2>&1; then
    git checkout origin/main -- "$file"
  else
    if git ls-files --error-unmatch "$file" 2>/dev/null; then
      git rm --force "$file"
    else
      rm -f "$file"
    fi
  fi
done

git status
git diff --cached --name-only
git commit -m "cleanup: remove fleet control files"
git push origin sprint/session-lifecycle-oob-fix
