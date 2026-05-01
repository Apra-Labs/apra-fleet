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
- **Change:** New module exporting `expandLocalPaths(paths: string[]): Promise<Array<{ absolute: string; relative: string }>>`. Rules per entry: (a) if the path is a directory (checked via `fs.statSync`) — walk with `fs.readdirSync(dir, { recursive: true })` (Node 18.17+), filter to files only, set `relative = join(basename(dir), relativePart)` so structure is preserved under the directory name; (b) if the path contains a glob character (`*`, `?`, `[`, `{`) — expand with Node 22 `await glob(pattern, { cwd: process.cwd(), withFileTypes: false })` from `node:fs/promises`, set `relative = basename(match)` for each match (flat, no structure); (c) otherwise (explicit file path) — set `relative = basename(path)` as today. Return empty array (not error) if a glob matches nothing or a directory is empty. Throw `Error` if an explicit file path does not exist.
- **Files:** `src/utils/expand-paths.ts` (new)
- **Tier:** cheap
- **Done when:** Unit tests pass for all three input types; `npm run build` passes
- **Blockers:** none

#### VERIFY: Phase 1
- `npm run build` passes
- `npm test` passes (new unit tests from Task 1)

---

### Phase 2: send_files — wire local expansion and SFTP upload

#### Task 2: Update `uploadViaSFTP()` to accept `{ absolute, relative }[]`
- **Change:** In `src/services/sftp.ts`, change `uploadViaSFTP(agent, localPaths: string[], ...)` to `uploadViaSFTP(agent, entries: Array<{ absolute: string; relative: string }>, ...)`. For each entry: compute `remotePath = remoteBase + '/' + entry.relative.replace(/\\/g, '/')`. Before calling `sftpPut`, call `sftpMkdirRecursive(sftp, posixDirname(remotePath))` to create any intermediate subdirectories. Report `entry.relative` (not just basename) in the `success`/`failed` arrays so callers see the full path. Update `src/services/file-transfer.ts` `uploadFiles()` to pass the new type.
- **Files:** `src/services/sftp.ts`, `src/services/file-transfer.ts`
- **Tier:** standard
- **Done when:** `uploadViaSFTP` accepts `{absolute, relative}[]`; a unit test uploading a nested entry creates the remote subdirectory; `npm run build` passes
- **Blockers:** Task 1

#### Task 3: Wire expansion into `send-files.ts`
- **Change:** In `src/tools/send-files.ts`: (1) Before the collision check, call `const entries = await expandLocalPaths(input.local_paths)` — if it throws (explicit file not found), return an error string; (2) Update the collision check to use `entry.relative` instead of `path.basename(p)` — two entries with the same `relative` path would overwrite each other; (3) Pass `entries` to `strategy.transferFiles()` — update that interface to accept `Array<{absolute, relative}>` (or add an overload); (4) Update the schema description for `local_paths` to document glob and directory support.
- **Files:** `src/tools/send-files.ts`, `src/services/strategy.ts` (interface update)
- **Tier:** standard
- **Done when:** `send_files(['src/'])` uploads all files under `src/` preserving structure; `send_files(['src/foo.ts'])` still uploads flat to `dest/foo.ts`; collision detection works for `relative` paths; `npm run build` passes
- **Blockers:** Tasks 1, 2

#### VERIFY: Phase 2
- `npm run build` passes
- `npm test` passes
- Manual: `send_files(local_paths: ['src/tools/'])` on a remote member → all files appear under `workFolder/src/tools/` on the member

---

### Phase 3: receive_files — SFTP remote expansion and directory download

#### Task 4: Add remote path expansion to `sftp.ts`
- **Change:** Add `expandRemotePaths(sftp: SFTPWrapper, workFolderPosix: string, remotePaths: string[]): Promise<Array<{ remoteFull: string; relative: string }>>`. Rules per entry: (a) if path ends with `/` or SFTP `stat` shows it is a directory — recursively `readdir`/`stat` to collect all files, set `relative = basename(dir) + '/' + relativePart`; (b) if path contains glob characters — use SFTP `readdir` of the parent and filter by pattern using `minimatch` (add `minimatch` as a dependency — it is tiny, widely used, and Node's built-in glob does not work on SFTP paths), set `relative = basename(match)` for each match; (c) otherwise (explicit remote file) — set `relative = basename(path)`. Note: if `minimatch` is undesirable, implement a simple `*`/`?` matcher internally to avoid adding a dependency.
- **Files:** `src/services/sftp.ts`
- **Tier:** standard
- **Done when:** Unit tests (with mocked SFTPWrapper) pass for all three remote input types; `npm run build` passes
- **Blockers:** none (can be developed in parallel with Task 2)

#### Task 5: Update `downloadViaSFTP()` to use expanded paths
- **Change:** In `src/services/sftp.ts`, update `downloadViaSFTP(agent, remotePaths, localDestination, ...)`: (1) Call `expandRemotePaths(sftp, workFolderPosix, remotePaths)` to get `{remoteFull, relative}[]`; (2) For each entry, compute `localPath = path.join(localDestination, entry.relative)`; (3) Call `fs.mkdirSync(path.dirname(localPath), { recursive: true })` to create intermediate local directories; (4) Download to `localPath`. Update `src/services/file-transfer.ts` `downloadFiles()` accordingly.
- **Files:** `src/services/sftp.ts`, `src/services/file-transfer.ts`
- **Tier:** standard
- **Done when:** `downloadViaSFTP` with a remote directory path downloads all files preserving structure; explicit remote file path still downloads flat; `npm run build` passes
- **Blockers:** Task 4

#### Task 6: Wire into `receive-files.ts` and update schema
- **Change:** In `src/tools/receive-files.ts`: (1) The expansion is now handled inside `downloadViaSFTP` — no change to `receive-files.ts` logic needed; (2) Update the schema description for `remote_paths` to document glob and directory support; (3) Update the log message to show total file count after expansion.
- **Files:** `src/tools/receive-files.ts`
- **Tier:** cheap
- **Done when:** Schema description updated; `npm run build` passes
- **Blockers:** Task 5

#### VERIFY: Phase 3
- `npm run build` passes
- `npm test` passes
- Manual: `receive_files(remote_paths: ['dist/'])` on a remote member → all files appear under `localDest/dist/` preserving structure

---

### Phase 4: Tests

#### Task 7: Unit tests for `expandLocalPaths()`
- **Change:** In `tests/expand-paths.test.ts` (new), using a temp directory: (a) explicit file → `relative` is basename, `absolute` is full path; (b) directory → all files found recursively, each `relative` starts with `dirname/`; (c) glob `*.ts` → only `.ts` files returned, flat basenames; (d) glob that matches nothing → empty array (no error); (e) explicit file that doesn't exist → throws.
- **Files:** `tests/expand-paths.test.ts` (new)
- **Tier:** standard
- **Done when:** `npm test` passes with all 5 cases
- **Blockers:** Task 1

#### Task 8: Unit tests for `expandRemotePaths()` and updated `uploadViaSFTP`
- **Change:** In `tests/sftp.test.ts` (create if absent): (a) `expandRemotePaths` with mocked SFTP for explicit file, directory, and glob cases; (b) `uploadViaSFTP` with `{absolute, relative: 'sub/file.ts'}` — assert `sftpMkdirRecursive` called with remote subdir path; (c) backward compat: `{relative: 'file.ts'}` (basename only) — assert flat upload as before.
- **Files:** `tests/sftp.test.ts`
- **Tier:** standard
- **Done when:** `npm test` passes with all cases
- **Blockers:** Tasks 2, 4

#### VERIFY: Phase 4
- `npm test` passes clean across all suites
- Manual end-to-end: `send_files` + `receive_files` round-trip of a directory preserves full file structure

---

## Risk Register

| Risk | Impact | Mitigation |
|------|--------|------------|
| Glob expansion on large directories sends thousands of files, overwhelming SFTP | med | No built-in limit needed for v1; document that large transfers should use `tar` + `execute_command` instead |
| Backward compat broken: existing callers see path changes in success[] output | med | Task 2 uses `entry.relative` in output — for plain files `relative = basename`, identical to today |
| SFTP remote readdir on large directories is slow | low | Async iteration with abort signal check every N entries |
| `minimatch` dependency introduces supply-chain risk | low | Alternative: implement single-level `*`/`?` glob inline; remote deep globs (`**`) are out of scope for v1 |
| Collision check misses cross-directory same-basename files | low | Collision check now uses full `relative` path — different dirs with same filename are not a collision |
| `node:fs/promises` `glob` API not stable in all Node 22 minors | low | Fall back to manual directory walk + micromatch if `glob` throws; document Node 22.13+ as minimum |

## Notes
- Base branch: `main`
- Implementation branch: `feat/glob-dir-transfer`
- Each task = one git commit
- VERIFY = checkpoint, stop and report
- Deep remote globs (`**`) are out of scope for v1 — single-level `*`/`?` only for remote paths
- Local strategy (local members using `fs.copyFile`) must also be updated to handle `{absolute, relative}[]` — check `src/services/strategy.ts` for the local transfer path
