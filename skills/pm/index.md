# Project Index

Index the project repo for code intelligence so fleet members can use
code_graph, code_impact, code_query, and code_context tools.

## Flow

1. Read `<project>/status.md` to find the repo path and an available member.
2. Pick any online member whose work_folder is the project repo. If no member
   is pointed at the repo, use any local online member and set `run_from` to
   the repo path.
3. Run via `execute_command` (wrap in background Agent per fleet rules):
   ```
   npx gitnexus analyze
   ```
   - `run_from`: project repo root
   - `timeout_s`: 300 (indexing large repos can take a minute)
4. Report the result: nodes indexed, edges, flows (gitnexus prints this on
   completion). If gitnexus is not installed, it will be fetched automatically
   via npx.
5. Non-fatal: if the command fails (e.g. no package.json, unsupported language),
   log the error and tell the user -- do not block the sprint.

## When to run

- After `/pm init` on a new project
- After a large merge or rebase that changes many files
- When `kb_session_prime` returns many stale entries
- Any time the user asks to re-index

## Notes

- Indexing is per-repo and persists on disk -- subsequent runs are incremental.
- The index is used by the gitnexus provider behind code_graph/impact/query/context.
- Fleet members never call gitnexus directly -- they use the fleet tools.
