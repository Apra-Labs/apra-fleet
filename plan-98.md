## Planning Session
- Member: fleet-dev2
- Date: 2026-05-01
- Gemini session: 5a72fea9 (start fresh session on fleet-dev2 to resume planning context)

---

# Glob patterns and directories in send_files / receive_files — Implementation Plan

> Expand globs and directory paths in `local_paths` / `remote_paths` before transfer, preserving directory structure for directory arguments while remaining fully backward-compatible for explicit file paths.

---

## Tasks

### Phase 1: Local path expansion utility

#### Task 1: Create `src/utils/expand-paths.ts`
- **Change:** New module exporting `expandLocalPaths(paths: string[]): Promise<Array<{ absolute: string; relative: string }>>`. Rules per entry: (a) if the path is a directory (`fs.statSync`) — walk with `fs.readdirSync(dir, { recursive: true })` (Node 18.17+), filter to files only, set `relative = join(basename(dir), relPart)` to preserve structure under the directory name; (b) if the path contains a glob character (`*`, `?`, `[`, `{`) — expand with `await glob(pattern, { cwd: process.cwd() })` from `node:fs/promises` (Node 22+), set `relative = basename(match)` for each match (flat — no structure for globs); (c) otherwise (explicit file) — set `relative = basename(path)`, unchanged from today. Return empty array (not error) if a glob matches nothing or a directory is empty. Throw `Error` if an explicit file path does not exist.
- **Files:** `src/utils/expand-paths.ts` (new)
- **Tier:** cheap
- **Done when:** Unit tests pass for all three input types; `npm run build` passes
- **Blockers:** none

#### VERIFY: Phase 1
- `npm run build` passes
- `npm test` passes (new unit tests from Task 1)

---

### Phase 2: send_files — wire local expansion and SFTP/local upload

#### Task 2: Update `uploadViaSFTP()` to accept `{ absolute, relative }[]`
- **Change:** In `src/services/sftp.ts`, change `uploadViaSFTP(agent, localPaths: string[], ...)` to `uploadViaSFTP(agent, entries: Array<{ absolute: string; relative: string }>, ...)`. For each entry: compute `remotePath = remoteBase + '/' + entry.relative.replace(/\\/g, '/')`. Before calling `sftpPut`, call `sftpMkdirRecursive(sftp, posixDirname(remotePath))` to create intermediate subdirectories. Report `entry.relative` in the `success`/`failed` arrays (for plain files this is the basename — identical to today). Update `src/services/file-transfer.ts` `uploadFiles()` to pass the new type.
- **Files:** `src/services/sftp.ts`, `src/services/file-transfer.ts`
- **Tier:** standard
- **Done when:** `uploadViaSFTP` accepts `{absolute, relative}[]`; unit test with a nested `relative` path confirms remote subdir is created; backward-compat test with basename-only `relative` passes; `npm run build` passes
- **Blockers:** Task 1

#### Task 3: Update `LocalStrategy.transferFiles()` and `receiveFiles()` in `strategy.ts`
- **Change:** The local strategy (for `agentType === 'local'` members) currently uses `path.basename()` for flat copies. Update `StrategyInterface.transferFiles` to accept `Array<{absolute: string; relative: string}>`. In `LocalStrategy.transferFiles()`: for each entry, compute `destPath = path.join(workFolder, destSubdir ?? '', entry.relative)`, call `fs.mkdirSync(path.dirname(destPath), { recursive: true })`, then `fs.copyFileSync(entry.absolute, destPath)`. In `LocalStrategy.receiveFiles()`: call `expandLocalPaths()` to expand directory/glob remote paths (local members share the same filesystem), then copy to `localDest` preserving `relative` paths.
- **Files:** `src/services/strategy.ts`
- **Tier:** standard
- **Done when:** `send_files` and `receive_files` on a local member handle directories and globs correctly; `npm run build` passes
- **Blockers:** Tasks 1, 2

#### Task 4: Wire expansion into `send-files.ts`
- **Change:** In `src/tools/send-files.ts`: (1) Before the collision check, call `const entries = await expandLocalPaths(input.local_paths)` — if it throws (explicit file not found), return an error string; (2) Update the collision check to use `entry.relative` instead of `path.basename(p)` — reject if two entries share the same `relative` path; (3) Pass `entries` to `strategy.transferFiles()`; (4) Update the schema description for `local_paths` to document glob and directory support.
- **Files:** `src/tools/send-files.ts`
- **Tier:** standard
- **Done when:** `send_files(['src/'])` uploads all files under `src/` with structure; `send_files(['src/foo.ts'])` still lands flat at `dest/foo.ts`; `npm run build` passes
- **Blockers:** Tasks 1, 2, 3

#### VERIFY: Phase 2
- `npm run build` passes
- `npm test` passes
- Manual: `send_files(local_paths: ['src/tools/'])` on a remote member → all files appear under `workFolder/src/tools/` on the member

---

### Phase 3: receive_files — SFTP remote expansion and directory download

#### Task 5: Add `expandRemotePaths()` to `sftp.ts`
- **Change:** Add `expandRemotePaths(sftp: SFTPWrapper, workFolderPosix: string, remotePaths: string[]): Promise<Array<{ remoteFull: string; relative: string }>>`. Rules per entry: (a) directory (path ends with `/` or SFTP `stat` shows `isDirectory()`) — recursively `readdir`/`stat` to collect all files, set `relative = basename(dir) + '/' + relPart`; (b) glob (path contains `*` or `?`) — `readdir` the parent, implement inline single-level matcher (`*` matches any chars, `?` matches one char, no `**` in v1) to filter entries, set `relative = basename(match)` each; (c) explicit file — set `relative = basename(path)`. No new npm dependencies — inline glob matcher only. After expansion, validate all `relative` paths: ensure `path.posix.normalize(relative)` does not start with `..` or `/` (guards against symlink escape).
- **Files:** `src/services/sftp.ts`
- **Tier:** standard
- **Done when:** Unit tests (mocked SFTPWrapper) pass for directory, glob, and explicit-file cases; path traversal test (`relative = '../escape'`) returns an error; `npm run build` passes
- **Blockers:** none

#### Task 6: Update `downloadViaSFTP()` to use expanded paths
- **Change:** In `src/services/sftp.ts`, update `downloadViaSFTP`: (1) Call `expandRemotePaths(sftp, workFolderPosix, remotePaths)` to get `{remoteFull, relative}[]`; (2) For each entry, `localPath = path.join(localDestination, entry.relative)`; (3) `fs.mkdirSync(path.dirname(localPath), { recursive: true })`; (4) `sftpGet(sftp, entry.remoteFull, localPath)`. Update `src/services/file-transfer.ts` `downloadFiles()` accordingly.
- **Files:** `src/services/sftp.ts`, `src/services/file-transfer.ts`
- **Tier:** standard
- **Done when:** Remote directory path downloads all files with structure; explicit remote file still lands flat; `npm run build` passes
- **Blockers:** Task 5

#### Task 7: Wire into `receive-files.ts` and update schema
- **Change:** In `src/tools/receive-files.ts`: expansion is now inside `downloadViaSFTP` — no logic change needed. Update the schema description for `remote_paths` to document glob and directory support. Update the log summary line to show the total expanded file count.
- **Files:** `src/tools/receive-files.ts`
- **Tier:** standard
- **Done when:** Schema description updated; log shows expanded count; `npm run build` passes
- **Blockers:** Task 6

#### VERIFY: Phase 3
- `npm run build` passes
- `npm test` passes
- Manual: `receive_files(remote_paths: ['dist/'])` on a remote member → all files appear under `localDest/dist/` preserving structure

---

### Phase 4: Tests

#### Task 8: Unit tests for `expandLocalPaths()`
- **Change:** In `tests/expand-paths.test.ts` (new), using a temp directory: (a) explicit file → `relative` is basename; (b) directory → all files found recursively, each `relative` starts with `dirname/`; (c) glob `*.ts` → `.ts` files only, flat basenames; (d) glob matches nothing → empty array; (e) explicit file missing → throws.
- **Files:** `tests/expand-paths.test.ts` (new)
- **Tier:** standard
- **Done when:** `npm test` passes with all 5 cases
- **Blockers:** Task 1

#### Task 9: Unit tests for `expandRemotePaths()` and updated SFTP functions
- **Change:** In `tests/sftp.test.ts` (create if absent): (a) `expandRemotePaths` — mocked SFTP for directory, single-level glob, and explicit-file inputs; (b) path traversal test: symlink returning `relative = '../escape'` → error; (c) `uploadViaSFTP` with `{relative: 'sub/file.ts'}` — assert `sftpMkdirRecursive` called for the subdir; (d) backward-compat: `{relative: 'file.ts'}` → flat upload, no subdir creation.
- **Files:** `tests/sftp.test.ts`
- **Tier:** standard
- **Done when:** `npm test` passes with all cases
- **Blockers:** Tasks 2, 5

#### VERIFY: Phase 4
- `npm test` passes clean across all suites
- Manual end-to-end: `send_files` + `receive_files` round-trip of a directory preserves full file structure

---

## Risk Register

| Risk | Impact | Mitigation |
|------|--------|------------|
| Symlink on remote member points outside work_folder | high | Task 5 validates all expanded `relative` paths — any `..` component rejected before download |
| Backward compat broken: success[] paths change for plain files | med | Plain files always get `relative = basename` — identical output to today |
| Glob expansion on large directories overwhelms SFTP | med | Document that large transfers should use `tar` + `execute_command`; no hard limit in v1 |
| `node:fs/promises` `glob` not available in Node 22 < 22.0 | low | `fs.readdirSync({ recursive: true })` handles directory case; local glob uses the API with a runtime check — fall back to manual walk if unavailable |
| Remote readdir is slow for deep trees | low | Abort signal checked every iteration; no extra mitigation in v1 |
| Collision check edge case: two globs expanding to same basename | low | Collision check on `relative` catches this — returns error before any upload |

## Notes
- Base branch: `main`
- Implementation branch: `feat/glob-dir-transfer`
- Each task = one git commit
- VERIFY = checkpoint, stop and report
- Deep remote globs (`**`) are out of scope for v1 — single-level `*`/`?` only
- No new npm dependencies — inline single-level glob matcher for remote paths
