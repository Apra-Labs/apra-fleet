## Planning Session
- Member: fleet-dev2
- Date: 2026-05-01
- Gemini session: 5a72fea9 (start fresh session on fleet-dev2 to resume planning context)

---

# Compress skill files using caveman mode — Implementation Plan

> Apply caveman-style compression to all 28 skill files under `skills/pm/` and `skills/fleet/`, targeting 40–60% token reduction without breaking PM/fleet behaviour. Files are LLM-consumed only — no human-readability constraint.

---

## Tasks

### Phase 1: Tooling setup

#### Task 1: Install caveman as a Claude Code skill
- **Change:** Clone [JuliusBrussee/caveman](https://github.com/JuliusBrussee/caveman) into `~/.claude/skills/caveman/` on the dev machine. Follow the repo's install instructions. Verify that `/caveman` is available as a slash command in Claude Code (`/help` lists it). Document the exact install command in a comment at the top of the new branch's first commit message.
- **Files:** `~/.claude/skills/caveman/` (local only — not committed to repo)
- **Tier:** cheap
- **Done when:** `/caveman` is available in Claude Code on the dev machine
- **Blockers:** none

#### VERIFY: Phase 1
- `/caveman` slash command responds in Claude Code
- No build step needed — skill files are pure Markdown

---

### Phase 2: Compress skill files

#### Task 2: Compress `skills/fleet/*.md` (8 files)
- **Change:** Open each of the 8 fleet skill files and run `/caveman` to produce compressed output. Replace file content with compressed version. Files: `SKILL.md`, `onboarding.md`, `permissions.md`, `skill-matrix.md`, `troubleshooting.md`, `auth-github.md`, `auth-bitbucket.md`, `auth-azdevops.md`. Record pre/post word counts in the commit message.
- **Files:** `skills/fleet/*.md` (8 files)
- **Tier:** standard
- **Done when:** All 8 files committed with ≥40% word-count reduction; `git diff --stat` shows only these 8 files
- **Blockers:** Task 1

#### Task 3: Compress `skills/pm/` operational files (9 files)
- **Change:** Compress the 9 non-template operational files: `SKILL.md`, `single-pair-sprint.md`, `multi-pair-sprint.md`, `simple-sprint.md`, `doer-reviewer.md`, `cleanup.md`, `init.md`, `context-file.md`, `plan-prompt.md`. Record pre/post word counts in the commit message.
- **Files:** `skills/pm/*.md` (non-tpl- files only — exactly these 9)
- **Tier:** standard
- **Done when:** All 9 operational pm files committed with ≥40% word-count reduction
- **Blockers:** Task 1

#### Task 4: Compress `skills/pm/tpl-*.md` template files (11 files)
- **Change:** Compress all 11 template files: `tpl-doer.md`, `tpl-reviewer.md`, `tpl-reviewer-plan.md`, `tpl-plan.md`, `tpl-deploy.md`, `tpl-design.md`, `tpl-requirements.md`, `tpl-status.md`, `tpl-backlog.md`, `tpl-projects.md`, `tpl-pm.md`. These are filled in by the PM LLM at runtime — caveman compression applies equally. Note: `tpl-progress.json` is JSON, skip it. Record pre/post word counts in the commit message.
- **Files:** `skills/pm/tpl-*.md` (all 11 template files)
- **Tier:** standard
- **Done when:** All 11 tpl-*.md files committed with ≥40% word-count reduction
- **Blockers:** Task 1

#### VERIFY: Phase 2
- `npm run build` passes (skills are not compiled, but ensures no TypeScript was accidentally touched)
- Word count reduction: `wc -w skills/pm/*.md skills/fleet/*.md` — compare to pre-compression baseline recorded in commit messages
- All 28 files modified, no other files touched

---

### Phase 3: Risk review

#### Task 5: Risk review pass on all compressed files
- **Change:** Using caveman's review/risk-identification mode (or a manual pass if caveman doesn't provide one), read through every compressed file and flag passages where: (a) an instruction became ambiguous, (b) a required step was dropped, (c) a constraint (e.g. "NEVER do X") was weakened. Write findings to `skills/COMPRESSION_REVIEW.md` — one line per flagged passage with: file, original phrase, compressed phrase, risk level (high/med/low), and resolution (keep, revert, or rephrase). Fix all high-risk findings before committing. Leave med/low findings as documented accepted risks.
- **Files:** `skills/COMPRESSION_REVIEW.md` (new), any skill files needing fixes
- **Tier:** premium
- **Done when:** `COMPRESSION_REVIEW.md` committed; zero high-risk unresolved findings
- **Blockers:** Tasks 2, 3, 4

#### VERIFY: Phase 3
- `COMPRESSION_REVIEW.md` present and readable
- Zero unresolved high-risk findings in the review document

---

### Phase 4: Regression test

#### Task 6: Regression test representative PM commands
- **Change:** Install compressed skills (they're already in the working tree — `apra-fleet install` reads from the repo). Run the following representative commands via a live PM session and verify behaviour matches pre-compression: (a) `/pm status` — checks skill loading and status rendering, (b) `/pm pair fleet-dev fleet-rev` — exercises doer-reviewer.md and context-file.md, (c) `/pm plan` with a trivial requirements.md — exercises single-pair-sprint.md and tpl-plan.md, (d) `/fleet onboard` — exercises onboarding.md. Record any behavioural differences. If any command produces wrong output, trace back to the responsible compressed file and fix.
- **Files:** no new files — this is a test-and-fix task; commit any fixes found
- **Tier:** premium
- **Done when:** All 4 representative commands produce correct output; any fixes committed
- **Blockers:** Tasks 2, 3, 4, 5

#### VERIFY: Phase 4
- All 4 representative commands pass
- No regressions in PM/fleet behaviour
- `npm run build` and `npm test` pass clean

---

## Risk Register

| Risk | Impact | Mitigation |
|------|--------|------------|
| Caveman drops a critical `NEVER` constraint from an operational file | high | Phase 3 risk review explicitly flags constraint weakening; fix before merge |
| Template files (tpl-*.md) produce malformed output after compression | med | Regression test Task 6 exercises tpl-plan.md via `/pm plan`; revert individual template if broken |
| Word count reduction falls below 40% target on some files | low | Target is per-file average; acceptable if total reduction ≥40% across all 28 files |
| caveman install instructions differ from what's in the repo README | low | Follow repo README exactly; document actual steps in commit message |
| Compressed files have encoding issues (BOM, line endings) | low | Verify with `file` command or `git diff --check` after each task commit |

## Notes
- Base branch: `main`
- Implementation branch: `feat/compress-skill-files`
- Each task = one git commit
- VERIFY = checkpoint, stop and report
- `skills/fleet/profiles/*.json` — excluded (JSON config, not LLM text)
- Token count proxy: `wc -w` (word count); actual token counts can be measured with `npx tiktoken` if needed
