$files = @(
    "skills/fleet/auth-azdevops.md",
    "skills/fleet/auth-bitbucket.md",
    "skills/fleet/auth-github.md",
    "skills/fleet/onboarding.md",
    "skills/fleet/permissions.md",
    "skills/fleet/SKILL.md",
    "skills/fleet/skill-matrix.md",
    "skills/fleet/troubleshooting.md",
    "skills/pm/cleanup.md",
    "skills/pm/context-file.md",
    "skills/pm/doer-reviewer.md",
    "skills/pm/init.md",
    "skills/pm/multi-pair-sprint.md",
    "skills/pm/plan-prompt.md",
    "skills/pm/simple-sprint.md",
    "skills/pm/single-pair-sprint.md",
    "skills/pm/SKILL.md",
    "skills/pm/tpl-backlog.md",
    "skills/pm/tpl-deploy.md",
    "skills/pm/tpl-design.md",
    "skills/pm/tpl-doer.md",
    "skills/pm/tpl-plan.md",
    "skills/pm/tpl-pm.md",
    "skills/pm/tpl-projects.md",
    "skills/pm/tpl-requirements.md",
    "skills/pm/tpl-reviewer-plan.md",
    "skills/pm/tpl-reviewer.md",
    "skills/pm/tpl-status.md"
)

Write-Host "File,Lite-Compress,High-Compress"
foreach ($f in $files) {
    $lite = (Get-Content $f | Measure-Object -Word).Words
    $high_content = git show "plan/issue-204/high-compression:$f" 2>$null
    if ($LASTEXITCODE -eq 0) {
        $high = ($high_content | Measure-Object -Word).Words
    } else {
        $high = "N/A"
    }
    Write-Host "$f,$lite,$high"
}
