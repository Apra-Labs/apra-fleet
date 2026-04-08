# Implementation Plans for Open Issues

This directory contains implementation plans for complex issues that require detailed planning before implementation.

Each subdirectory contains a `PLAN.md` file for a specific issue:

- `plan-issue-100/` - Track and resolve npm audit vulnerabilities
- `plan-issue-98/` - Support glob patterns and directories in file transfer
- `plan-issue-96/` - Fix Windows installer file lock issue
- `plan-issue-92/` - Source deploy.md from project git root
- `plan-issue-91/` - Fix git worktree path corruption bug
- `plan-issue-90/` - Use claude --auto permissions for Team/Enterprise
- `plan-issue-77/` - Slack notifications for fleet state changes (Future)
- `plan-issue-76/` - Research GitHub App installation token scope limitations

## Note

These plans were created by automated issue triage. Each issue should eventually get its own feature branch and pull request for implementation.

## Limitation

Due to permission constraints, these plans are all in a single branch. Ideally, each would be in a separate `plan/issue-N` branch with its own draft PR, but that requires direct push permissions which the bot doesn't have.

## Next Steps

To create individual PRs for each plan:

1. For each issue, create a new branch from main: `git checkout -b plan/issue-N main`
2. Copy the corresponding PLAN.md to the root: `cp plan-issue-N/PLAN.md ./PLAN.md`
3. Commit: `git add PLAN.md && git commit -m "Plan: <issue title> (issue #N)"`
4. Push: `git push origin plan/issue-N`
5. Create draft PR: `gh pr create --draft --title "Plan: <issue title>" --body "Planning document for issue #N"`
