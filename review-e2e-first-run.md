# e2e/first-run Branch Review

**Reviewer:** fleet-rev
**Date:** 2026-05-11 21:40:00+05:30
**Verdict:** APPROVED

---

## Summary of Changes

This branch introduces a comprehensive LLM-driven end-to-end testing facility for apra-fleet, alongside several production code improvements.

1. **E2E Test Infrastructure** (`.github/e2e/`, `.github/workflows/fleet-e2e.yml`): Cross-platform e2e test suite with GitHub Actions workflow, Node.js runner, templated test scripts, result extraction, telemetry, and pre-flight review.

2. **`secret` CLI Subcommand** (`src/cli/secret.ts`, `src/utils/collect-secret.ts`): New `apra-fleet secret` CLI for credential store management with `-y` flag for CI.

3. **Auth CLI Simplification** (`src/cli/auth.ts`): Narrowed to `--confirm` only. Unknown flags rejected before prompting.

4. **Stall Detector Improvements**: `busy(mm:ss)` elapsed time, `unknown` state, `onStall` callback, removed unused `blocked`/`verify` states.

5. **Auth Socket Hardening** (`src/services/auth-socket.ts`): Socket tracking, PID management, Windows cancellation.

6. **Test Suite Overhaul**: Dead test removal, new coverage for credential store, OOB flows, secret CLI.

7. **Credential Store**: Configurable data directory via `APRA_FLEET_DATA_DIR`.

8. **PM Skill Cleanup**: Deduplicated secrets docs, updated Beads lifecycle hooks.

9. **Misc**: Version 0.1.9.1, CI excludes e2e files, `.mcp.json` removed, dir-watcher mtime fix, secure token regex allows hyphens.

---

## Documentation Analysis

### README.md - Updated (adequate)

Updated with OOB blocking behavior, CI usage (`-y` flag), Windows cancellation. No further changes needed. The e2e facility is developer/CI infrastructure, correctly omitted from user-facing docs.

### docs/ - Updated (adequate)

- `docs/adr-oob-password.md`: Windows close-signal handling
- `docs/features/oob-auth.md`: `secret` CLI references
- `docs/requirements/oob-credential-collection.md`: New requirements doc
- `docs/secure-variable-usecases.md`: New use-case document
- `docs/test-audit-report.md`: New test audit report

### llms-full.txt - Updated in sync with README. No issues.

### skills/ - Updated with new credential flow and Beads syntax.

---

## Code Review Findings

### Build & Tests
- **PASS**: `npm run build` - clean compilation
- **PASS**: `npm test` - 76 files, 1233 passed, 6 skipped, 0 failures

### Security
- **PASS**: `collectSecret()` - hidden input, timeout, empty rejection
- **PASS**: `secret` CLI - name validation, auth socket, `-y` for CI
- **PASS**: Auth socket - PID tracking, kill-on-completion, socket tracking
- **PASS**: Credential store - `APRA_FLEET_DATA_DIR` respects permissions
- **PASS**: `register-member.ts` auto-creates credentials via OOB
- **PASS**: Secure token regex allows hyphens consistently

### Code Quality
- **PASS**: `onStall` + `clearedByStall` race condition handling
- **PASS**: `baseStatus()` strips parenthetical suffixes correctly
- **PASS**: `check-status.ts` defers to stall detector for busy/unknown
- **PASS**: `auth.ts` simplification with unknown flag rejection
- **PASS**: dir-watcher mtime filter prevents stale detection
- **PASS**: `findExe()` avoids Windows cmd.exe argument mangling

### Test Coverage
- **PASS**: `tests/secret-cli.test.ts` (467 lines)
- **PASS**: `tests/credential-store-set.test.ts` (144 lines)
- **PASS**: `tests/credential-store-path.test.ts` (173 lines)
- **PASS**: `tests/register-member-oob.test.ts` (218 lines)
- **PASS**: `tests/providers.test.ts` - new provider coverage
- **PASS**: Dead tests removed per audit findings
- **PASS**: Stall detector tests updated

### Patterns & Consistency
- **PASS**: `LogScope` usage aligns with project patterns
- **PASS**: `fmtElapsed` provides consistent `mm:ss` formatting
- **PASS**: E2e cleanly separated, CI excludes e2e triggers
- **NOTE**: PM `backlog.md` template removed intentionally (Beads replaces it)

---

## Final Summary

**Verdict: APPROVED**

Build and test suite pass cleanly. E2e infrastructure is well-designed with cross-platform support and clear runbook. Production code changes are well-tested. Documentation is current across README, llms-full.txt, skill docs, and ADR docs. No security issues, no missing tests, no stale documentation.
