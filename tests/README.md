# apra-fleet Test Suite

## Cross-OS File Transfer Matrix

The `file-transfer-matrix.test.ts` file contains a comprehensive test matrix covering all (fleet host OS, target member type) combinations for file transfer operations. This matrix is **authoritative** for validating changes to the file transfer code path.

### Why This Matrix Exists

The file transfer code (`send_files`, `receive_files`, and their underlying SFTP transport) must work correctly across all combinations of:
- Fleet host OS (Linux, Windows, macOS)
- Target member type (local, remote Linux via SSH, remote Windows via SSH, cloud)
- Path styles (relative, absolute Linux `/paths`, absolute Windows `C:\paths`, and mixed)

Without this test matrix, path-handling bugs can silently pass in CI (which runs on Linux) but fail in production when users on Windows try to transfer files to Windows members.

### The sftp.ts path-resolution gotcha

Never use `path.posix.resolve()` to compute a remote SFTP path: it does NOT
understand Windows drive letters, and silently produces garbage rather than
failing.

```javascript
// This produces garbage:
path.posix.resolve('C:/Users/someone/repos', '_staging')
// -> '/home/someone/repos/apra/apra-fleet/C:/Users/someone/repos/_staging'  <- BROKEN
```

Use `resolveRemotePath()` in `src/utils/platform.ts` instead -- it handles all
path styles and is tested against the full matrix.

This class of bug is invisible without the matrix: CI runs on Linux, where
`path.posix.resolve` works correctly for Linux-style paths, and tests that mock
the SFTP layer never exercise path resolution at all.

### Matrix Coverage Rule

**Any PR that touches** `src/tools/send-files.ts`, `src/tools/receive-files.ts`, `src/services/strategy.ts`, or `src/services/sftp.ts` **must**:
1. Keep all rows of the cross-OS matrix passing
2. Add a new matrix row if introducing a new transport mechanism or OS combination

This rule ensures cross-OS path regressions are caught before merging.
