# Fleet-Rev Final Verdict — improve/schema-usability

## Verdict: APPROVED

## Summary

Reviewed 6 commits since `31aa84f` covering: prompt file delivery refactor, unique prompt filenames, null byte defense, resolvedPath passthrough, stale doc cleanup, and receive_files tests. Build passes cleanly, all 614 tests pass (40 test files, 4 skipped). The core prompt-file implementation is solid and the security additions are well-placed.

## Issues Found

### BLOCKING

None.

### MINOR

1. **Stale `reset_session` references remain** — Found in `README.md:53`, `docs/architecture.md:167`, and `docs/MCP-BACKLOG.md:10`. The docs cleanup commit (`f9f9874`) caught the references in `docs/tools-work.md` and `docs/cloud-compute.md` but missed these three files. Non-blocking since `reset_session` is no longer a tool and these are reference docs, but should be cleaned up in a follow-up.

2. **Stale "Base64-encodes the prompt" in `docs/tools-work.md:69`** — The execute_prompt section still describes the old base64 inline delivery mechanism ("Base64-encodes the prompt — this avoids shell escaping issues..."). After the file-delivery refactor this is inaccurate. The description should say the prompt is written to a unique `.fleet-task-*.md` file and the CLI is instructed to read it.

3. **receive_files test coverage** — The 4 tests cover the critical paths (local copy, SFTP, boundary violation, null byte). A "member not found" test case would round it out but is not essential since that code path is shared with other tools that already test it.

## Review Details

### Prompt file implementation (`execute-prompt.ts`)
- `writePromptFile`: Correct for all three paths — local (`fs.writeFileSync`), Windows (`EncodedCommand` with proper single-quote escaping), Linux (base64 pipe to file). The base64 approach for Linux remote writes is safe since b64 output contains no shell-special characters.
- `deletePromptFile`: Proper silent cleanup — `try/catch` for local, `.catch(() => {})` for remote. Windows uses `-Force -ErrorAction SilentlyContinue`, Linux uses `rm -f`.
- `try/finally` wraps the entire execution block including both retry paths (stale session + server error). Cleanup is guaranteed.
- Unique filenames: `crypto.randomUUID().slice(0, 8)` gives 8 hex chars — collision probability is negligible. The `.fleet-task-*.md` pattern is in `.gitignore` and `tpl-doer.md` warns doers not to commit it.
- `promptFileName` is passed through to `promptOpts.promptFile` which flows into all provider `buildPromptCommand` calls correctly.

### OS command builders
- **Windows** (`windows.ts:93-112`): Uses `provider.headlessInvocation(instruction)` which wraps the instruction in the provider's native flag. The instruction is a fixed template with only `promptFile` interpolated — safe since the filename is internally generated `[a-f0-9]{8}`.
- **Linux** (`linux.ts:84-95`): Delegates to `provider.buildPromptCommand(opts)` which builds the full command. The `cdPrefix` injection of `CLI_PATH` is clean.
- No shell injection risk in either path.

### Provider `headlessInvocation` / `buildPromptCommand`
All four providers (Claude, Gemini, Codex, Copilot) use the identical instruction template: `Your task is described in ${promptFile} in the current directory. Read that file first, then execute the task.` All quote it properly — Claude/Gemini/Copilot via `-p "..."`, Codex via `exec "..."`. Folder paths use `escapeDoubleQuoted()` consistently.

### Null byte defense
- `send_files.ts:31` — checks `destination_path` before path resolution. Correct placement.
- `receive_files.ts:39` — checks each `remote_path` in the loop before resolution. Correct placement.
- Both return clear error messages. Coverage is complete for the file transfer tools.

### resolvedPath passthrough (`send_files.ts:81`)
Output now shows the actual resolved destination path instead of just the work folder. Correct.

## Approved for merge: yes
