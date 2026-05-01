# Issue #159 — Credential Audit Log: Plan Review

**Reviewer:** fleet-rev (Claude Opus 4.6)
**Date:** 2026-05-01
**Verdict:** **APPROVED**

---

## 13-Point Checklist

### 1. Does the plan address everything in requirements.md? — PASS

All 5 events (SET, DELETED, RESOLVED, REJECTED, EXPIRED) mapped to correct trigger points. Log format matches the spec. Security properties (names-only, append-only, `0o600`, 10MB rotation) all present. `tool?` parameter addition to `credentialResolve()` and all 7 call-site updates covered. No MCP tool needed — correctly identified as side-effect of existing operations.

### 2. Are phases clearly separated with VERIFY checkpoints? — PASS

Four phases, each with an explicit VERIFY checkpoint:
- Phase 1: Audit log service (standalone, testable in isolation)
- Phase 2: Wire into credential-store.ts
- Phase 3: Pass tool names at call sites
- Phase 4: Unit + integration tests

Each phase produces a reviewable, testable increment. Separation is cohesive — Phase 1 can be reviewed without Phase 2 context.

### 3. Are tiers monotonically non-decreasing within each phase? — PASS

| Phase | Tasks | Tiers | Monotonic? |
|-------|-------|-------|------------|
| 1 | T1 | cheap | trivial ✓ |
| 2 | T2, T3 | cheap → standard | ✓ |
| 3 | T4 | cheap | trivial ✓ |
| 4 | T5, T6 | standard → standard | ✓ |

No tier downgrades within any phase.

### 4. Does each task have a concrete "Done when" criterion? — PASS

All 6 tasks have explicit, verifiable criteria. Examples: "Unit test can call `appendAuditLog()` and read back a correctly-formatted line" (T1), "All 7 files updated; `npm run build` passes; audit log entries for each tool show the correct `tool=` field" (T4). No vague criteria found.

### 5. Are blockers correctly stated? — PASS

| Task | Stated Blockers | Correct? |
|------|----------------|----------|
| T1 | none | ✓ — standalone module |
| T2 | T1 | ✓ — needs audit type import |
| T3 | T1, T2 | ✓ — needs module + updated signature |
| T4 | T2 | ✓ — needs `tool?` param to compile |
| T5 | T1 | ✓ — tests the audit module |
| T6 | T3, T4 | ✓ — tests wired-up calls with tool names |

### 6. Is the base branch correct? — PASS

Base branch: `main`. Implementation branch: `feat/credential-audit-log`. Both follow the `feat/<topic>` convention from CLAUDE.md.

### 7. Are file paths accurate and do referenced files exist? — PASS

Verified against the repo:
- `src/services/credential-store.ts` — exists ✓
- `src/services/credential-audit.ts` — new file, correctly marked ✓
- All 7 call-site files under `src/tools/` — exist ✓
- `tests/credential-audit.test.ts` — new file ✓
- `tests/credential-store.test.ts` — does not exist; plan says "create if absent" ✓
- Import path `./credential-audit.js` — correct for ESM output ✓

### 8. Is scope complete — all 7 call sites listed? — PASS

Grep for `credentialResolve(` in `src/tools/` returns exactly 7 matches. All match the plan's list:

| File | Plan's call | Actual current call | Match? |
|------|-------------|-------------------|--------|
| `execute-command.ts` | `credentialResolve(name, callingMember, 'execute_command')` | `credentialResolve(name, callingMember)` | ✓ |
| `provision-auth.ts` | `credentialResolve(name, agent.friendlyName, 'provision_auth')` | `credentialResolve(name, agent.friendlyName)` | ✓ |
| `provision-vcs-auth.ts` | `credentialResolve(name, callingMember, 'provision_vcs_auth')` | `credentialResolve(name, callingMember)` | ✓ |
| `register-member.ts` | `credentialResolve(name, input.friendly_name, 'register_member')` | `credentialResolve(name, input.friendly_name)` | ✓ |
| `setup-git-app.ts` | `credentialResolve(tokenMatch[1], '*', 'setup_git_app')` | `credentialResolve(tokenMatch[1], '*')` | ✓ |
| `update-member.ts` | `credentialResolve(name, existing.friendlyName, 'update_member')` | `credentialResolve(name, existing.friendlyName)` | ✓ |
| `credential-store-update.ts` | `credentialResolve(input.name, undefined, 'credential_store_update')` | `credentialResolve(input.name)` | ✓ |

All existing argument patterns preserved; only the new third `tool` argument is added.

### 9. Are risks identified and mitigated? — PASS

Risk register covers 5 risks with appropriate mitigations:
- Audit write failure → catch-and-swallow (critical — audit must never break credential ops)
- Unbounded growth → 10MB rotation
- chmod overhead → first-write-only mode set
- Rotation race → single-process, no concern
- Undefined callingMember → intentional PM fallback

One minor note: the risk register mentions `FLEET_AUDIT_MAX_BYTES` env var for configurable rotation cap, but Task 1 only mentions `MAX_AUDIT_LOG_BYTES` as a constant default. The env var override should be documented in Task 1's change description to avoid ambiguity during implementation. **Not blocking** — the developer can infer this from the risk register.

### 10. Is the regression test realistic and sufficient? — PASS

- T5: 5 unit test cases covering format, optional fields, rotation, permissions, error swallowing
- T6: 6 integration test cases covering all 5 event types plus the null/not-found no-audit case
- VERIFY checkpoints include manual smoke tests (SET + RESOLVED flow)
- Spy-based approach for integration tests (mock `appendAuditLog`) is appropriate — avoids filesystem coupling in credential-store tests

### 11. Are there implementation details missing that would block a developer? — PASS (with note)

The plan is implementation-ready. One minor gap:

- **Env var for max bytes**: Task 1 should explicitly state `const MAX_AUDIT_LOG_BYTES = parseInt(process.env.FLEET_AUDIT_MAX_BYTES ?? '') || 10 * 1024 * 1024` (or similar) to match the risk register's configurability claim. Currently Task 1 just says "default `10 * 1024 * 1024`" without specifying the env var. **Not blocking** — developer can derive from risk register context.

### 12. Are commit/branch conventions followed? — PASS

- Branch: `feat/credential-audit-log` — matches `feat/<topic>` convention ✓
- "Each task = one git commit" — follows one-commit-per-task convention ✓
- Base branch `main` with PR workflow — follows "never push to main directly" rule ✓

### 13. Any security concerns (e.g. audit log leaking credential names)? — PASS

- **Names only, never values**: Plan explicitly states log entries contain `credential=<name>` with no plaintext or ciphertext. Verified against the `AuditEntry` type — no `value` field exists.
- **File permissions**: `0o600` matches `credentials.json` permissions, consistent security posture.
- **Credential names are not secrets**: Names like `github_pat` or `deploy_key` are already visible via `credential_store_list` MCP tool. Logging them to a file with the same owner-only permissions adds no new exposure surface.
- **No delete API for audit log**: Append-only by design — entries survive credential deletion, preserving the audit trail.
- **Rotation overwrites `.log.1`**: Acceptable — rotated-out entries are older and lower-value; keeping one rotation file is a reasonable trade-off vs unbounded growth.

---

## Summary

The plan is well-structured, accurate, and complete. All 7 `credentialResolve()` call sites verified against the actual codebase. Event points in `credential-store.ts` correctly identified (lines 111–129 for SET, 161–173 for DELETE, 202–266 for RESOLVE with expired/denied/success paths, 337–362 for PURGE). Risk mitigations are sound. Test coverage is comprehensive.

**Minor notes (non-blocking):**
1. Task 1 should explicitly mention the `FLEET_AUDIT_MAX_BYTES` env var for max log size configurability, rather than leaving it only in the risk register.

**Verdict: APPROVED** — ready for implementation.
