# Doc Consolidation Plan

## Branch: refactor/doc-consolidation
## Base: main

## Summary

Establish `readme.md` as the single source of truth. All other doc files either point to it or are auto-generated from it. The actual user guide file is `docs/user-guide.md` (349 lines) — not `userguide.md` at root as the requirements shorthand suggests.

## Risk Register

| Risk | Likelihood | Impact | Mitigation |
|------|-----------|--------|------------|
| CI breaks if `docs/user-guide.md` deleted before `gen-llms-full.mjs` updated | High | High | Task 1.2 (CI update) is placed before Task 2.1 (delete). VERIFY 1 confirms generation works. |
| Stale `user-guide` references across 14 files cause broken links | Medium | Medium | Task 2.2 does repo-wide grep and fixes all references. VERIFY 2 confirms none remain. |
| Content lost during user-guide → readme merge | Medium | High | Task 1.1 produces an explicit overlap map. Task 2.1 merges only missing content, preserving readme structure. |
| `llms.txt` still points to deleted file | Medium | Medium | Task 1.2 updates `llms.txt` alongside `gen-llms-full.mjs`. |
| CLAUDE.md/AGENTS.md too thin — agents lose context | Low | Medium | Both files include a "read readme.md" directive + retain agent-specific content (dev commands, repo conventions). Task 3.3 verifies. |

## Phase 1 — CI Safety Net

### Task 1.1 — Audit content overlap
- **Tier:** cheap
- **Files:** `readme.md`, `docs/user-guide.md`, `CLAUDE.md`, `AGENTS.md`
- **What:** Read all four files and produce a structured overlap map as a commit message annotation:
  - Content in `docs/user-guide.md` NOT covered by `readme.md` (detailed install, uninstall, `--skill` flag, multi-provider auth provisioning, git auth setup for GitHub/Bitbucket/Azure DevOps, PM commands table, troubleshooting)
  - Content in `CLAUDE.md`/`AGENTS.md` that duplicates `readme.md` (MCP tools table, workflows, example prompts — nearly all of it)
  - Content in `CLAUDE.md`/`AGENTS.md` that is agent-specific and should stay (none found — both are pure copies of readme content)
- **Done:** Overlap map documented; clear list of what to merge and what to discard
- **Risks:** None — read-only task

### Task 1.2 — Update CI and llms.txt to stop referencing `docs/user-guide.md`
- **Tier:** cheap
- **Files:** `scripts/gen-llms-full.mjs`, `llms.txt`
- **What:**
  1. In `scripts/gen-llms-full.mjs` line 21-25: replace `path: 'docs/user-guide.md'` with `path: 'readme.md'`, update the title to "README" and desc to match readme.md's scope
  2. In `llms.txt` line 9: replace `[User Guide](docs/user-guide.md)` with `[README](readme.md)` and update the description
  3. Run `node scripts/gen-llms-full.mjs` locally to regenerate `llms-full.txt`
  4. Commit all three files
- **Done:** `node scripts/gen-llms-full.mjs` runs without error and produces valid `llms-full.txt` that no longer references `docs/user-guide.md`
- **Risks:** If readme.md is very large, `llms-full.txt` size may increase — monitor but not blocking

### VERIFY 1
- [ ] `node scripts/gen-llms-full.mjs` succeeds
- [ ] `llms-full.txt` does not contain `docs/user-guide.md`
- [ ] `llms.txt` does not reference `docs/user-guide.md`
- [ ] `scripts/gen-llms-full.mjs` references `readme.md` not `docs/user-guide.md`

## Phase 2 — Merge and Delete

### Task 2.1 — Absorb `docs/user-guide.md` into `readme.md`
- **Tier:** standard
- **Files:** `readme.md`, `docs/user-guide.md`
- **What:** Merge content from `docs/user-guide.md` that `readme.md` is missing. Sections to add/expand in `readme.md`:
  - **Install section:** Add manual install steps, `what install writes` table, `what install does NOT do`, `--skill` flag options, uninstall instructions
  - **Register section:** Add local vs remote detail, non-Claude provider registration, SSH key migration
  - **Using members:** Add run-prompt, run-command, send-files, check-status examples
  - **Multi-provider fleets:** Add auth provisioning per provider, CLI install, capabilities/limits, mix-and-match example
  - **Git authentication:** Expand with GitHub App setup (both Apra-Labs and custom), Bitbucket, Azure DevOps instructions
  - **PM Skill:** Add init/plan/pair commands table
  - **Troubleshooting:** Add troubleshooting section
  Preserve readme.md's existing structure and voice. Do not duplicate content already present.
- **Done:** `readme.md` is a comprehensive reference covering everything `docs/user-guide.md` had
- **Risks:** readme.md gets long — use collapsible `<details>` sections for detailed setup instructions to keep it scannable

### Task 2.2 — Delete `docs/user-guide.md` and fix all references
- **Tier:** cheap
- **Files:** `docs/user-guide.md` (delete), plus all files referencing it
- **What:**
  1. Delete `docs/user-guide.md`
  2. Run `grep -r "user-guide" . --include="*.md" --include="*.txt" --include="*.json" --include="*.yml" --include="*.ts" --include="*.js"` and update every reference:
     - `CLAUDE.md` links section → will be rewritten in Task 3.1 anyway
     - `AGENTS.md` links section → will be rewritten in Task 3.2 anyway
     - `docs/*.md` cross-references → update to point to `readme.md` or the relevant readme section
     - Any remaining files → fix or remove the reference
  3. Commit deletion + reference fixes
- **Done:** `grep -ri "user-guide" . --include="*.md" --include="*.txt" --include="*.json" --include="*.yml" --include="*.ts" --include="*.js"` returns zero results (excluding requirements-doc-consolidation.md)
- **Risks:** References in generated files (`llms-full.txt`) — already handled by Task 1.2

### VERIFY 2
- [ ] `docs/user-guide.md` does not exist
- [ ] `grep -ri "user-guide"` returns no results in tracked source files
- [ ] `readme.md` covers all content that was in `docs/user-guide.md`
- [ ] `npm run build` passes
- [ ] `npm test` passes

## Phase 3 — Thin Wrappers + Final Check

### Task 3.1 — Rewrite `CLAUDE.md` as thin wrapper
- **Tier:** cheap
- **Files:** `CLAUDE.md`
- **What:** Replace the current 122-line file with a thin wrapper (under 30 lines) containing:
  1. A directive: "Read `readme.md` in this repo for full tool reference, installation, configuration, and usage."
  2. Dev commands: `npm install && npm run build`, `npm test`, `npm run build:binary`
  3. Any Claude Code-specific conventions (branch naming, commit style from git log)
  No MCP tools table, no workflows, no example prompts — those are in readme.md.
- **Done:** `CLAUDE.md` is under 30 lines and contains no duplicated readme content
- **Risks:** Fleet skill or other tooling may parse CLAUDE.md — verify no code reads it programmatically

### Task 3.2 — Rewrite `AGENTS.md` as thin wrapper
- **Tier:** cheap
- **Files:** `AGENTS.md`
- **What:** Same treatment as CLAUDE.md but targeted at OpenAI Codex/Devin/SWE-Agent:
  1. A directive: "Read `readme.md` in this repo for full tool reference, installation, configuration, and usage."
  2. Dev commands: `npm install && npm run build`, `npm test`
  3. Any agent-specific conventions
  Under 30 lines. No duplicated readme content.
- **Done:** `AGENTS.md` is under 30 lines and contains no duplicated readme content
- **Risks:** Same as 3.1 — verify no code reads AGENTS.md programmatically

### Task 3.3 — Final verification (Task 6)
- **Tier:** cheap
- **Files:** none (verification only)
- **What:** Run full verification checklist:
  1. `npm run build` passes
  2. `npm test` passes
  3. `node scripts/gen-llms-full.mjs` runs without error
  4. `readme.md` is comprehensive
  5. `CLAUDE.md` is under 30 lines, points to readme.md
  6. `AGENTS.md` is under 30 lines, points to readme.md
  7. `docs/user-guide.md` is deleted
  8. No stale references: `grep -ri "user-guide" . --include="*.md" --include="*.txt" --include="*.json" --include="*.yml" --include="*.ts" --include="*.js"` returns nothing in tracked source
- **Done:** All 8 checks pass
- **Risks:** None — read-only verification

### VERIFY 3 (Final)
- [ ] All checks from Task 3.3 pass
- [ ] Branch is clean — all changes committed
- [ ] Ready for PR review
