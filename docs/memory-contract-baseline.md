# Memory Contract v1 Baseline

## Purpose
Establish the baseline commit against which all memory-contract/v1 changes are measured.

## Baseline Commit
- **Verified Baseline SHA**: `a400c809` (auto-sprint merge commit)
- **Provenance SHA**: `94bc1368` (PR #305 merge commit: Code intelligence, code index, and knowledge bible consolidation)
- **Date of Provenance**: 2026-08-18
- **Branch**: main at a400c809, includes PR #305 merge commit

## Verification
**Build**: `npm run build`
- Exit code: 0
- Status: [OK] Passing

**MemoryProvider Implementations**
- `src/services/knowledge/sqlite-provider.ts:70` - SqliteProvider: [OK] Compiles
- `src/services/knowledge/http-provider.ts:42` - HttpKbProvider: [OK] Compiles
- `src/services/knowledge/types.ts:230` - MemoryProvider interface: [OK] Unchanged since merge

**Test Suite**: Local Windows run (Windows 10, npm test via scripts/run-all-tests.mjs)
- Vitest: 296 passed | 1 failed | 8 skipped (305 test files)
- Total tests: 4153 passed | 2 failed | 38 skipped (4195 tests)
- apra-fleet-se workspace: 1926 passed | 0 failed | 3 skipped (1929 tests)
- Overall result: EXIT=1 (1 vitest failure not related to memory contract)

**Environmental-Only Exclusions** (Windows-only, not related to code changes)
- `tests/eft-41-symlinked-entry.test.ts` - Skipped (symlink creation requires Windows Developer Mode or elevated process)
- `tests/2cc-win-bd-invocation-integ.test.ts` - Potential EBUSY rmdir on file cleanup, gated with longer timeouts
- `tests/register-member.test.ts` - Subprocess timeouts, configured with longer waits (45000/20000/60000ms) and retry logic
- `tests/register-member-bootstrap-gate.test.ts` - Connection/version/auth subprocess timeouts, configured with 30000ms gate

These failures appear on stock Windows hosts independent of code changes.

## Implementation Notes
The baseline was established with PR #305 (consolidated Knowledge Bible, Code Intelligence, and Code Index consolidation). This commit includes the KnowledgeProvider interface and both memory provider implementations that will be the subject of further contract extraction work in T1.0.2+.
