# Issue #204 — Compress skill files using caveman mode

## Problem

Fleet skill files (`skills/pm/*.md`, `skills/fleet/*.md` — 28 files) are loaded as input tokens on every PM/fleet invocation. As session length grows, each file re-enters context on every turn. Current content is unoptimised prose.

## Goal

Apply caveman-style compression to all 28 skill files, targeting 40–60% token reduction without breaking behaviour.

## Scope

**28 files total:**

### skills/fleet/ (8 files)
- SKILL.md, onboarding.md, permissions.md, skill-matrix.md, troubleshooting.md
- auth-github.md, auth-bitbucket.md, auth-azdevops.md

### skills/pm/ (20 files)
- Operational: SKILL.md, single-pair-sprint.md, multi-pair-sprint.md, simple-sprint.md, doer-reviewer.md, cleanup.md, init.md, context-file.md, plan-prompt.md
- Templates: tpl-doer.md, tpl-reviewer.md, tpl-reviewer-plan.md, tpl-plan.md, tpl-deploy.md, tpl-design.md, tpl-requirements.md, tpl-status.md, tpl-backlog.md, tpl-projects.md, tpl-pm.md

**Not in scope:** `skills/fleet/profiles/*.json` (JSON config files, not LLM-consumed text)

## Approach

1. **Install caveman tooling** — add [JuliusBrussee/caveman](https://github.com/JuliusBrussee/caveman) as a Claude Code skill
2. **Compress all 28 files** — run caveman pass on every .md in scope (all files are LLM-consumed only — no human-readability constraint)
3. **Risk review** — flag any passages where meaning was lost or instructions became ambiguous
4. **Regression test** — install compressed skills and run representative PM commands to verify behaviour

## Acceptance Criteria

- All 28 files compressed by at least 40% in token count (measure with `wc -w` as proxy)
- No PM or fleet command behaviour changes observable in regression test
- Risk review sign-off in a review document
- `npm run build` and `npm test` pass (no TypeScript references to skill content)

## Notes

- `tpl-*.md` files are only ever read by LLMs — compress equally, no readability constraint
- Base branch: `main`
- Depends on: none
