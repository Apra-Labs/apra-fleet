# Review: e2e/local-only branch

**Branch:** `e2e/local-only` vs `main`  
**Commit:** `a122d50 feat(e2e): add s1.1/s1.2/s1.3 local-only suites; remove parked run-e2e.mjs`  
**Reviewer:** Claude (automated)  
**Date:** 2026-05-11

---

## Verdict: CHANGES NEEDED

---

## Findings

### BUG — jq syntax error on dotted suite names (fleet-e2e.yml:58–63)

The "Load suite config" step uses bare dot notation to access suite config:

```bash
PM_PROVIDER=$(echo $CONFIG | jq -r ".suites.$SUITE.pm.provider")
```

For `SUITE=s1.1`, jq parses `.suites.s1.1` as `.suites["s1"]["1"]`, which is a **syntax error** (`unexpected LITERAL`). This affects all 7 jq expressions that use `$SUITE` in this step and will cause s1.1/s1.2/s1.3 to fail immediately in CI.

**Fix:** Use bracket notation for the suite key:

```bash
PM_PROVIDER=$(echo $CONFIG | jq -r ".suites[\"$SUITE\"].pm.provider")
```

This applies to all 7 lines (pm.provider, pm.os, doer.os, doer.provider, reviewer.os, reviewer.provider, vcs).

---

### Checklist — All Other Items Pass

| Item | Status | Notes |
|------|--------|-------|
| **members.json** — 6 new entries | PASS | 2 per platform, all have `host: "local"`, distinct `work_folder`, no `username` field. Existing entries unchanged. |
| **suites.json** — s1.1/s1.2/s1.3 added | PASS | Correct `local_doer_*`/`local_reviewer_*` OS keys, all use `claude` provider, `github` VCS. s1–s6 unchanged. |
| **test-script.md** — conditional T1 registration | PASS | Local members skip host/username/password; remote members keep the password path. T2/T4/T5/session-log/teardown sections unchanged. |
| **fleet-e2e.yml** — options list | PASS | s1.1/s1.2/s1.3 added to choice list. |
| **fleet-e2e.yml** — `runs-on` ternary | PASS | s1.1→fleet-windows, s1.2→fleet-linux, s1.3→fleet-macos. s1–s6 routing unchanged. |
| **fleet-e2e.yml** — username `// empty` null-safety | PASS | `jq -r ".$DOER_OS.username // empty"` correctly produces empty string for local members (no `username` field). Member OS keys like `local_doer_windows` contain no dots, so dot notation is fine here. |
| **fleet-e2e.yml** — DOER_USER/REV_USER echo to GITHUB_OUTPUT | PASS | `echo "doer_user="` is valid — produces empty output value. |
| **fleet-e2e.yml** — Render test script sed | PASS | `s|{{DOER_USER}}||g` with empty value removes the placeholder, leaving an empty cell. No malformed output. |
| **fleet-e2e.yml** — Seed credential store | PASS | Unchanged; no dependency on local vs remote. |
| **fleet-e2e.yml** — Smoke-test PM LLM auth | PASS | PM is always a real machine — works the same for all suites. |
| **fleet-e2e.yml** — T6 teardown | PASS | `remove_member` API is the same for local and remote members. |
| **fleet-e2e.yml** — no run-e2e.mjs references | PASS | Grep confirms zero matches. |
| **run-e2e.mjs** — deleted | PASS | File does not exist on disk; `git diff` confirms full deletion (309 lines removed). |
| **Build** (`npm run build`) | PASS | Clean, no errors. |
| **Tests** (`npm test`) | PASS | 76 test files, 1233 passed, 6 skipped, 0 failed. |
