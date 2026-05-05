# Compression Lite Review

| File | Original Phrase | Lite Phrase | Risk Level (High/Med/Low) | Resolution |
|------|-----------------|-------------|---------------------------|------------|
| skills/fleet/SKILL.md | multiple | "entered OOB — never in chat", "Never leave tool selection implicit", "Only use `{{secure.NAME}}` in the fields documented above." | Low | Preserved critical "NEVER" and "ONLY" constraints. |
| skills/fleet/permissions.md | "The tool rejects sudo, su..." | "The tool rejects sudo, su, env, printenv, nc, and nmap. Escalate these to the user." | Low | Strict rejection list preserved. |
| skills/fleet/onboarding.md | "Pass the sec://NAME handle in the task prompt" | "Pass the sec://NAME handle in the task prompt—reference by name only (e.g. \"authenticate using credential github_pat\")." | Low | Formal handle and usage instructions preserved. |
| skills/pm/SKILL.md | "NEVER read code, diagnose bugs, or suggest fixes" | "NEVER read code, diagnose bugs, or suggest fixes — assign a member." | Low | PM core mandate preserved. |
| skills/pm/single-pair-sprint.md | "Do not skip phases or stall between them." | "Do not skip phases or stall between them." | Low | Direct instruction preserved. |
| skills/pm/doer-reviewer.md | "The PM never self-reviews." | "The PM never self-reviews." | Low | Mandate preserved. |
| skills/pm/plan-prompt.md | "For every assumption, answer: 'How do I know this is currently true?' Then verify it." | "For every assumption, answer: 'How do I know this is currently true?' Then verify it." | Low | Verification loop preserved. |
| skills/pm/cleanup.md | (Code block for git cleanup) | (Same code block) | Low | Code blocks are never compressed. |
| skills/pm/context-file.md | "Never use rm -f or git rm -f" | "Never use rm -f or git rm -f on these files to avoid wiping a tracked project file." | Low | Safety warning preserved. |

## Conclusion
Lite compression (using `/caveman lite`) successfully reduced token usage while maintaining full grammatical structure and technical accuracy. No HIGH or MEDIUM risks were identified. All "NEVER", "ONLY", and "CRITICAL" constraints found in the original files were retained in the lite-compressed versions.
