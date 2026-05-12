# Review: e2e/local-only branch

**Branch:** `e2e/local-only` vs `main`  
**Commits reviewed:** `a122d50` (feat), `89a3450` (fix)  
**Reviewer:** Claude (automated)  
**Date:** 2026-05-11

---

## Verdict: APPROVED

The jq bracket-notation bug identified in the first review has been fixed in commit `89a3450`. All 7 jq expressions in "Load suite config" now use `.suites["$SUITE"]` instead of `.suites.$SUITE`, which correctly handles dotted suite names (s1.1, s1.2, s1.3).

---

## Re-review: jq fix verification (fleet-e2e.yml:58-64)

All 7 lines confirmed using bracket notation:

```bash
PM_PROVIDER=$(echo $CONFIG | jq -r ".suites[\"$SUITE\"].pm.provider")
PM_OS=$(echo $CONFIG      | jq -r ".suites[\"$SUITE\"].pm.os")
DOER_OS=$(echo $CONFIG    | jq -r ".suites[\"$SUITE\"].doer.os")
DOER_PROV=$(echo $CONFIG  | jq -r ".suites[\"$SUITE\"].doer.provider")
REV_OS=$(echo $CONFIG     | jq -r ".suites[\"$SUITE\"].reviewer.os")
REV_PROV=$(echo $CONFIG   | jq -r ".suites[\"$SUITE\"].reviewer.provider")
VCS=$(echo $CONFIG        | jq -r ".suites[\"$SUITE\"].vcs")
```

No remaining instances of `.suites.$SUITE` bare dot notation in the file.

---

## Checklist — All Items Pass

| Item | Status | Notes |
|------|--------|-------|
| **jq bracket notation fix** | PASS | All 7 expressions use `.suites["$SUITE"]`. Dotted suite names (s1.1/s1.2/s1.3) will parse correctly. |
| **members.json** — 6 new entries | PASS | 2 per platform, all have `host: "local"`, distinct `work_folder`, no `username` field. Existing entries unchanged. |
| **suites.json** — s1.1/s1.2/s1.3 added | PASS | Correct `local_doer_*`/`local_reviewer_*` OS keys, all use `claude` provider, `github` VCS. s1-s6 unchanged. |
| **test-script.md** — conditional T1 registration | PASS | Local members skip host/username/password; remote members keep the password path. T2/T4/T5/session-log/teardown sections unchanged. |
| **fleet-e2e.yml** — options list | PASS | s1.1/s1.2/s1.3 added to choice list. |
| **fleet-e2e.yml** — `runs-on` ternary | PASS | s1.1->fleet-windows, s1.2->fleet-linux, s1.3->fleet-macos. s1-s6 routing unchanged. |
| **fleet-e2e.yml** — username `// empty` null-safety | PASS | `jq -r ".$DOER_OS.username // empty"` correctly produces empty string for local members. Member OS keys contain no dots, so dot notation is fine here. |
| **fleet-e2e.yml** — DOER_USER/REV_USER echo to GITHUB_OUTPUT | PASS | `echo "doer_user="` with empty value is valid. |
| **fleet-e2e.yml** — Render test script sed | PASS | Empty `{{DOER_USER}}` substitution removes placeholder cleanly. |
| **fleet-e2e.yml** — Seed credential store | PASS | Unchanged; no dependency on local vs remote. |
| **fleet-e2e.yml** — Smoke-test PM LLM auth | PASS | PM is always a real machine — works the same for all suites. |
| **fleet-e2e.yml** — T6 teardown | PASS | `remove_member` API is the same for local and remote members. |
| **fleet-e2e.yml** — no run-e2e.mjs references | PASS | Zero matches in repo. |
| **run-e2e.mjs** — deleted | PASS | File removed; `git diff` confirms full deletion. |
| **Build** (`npm run build`) | PASS | Clean, no errors. |
| **Tests** (`npm test`) | PASS | 76 test files, 1233 passed, 6 skipped, 0 failed. |
