## Research: Glob Pattern Support in send_files / receive_files

### 1. Where does path expansion happen today?

**It doesn't.** Paths are treated as literal file references throughout the pipeline:

- **`src/tools/send-files.ts:61-79`** — iterates `input.local_paths` for basename collision checks, then passes array directly to `strategy.transferFiles()`
- **`src/tools/receive-files.ts:37-59`** — validates each `remote_path` for null bytes and work folder containment, then passes array to `strategy.receiveFiles()`
- **`src/services/strategy.ts`** — `LocalStrategy.transferFiles()` (line 99-122) and `RemoteStrategy.transferFiles()` (line 32-34) both loop over paths with `fs.copyFileSync()` or SFTP `fastPut()`
- **`src/services/sftp.ts:57-87`** (`uploadViaSFTP`) — loops over `localPaths` calling `sftp.fastPut()` per file
- **`src/services/sftp.ts:89-117`** (`downloadViaSFTP`) — loops over `remotePaths` calling `sftp.fastGet()` per file

No glob expansion or directory traversal occurs anywhere.

### 2. Existing glob library?

**None installed.** Current deps: `ssh2`, `zod`, `uuid`, `smol-toml`, `@inquirer/password`, `@modelcontextprotocol/sdk`.

**Recommendation: `fast-glob`**
- ~3KB, fastest performance, native ESM (project is `"type": "module"`), full cross-platform support
- ~66M downloads/week, used by esbuild/Vite — well trusted
- Supports ignore patterns and has built-in symlink loop detection

Alternative: Node.js built-in `fs.glob()` (available since 18.17, but still experimental — project targets Node 22+)

### 3. Minimal code changes needed

| File | Change |
|------|--------|
| **NEW `src/utils/glob-expansion.ts`** | `expandLocalGlobs(patterns, basePath)` and `expandRemoteGlobs(agent, patterns, basePath)` utility functions |
| **`src/tools/send-files.ts`** | Call `expandLocalGlobs()` after input validation, BEFORE basename collision check (line ~58). Update schema description (line 13). |
| **`src/tools/receive-files.ts`** | Call glob expansion after validation (line ~37). For remote members, glob must expand ON the remote via SSH. Update schema description (line 14). |
| **`src/services/strategy.ts`** | `RemoteStrategy.receiveFiles()` needs remote glob expansion logic (shell command over SSH, parse results) |
| **`package.json`** | Add `fast-glob` dependency |

The `receive_files` remote case is the trickiest — glob expansion must happen on the member's filesystem, not locally.

### 4. Edge cases and risks

| Risk | Details | Mitigation |
|------|---------|------------|
| **Symlink loops** | Glob could follow symlinks infinitely | `fast-glob` has built-in loop detection; use `{ followSymbolicLinks: false }` by default |
| **Large directory trees** | Expanding `**/*` on thousands of files could be slow/memory-heavy | Set `maxResults` limit (e.g. 1000); document performance implications |
| **Path traversal** | Pattern like `../../../etc/passwd` could escape work_folder | Validate patterns before expansion (reject `..`); validate all results with existing `isContainedInWorkFolder()` |
| **Cross-platform separators** | Windows backslashes vs Unix forward slashes | `fast-glob` handles this internally; `src/utils/platform.ts:9-30` already normalizes paths |
| **Basename collisions** | Glob `*.txt` could match files with same basename in different dirs | Run collision detection AFTER expansion, not before |
| **Hidden files** | `*` doesn't match dotfiles by default (standard glob behavior) | Document that `.*` is needed for dotfiles |
| **Null bytes** | Expanded paths could contain special chars | Apply same null-byte validation (already exists at send-files.ts:33-35) on expanded results |

### 5. Complexity estimate

**MEDIUM** (~11-15 hours)

- Core local glob expansion is straightforward (fast-glob wrapper + validation)
- Remote glob expansion over SSH adds complexity (shell escaping, cross-platform commands, error handling)
- Cross-platform testing needed (Windows paths, symlinks, large dirs)
- Security validation on expanded results is essential but uses existing patterns
- No architectural changes required — fits cleanly into existing tool → strategy → transfer pipeline

Not SMALL because remote expansion and cross-platform edge cases require careful handling. Not LARGE because the core logic is simple and existing validation patterns can be reused.
