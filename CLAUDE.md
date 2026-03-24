# Apra Fleet — MCP Server + PM Skill

## What This Repo Is
<<<<<<< HEAD
MCP server (`src/`) managing a fleet of remote/local Claude Code members via SSH. Ships with a PM skill (`skills/pm/`) that orchestrates multi-step work across members.

## Key Paths
- `src/` — MCP server source (TypeScript)
- `skills/pm/` — PM skill (`SKILL.md` + supporting docs + templates)
- `docs/` — server documentation and design docs
- `tests/` — unit + integration tests
- `hooks/` — post-registration hook
- `scripts/` — statusline, SEA build pipeline

## Terminology
- **member** = registered machine in the fleet
- **agent** = Claude Code session running on a member (internal code type)
- See `docs/vocabulary.md` for full definitions

## Fleet MCP Essentials
- **Fleet operations** run as background subagents (`run_in_background: true`)
- **Never two concurrent ops on the same member** — one member, one task at a time
- **3-file pattern**: CLAUDE.md + PLAN.md + progress.json pushed to member's work_folder
- **planned.json** (pm's immutable copy) vs **progress.json** (member's living state)
- **Dev vs deploy**: code committed != code deployed. Pull → install → build → restart.
- **Verify checkpoints**: member stops, pm reviews, resumes. Never skip.

## Development Gotchas
- **After `npm run build`**: call `shutdown_server` → user runs `/mcp` → confirm before live testing. The running process serves old code until restarted.
- **Claude CLI invocations**: `getClaudeCommand(os, args)` in `src/utils/platform.ts` is the single source of truth.
- **ssh2 streams**: require `stream.end()` after exec to close stdin (prevents `claude -p` from hanging).
- **Auth validation**: always use `claude -p "hello"` not `claude auth status` (the latter doesn't validate API keys).
=======
An MCP server () that manages a fleet of remote/local AI coding agents via SSH. Ships with a PM skill () that orchestrates long-running work across those agents.

## Key Paths
-  — MCP server source (TypeScript)
-  — PM skill definition and templates
-  — documentation
-  — test suite

## Rules
- Run 
> apra-fleet@0.1.0 test
> vitest run


[1m[46m RUN [49m[22m [36mv4.0.18 [39m[90mC:/akhil/git/apra-fleet[39m

 [32m✓[39m tests/platform.test.ts [2m([22m[2m105 tests[22m[2m | [22m[33m3 skipped[39m[2m)[22m[33m 938[2mms[22m[39m
       [33m[2m✓[22m[39m windows: returns pristine env and powershell shell [33m 897[2mms[22m[39m
 [32m✓[39m tests/cloud-provider.test.ts [2m([22m[2m28 tests[22m[2m)[22m[32m 178[2mms[22m[39m
 [32m✓[39m tests/cloud-integration.test.ts [2m([22m[2m9 tests[22m[2m)[22m[33m 493[2mms[22m[39m
 [32m✓[39m tests/idle-manager.test.ts [2m([22m[2m15 tests[22m[2m)[22m[32m 32[2mms[22m[39m
 [32m✓[39m tests/activity.test.ts [2m([22m[2m15 tests[22m[2m)[22m[32m 16[2mms[22m[39m
 [32m✓[39m tests/cloud-lifecycle.test.ts [2m([22m[2m11 tests[22m[2m)[22m[33m 346[2mms[22m[39m
 [32m✓[39m tests/strategy.test.ts [2m([22m[2m5 tests[22m[2m)[22m[33m 2839[2mms[22m[39m
     [33m[2m✓[22m[39m execCommand() runs command locally and returns stdout/code [33m 1479[2mms[22m[39m
     [33m[2m✓[22m[39m execCommand() does not leak CLAUDECODE to child process [33m 648[2mms[22m[39m
     [33m[2m✓[22m[39m execCommand() returns non-zero code for failed commands [33m 681[2mms[22m[39m
 [32m✓[39m tests/registry.test.ts [2m([22m[2m22 tests[22m[2m)[22m[33m 430[2mms[22m[39m
 [32m✓[39m tests/provision-vcs-auth.test.ts [2m([22m[2m11 tests[22m[2m)[22m[32m 241[2mms[22m[39m
 [32m✓[39m tests/cloud-lifecycle-unit.test.ts [2m([22m[2m6 tests[22m[2m)[22m[32m 246[2mms[22m[39m
 [32m✓[39m tests/execute-prompt.test.ts [2m([22m[2m8 tests[22m[2m)[22m[33m 380[2mms[22m[39m
 [32m✓[39m tests/provision-auth.test.ts [2m([22m[2m7 tests[22m[2m)[22m[32m 287[2mms[22m[39m
 [32m✓[39m tests/defensive-ux.test.ts [2m([22m[2m9 tests[22m[2m)[22m[32m 164[2mms[22m[39m
 [32m✓[39m tests/github-app.test.ts [2m([22m[2m7 tests[22m[2m)[22m[33m 589[2mms[22m[39m
     [33m[2m✓[22m[39m produces a verifiable RS256 signature [33m 551[2mms[22m[39m
 [32m✓[39m tests/vcs-auth.test.ts [2m([22m[2m18 tests[22m[2m)[22m[32m 15[2mms[22m[39m
 [32m✓[39m tests/shell-escape.test.ts [2m([22m[2m13 tests[22m[2m)[22m[32m 10[2mms[22m[39m
 [32m✓[39m tests/cost.test.ts [2m([22m[2m12 tests[22m[2m)[22m[32m 8[2mms[22m[39m
 [32m✓[39m tests/crypto.test.ts [2m([22m[2m5 tests[22m[2m)[22m[33m 734[2mms[22m[39m
 [32m✓[39m tests/execute-command.test.ts [2m([22m[2m8 tests[22m[2m)[22m[32m 291[2mms[22m[39m
 [32m✓[39m tests/agent-helpers.test.ts [2m([22m[2m4 tests[22m[2m)[22m[32m 135[2mms[22m[39m
 [32m✓[39m tests/revoke-vcs-auth.test.ts [2m([22m[2m6 tests[22m[2m)[22m[32m 200[2mms[22m[39m
 [32m✓[39m tests/known-hosts.test.ts [2m([22m[2m7 tests[22m[2m)[22m[32m 98[2mms[22m[39m
 [32m✓[39m tests/agent-detail.test.ts [2m([22m[2m3 tests[22m[2m)[22m[32m 81[2mms[22m[39m
 [32m✓[39m tests/setup-git-app.test.ts [2m([22m[2m5 tests[22m[2m)[22m[32m 74[2mms[22m[39m
 [32m✓[39m tests/git-config.test.ts [2m([22m[2m5 tests[22m[2m)[22m[32m 43[2mms[22m[39m
 [32m✓[39m tests/security-hardening.test.ts [2m([22m[2m24 tests[22m[2m)[22m[32m 20[2mms[22m[39m
 [32m✓[39m tests/credential-validation.test.ts [2m([22m[2m12 tests[22m[2m)[22m[32m 14[2mms[22m[39m
 [32m✓[39m tests/task-wrapper.test.ts [2m([22m[2m7 tests[22m[2m)[22m[32m 8[2mms[22m[39m
 [32m✓[39m tests/prompt-errors.test.ts [2m([22m[2m6 tests[22m[2m)[22m[32m 6[2mms[22m[39m
 [32m✓[39m tests/gpu-parser.test.ts [2m([22m[2m4 tests[22m[2m)[22m[32m 7[2mms[22m[39m

[2m Test Files [22m [1m[32m30 passed[39m[22m[90m (30)[39m
[2m      Tests [22m [1m[32m394 passed[39m[22m[2m | [22m[33m3 skipped[39m[90m (397)[39m
[2m   Start at [22m 23:06:26
[2m   Duration [22m 22.49s[2m (transform 1.15s, setup 343ms, import 4.79s, tests 8.92s, environment 7ms)[22m before committing
- Run 
> apra-fleet@0.1.0 build
> tsc before pushing
- Never commit secrets or credentials
>>>>>>> a2ac0c9 (chore: move requirements to docs/, reset CLAUDE.md and progress.json to clean state)
