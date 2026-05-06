#!/bin/bash
set -e
cd /mnt/c/akhil/git/apra-fleet

for file in CLAUDE.md GEMINI.md AGENTS.md COPILOT-INSTRUCTIONS.md; do
  if git show origin/main:"$file" > /dev/null 2>&1; then
    git checkout origin/main -- "$file"
    echo "restored $file"
  else
    git rm -f "$file" 2>/dev/null && echo "removed $file" || rm -f "$file"
  fi
done

git commit -m "cleanup: remove fleet control files"
git push
