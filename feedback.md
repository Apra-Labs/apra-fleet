# T3: Bisect + Root Cause Documentation

## Root Cause Commit

**Commit SHA:** `aa9605f`
**PR:** #65 (feat: member name resolution, receive_files, DRY OAuth)
**Date:** 2026-02-26 (one day after initial implementation)

## Diagnosis

The bug was introduced in commit `aa9605f` when the `receive_files` feature was added to the codebase. Prior to this commit, `uploadViaSFTP` in `src/services/sftp.ts` used simple string concatenation to join work folder with destination path:

```typescript
// Initial implementation (993afca) — works for all OS types
remoteBase = `${remoteBase}/${remoteSubfolder}`;
```

Commit `aa9605f` refactored this to use `path.posix.resolve` for both `uploadViaSFTP` and the newly added `downloadViaSFTP`:

```typescript
// PR #65 (aa9605f) — breaks Windows drive-letter paths
const remoteBase = path.posix.resolve(workFolderPosix, destinationPath.replace(/\\/g, '/'));
```

The problem: `path.posix.resolve` treats paths that don't start with `/` as relative paths. When `workFolderPosix` is a Windows drive letter like `C:/Users/...`, it does NOT start with `/`, so `path.posix.resolve` treats it as a relative path and prepends the local Node.js process CWD, producing garbage like:

```
/home/kashyap/repos/apra/apra-fleet/C:/Users/Kashyap/repos/_staging
```

Instead of the correct:

```
C:/Users/Kashyap/repos/_staging
```

## Classification

**Feature Gap** — NOT a regression from PR #97.

- PR #97 (d0139ff, 2026-04-08) only renamed parameters and did not touch the `path.posix.resolve` calls in `sftp.ts`.
- The `path.posix.resolve` pattern has existed since commit `aa9605f` (2026-02-26), predating PR #97 by over a month.
- The bug was never caught because:
  1. Initial development and testing only used Linux-to-Linux transfers
  2. No Windows member existed in the fleet until recently
  3. The existing test suite mocks the SFTP layer, so it never exercises the actual path resolution inside `sftp.ts`

## Evidence

- `git show 993afca:src/services/sftp.ts` — no `path.posix.resolve` in initial implementation
- `git show aa9605f -- src/services/sftp.ts` — introduces `path.posix.resolve` for both upload and download
- `git show d0139ff --stat` — PR #97 does not list `sftp.ts` in modified files

## Implication for Fix

The fix applies the path-resolution pattern that already exists in `platform.ts` (`isContainedInWorkFolder`) and `send-files.ts` (lines 52-55): detect Windows drive letters and join paths without `path.posix.resolve`.
