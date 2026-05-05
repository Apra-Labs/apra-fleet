# Issue #98 — Glob patterns and directories in send_files / receive_files

## Problem

`send_files` and `receive_files` accept only individual file paths. Sending a directory requires enumerating every file manually — error-prone and tedious for common cases like uploading `src/` or downloading a test output folder.

## Goal

Support glob patterns and directory paths in `local_paths` (send_files) and `remote_paths` (receive_files), with directory structure preserved for directory arguments.

## Expansion rules

### send_files `local_paths`
| Input | Expansion | Destination relative path |
|-------|-----------|--------------------------|
| `src/foo.ts` (explicit file) | as-is | `foo.ts` (basename only — no change to existing behaviour) |
| `tests/*.ts` (glob) | all matching files | `<basename>` each — flat, same as explicit files |
| `src/` (directory) | all files recursively under `src/` | `src/foo.ts`, `src/bar/baz.ts` — structure preserved |

### receive_files `remote_paths`
| Input | Expansion | Local path |
|-------|-----------|-----------|
| `output.log` (explicit file) | as-is | `localDest/output.log` (no change) |
| `dist/*.js` (remote glob) | SFTP readdir + filter | `localDest/<basename>` each — flat |
| `dist/` (remote directory) | SFTP recursive readdir | `localDest/dist/foo.js`, `localDest/dist/sub/bar.js` — structure preserved |

## Key constraint

Existing callers passing individual file paths must see **no change** in destination path — backward compatible.

## Files in scope

- `src/utils/expand-paths.ts` (new) — `expandLocalPaths()`: expand globs and directories to `{absolute, relative}[]`
- `src/services/sftp.ts` — `uploadViaSFTP()`: accept `{absolute, relative}[]`; add `expandRemotePaths()` for SFTP-side directory/glob expansion; update `downloadViaSFTP()`
- `src/services/file-transfer.ts` — thread through expanded paths
- `src/tools/send-files.ts` — call `expandLocalPaths()` before collision check; update schema description
- `src/tools/receive-files.ts` — expand remote paths before download; update schema description
- `tests/expand-paths.test.ts` (new), `tests/sftp.test.ts` (new or existing)

## Notes

- Base branch: `main`
- Node 22 built-ins only — no new npm dependencies. Use `glob` from `node:fs/promises` (added Node 22.0) for local glob expansion; `fs.readdirSync(dir, { recursive: true })` for local directory walk; SFTP `readdir` for remote directory walk.
- `node:fs/promises` `glob` is not yet stable in older Node 22 minor versions — use `fast-glob` as a dev dependency if needed, but prefer built-in.
