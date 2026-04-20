# Sprint Cleanup

Run at sprint completion, before raising the PR. Execute on both doer and reviewer via `execute_command`:

```
git rm --cached .fleet-task*.md 2>/dev/null || true; rm -f .fleet-task*.md; git rm PLAN.md progress.json feedback.md requirements.md design.md 2>/dev/null; for file in CLAUDE.md GEMINI.md AGENTS.md COPILOT-INSTRUCTIONS.md; do if git show origin/main:"$file" > /dev/null 2>&1; then git checkout origin/main -- "$file"; else git rm -f "$file" 2>/dev/null || rm -f "$file"; fi; done; git commit -m "cleanup: remove fleet control files" && git push
```

**Why:** If a file like `CLAUDE.md` or `AGENTS.md` exists in `main`, it is a project deliverable — the sprint replaced it with a context file of the same name. Restoring from `origin/main` ensures the deliverable is preserved. Only files absent from `main` (pure sprint context) are deleted.

After cleanup on both members, raise the PR (`gh pr create`) and verify CI is green (`gh pr checks`). Do not merge — merge is the user's decision.
