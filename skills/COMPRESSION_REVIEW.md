#Compression Risk Review

## skills/fleet/SKILL.md
skills/fleet/SKILL.md: "Never use PowerShell or cmd.exe syntax" -> "Use bash." | risk: high | resolution: rephrased-fix
skills/fleet/SKILL.md: "never SSH directly or bypass fleet infrastructure" -> "Local: ALWAYS use fleet tools. No bypass." | risk: high | resolution: rephrased-fix
skills/fleet/SKILL.md: "always transfer all files in a single call, never one file per call." -> "Batch ops." | risk: high | resolution: rephrased-fix
skills/fleet/SKILL.md: "There is no way to target a specific session ID by value." -> "resume=true (default)." | risk: med | resolution: keep

## skills/pm/SKILL.md
skills/pm/SKILL.md: "NEVER read code, diagnose bugs, or suggest fixes — assign a member." -> "1. **No code.** Assign members." | risk: high | resolution: rephrased-fix
skills/pm/SKILL.md: "Do NOT pass dangerously_skip_permissions to execute_prompt" -> dropped entirely | risk: high | resolution: rephrased-fix
skills/pm/SKILL.md: "never delegate to fleet members" -> dropped | risk: high | resolution: rephrased-fix

## skills/pm/doer-reviewer.md
skills/pm/doer-reviewer.md: "Never bypass by running the denied command yourself via execute_command." -> "Denial? compose_permissions w/ grant. Append to ledger." | risk: high | resolution: rephrased-fix
skills/pm/doer-reviewer.md: "PM never self-reviews." -> dropped | risk: med | resolution: keep

## skills/pm/plan-prompt.md
skills/pm/plan-prompt.md: "NEVER commit to the base branch" -> "3. Commit plan to branch." | risk: high | resolution: rephrased-fix

## skills/pm/single-pair-sprint.md
skills/pm/single-pair-sprint.md: "this is the immutable original, never modify it" -> "Approved? Save planned.json." | risk: high | resolution: rephrased-fix
skills/pm/single-pair-sprint.md: "Never bypass by running the denied command yourself" -> "Denial? compose_permissions with grant." | risk: high | resolution: rephrased-fix
