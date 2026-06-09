# apra-fleet npm Packaging -- Phase 3 Re-Review

**Reviewer:** fleet-rev
**Date:** 2026-06-09 02:30:00-0400
**Verdict:** APPROVED

> See the recent git history of this file to understand the context of this review.
> Prior entries: db9936e (Phase 1 -- APPROVED), 25086a5 (Phase 2 -- APPROVED), bfc2e47
> (Phase 3 -- CHANGES NEEDED: 1 HIGH claude MCP drops script path + 2 MEDIUM over-mocked
> tests), fc5f69b (doer sha annotations). This re-review covers the fix in commit 88f3a66
> (install.ts MCP command builder + tests/install-npm.test.ts strengthening).

---

## Independent verification

- `npm run build` -- clean (tsc, no errors).
- `npm test` -- **82 files passed (1 skipped), 1335 passed, 14 skipped, 0 failed.** Matches
  the Phase-3 baseline; the fix added no net tests (the 3 over-mocked tests were strengthened
  in place, file still has 11). install-npm.test.ts: 11 green.
- `tests/install.test.ts` -- **unchanged from main** (empty `git diff main..HEAD --
  tests/install.test.ts`); 7 tests green. No regression to the existing install suite.
- File hygiene: the fix diff (`git diff bfc2e47..HEAD`) touches only `src/cli/install.ts`
  (lines 584-590) and `tests/install-npm.test.ts`. Clean. The uncommitted CLAUDE.md/AGENTS.md
  and untracked working-tree files are not part of any sprint commit and are out of scope.

---

## Finding 1 (was HIGH): claude MCP registration now includes node + script -- FIXED / PASS

Read `src/cli/install.ts:573-591`. The mcpConfig ternary is unchanged: SEA -> `{command:
binaryPath, args: []}`, npm -> `{command: process.execPath, args: [process.argv[1]]}`, dev ->
`{command: 'node', args: [<dist/index.js>]}`. The claude command builder (lines 588-590) now
branches on `mcpConfig.args.length > 0` instead of the literal `'node'` string:

```
const cmd = mcpConfig.args.length > 0
  ? `claude mcp add --scope user apra-fleet -- "${mcpConfig.command}" "${mcpConfig.args[0]}"`
  : `claude mcp add --scope user apra-fleet -- "${mcpConfig.command}"`;
```

Confirmed against each requested sub-case:

- **(a) npm mode -- PASS.** `args.length === 1` -> emits `... -- "<execPath>" "<scriptPath>"`.
  The script path (`process.argv[1]`) is no longer dropped. This is the core fix.
- **(b) dev mode -- PASS.** `args.length === 1` -> emits `... -- "node" "<dist/index.js>"`.
  Functionally identical to the pre-bug behavior; `'node'` is now quoted, which the shell
  spawns the same way. Node + script both present.
- **(c) SEA mode -- PASS.** `args.length === 0` -> the `else` branch emits just
  `... -- "<binaryPath>"`. Byte-identical to prior SEA behavior; unchanged.
- **(d) gemini/codex/copilot/agy -- PASS.** Untouched. They consume `mcpConfig` directly via
  `mergeGeminiConfig`/`mergeCodexConfig`/`mergeCopilotConfig`/`mergeAgyConfig` (lines 592-599);
  the claude-only command builder edit does not affect them.
- **(e) Windows-path quoting -- PASS.** Both `mcpConfig.command` and `mcpConfig.args[0]` are
  double-quoted, so an execPath like `C:\Program Files\nodejs\node.exe` and a script path with
  spaces survive intact. The empirical pre-fix run (below) showed the actual execPath
  `C:\nvm4w\nodejs\node.exe` correctly quoted.

`run()` (line 331) dispatches via `execSync` (line 334), so the registration command is a real
shell command, and the test mock observes it on the `execSync` call list. Verified.

## Finding 2 (was MEDIUM x2): the 3 tests now assert real registered command/args -- FIXED / PASS

All three previously-tautological tests now capture `vi.mocked(execSync).mock.calls`, find the
`claude mcp add` command, and assert on its actual content rather than a console.log string:

- "sets binaryPath ... (flows into claude MCP script arg)" (lines 164-182):
  `expect(mcpAdd).toContain(npmPath)`.
- "registers MCP config with process.execPath + absolute script path" (lines 220-236):
  `toContain(process.execPath)` AND `toContain(npmPath)`.
- "uses process.execPath for npm mode MCP registration" (lines 238-254): exact-match
  `toBe(\`claude mcp add --scope user apra-fleet -- "${process.execPath}" "${npmPath}"\`)`.

**Are these real regression guards?** Yes -- verified empirically, not just by reasoning. I
checked out the pre-fix `install.ts` (bfc2e47) and ran the new test file against it: **3 tests
FAILED, 8 passed.** The failure was exactly the dropped script path -- pre-fix Received
`... -- "C:\nvm4w\nodejs\node.exe"` (no script) vs Expected `... -- "<execPath>"
"<scriptPath>"`. Restored HEAD; all 11 pass. So these assertions would have caught the HIGH
bug -- they are genuine regression guards now, not tautologies.

The 6 `isNpmGlobalInstall()` detection tests (lines 53-131) and the copyFileSync-skip test
(line 153) are intact and unchanged -- confirmed in the diff and the green run.

## Finding 3: regression + ASCII -- PASS

- Full suite green at 1335 passing (== Phase-3 baseline; no net change in count, as expected
  for an in-place strengthening). install.test.ts unchanged and green. SEA and dev paths
  unaltered (SEA `args:[]` -> binary-alone; dev `node` + script both registered).
- ASCII-only in the committed sprint files: `tests/install-npm.test.ts` and this `feedback.md`
  contain no non-ASCII. The fix diff lines in `install.ts` (584-590) introduced none. The
  pre-existing em-dashes elsewhere in `install.ts` (.ts exempt from the ASCII hook) are
  out of scope and were already noted in the prior review.

---

## Summary

The HIGH finding is fully resolved: the claude MCP command builder no longer keys on the
literal `'node'` string; it branches on `mcpConfig.args.length`, so npm mode now registers
BOTH the node executable and the script path (`"<execPath>" "<scriptPath>"`), with both
segments quoted for Windows paths. SEA (binary alone), dev (node + script), and the
gemini/codex/copilot/agy providers are functionally unchanged.

Both MEDIUM findings are resolved: the three formerly log-only tests now assert on the real
registered `claude mcp add` command/args. I confirmed empirically that all three FAIL against
the pre-fix code and PASS against the fix -- they are real regression guards, not tautologies.
The 6 detection tests and the copyFileSync-skip test remain intact.

Build clean, full suite green (1335 passing), existing install.test.ts unchanged, file hygiene
clean, committed files ASCII-only. No new issues introduced and no scope creep.

**Verdict: APPROVED.** Phase 3 closes.
