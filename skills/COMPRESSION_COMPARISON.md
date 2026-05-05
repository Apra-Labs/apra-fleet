# Compression Comparison Report

This report compares word counts across four modes: Original, High-Compress (Caveman Ultra), Lite-Compress (Caveman Lite), and Normal-Compress (Caveman Normal).

| File | Original | Lite | Normal | High | Normal vs Orig % |
|------|----------|------|--------|------|------------------|
| fleet/auth-azdevops.md | 326 | 332 | 251 | 57 | -23.0% |
| fleet/auth-bitbucket.md | 277 | 267 | 218 | 39 | -21.3% |
| fleet/auth-github.md | 352 | 346 | 260 | 44 | -26.1% |
| fleet/onboarding.md | 573 | 552 | 314 | 133 | -45.2% |
| fleet/permissions.md | 178 | 164 | 102 | 49 | -42.7% |
| fleet/SKILL.md | 2186 | 2083 | 840 | 464 | -61.6% |
| fleet/skill-matrix.md | 268 | 269 | 233 | 129 | -13.1% |
| fleet/troubleshooting.md | 301 | 281 | 164 | 64 | -45.5% |
| pm/cleanup.md | 158 | 159 | 113 | 94 | -28.5% |
| pm/context-file.md | 303 | 286 | 143 | 129 | -52.8% |
| pm/doer-reviewer.md | 1174 | 1215 | 388 | 257 | -66.9% |
| pm/init.md | 223 | 199 | 101 | 78 | -54.7% |
| pm/multi-pair-sprint.md | 508 | 512 | 205 | 137 | -59.6% |
| pm/plan-prompt.md | 1152 | 696 | 315 | 209 | -72.7% |
| pm/simple-sprint.md | 321 | 335 | 156 | 106 | -51.4% |
| pm/single-pair-sprint.md | 1291 | 1279 | 443 | 247 | -65.7% |
| pm/SKILL.md | 1476 | 1469 | 538 | 328 | -63.5% |
| pm/tpl-backlog.md | 76 | 76 | 46 | 42 | -39.5% |
| pm/tpl-deploy.md | 113 | 115 | 47 | 24 | -58.4% |
| pm/tpl-design.md | 91 | 91 | 71 | 47 | -22.0% |
| pm/tpl-doer.md | 433 | 436 | 211 | 167 | -51.3% |
| pm/tpl-plan.md | 437 | 435 | 153 | 144 | -65.0% |
| pm/tpl-pm.md | 15 | 15 | 13 | 7 | -13.3% |
| pm/tpl-projects.md | 15 | 15 | 15 | 14 | 0.0% |
| pm/tpl-requirements.md | 80 | 79 | 45 | 36 | -43.8% |
| pm/tpl-reviewer-plan.md | 329 | 329 | 175 | 127 | -46.8% |
| pm/tpl-reviewer.md | 467 | 463 | 215 | 169 | -54.0% |
| pm/tpl-status.md | 90 | 90 | 82 | 59 | -8.9% |
| **TOTAL** | **13203** | **12513** | **5857** | **3156** | **-55.6%** |

*Note: Lite and High counts are based on generate_report.ps1 baseline. Normal counts are actual measurements from this sprint.*
