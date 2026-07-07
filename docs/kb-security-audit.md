# Knowledge Bank -- Security Audit

Audit date: 2026-06-11
Scope: All KB source files in src/services/knowledge/ and src/tools/kb-*.ts

## Findings

### 1. SQL Injection -- PASS

All SQLite queries use `db.prepare()` with parameterized `?` placeholders.
No string concatenation of user input into SQL.

Dynamic `IN (?,?,?)` clauses in sqlite-provider.ts generate placeholder
count from array length (not user strings), then bind values via spread.
This is safe: the query structure is fixed, only the parameter count varies.

Files audited:
- src/services/knowledge/sqlite-provider.ts

### 2. Command Injection -- PASS

`computeFileHash` and `computeFileHashBatch` in file-hash.ts use
`child_process.execFile` (not `exec`). File paths are passed as array
arguments, never shell-interpolated.

Files audited:
- src/services/knowledge/file-hash.ts

### 3. Path Traversal -- FIXED

**Finding:** KB tools accepted arbitrary file paths without validation.
Paths like `../../etc/passwd` or absolute paths could reach outside the
working directory.

**Fix:** Added `validateFilePaths()` in src/services/knowledge/path-validation.ts.
Rejects absolute paths and paths containing `..` sequences. Applied to:
- kb-capture.ts (source_files, source_file)
- kb-invalidate.ts (files)
- kb-context.ts (files)
- kb-session-prime.ts (session_files)

kb-server.ts (Task 17) also validates file paths in request bodies.

### 4. Plaintext Credentials -- PASS

kb-setup.ts stores remote tokens via AES-256-GCM encryption
(encryptPassword from src/utils/crypto.ts). Token is never logged
or returned in MCP tool output. Config file written with mode 0o600.

kb-server.ts stores its auth token at FLEET_DIR/knowledge/kb-server.token
with mode 0o600. The Authorization header value is never logged.

### 5. Non-ASCII Characters -- PASS

No non-ASCII characters found in any KB source file.

## Summary

| Category           | Status | Action taken            |
|--------------------|--------|-------------------------|
| SQL injection      | PASS   | None needed             |
| Command injection  | PASS   | None needed             |
| Path traversal     | FIXED  | Added validateFilePaths |
| Plaintext creds    | PASS   | None needed             |
| Non-ASCII          | PASS   | None needed             |
