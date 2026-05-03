# PR #231 — feat/per-instance-data-dir — Code Review

## Verdict: APPROVED

Build: ✅ pass | Tests: ✅ 1138 passed, 6 skipped, 0 failures

---

## Findings

### MEDIUM — `mcp remove` still uses shell-interpolated `execSync` (inconsistency)

**File:** `src/cli/install.ts:595`

The security fix correctly switches `claude mcp add` to `execFileSync` with an argv array, eliminating shell injection. However, `claude mcp remove` still goes through the `run()` helper which uses `execSync` with string interpolation:

```ts
run(`claude mcp remove ${serverName} --scope user`, { stdio: 'ignore' });
```

This is **not exploitable** because `serverName` is derived from `instanceName` which is validated against `/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/` — no shell metacharacters can pass. But for consistency and defense-in-depth, consider switching this to `execFileSync` as well.

### LOW — `workspace.ts` duplicates path constants from `paths.ts`

**File:** `src/cli/workspace.ts:5-9`

`APRA_BASE`, `WORKSPACES_DIR`, and `WORKSPACES_INDEX` are defined identically in both `src/paths.ts` and `src/cli/workspace.ts`. Should import from `../paths.ts` to avoid drift.

### LOW — `cmdUse` eval suggestion could confuse users

**File:** `src/cli/workspace.ts:151`

The output suggests `eval "$(apra-fleet workspace use <name>)"` but the command also prints a comment line (`# To activate...`) which would be harmless but noisy in eval context. Consider emitting the export-only line when stdout is not a TTY, or documenting that eval will work despite the comment.

---

## Security Assessment

- **Shell injection:** Fully eliminated for the `mcp add` path (the attack vector described in #193). The `mcp remove` path is safe due to input validation but could be hardened for consistency.
- **Path traversal:** `--instance` name is alphanumeric-only (regex validated), `--data-dir` resolves `~` safely. No directory traversal possible via instance names.
- **No user input flows unvalidated into file system paths** — workspace names are validated, data-dir is used as-is (user controls their own filesystem).

## Backward Compatibility

- No `--data-dir` / `--instance` → old behavior unchanged: server name remains `apra-fleet`, data dir defaults to `~/.apra-fleet/data`.
- `FLEET_DIR` in `paths.ts` still falls back to the old default when `APRA_FLEET_DATA_DIR` is unset.
- Existing MCP registrations are unaffected.

## Summary

Clean implementation. The --instance/--data-dir design is intuitive, input validation is solid, the security fix addresses the reported shell injection, tests cover flag parsing + multi-provider + permissions correctly. The two MEDIUM/LOW items are non-blocking improvements.
