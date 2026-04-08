# How to Create Individual Draft PRs from Plan Branches

## Current Situation

All implementation plans have been created and stored in two places:

1. **Organized in subdirectories** (on branch `copilot/analyze-issues-create-prs`):
   - `plan-issue-100/PLAN.md` - npm audit vulnerabilities
   - `plan-issue-98/PLAN.md` - glob patterns in file transfer
   - `plan-issue-96/PLAN.md` - Windows installer fix
   - `plan-issue-92/PLAN.md` - PM deploy.md sourcing
   - `plan-issue-91/PLAN.md` - git worktree bug
   - `plan-issue-90/PLAN.md` - claude --auto permissions
   - `plan-issue-77/PLAN.md` - Slack notifications
   - `plan-issue-76/PLAN.md` - GitHub App research

2. **Individual branches** (local only, not pushed):
   - `plan/issue-100-npm-audit`
   - `plan/issue-98-glob-patterns`
   - `plan/issue-96-windows-installer`
   - `plan/issue-92-pm-deploy-md`
   - `plan/issue-91-git-worktree`
   - `plan/issue-90-claude-auto`
   - `plan/issue-77-slack-notifications`
   - `plan/issue-76-github-app-research`

## Limitation

The bot cannot push branches directly to the repository due to permission constraints. The `report_progress` tool only pushes to a single PR branch (`copilot/analyze-issues-create-prs`).

## Manual Steps to Create Individual PRs

### Option 1: Using Local Branches (Recommended)

If you have push access to the repository, you can push the local branches and create PRs:

```bash
cd /path/to/apra-fleet

# Push all plan branches
for branch in plan/issue-100-npm-audit plan/issue-98-glob-patterns plan/issue-96-windows-installer plan/issue-92-pm-deploy-md plan/issue-91-git-worktree plan/issue-90-claude-auto plan/issue-77-slack-notifications plan/issue-76-github-app-research; do
  git push origin $branch
done

# Create draft PRs using gh CLI
gh pr create --head plan/issue-100-npm-audit --draft --title "Plan: Track and resolve npm audit vulnerabilities" --body "Implementation plan for issue #100. See PLAN.md for details."
gh pr create --head plan/issue-98-glob-patterns --draft --title "Plan: Support glob patterns in file transfer" --body "Implementation plan for issue #98. See PLAN.md for details."
gh pr create --head plan/issue-96-windows-installer --draft --title "Plan: Fix Windows installer file lock" --body "Implementation plan for issue #96. See PLAN.md for details."
gh pr create --head plan/issue-92-pm-deploy-md --draft --title "Plan: Source deploy.md from git root" --body "Implementation plan for issue #92. See PLAN.md for details."
gh pr create --head plan/issue-91-git-worktree --draft --title "Plan: Fix git worktree corruption bug" --body "Implementation plan for issue #91. See PLAN.md for details."
gh pr create --head plan/issue-90-claude-auto --draft --title "Plan: Use claude --auto permissions" --body "Implementation plan for issue #90. See PLAN.md for details."
gh pr create --head plan/issue-77-slack-notifications --draft --title "Plan: Slack notifications for fleet" --body "Implementation plan for issue #77. See PLAN.md for details."
gh pr create --head plan/issue-76-github-app-research --draft --title "Research: GitHub App token limitations" --body "Research plan for issue #76. See PLAN.md for details."
```

### Option 2: Recreate from Subdirectories

If the local branches are not available, you can recreate them from the subdirectories:

```bash
cd /path/to/apra-fleet

# Checkout the branch with all plans
git fetch origin
git checkout copilot/analyze-issues-create-prs

# For each issue, create a branch and copy the plan
for issue in 100 98 96 92 91 90 77 76; do
  git checkout -b plan/issue-${issue} origin/main
  cp plan-issue-${issue}/PLAN.md ./PLAN.md
  git add PLAN.md
  git commit -m "Plan: Implementation plan for issue #${issue}"
  git push origin plan/issue-${issue}
done

# Then create PRs as shown in Option 1
```

### Option 3: Using Git Patches

Git patches have been created for each plan and can be applied:

```bash
# Patches are available in /tmp/plan-patches/ on the bot's machine
# To use them, you would need to:
# 1. Get the patch files from the bot
# 2. Apply each patch to create the branch
# 3. Push and create PRs

# Example for one issue:
git checkout -b plan/issue-100 origin/main
git am < issue-100.patch
git push origin plan/issue-100
gh pr create --head plan/issue-100 --draft --title "Plan: npm audit fix" --body "Plan for #100"
```

## Automated Script

A helper script is available that automates the process (requires push permissions):

```bash
#!/bin/bash
set -e

# Array of issues
declare -A issues
issues[100]="Track and resolve npm audit vulnerabilities"
issues[98]="Support glob patterns and directories in file transfer"
issues[96]="Fix Windows installer file lock issue"
issues[92]="Source deploy.md from project git root"
issues[91]="Fix git worktree path corruption bug"
issues[90]="Use claude --auto permissions for Team/Enterprise"
issues[77]="Slack notifications for fleet state changes"
issues[76]="Research GitHub App installation token scope limitations"

# For each issue
for issue in "${!issues[@]}"; do
  branch="plan/issue-${issue}"
  title="${issues[$issue]}"
  
  echo "Processing issue #${issue}..."
  
  # Push branch
  if git push origin ${branch} 2>/dev/null; then
    echo "  ✓ Pushed ${branch}"
    
    # Create PR
    gh pr create \
      --head ${branch} \
      --title "Plan: ${title}" \
      --body "Implementation plan for issue #${issue}. See PLAN.md for details." \
      --draft && echo "  ✓ Created PR"
  else
    echo "  ✗ Failed to push ${branch}"
  fi
done
```

## Summary

The bot has created all the implementation plans but cannot push them individually due to permission constraints. Manual intervention is required to:

1. Push the plan branches to the repository
2. Create individual draft PRs for each issue

All necessary content is prepared and ready; it just needs to be pushed with appropriate permissions.
