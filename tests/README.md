# apra-fleet Test Suite

## Cross-OS File Transfer Matrix

The `file-transfer-matrix.test.ts` file contains a comprehensive test matrix covering all (fleet host OS, target member type) combinations for file transfer operations. This matrix is **authoritative** for validating changes to the file transfer code path.

### Why This Matrix Exists

The file transfer code (`send_files`, `receive_files`, and their underlying SFTP transport) must work correctly across all combinations of:
- Fleet host OS (Linux, Windows, macOS)
- Target member type (local, remote Linux via SSH, remote Windows via SSH, cloud)
- Path styles (relative, absolute Linux `/paths`, absolute Windows `C:\paths`, and mixed)

Without this test matrix, path-handling bugs can silently pass in CI (which runs on Linux) but fail in production when users on Windows try to transfer files to Windows members.

### The sftp.ts Path Resolution Incident

In late 2025, file transfers from Linux to Windows members began failing with "No such file" errors ([GH issue #220](https://github.com/Apra-Labs/apra-fleet/issues/220)). Root cause analysis revealed that `src/services/sftp.ts` was using `path.posix.resolve()` to compute remote SFTP paths — a function that does NOT understand Windows drive letters.

```javascript
// This produced garbage:
path.posix.resolve('C:/Users/Kashyap/repos', '_staging')
// → '/home/kashyap/repos/apra/apra-fleet/C:/Users/Kashyap/repos/_staging'  ← BROKEN
```

The bug was introduced in commit aa9605f (PR #65) and predated the suspected PR #97. It went undetected because:
1. No Windows members existed in the test environment when the bug was introduced
2. CI runs on Linux, where path.posix.resolve works correctly for Linux-style paths
3. Tests mocked the SFTP layer and never exercised the actual path resolution logic

The fix (`resolveRemotePath()` in `src/utils/platform.ts`) correctly handles all path styles and is now tested against the full matrix.

### Matrix Coverage Rule

**Any PR that touches** `src/tools/send-files.ts`, `src/tools/receive-files.ts`, `src/services/strategy.ts`, or `src/services/sftp.ts` **must**:
1. Keep all rows of the cross-OS matrix passing
2. Add a new matrix row if introducing a new transport mechanism or OS combination

This rule ensures that regressions like #220 are caught before merging.
