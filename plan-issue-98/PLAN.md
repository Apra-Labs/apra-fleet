# Implementation Plan: Support Glob Patterns and Directories in File Transfer

**Issue:** #98  
**Complexity:** Medium-Complex (4 files, SFTP integration, testing)

## Problem Summary

`send_files` and `receive_files` currently accept only individual file paths. To send a directory like `src/`, you must enumerate every file manually. This is cumbersome and error-prone.

## Proposed Solution

Support glob patterns and directory paths in `local_paths` (for `send_files`) and `remote_paths` (for `receive_files`):

```json
{ "local_paths": ["src/", "tests/*.ts"] }
```

- Directory paths should be sent recursively
- Glob patterns should be expanded before transfer
- Behaviour should match common tools like `scp -r` or `rsync`

## Implementation Plan

### Phase 1: Research & Design
- [ ] Review current `send_files` and `receive_files` implementation
- [ ] Research Node.js glob libraries (e.g., `glob`, `fast-glob`)
- [ ] Review SFTP library capabilities for recursive transfers
- [ ] Design API: should patterns be expanded client-side or server-side?

### Phase 2: Implementation
- [ ] Add glob pattern expansion in `src/services/file-transfer.ts`
  - Handle directory recursion
  - Handle glob patterns (e.g., `**/*.ts`)
  - Preserve directory structure
- [ ] Update `src/services/sftp.ts`
  - Modify `uploadViaSFTP` to handle multiple files/directories
  - Modify `downloadViaSFTP` to handle multiple files/directories
  - Ensure recursive transfer works correctly
- [ ] Update tool schemas in `src/tools/send-files.ts` and `src/tools/receive-files.ts`
  - Update parameter descriptions
  - Add examples showing glob patterns and directories
- [ ] Add dependency if needed (e.g., `fast-glob`)
  - Check for vulnerabilities before adding

### Phase 3: Testing
- [ ] Unit tests for glob expansion logic
- [ ] Integration tests for directory transfer
- [ ] Integration tests for glob pattern transfer
- [ ] Test edge cases:
  - Empty directories
  - Nested directories
  - Non-existent patterns
  - Mixed paths (some files, some globs)
- [ ] Manual testing with actual SFTP transfers

### Phase 4: Documentation
- [ ] Update tool descriptions with examples
- [ ] Update README or documentation with glob pattern usage
- [ ] Add migration notes if behavior changes

## Estimated Effort
4-8 hours

## Files Affected
- `src/services/sftp.ts`
- `src/services/file-transfer.ts`
- `src/tools/send-files.ts`
- `src/tools/receive-files.ts`
- Tests files
- Possibly `package.json` for new dependency
