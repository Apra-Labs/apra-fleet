# Doc Consolidation Plan

## Branch: feat/install-ux-and-docs
## Base: main

## Summary

Establish `readme.md` as the single source of truth. All other doc files either point to it or are auto-generated from it. The actual user guide file is `docs/user-guide.md` (349 lines) — not `userguide.md` at root.

## Risk Register

| Risk | Likelihood | Impact | Mitigation |
|------|-----------|--------|------------|
| CI breaks if `docs/user-guide.md` deleted before `gen-llms-full.mjs` updated | High | High | Task 1.2 (CI update) placed before Task 2.1 (delete). VERIFY 1 confirms generation works before anything is deleted. |
| Stale `user-guide` references across 14 files cause broken links | Medium | Medium | Task 2.2 does repo-wide grep and fixes all references. Final VERIFY confirms none remain. |
| Content lost during user-guide → readme merge | Medium | High | Task 1.1 produces explicit overlap map. Task 2.1 merges only missing content. |
| CLAUDE.md/AGENTS.md too thin — agents lose context | Low | Medium | Both files include a "read readme.md" directive + dev commands. Final VERIFY checks line counts. |

## Phase 1 — CI Safety Net

### Task 1.1 — Audit content overlap
- **Tier:** cheap
- **Files:** `readme.md`, `docs/user-guide.md`, `CLAUDE.md`, `AGENTS.md`
- **What:** Read all four files and produce a structured overlap map as a commit message annotation:
  - Content in `docs/user-guide.md` NOT covered by `readme.md`
  - Content in `CLAUDE.md`/`AGENTS.md` that duplicates `readme.md` vs. is agent-specific
- **Done:** Overlap map documented; clear list of what to merge and what to discard
- **Risks:** None — read-only task

### Task 1.2 — Update CI and llms.txt to stop referencing `docs/user-guide.md`
- **Tier:** cheap
- **Files:** `scripts/gen-llms-full.mjs`, `llms.txt`
- **What:**
  1. In `scripts/gen-llms-full.mjs`: replace `path: 'docs/user-guide.md'` with `path: 'readme.md'`; update title/desc to match
  2. In `llms.txt`: replace the `docs/user-guide.md` link with `readme.md`
  3. Run `node scripts/gen-llms-full.mjs` locally to regenerate `llms-full.txt`
  4. Commit all three files
- **Done:** `node scripts/gen-llms-full.mjs` runs without error; `llms-full.txt` no longer references `docs/user-guide.md`
- **Risks:** If readme.md is very large, `llms-full.txt` size may increase — monitor but not blocking

### VERIFY 1
- [ ] `node scripts/gen-llms-full.mjs` succeeds
- [ ] `llms-full.txt` does not contain `docs/user-guide.md`
- [ ] `llms.txt` does not reference `docs/user-guide.md`
- [ ] `scripts/gen-llms-full.mjs` references `readme.md` not `docs/user-guide.md`
- [ ] Push to origin before stopping

## Phase 2 — Merge, Delete, Thin Wrappers

### Task 2.1 — Absorb `docs/user-guide.md` into `readme.md`
- **Tier:** standard
- **Files:** `readme.md`, `docs/user-guide.md`
- **What:** Merge content from `docs/user-guide.md` that `readme.md` is missing:
  - **Install section:** manual install steps, what install writes, what it does NOT do, `--skill` flag options, uninstall
  - **Register section:** local vs remote detail, non-Claude provider registration, SSH key migration
  - **Using members:** run-prompt, run-command, send-files, check-status examples
  - **Multi-provider fleets:** auth provisioning per provider, CLI install, capabilities/limits
  - **Git authentication:** GitHub App setup, Bitbucket, Azure DevOps
  - **PM Skill:** init/plan/pair commands table
  - **Troubleshooting:** troubleshooting section
  Use `<details>` collapsibles for long setup blocks. Do not duplicate content already present.
- **Done:** `readme.md` is a comprehensive reference covering everything `docs/user-guide.md` had
- **Risks:** readme.md gets long — mitigated by `<details>` collapsibles

### Task 2.2 — Delete `docs/user-guide.md` and fix all references
- **Tier:** cheap
- **Files:** `docs/user-guide.md` (delete), plus all files referencing it
- **What:**
  1. Delete `docs/user-guide.md`
  2. Run: `grep -r "user-guide" . --include="*.md" --include="*.txt" --include="*.json" --include="*.yml" --include="*.ts" --include="*.js"`
  3. Update every reference found — point to `readme.md` or the relevant section
  4. Commit deletion + reference fixes
- **Done:** grep returns zero results in tracked source (excluding PM project docs)
- **Risks:** References in already-regenerated `llms-full.txt` — handled by Task 1.2

### Task 2.3 — Rewrite `CLAUDE.md` as thin wrapper
- **Tier:** cheap
- **Files:** `CLAUDE.md`
- **What:** Replace with under 30 lines:
  1. Directive: "Read `readme.md` in this repo for full tool reference, installation, configuration, and usage."
  2. Dev commands: `npm install && npm run build`, `npm test`, `npm run build:binary`
  3. Any Claude Code-specific conventions not in readme.md (branch naming, commit style)
  No MCP tools table, no workflows, no example prompts.
- **Done:** `CLAUDE.md` under 30 lines, no duplicated readme content

### Task 2.4 — Rewrite `AGENTS.md` as thin wrapper
- **Tier:** cheap
- **Files:** `AGENTS.md`
- **What:** Same treatment as CLAUDE.md but for OpenAI Codex/Devin/SWE-Agent. Under 30 lines.
- **Done:** `AGENTS.md` under 30 lines, no duplicated readme content

### VERIFY 2 (Final)
- [ ] `npm run build` passes
- [ ] `npm test` passes
- [ ] `node scripts/gen-llms-full.mjs` runs without error
- [ ] `readme.md` is comprehensive — covers all content from `docs/user-guide.md`
- [ ] `CLAUDE.md` under 30 lines, points to readme.md
- [ ] `AGENTS.md` under 30 lines, points to readme.md
- [ ] `docs/user-guide.md` does not exist
- [ ] `grep -ri "user-guide"` returns no results in tracked source
- [ ] Push to origin before stopping
