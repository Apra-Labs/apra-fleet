$baseline = @{
    "skills/fleet/auth-azdevops.md" = 326
    "skills/fleet/auth-bitbucket.md" = 277
    "skills/fleet/auth-github.md" = 352
    "skills/fleet/onboarding.md" = 573
    "skills/fleet/permissions.md" = 178
    "skills/fleet/SKILL.md" = 2186
    "skills/fleet/skill-matrix.md" = 268
    "skills/fleet/troubleshooting.md" = 301
    "skills/pm/cleanup.md" = 158
    "skills/pm/context-file.md" = 303
    "skills/pm/doer-reviewer.md" = 1174
    "skills/pm/init.md" = 223
    "skills/pm/multi-pair-sprint.md" = 508
    "skills/pm/plan-prompt.md" = 1152
    "skills/pm/simple-sprint.md" = 321
    "skills/pm/single-pair-sprint.md" = 1291
    "skills/pm/SKILL.md" = 1476
    "skills/pm/tpl-backlog.md" = 76
    "skills/pm/tpl-deploy.md" = 113
    "skills/pm/tpl-design.md" = 91
    "skills/pm/tpl-doer.md" = 433
    "skills/pm/tpl-plan.md" = 437
    "skills/pm/tpl-pm.md" = 15
    "skills/pm/tpl-projects.md" = 15
    "skills/pm/tpl-requirements.md" = 80
    "skills/pm/tpl-reviewer-plan.md" = 329
    "skills/pm/tpl-reviewer.md" = 467
    "skills/pm/tpl-status.md" = 90
}

$lite = @{
    "skills/fleet/auth-azdevops.md" = 332
    "skills/fleet/auth-bitbucket.md" = 267
    "skills/fleet/auth-github.md" = 346
    "skills/fleet/onboarding.md" = 552
    "skills/fleet/permissions.md" = 164
    "skills/fleet/SKILL.md" = 2083
    "skills/fleet/skill-matrix.md" = 269
    "skills/fleet/troubleshooting.md" = 281
    "skills/pm/cleanup.md" = 159
    "skills/pm/context-file.md" = 286
    "skills/pm/doer-reviewer.md" = 1215
    "skills/pm/init.md" = 199
    "skills/pm/multi-pair-sprint.md" = 512
    "skills/pm/plan-prompt.md" = 696
    "skills/pm/simple-sprint.md" = 335
    "skills/pm/single-pair-sprint.md" = 1279
    "skills/pm/SKILL.md" = 1469
    "skills/pm/tpl-backlog.md" = 76
    "skills/pm/tpl-deploy.md" = 115
    "skills/pm/tpl-design.md" = 91
    "skills/pm/tpl-doer.md" = 436
    "skills/pm/tpl-plan.md" = 435
    "skills/pm/tpl-pm.md" = 15
    "skills/pm/tpl-projects.md" = 15
    "skills/pm/tpl-requirements.md" = 79
    "skills/pm/tpl-reviewer-plan.md" = 329
    "skills/pm/tpl-reviewer.md" = 463
    "skills/pm/tpl-status.md" = 90
}

$high = @{
    "skills/fleet/auth-azdevops.md" = 57
    "skills/fleet/auth-bitbucket.md" = 39
    "skills/fleet/auth-github.md" = 44
    "skills/fleet/onboarding.md" = 133
    "skills/fleet/permissions.md" = 49
    "skills/fleet/SKILL.md" = 464
    "skills/fleet/skill-matrix.md" = 129
    "skills/fleet/troubleshooting.md" = 64
    "skills/pm/cleanup.md" = 94
    "skills/pm/context-file.md" = 129
    "skills/pm/doer-reviewer.md" = 257
    "skills/pm/init.md" = 78
    "skills/pm/multi-pair-sprint.md" = 137
    "skills/pm/plan-prompt.md" = 209
    "skills/pm/simple-sprint.md" = 106
    "skills/pm/single-pair-sprint.md" = 247
    "skills/pm/SKILL.md" = 328
    "skills/pm/tpl-backlog.md" = 42
    "skills/pm/tpl-deploy.md" = 24
    "skills/pm/tpl-design.md" = 47
    "skills/pm/tpl-doer.md" = 167
    "skills/pm/tpl-plan.md" = 144
    "skills/pm/tpl-pm.md" = 7
    "skills/pm/tpl-projects.md" = 14
    "skills/pm/tpl-requirements.md" = 36
    "skills/pm/tpl-reviewer-plan.md" = 127
    "skills/pm/tpl-reviewer.md" = 169
    "skills/pm/tpl-status.md" = 59
}

$files = $baseline.Keys | Sort-Object

Write-Output "| File | Original | High-Compress | Lite-Compress | Lite vs Orig % | High vs Orig % |"
Write-Output "|------|----------|---------------|---------------|----------------|----------------|"

$totalOrig = 0
$totalHigh = 0
$totalLite = 0

foreach ($f in $files) {
    $o = $baseline[$f]
    $h = $high[$f]
    $l = $lite[$f]
    
    $lp = [math]::Round(($l - $o) / $o * 100, 1)
    $hp = [math]::Round(($h - $o) / $o * 100, 1)
    
    Write-Output "| $f | $o | $h | $l | $lp% | $hp% |"
    
    $totalOrig += $o
    $totalHigh += $h
    $totalLite += $l
}

$totalLP = [math]::Round(($totalLite - $totalOrig) / $totalOrig * 100, 1)
$totalHP = [math]::Round(($totalHigh - $totalOrig) / $totalOrig * 100, 1)

Write-Output "| **TOTAL** | **$totalOrig** | **$totalHigh** | **$totalLite** | **$totalLP%** | **$totalHP%** |"
