# PLAN — Open-Source Readiness for apra-fleet

## Branch: `feature/open-source`
## Base: `main`

---

## Phase 1 — Community Health Files & Templates

### Task 1 — Setup branch
- `git fetch origin && git checkout main && git pull origin main`
- `git checkout -b feature/open-source`

### Task 2 — GitHub Issue Templates
Create `.github/ISSUE_TEMPLATE/bug_report.yml` and `.github/ISSUE_TEMPLATE/feature_request.yml` using GitHub's YAML form schema format.

**Bug report template should include:**
- Name, description, labels (bug)
- Fields: description (textarea, required), steps to reproduce (textarea, required), expected behavior (textarea), actual behavior (textarea), environment info (dropdown: OS, Node version), additional context (textarea)

**Feature request template should include:**
- Name, description, labels (enhancement)
- Fields: problem description (textarea, required), proposed solution (textarea, required), alternatives considered (textarea), additional context (textarea)

Also create `.github/ISSUE_TEMPLATE/config.yml` with `blank_issues_enabled: true` and a link to discussions if applicable.

### Task 3 — Pull Request Template
Create `.github/PULL_REQUEST_TEMPLATE.md` with:
- Summary section
- Type of change checklist (bug fix, new feature, breaking change, docs)
- Testing checklist
- Checklist: tests pass, docs updated, no breaking changes without note

### Task 4 — CONTRIBUTING.md
Create `CONTRIBUTING.md` at repo root:
- How to report bugs (link to issue templates)
- Development setup (`npm install && npm run build`)
- Running tests (`npm test`)
- Branch naming: `feature/*`, `fix/*`, `docs/*`
- Commit message convention
- PR process
- Code style notes (TypeScript, existing patterns)
- Reference the LICENSE

### Task 5 — CODE_OF_CONDUCT.md
Create `CODE_OF_CONDUCT.md` at repo root using Contributor Covenant v2.1.
- Contact: use `opensource@apralabs.com` as the enforcement contact (or leave as placeholder to be filled by maintainers)

### Task 6 — SECURITY.md
Create `SECURITY.md` at repo root:
- Supported versions (current: 0.1.x)
- How to report vulnerabilities (email `security@apralabs.com` or use placeholder)
- What to expect (acknowledgment timeline, fix timeline)
- Out of scope

### Task 7 — Update package.json keywords
Add these keywords to the existing `keywords` array in `package.json`:
`ai-agent`, `remote-execution`, `devtools`, `automation`, `claude`, `anthropic`, `model-context-protocol`

Keep existing keywords. Deduplicate if any overlap. Sort alphabetically.

### Task 8 — VERIFY: Phase 1
- Run `npm test` — all tests must pass
- Run `npm run build` — build must succeed
- Review all new files for consistent formatting
- `git push origin feature/open-source`
- STOP and report status
