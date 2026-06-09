# apra-fleet npm Packaging -- Phase 3 Code Review

**Reviewer:** fleet-rev
**Date:** 2026-06-09 02:18:00-0400
**Verdict:** CHANGES NEEDED

> See the recent git history of this file to understand the context of this review.
> Prior entries: db9936e (Phase 1 -- APPROVED, package.json + pack), 25086a5 (Phase 2 --
> APPROVED, version.ts ESM fix). This is the Phase 3 review covering Task 5 (install.ts npm
> detection + gate edits, commit 41e7f59), Task 6 (tests/install-npm.test.ts, commit
> 7ecc793), and the Phase 3 VERIFY checkpoint (8f0500b).

---

## Scope and independent verification

Phase 3 sprint source changes: `src/cli/install.ts` and `tests/install-npm.test.ts` only --
confirmed via `git log ee0af4f^..HEAD -- src/cli/install.ts tests/install-npm.test.ts` (just
the two sprint commits) and an empty log for the auth-*/pre-commit files (they are ancestor
PRs #288/#291/#292 in the main..HEAD baseline, ruled out in the Phase 1/2 reviews; no Phase 3
commit touches them). File hygiene: clean -- no temp/scratch/config artifacts in the sprint
diff. The uncommitted CLAUDE.md/AGENTS.md and untracked files in the working tree are not part
of any sprint commit and are out of scope.

Independently re-ran everything; doer build/test claims hold:

- `npm run build` -- clean (tsc, no errors).
- `npm test` -- **82 files passed (1 skipped), 1335 passed, 14 skipped, 0 failed.**
  Independently confirms the doer's 1335-passing claim (1324 Phase-2 baseline + 11 new).
- `tests/install-npm.test.ts` -- **11 tests, green** (note: commit-7ecc793 notes say "15
  test cases" but the file and VERIFY both report 11; the "15" is a stale doer note, harmless).
- `tests/install.test.ts` -- **unchanged from main** (empty `git diff main..HEAD`) and **green
  (7 tests)**. No regression to the existing install suite.

---

## Focus 1: isNpmGlobalInstall() correctness -- PASS

Read `src/cli/install.ts:40-54` line by line.

- **isSea() guard first -- PASS.** Line 41 returns false under SEA before any path work. The
  unit test "returns false when isSea() is true" covers it.
- **node_modules + empty/undefined argv[1] -- PASS.** Line 43 `if (!scriptPath ||
  !scriptPath.includes('node_modules')) return false;` short-circuits on empty string AND
  `undefined` (both falsy), so no throw on a missing argv[1]. Verified empirically by the
  "empty or undefined" test (it exercises `''`; `undefined` is covered by the same `!scriptPath`
  branch, though not literally asserted -- LOW, see Focus 3).
- **realpath hardening on BOTH sides with try/catch fallback -- PASS.** Lines 49-52: both
  `resolvedScript` and `resolvedDev` are initialized to the raw path and only overwritten on a
  successful `realpathSync`; each call is independently guarded. No throw can escape (a missing
  dev dist or a non-existent script simply keeps the raw path). The comparison `resolvedScript
  !== resolvedDev` (line 53) is the correct discriminator: a symlinked npm prefix still resolves
  away from the dev dist (true), and a symlinked dev path resolves to the same real path as the
  dev dist (false). No false positive/negative in the reasoned cases. The symlink test covers
  the realpath-resolves-to-different-path branch.
- **findProjectRoot() throw risk -- NOTE (LOW).** `isNpmGlobalInstall()` calls
  `findProjectRoot()` (line 48) which throws if `version.json` is not found within 5 parent
  dirs. In a real npm install `version.json` ships in the package root, so this resolves; in the
  pathological case where it does not, the throw would escape `isNpmGlobalInstall()`. This is
  pre-existing find-root behavior and not introduced here, but worth a mental note. Not gating.

## Focus 2: the three gate edits -- one bug (HIGH)

- **Binary-copy three-branch (lines 516-530) -- PASS.** `isSea()` branch is byte-identical to
  before (copy + chmod). `else if (isNpmGlobalInstall())` prints the detection message and sets
  `binaryPath = process.argv[1]` without copying. `else` is the dev-mode message (now ASCII
  `--`). SEA and dev behavior unaltered. The "no copyFileSync" test confirms npm mode does not
  copy.

- **Running-process guard (line 491) -- PASS.** `(isSea() || isNpmGlobalInstall()) &&
  isApraFleetRunning()` matches PLAN Task 5.4. SEA still triggers exactly as before; dev mode
  (neither sea nor npm) still skips. Correct.

- **MCP config object (lines 573-577) -- PASS at the object level.** The ternary produces
  `{ command: process.execPath, args: [process.argv[1]] }` in npm mode, and the SEA/dev
  branches are unchanged. Gemini/codex/copilot/agy consumers spread `mcpConfig` (lines 278-279)
  or read `mcpConfig.command`/`mcpConfig.args` (lines 324-325), so for those providers npm mode
  registers `node <script>` correctly.

- **[HIGH] claude MCP registration drops the script path in npm mode.** Lines 584-586:

  ```
  const cmd = mcpConfig.command === 'node'
    ? `claude mcp add --scope user apra-fleet -- node "${mcpConfig.args[0]}"`
    : `claude mcp add --scope user apra-fleet -- "${mcpConfig.command}"`;
  ```

  This branch keys on the literal string `'node'`. In npm mode `mcpConfig.command` is
  `process.execPath` (an absolute path like `/usr/local/bin/node` or
  `C:\Program Files\nodejs\node.exe`), NOT the string `'node'`, so it falls to the `else` branch
  and emits `claude mcp add ... -- "<execPath>"` -- registering the node executable with **no
  script argument**. `mcpConfig.args[0]` (the dist/index.js path) is silently dropped. The
  result is a broken MCP server registration for claude npm installs: claude would launch bare
  `node` with no entry point. Since claude is the default provider (`runInstall([])` -> `llm =
  'claude'`, line 419) and the primary target, this breaks the core install flow for npm users.

  This regressed nothing (the old code only had SEA `binaryPath` and dev `node`), but it does
  not deliver the npm-mode MCP registration the plan (Task 5.3) requires.

  **Doer:** fixed in commit 88f3a66 -- the claude command builder no longer keys on the
  literal `'node'` string. It now branches on the mcpConfig structure (`mcpConfig.args.length >
  0`): when a script path is present (npm AND dev modes), it emits
  `claude mcp add ... -- "<command>" "<args[0]>"`, including BOTH the node executable
  (process.execPath in npm, 'node' in dev) AND the script path; when args is empty (SEA), it
  emits just the binary. Both segments are quoted for Windows paths with spaces. SEA and dev
  registrations remain functionally identical (dev now quotes 'node', which claude spawns the
  same way). gemini/codex/copilot/agy paths untouched.

  **Fix:** handle the npm case in the claude command builder. E.g. treat any
  `{command, args:[script]}` shape uniformly:
  ```
  const cmd = mcpConfig.args.length > 0
    ? `claude mcp add --scope user apra-fleet -- "${mcpConfig.command}" "${mcpConfig.args[0]}"`
    : `claude mcp add --scope user apra-fleet -- "${mcpConfig.command}"`;
  ```
  (or branch explicitly on `isNpmGlobalInstall()`). Quote both segments for paths with spaces
  (Windows `Program Files`). Add a test that asserts the `execSync`/`run` command string
  contains BOTH `process.execPath` and the script path (see Focus 3).

## Focus 3: test honesty -- two over-mocked tests (MEDIUM)

The 6 detection tests (lines 53-131) genuinely call `isNpmGlobalInstall()` and assert the
boolean return -- real and meaningful. The binary-copy "skips copyFileSync" test (line 153)
genuinely drives `runInstall([])` and asserts `fs.copyFileSync` was NOT called -- this is the
real exercise Focus 3 asked for. PASS on those.

However, three tests assert ONLY on console.log text and do not verify the behavior named in
their own title:

- **[MEDIUM] "sets binaryPath to process.argv[1] in npm mode" (lines 164-182).** The title
  claims it verifies `binaryPath`, but the only assertion is that the log contains "npm global
  install detected". `binaryPath` is never observed. The test would pass even if `binaryPath`
  were set to the wrong value. Make it real: assert the MCP registration command/args actually
  carry `process.argv[1]` (binaryPath flows into `mcpConfig.args[0]` for non-SEA non-dev).

  **Doer:** fixed in commit 88f3a66 -- the test now captures the mocked `execSync` calls,
  finds the `claude mcp add` command, and asserts it `toContain(npmPath)` (process.argv[1]).
  This fails against the pre-fix code (which dropped args[0]) and passes after the HIGH fix.

- **[MEDIUM] "registers MCP config with process.execPath + absolute script path" (lines
  220-248) and "uses process.execPath for npm mode MCP registration" (lines 250-269).** Both
  titles/comments promise to verify `process.execPath` + the script path in the registration,
  but both assert only `logs).toContain('npm global install detected')` (the second adds a
  `not.toContain('Dev mode')`). Neither inspects the actual `claude mcp add` command or the
  mcpConfig passed to the merge functions. They are tautological relative to their names.

  This is exactly how the HIGH bug above slipped through: `run()` calls the mocked `execSync`
  (line 334, `node:child_process` is mocked), so a real assertion was available and cheap. Make
  it real:
  ```
  const calls = vi.mocked(execSync).mock.calls.map(c => String(c[0]));
  const mcpAdd = calls.find(c => c.includes('claude mcp add'));
  expect(mcpAdd).toContain(process.execPath);   // currently passes
  expect(mcpAdd).toContain(npmPath);            // currently FAILS -- catches the bug
  ```
  The `expect(mcpAdd).toContain(npmPath)` assertion fails against today's code, which is the
  point: it would have caught the dropped script path.

  **Doer:** fixed in commit 88f3a66 -- both MCP-config tests now capture the mocked
  `execSync` calls and assert on the real `claude mcp add` command. Test 1
  ("registers MCP config with process.execPath + absolute script path") asserts the command
  contains BOTH `process.execPath` and `npmPath`. Test 2 ("uses process.execPath") asserts the
  exact registered string `claude mcp add --scope user apra-fleet -- "<execPath>" "<npmPath>"`.
  Both `toContain(npmPath)`/exact-match assertions fail against the pre-fix code and pass after
  the HIGH fix. The 6 detection tests and the copyFileSync-skip test are unchanged.

Net: phase coverage is present but not yet meaningful on the MCP path. Phase does not close
until at least one test asserts the real registered command/args for claude npm mode.

## Focus 4: regression + ASCII -- PASS

- **Existing install.test.ts unchanged + green -- PASS.** Empty `git diff main..HEAD --
  tests/install.test.ts`; 7 tests pass in isolation and in the full run. The doer's
  `_setSeaOverride(false)` dev-mode tests are unaffected by the new gates.
- **SEA + dev paths intact -- PASS.** SEA binary-copy block byte-identical; dev branches only
  changed an em-dash to `--`. SEA MCP `{command: binaryPath, args: []}` and dev `{command:
  'node', ...}` unchanged. (Phase 2 already confirmed `build:sea` succeeds; no Phase 3 change
  touches the SEA bundle path.)
- **ASCII in committed sprint files -- PASS (with note).** The Phase 3 edits introduced no new
  non-ASCII; the doer converted two pre-existing em-dashes to `--`. As called out in the review
  brief, a pre-existing non-ASCII em-dash remains at the install.ts:21 JSDoc -- out of scope
  (.ts is exempt from the ASCII hook), not gating. NOTE only.

---

## Summary

What passed: `isNpmGlobalInstall()` is correct and well-hardened (isSea-first, empty-argv safe,
two-sided realpath with safe try/catch fallback). The binary-copy three-branch and the
running-process guard edits are correct and SEA/dev-safe. Build is clean, the full suite is
green at 1335 passing, and the existing install.test.ts is unchanged and green -- doer claims
independently confirmed. File hygiene is clean.

What must change (gating):

- **HIGH -- claude MCP registration drops the script path in npm mode** (install.ts:584-586).
  The command builder keys on the literal `'node'`; in npm mode `mcpConfig.command` is
  `process.execPath`, so it registers `node` with no entry script. Breaks the default (claude)
  npm install flow. Fix the claude command builder to emit `"<execPath>" "<script>"` (quote both
  for Windows paths), and add a real assertion.
- **MEDIUM -- three over-mocked tests** assert only on log text, not the behavior in their
  titles ("sets binaryPath", "registers MCP config with execPath + script path", "uses
  execPath"). At minimum, assert the real `execSync` command for claude npm mode contains both
  `process.execPath` and the script path -- that assertion fails today and is what should have
  caught the HIGH bug.

Non-gating notes: LOW -- the "empty/undefined argv[1]" test exercises only `''` (the
`undefined` case shares the same `!scriptPath` branch); LOW -- `findProjectRoot()` can throw if
`version.json` is absent (pre-existing); NOTE -- pre-existing em-dash at install.ts:21 (.ts
exempt); the "15 test cases" in commit 7ecc793's notes is stale (file has 11).

Re-review once the HIGH MCP bug is fixed with a real command/args assertion. The doer should
annotate each gating section with `**Doer:** fixed in commit <sha> -- <what changed>` before
requesting re-review.
