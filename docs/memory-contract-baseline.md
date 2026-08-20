# Memory Contract v1 Baseline

## Purpose
Establish the baseline commit against which all memory-contract/v1 changes are measured.

## Baseline Commit
- **Verified Baseline SHA**: `a400c809` (commit where CI ran green)
- **Provenance SHA**: `94bc1368` (PR #305 merge commit: Code intelligence, code index, and knowledge bible consolidation)
- **Date of Provenance**: 2026-08-18
- **Branch**: main at a400c809, includes PR #305 merge commit

## Verification
- **CI Status**: [OK] Passed on a400c809 (auto-sprint [PASS] marker; see commit a400c809)
- **Build**: [OK] Passing (npm run build)
- **MemoryProvider Implementations**: [OK] Both implementations compile
  - `src/services/knowledge/sqlite-provider.ts` - SqliteProvider
  - `src/services/knowledge/http-provider.ts` - HttpKbProvider
- **Shared Interface**: [OK] MemoryProvider interface at line 230 unchanged; types.ts otherwise changed (Author union added 'kb-reconciler')

## Test Suite Details
- **Total Tests**: 4195
- **Test Files**: 305
- **Skipped**: 37
- **CI Result**: [PASS] at a400c809 (verified via auto-sprint workflow)
- **Note**: Local Windows runs show 4 test files with environmental-only failures (symlink EPERM, bd init, timeouts) unrelated to code changes; CI runs on Linux exclude these and pass

## Implementation Notes
The baseline was established with PR #305 (consolidated Knowledge Bible, Code Intelligence, and Code Index consolidation). This commit includes the KnowledgeProvider interface and both memory provider implementations that will be the subject of further contract extraction work in T1.0.2+.
