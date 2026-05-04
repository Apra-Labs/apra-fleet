#!/bin/bash
git rm --cached .fleet-task*.md 2>/dev/null || true
rm -f .fleet-task*.md
git rm PLAN.md progress.json feedback.md requirements.md design.md 2>/dev/null || true
for file in CLAUDE.md GEMINI.md AGENTS.md COPILOT-INSTRUCTIONS.md; do
  if git show origin/main:"$file" > /dev/null 2>&1; then
    git checkout origin/main -- "$file"
  else
    git rm -f "$file" 2>/dev/null || rm -f "$file"
  fi
done
git commit -m "cleanup: remove fleet control files" && git push origin sprint/session-lifecycle-oob-fix
