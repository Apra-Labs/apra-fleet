# File Audit — Apra Fleet

> Audit date: 2026-03-19
> Every file in the repo evaluated. Comment inline with your decision.

---

## Legend

- **Keep** — no changes needed
- **Refine** — content is useful but needs updates
- **Remove** — historical artifact, git history preserves it

---

## Root Files

### 1. `CLAUDE.md` — **Refine**
References non-existent `materials/` directory. "Current Focus" section describes a PM skill rewrite driven by `materials/index.md`, `materials/progress.md`, `materials/change-proposals.md`, `materials/improvements-needed.md` — none of which exist. Fleet essentials section is accurate but could be tightened.

### 2. `README.md` — **Refine**
Mostly accurate. Mixes "agent"/"member" terminology in a few places (e.g. architecture diagram description). Tool table is current and correct.

### 3. `CORRECTIONS.md` — **Remove**
Historical list of corrections to Task 18 (PM skill). These should have been applied to SKILL.md already. If any are unapplied, apply them first, then delete this file.

### 4. `progress.json` — **Remove**
All 25 tasks marked "done" from v0.0.1 release. Purely historical — git history preserves this. No open items.

### 5. `package.json` — **Keep**
Current and accurate. Version, dependencies, scripts all correct.

### 6. `tsconfig.json` — **Keep**
Standard TypeScript build config. Nothing outdated.

### 7. `vitest.config.ts` — **Keep**
Standard test runner config. Nothing outdated.

### 8. `version.json` — **Keep**
Current at 0.1.1.

### 9. `fleet.config.json` — **Refine**
Contains example agent registrations checked into git. Should either be gitignored (it's runtime data) or renamed to make clear it's an example, since `fleet.config.example.json` already exists separately.

### 10. `fleet.config.example.json` — **Keep**
Configuration template for users. Serves its purpose.

---

## `docs/` Directory

### 11. `docs/architecture.md` — **Refine**
Architecture is accurate but uses "agent" throughout instead of "member". Tool group links reference old names (`register_agent`, `agent_detail`, `list_agents`). Needs a terminology pass.

### 12. `docs/vocabulary.md` — **Keep**
Authoritative terminology reference. Correctly defines member vs agent vs subagent. The source of truth for naming.

### 13. `docs/user-guide.md` — **Keep**
Already uses "member" terminology consistently. Most accurate user-facing doc.

### 14. `docs/ssh-setup.md` — **Keep**
Platform-specific SSH setup instructions. Current and accurate.

### 15. `docs/SECURITY-REVIEW.md` — **Keep**
Security audit findings. Accurate for the current codebase.

### 16. `docs/LANDSCAPE.md` — **Keep**
Competitive analysis. Uses "agent" in industry context which is appropriate.

### 17. `docs/tools-lifecycle.md` — **Refine**
Severely outdated — references `register_agent`, `list_agents`, `agent_detail` instead of `register_member`, `list_members`, `member_detail`. Parameter names wrong (`agent_id` should be `member_id`). Needs full rewrite of tool names and parameters.

### 18. `docs/tools-observability.md` — **Refine**
References `agent_detail` instead of `member_detail`. Parameter names wrong. Same terminology issues as tools-lifecycle.md.

### 19. `docs/tools-work.md` — **Refine**
Tool names are correct but uses `agent_id` parameter name (should be `member_id`). "Agent" terminology in prose descriptions.

### 20. `docs/tools-infrastructure.md` — **Refine**
Minor terminology issues. Parameter names need verification against actual tool schemas in src/.

### 21. `docs/ProjMgr-requirements.md` — **Refine**
50+ instances of "agent" that should be "member". References `list_agents` (should be `list_members`). Core design content is sound but terminology is pervasively wrong.

### 22. `docs/design-git-auth.md` — **Refine**
Uses "agent" throughout. Design is sound but predates the VCS auth unification. Terminology pass needed.

### 23. `docs/design-vcs-auth-onboarding.md` — **Refine**
Partially implemented design doc. Uses "agent" terminology. Should be marked with implementation status (what's done, what's not).

### 24. `docs/learnings.md` — **Refine**
References `register_agent` (should be `register_member`). Practical content is valuable but terminology is stale.

### 25. `docs/tasks-git-auth.md` — **Remove**
Pre-implementation task checklist for git auth. All tasks complete or superseded. Historical artifact — git history preserves it.

### 26. `docs/MCP-BACKLOG.md` — **Keep**
Active MCP server backlog with prioritized items. Still relevant for future server work.

---

## `skills/pm/` — Core Files

### 27. `skills/pm/SKILL.md` — **Refine**
Primary target for the PM skill rewrite. Baseline version — functional but needs improvements identified in backlog.md and CORRECTIONS.md.

### 28. `skills/pm/init.md` — **Keep**
Project initialization flow. Complete and current.

### 29. `skills/pm/doer-reviewer.md` — **Keep**
Review loop protocol. Current, uses "member" correctly. Well-structured.

### 30. `skills/pm/onboarding.md` — **Refine**
References `agentType` field name (internal) in user-facing context. Should use user-facing "member type" language.

### 31. `skills/pm/permissions.md` — **Refine**
References `compose_permissions` tool — verify this matches actual tool name in `src/tools/compose-permissions.ts`. Cross-reference needed.

### 32. `skills/pm/plan-prompt.md` — **Refine**
Doesn't reference the `tpl-plan.md` output format. Should explicitly link to the template so the prompt and expected output stay in sync.

### 33. `skills/pm/skill-matrix.md` — **Keep**
Skills lookup table by project/VCS/role. Current and used by onboarding.

### 34. `skills/pm/troubleshooting.md` — **Keep**
Symptom-to-action lookup. Compact and current.

### 35. `skills/pm/backlog.md` — **Remove**
All 13 items marked "done", 1 "won't-do". No open items. Historical — git preserves it. Improvements should be reflected in SKILL.md itself, not tracked separately after completion.

---

## `skills/pm/` — Auth Guides

### 36. `skills/pm/auth-github.md` — **Refine**
Uses `agent_id` parameter in tool call examples. Should be `member_id`.

### 37. `skills/pm/auth-bitbucket.md` — **Refine**
Same `agent_id` → `member_id` issue in examples.

### 38. `skills/pm/auth-azdevops.md` — **Refine**
Same `agent_id` → `member_id` issue in examples.

---

## `skills/pm/` — Templates

### 39. `skills/pm/tpl-claude-pm.md` — **Refine**
Only 2 lines. As the PM's own CLAUDE.md template, this should be more complete — at minimum include project context, member roster reference, and key constraints.

### 40. `skills/pm/tpl-claude.md` — **Keep**
Doer's execution harness. Well-structured with clear rules.

### 41. `skills/pm/tpl-reviewer.md` — **Keep**
Reviewer's execution harness. Complements tpl-claude.md properly.

### 42. `skills/pm/tpl-reviewer-plan.md` — **Keep**
Plan review checklist. Current and complete.

### 43. `skills/pm/tpl-plan.md` — **Keep**
PLAN.md structure template. Clean and functional.

### 44. `skills/pm/tpl-progress.json` — **Refine**
No field documentation. Should have a companion comment or doc explaining what each field means, valid values, and how pm reads/writes it.

### 45. `skills/pm/tpl-design.md` — **Keep**
Design doc template. Clean.

### 46. `skills/pm/tpl-deploy.md` — **Keep**
Deployment steps template. Current.

### 47. `skills/pm/tpl-status.md` — **Keep**
Status file template. Functional.

### 48. `skills/pm/tpl-projects.md` — **Keep**
Projects portfolio template. Minimal but functional.

---

## `skills/pm/profiles/`

### 49. `skills/pm/profiles/tpl-permissions.json` — **Refine**
Empty template with no guidance. Should show a realistic example or have inline documentation for expected structure.

### 50. `skills/pm/profiles/base-dev.json` — **Keep**
Base developer permissions. Well-structured.

### 51. `skills/pm/profiles/base-reviewer.json` — **Keep**
Base reviewer permissions. Well-structured.

### 52-58. `skills/pm/profiles/{cpp,dotnet,go,jvm,node,python,rust}.json` — **Keep**
Language/stack-specific permission profiles. All well-structured and complete.

---

## `src/` — Source Code

### 59. All `src/` files — **Keep**
Clean, well-organized. No dead code, no unused exports. Internal "agent" vs user-facing "member" split is intentional per `vocabulary.md`. No changes needed.

---

## `tests/`

### 60. All test files — **Keep**
~3,100 lines of tests. Integration test is comprehensive. Unit tests cover core utilities. No stale test descriptions.

---

## `hooks/`

### 61. `hooks/hooks-config.json` — **Keep**
Active post-registration hook config. Fires on `register_member` tool use.

### 62. `hooks/post-register-member.sh` — **Keep**
Active onboarding nudge script. Outputs 7-step checklist.

---

## `scripts/`

### 63. `scripts/fleet-statusline.sh` — **Keep**
Active statusline renderer for Claude Code status bar.

### 64-67. `scripts/{build-sea,gen-sea-config,package-sea,gen-ico}.mjs` — **Keep**
SEA binary build pipeline. Active for releases.

---

## `assets/`, `data/`

### 68. `assets/` (icons, logos) — **Keep**
Branding assets. Current.

### 69. `data/` (`.gitkeep` only) — **Keep**
Runtime data placeholder.

---

## Install Scripts

### 70-73. `install.{cjs,sh,ps1,cmd}` — **Keep**
Multi-platform install wrappers. All current.

---

## Summary

| Decision | Count | Key files |
|----------|-------|-----------|
| **Keep** | ~50 | All src/, tests/, install scripts, profiles, most templates |
| **Refine** | ~20 | CLAUDE.md, architecture.md, tools-*.md, auth-*.md, onboarding.md, ProjMgr-requirements.md |
| **Remove** | 4 | `CORRECTIONS.md`, `progress.json`, `docs/tasks-git-auth.md`, `skills/pm/backlog.md` |

### Systemic Issues

1. **"agent" → "member" terminology** — drives most Refine decisions across docs/ and auth guides
2. **`materials/` directory doesn't exist** — CLAUDE.md references it as source of truth for PM rewrite, but it was never created
