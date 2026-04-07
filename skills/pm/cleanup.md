# Sprint Cleanup

Run at sprint completion, before raising the PR. Execute on both doer and reviewer via `execute_command`:

```
git rm --cached .fleet-task.md 2>/dev/null || true; rm -f .fleet-task.md; git rm PLAN.md progress.json feedback.md requirements.md design.md 2>/dev/null; rm -f CLAUDE.md GEMINI.md AGENTS.md COPILOT-INSTRUCTIONS.md; git commit -m "cleanup: remove fleet control files" && git push
```

After cleanup on both members, raise the PR (`gh pr create`) and verify CI is green (`gh pr checks`). Do not merge — merge is the user's decision.
