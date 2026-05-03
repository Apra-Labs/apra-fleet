# Beads Install Step — Code Review

**Reviewer:** fleet-reviewer
**Date:** 2026-05-03T19:10:00Z
**Verdict:** CHANGES NEEDED

---

## Install Step Logic

- `execFileSync('bd', ['--version'])` correctly detects existing install and skips re-install. ✓
- Outer try/catch makes the step non-fatal — `console.warn` on failure, install continues. ✓
- Step is positioned correctly: after PM skill (step 7), before `mergePermissions` and the success banner. ✓

## Step Counter Updates

- `totalSteps` incremented by 1 across all four branches of the ternary (`8:7:8:6`, was `7:6:7:5`). ✓
- Beads step always runs regardless of `skillMode`, and the counter reflects this. ✓
- Step label uses `${totalSteps}/${totalSteps}` so numbering stays correct in all skill-mode permutations. ✓

## Banner

- **BUG**: `beadsVersion` is initialized to `'installed'` and the catch block at L630 is empty. If `bd --version` fails (Beads not installed or install failed), the banner prints `Beads: installed` — misleading. The catch should set `beadsVersion = 'not available'` or similar.
- When `bd` *is* available, version string is trimmed correctly, with `'installed'` as a safe fallback for empty output. ✓

## Tests

Three new tests cover the three meaningful code paths:
1. **bd not found → npm install runs, step label appears** — verifies the install-path fires and step counter is correct.
2. **bd already installed → npm install skipped** — asserts no `@beads/bd` call to `execFileSync`, confirming skip logic.
3. **npm install fails → non-fatal warn** — asserts `resolves.toBeUndefined()` (no throw) and checks warning message.

Tests are meaningful, not just smoke. All 1066 existing tests pass (7 skipped). ✓

## Security

- Uses `execFileSync` (not `execSync`) with arguments as an array — no shell interpolation, no injection risk. ✓
- `stdio: 'pipe'` on the version check prevents output leaking. ✓
- No user-controlled input flows into the exec calls. ✓

---

## Summary

The implementation is clean, well-structured, and safe. The tests cover all branches meaningfully. The one issue requiring a fix:

**Banner version fallback bug** (`src/cli/install.ts:626-632`): When `bd` is not available, the catch block should set `beadsVersion` to `'not available'` instead of leaving it as the misleading default `'installed'`. One-line fix:

```ts
} catch {
  beadsVersion = 'not available';
}
```

Verdict: **CHANGES NEEDED** — fix the banner fallback, then this is ready to merge.
