# Test Suite Audit Report
Generated: 2026-05-09

## Summary
- Files audited: 76
- Dead tests: 26
- Duplicate tests: 28
- Implementation-detail tests: 98
- Tests to add (coverage gaps): 12

## Findings by File

### tests/cost.test.ts
#### Implementation Details
- Line 35: "high-cost warning references dollar amount (consistent with COST_WARNING_THRESHOLD)" — asserts `COST_WARNING_THRESHOLD === 10` (literal constant value); regex assertion duplicates line 32
- Line 42: "returns rate warning for expensive instance types" — embeds `expect(RATE_WARNING_THRESHOLD).toBe(5)` (constant value assertion)
- Line 68: "returns anomaly warning for long sessions" — embeds `expect(UPTIME_WARNING_THRESHOLD_HRS).toBe(12)` (constant value assertion)

### tests/credential-validation.test.ts
#### Implementation Details
- Line 35: "returns near-expiry with 1 minute left" — tests internal `Math.ceil` rounding (`30s → minutesLeft: 1`), not a distinct behavioral case from the "at 59 minutes" test

### tests/crypto.test.ts
#### Implementation Details
- Line 41: "creates and reuses a per-installation key file" — reads internal `salt` file path directly, checks hex format — tests private key-storage internals, not observable encrypt/decrypt contract

### tests/git-config.test.ts
#### Dead
- Line 50: "saves with restrictive file permissions" — `if (process.platform !== 'win32') return;` makes the 0o600 assertion a no-op on Windows

### tests/github-app.test.ts
#### Implementation Details
- Line 56: "produces a verifiable RS256 signature" — generates two RSA key pairs that are never used; verifies signature using the signing key as its own verifier (internal mechanism, not API contract)

### tests/install-force.test.ts
#### Implementation Details
- Line 247: "killApraFleet calls pkill -x apra-fleet on Linux" — verifies exact `pkill -x apra-fleet` shell string rather than observable effect
- Line 255: "killApraFleet calls taskkill on Windows" — verifies exact `taskkill /F /IM apra-fleet.exe` shell string

### tests/install-multi-provider.test.ts
#### Implementation Details
- Line 337: "writes defaultModel for Claude (claude-sonnet-4-6) to settings.json" — tests the literal value of a config constant; breaks on intentional model renames
- Line 352: "writes defaultModel for Gemini (gemini-3-flash-preview) to settings.json" — same
- Line 366: "writes defaultModel for Codex (gpt-5.4) to config.toml" — same
- Line 402: "writes defaultModel for Copilot (claude-sonnet-4-5) to settings.json" — same
#### Duplicates
- Lines 418 + 441 + 549: "--skill alone" / "--skill all" / "bare install" — all three assert identical `mkdirSync` calls for both skill dirs
- Lines 572 + 587: "--skill none" / "--skill=none (equals form)" — identical assertions (no skill dirs created)
- Lines 464 + 503: "--skill fleet" / "--skill=fleet (equals form)" — identical assertions
- Lines 480 + 518: "--skill pm" / "--skill=pm (equals form)" — identical assertions
- Lines 619 + 633: "--help" / "-h" — `-h` test is a strict subset of `--help` test
- Lines 152 + 160: "errors on unsupported provider" / "errors on unsupported provider via space form" — identical exit-1 assertion

### tests/known-hosts.test.ts
#### Dead
- Line 109: "writes known_hosts file with mode 0o600" — `if (process.platform === 'win32') return;` makes the assertion a no-op on Windows

### tests/onboarding-text.test.ts
#### Implementation Details
- Line 13: "contains the ASCII art header line" — tests a literal substring of a UI string constant; breaks on copy/design changes
- Line 17: "contains the tagline" — same
- Line 21: "contains the separator lines" — same
- Line 27: "covers adding a member" — tests literal copy in a UI string constant
- Line 30: "covers giving it work with natural language examples" — same
- Line 34: "covers checking status" — same
- Line 37: "does not include the /pm step" — tests absence of specific text in a UI string constant

### tests/ssh-error-messages.test.ts
#### Implementation Details
- Line 43: "hook does not fire on SSH connection failure (❌ result)" — tests internal `❌` string-based gating in `getOnboardingNudge`; also placed in the wrong test file

### tests/task-wrapper.test.ts
#### Implementation Details
- Line 11: "output contains no python3 reference" — regression guard for internal command choice
- Line 17: "uses grep + cut to extract started timestamp" — verifies internal shell parsing technique, not observable outcome
- Line 23: "has fallback to date if started is empty" — verifies internal `[ -z ]` fallback string, not observable behavior
- Line 33: "MAIN_CMD and RESTART_CMD are same base64 when restartCommand is omitted" — checks internal base64-variable naming
- Line 41: "MAIN_CMD and RESTART_CMD are different when restartCommand is provided" — same
- Line 54: "first run uses MAIN_CMD" — checks internal bash variable name
- Line 60: "retry loop uses RESTART_CMD" — checks internal bash variable name

### tests/windows-credential-helper.test.ts
#### Implementation Details
- Line 7: "produces valid PowerShell without here-string delimiters" — regression guard for absent internal syntax (`@'...'@`)
- Line 43: "uses -join to build multi-line bat content" — checks internal PowerShell `-join` operator usage

### tests/unit/pid-wrapper.test.ts
#### Dead
- Line 72: "emits FLEET_PID as first stdout line before command output" (unixTest) — `it.skip` on Windows
- Line 81: "emitted PID is a positive integer" (unixTest) — `it.skip` on Windows
- Line 90: "propagates exit code 0 from successful inner command" (unixTest) — `it.skip` on Windows
- Line 95: "propagates non-zero exit code from inner command" (unixTest) — `it.skip` on Windows
#### Implementation Details
- Line 16: "uses a captured variable for the PID" — tests internal variable name `_fleet_pid`
- Line 20: "backgrounds the inner command in a subshell" — tests internal subshell-backgrounding mechanism
- Line 24: "waits for the background process" — tests `wait` string in script
- Line 28: "propagates exit code with exit $?" — tests `exit $?` string
- Line 31: "emits PID before wait in command order" — tests internal script ordering via `indexOf`
- Line 56: "places setup commands before ProcessStartInfo" — tests internal .NET class name ordering
#### Duplicates
- Lines 108 + 113: "returns kill -9 command with the given PID" / "works for PID 1" — same structural assertion, only integer differs
- Lines 120 + 124: "returns taskkill command with force and tree flags" / "includes /T to terminate child processes" — `/T` check is a strict subset

### tests/cloud-integration.test.ts
#### Implementation Details
- Line 232: "uses restart_command: wrapper script contains both base64-encoded commands" — calls `generateTaskWrapper` directly and asserts base64 string contents (internal encoding detail)

### tests/cloud-lifecycle.test.ts
#### Implementation Details
- Line 84: "calls ensureCloudReady even for non-cloud members (returns unchanged)" — asserts internal call pattern, not observable behavior

### tests/cloud-provider.test.ts
#### Implementation Details
- Lines 48–51, 76–83, 87–91, 99–110, 118–127: Multiple tests asserting `exec.mock.calls[1][0]` contains specific CLI substrings (`describe-instances`, `start-instances`, `stop-instances`, `--output text`, `--profile`) — pins exact shell command strings; breaks if implementation switches from CLI to SDK
- Line 173: "caches CLI check — only calls aws --version once across multiple operations" — counts internal raw exec calls to verify an optimization detail

### tests/credential-cleanup.test.ts
#### Implementation Details
- Line 75: "schedules a timer with default 55-minute TTL when no expiresAt" — peeks at internal `_getCleanupTimers()` Map
- Line 80: "schedules timer based on expiresAt" — identical internal map assertion
- Line 118: "cancels previous timer when re-provisioning same member" — compares internal `NodeJS.Timeout` object references
- Line 129: "multiple agents have independent timers" — asserts internal map size and membership
- Line 150: "cancels the timer and removes from map" — asserts internal map state instead of behavioral outcome
#### Duplicates
- Lines 75 + 80: Both assert only `_getCleanupTimers().has('member-1') === true` — identical observable assertion

### tests/credential-store-and-execute.test.ts
#### Duplicates
- Line 80: "credentialDelete removes from both session and persistent tiers (M1)" — the set/resolve/delete/verify-gone pattern is identical to "set, list, delete a session credential" (line 46); cannot test the claimed two-tier deletion because `credentialSet(name, ..., false, ...)` only writes to session tier

### tests/idle-manager.test.ts
#### Implementation Details
- Line 130: "is wired into touchAgent via setIdleTouchHook" — extracts internal mock call to verify hook registration; final assertion `typeof hookFn === 'function'` is trivially true
- Line 90: "R-9: preloads lastActivity from registry so recently-active members are not stopped" — test name references private field `lastActivity`; assertions are behavioral but design is oriented around internal mechanism

### tests/integration.test.ts
#### Dead
- Entire file: No vitest `describe`/`it` blocks; excluded from vitest config via `exclude: ['tests/integration.test.ts']`; requires live SSH infrastructure. This is a script-style e2e harness, not a vitest test file.

### tests/integration/session-lifecycle.test.ts
#### Dead
- Line 141: "returns fallback with actual member name when DISPLAY is unset on Linux" — bare `if (process.platform !== 'linux') return;` — never fires on Windows
- Line 170: "does not return the headless-display fallback when DISPLAY is set on Linux" — same
- Line 192: "returns fallback on macOS when SSH_TTY is set" — bare `if (process.platform !== 'darwin') return;` — never fires on Windows

### tests/log-helpers.test.ts
#### Implementation Details
- Line 60: "field order: ts, level, tag, msg (no mid/mem/pid when omitted)" — asserts exact JSON key insertion order (`Object.keys(lines[0]).toEqual([...])`) which is an internal formatting detail

### tests/onboarding.test.ts
#### Dead
- Line 128: "writes onboarding.json with 0o600 permissions (owner-only, non-Windows)" — bare `if (process.platform === 'win32') return;` makes it a no-op on Windows
#### Duplicates
- Lines 177 + 183: "returns true for unset milestones" / "returns false for set milestones" — already fully covered by `advanceMilestone` describe block (lines 146–152)

### tests/provision-auth.test.ts
#### Implementation Details
- Line 172: "prompts OOB when api_key is absent for non-OAuth provider" — `expect(mockCollectOobApiKey).toHaveBeenCalledWith(...)` verifies internal OOB dispatch mechanism rather than observable outcome

### tests/provision-vcs-auth.test.ts
#### Implementation Details
- Line 288: "github: pat mode prompts OOB when token is absent" — asserts `expect(mockCollectOobApiKey).toHaveBeenCalledWith(...)` (internal OOB dispatch)
- Line 305: "bitbucket: prompts OOB when api_token is absent" — same
- Line 323: "azure-devops: prompts OOB when pat is absent" — same

### tests/remove-member-decomm.test.ts
#### Implementation Details
- Line 93: "calls cancelCredentialCleanup before removing" — verifies a specific private service function was invoked
- Line 102: "revokes VCS auth for remote member with vcsProvider" — asserts internal `revoke()` method was called rather than observable `✅` result
- Line 128: "attempts authorized_keys cleanup for remote member with keyPath" — verifies internal command list sent to `mockExecCommand`

### tests/revoke-vcs-auth.test.ts
#### Implementation Details
- Lines 44–58: "github/bitbucket/azure-devops: revokes credentials successfully" — assert exact internal shell command content (`fleet-git-credential`, `credential.https://`)
- Line 61: "revoke with label targets only that label credential file" — asserts internal file-naming conventions in shell commands
- Line 75: "revoke without label defaults to provider-named label" — verifies internal default label naming in generated command

### tests/security-hardening.test.ts
#### Dead
- Line 18: "writes registry with mode 0o600 (non-Windows)" — bare `if (process.platform === 'win32') return;` makes it a no-op on Windows
#### Implementation Details
- Line 295: "Linux: generates proper commands with escapeShellArg" — verifies internal shell command string formats
- Line 309: "Linux: escapes single quotes in key comments" — same
- Line 319: "Windows: generates proper commands" — same
- Line 335: "Windows: escapes single quotes in key" — same

### tests/strategy.test.ts
#### Implementation Details
- Line 132: "execCommand() passes windowsHide:true to spawn to suppress cmd.exe flashes on Windows" — reads the TypeScript source file and checks that string `windowsHide: true` appears in source text (source-code inspection test, not behavioral)

### tests/tool-provider.test.ts
#### Implementation Details
- Lines 171–186: "provisions claude/gemini/codex/copilot API key using correct env var" — verifies internal shell command strings contain provider's auth env var name
- Line 219: "uses gemini version command when member is gemini provider" — asserts `gemini` appears in internal command strings

### tests/unattended-mode.test.ts
#### Implementation Details
- Line 205: "does NOT pass --dangerously-skip-permissions when dangerously_skip_permissions=true but member.unattended=false" — asserts internal CLI command string content
- Line 228: "passes --dangerously-skip-permissions when member.unattended='dangerous'" — same
- Line 250: "passes --permission-mode auto when member.unattended='auto'" — same

### tests/vcs-auth.test.ts
#### Implementation Details
- Line 42: "deploy: github-app mode mints token and writes credential helper" — verifies exact internal shell command strings (`github.com`, `x-access-token`)
- Line 63: "deploy: pat mode deploys token directly without minting" — verifies token in internal command and asserts `mockMint` not called
- Lines 179–259: Multiple tests in "Multi-label credential isolation" — all assert `execCalls[N].toContain(...)` checking internal shell command strings for file naming patterns

### tests/execute-command.test.ts
#### Implementation Details
- Line 39: "wraps command with work folder" — asserts exact call signature of `mockExecCommand` including positional `undefined` (for `maxTotalMs`)
- Line 53: "uses custom run_from when provided" — same; any argument reordering breaks these tests

### tests/receive-files.test.ts
#### Dead
- Lines 6 + 11: `vi.mock('../src/services/registry.js')` and `registry` import — dead mock; `receive-files.ts` doesn't import `registry` directly
#### Implementation Details
- Line 58: "Remote member: downloads via SFTP" — verifies internal SFTP function is invoked with exact arguments through two layers of private delegation

### tests/windows-pid-wrap.test.ts
#### Implementation Details
- Line 34: "contains ProcessStartInfo" — checks internal .NET API class name in generated script
- Line 38: "contains UseShellExecute = $false" — checks internal PowerShell flag
- Line 42: "does not contain Start-Process" — checks absence of internal cmdlet
- Line 46: "launches via [System.Diagnostics.Process]::Start" — checks internal .NET method call
- Line 50: "contains WaitForExit" — checks internal .NET method
- Line 54: "contains exit $_fleet_proc.ExitCode" — checks internal variable and property
- Line 58: "uses $_fleet_proc as the process variable" — checks internal variable name
- Line 147: "uses direct shell execution to launch the claude executable" — checks internal `FLEET_PID:$pid` format
#### Duplicates
- Lines 72 + 77 + 82: "does not contain FLEET_PID:$PID in buildAgentPromptCommand" for unattended=false/auto/dangerous — all three make the same assertion; PID format doesn't vary with unattended flag

### tests/compose-permissions.test.ts
#### Implementation Details
- All tests in "Claude proactive", "Gemini proactive", "Codex proactive", "Copilot proactive", "Claude reactive grant", "Gemini reactive grant" describe blocks — assertions check `allCmds.filter(cmd => cmd.includes('cat >'))` and inspect shell command string content. Pins exact format of shell commands sent to `mockExecCommand`.
- Line 446: "does not crash when permissions.json exists but contains only {}" — uses `vi.spyOn(fs, 'existsSync')` with complex conditional mock tightly coupled to internal `findProfilesDir()` candidate paths

### tests/sftp-path-resolution.test.ts
#### Dead
- Lines 15–96: Entire file (6 tests) — imports nothing from `src/`. Tests `path.posix.resolve` from Node.js stdlib to document an old bug. The bug is already fixed in `src/utils/platform.ts` (`resolveRemotePath`). Does not exercise the fix.

### tests/update-check.test.ts
#### Dead
- Line 159: "compact output includes update notice when update available" — imports `fleetStatus` but never calls it; only calls `getUpdateNotice()` which is already fully covered by other tests in the same file

### tests/read-log-tail.test.ts
#### Implementation Details
- Line 58: "calls logLine before issuing execCommand" — asserts internal log tag string `'stall_log_read'`
- Line 67: "calls execCommand with tail command and 5000ms timeout" — asserts exact shell string `tail -c 512`

### tests/stall-detector.test.ts
#### Implementation Details
- Line 115: "start sets interval" — spies on `global.setInterval` and asserts it was called; pins internal scheduling mechanism

### tests/stall-poller.test.ts
#### Implementation Details
- Line 127: "uses tail -c 500 on Unix" — asserts exact shell command `tail -c 500`
- Line 136: "uses PowerShell Get-Content -Tail on Windows" — asserts exact PowerShell command string

### tests/auth-socket.test.ts
#### Dead
- Line 26: "returns a path under FLEET_DIR on non-Windows" — body gated `if (process.platform !== 'win32')`, zero assertions on Windows
- Line 210: "cleans up socket file on close" — all meaningful assertions inside `if (process.platform !== 'win32')`, zero assertions on Windows
- Line 557: "returns fallback with member name on Linux when DISPLAY is unset" — `if (process.platform !== 'linux') return;`, zero assertions on Windows
- Line 568: "returns fallback with member name on Windows when SESSIONNAME is not Console" — `if (process.platform !== 'win32') return;`, zero assertions on non-Windows
- Line 578: "returns fallback with actual member name substituted (not a placeholder)" — `if (process.platform !== 'linux') return;`, zero assertions on Windows

### tests/providers.test.ts
#### Implementation Details
- Line 26: "has correct metadata" (ClaudeProvider) — asserts literal constant values of `name`, `processName`, `authEnvVar`, `credentialPath`, `instructionFileName`
- Line 204: "has correct metadata" (GeminiProvider) — same
- Line 389: "has correct metadata" (CodexProvider) — same
- Line 500: "has correct metadata" (CopilotProvider) — same
- Line 700: "member without llmProvider uses ClaudeProvider" — tests `undefined ?? 'claude'` written inside the test body, not any src function; already covered by `getProvider factory` tests
#### Duplicates
- Lines 149 + 154: "maps model tiers" / "modelTiers() returns cheap/standard/premium mapping" (ClaudeProvider) — `modelForTier(tier)` and `modelTiers()[tier]` must return the same string by definition
- Lines 323 + 326: Same pair for GeminiProvider
- Lines 441 + 444: Same pair for CodexProvider
- Lines 592 + 595: Same pair for CopilotProvider

### tests/secret-cli.test.ts
#### Dead
- Line 355: "exits 1 for invalid name" (under `--update`) — passes `'bad-name'` expecting rejection, but `NAME_REGEX = /^[a-zA-Z0-9_-]{1,64}$/` accepts hyphens. Test expectation contradicts actual src regex.

## Coverage Gaps

### src/tools/credential-store-set.ts — no test file exists
The entire file was rewritten. No `tests/credential-store-set.test.ts` exists. Key paths to cover:
- `collectOobApiKey` call and fallback handling (line 25–28)
- `decryptPassword` on the received password (line 30)
- `members` parsing: `'*'` stays as `'*'`, otherwise comma-split with trim/filter (lines 31–33)
- `credentialSet` call with all parameters including `ttl_seconds` (line 34)
- `logLine` called after successful store (line 35)
- Success message format with `meta.name`, `meta.scope`, `{{secure.NAME}}` hint (line 36)
- Error path when no password received (line 28)

### src/cli/secret.ts — -y flag (nonInteractive mode)
- Line 175: `-y` flag sets `nonInteractive = true`
- Lines 191–210: When `-y` is set, reads from `process.stdin` directly (data chunks, trims, exits 1 if empty)
- No test covers the `-y` / `nonInteractive` stdin-reading path

### src/services/auth-socket.ts — 500ms grace period
- Lines 354–368: When the cancellation promise resolves `null` (terminal exited code 0), a 500ms `Promise.race` determines if the password arrived in time
- The 500ms timeout → fallback path is not covered by any test
- The detached cleanup logic (lines 364–366) in the catch block is not tested

### src/tools/provision-auth.ts — logLine post-success placement
- Lines 258, 265, 275: `logLine` is only called when `!result.startsWith('❌')`
- No test verifies that `logLine` is NOT called on failure, or that it IS called on success with the correct arguments

## Recommended Additions

### 1. tests/credential-store-set.test.ts (new file)
- **"returns fallback message when OOB terminal is unavailable"** — mock `collectOobApiKey` to return `{ fallback: 'no terminal' }`, verify the fallback string is returned
- **"returns error when no password received"** — mock `collectOobApiKey` to return `{}` (no password, no fallback), verify error message
- **"decrypts password and stores credential with correct parameters"** — mock `collectOobApiKey` to return `{ password: encryptedValue }`, verify `decryptPassword` called, `credentialSet` called with `(name, plaintext, persist, network_policy, allowedMembers, ttl_seconds)`
- **"parses members='*' as wildcard"** — pass `members: '*'`, verify `credentialSet` called with `'*'`
- **"parses comma-separated members list"** — pass `members: 'alice, bob, ,charlie'`, verify `credentialSet` called with `['alice', 'bob', 'charlie']`
- **"returns success message with name, scope, and secure template hint"** — verify returned string contains `name`, scope indicator, and `{{secure.NAME}}`
- **"calls logLine after successful store"** — verify `logLine('credential_store_set', ...)` called after `credentialSet`
- **"schema validates name regex"** — pass names with invalid characters, verify zod parse fails
- **"schema enforces positive ttl_seconds"** — pass `ttl_seconds: 0` and `ttl_seconds: -1`, verify zod parse fails

### 2. tests/secret-cli.test.ts — -y flag coverage
- **"reads secret from stdin when -y is passed"** — mock `process.stdin` with a readable stream that emits data, verify `credentialSet` or socket delivery receives the value
- **"exits 1 when -y is passed but stdin is empty"** — mock `process.stdin` that emits empty string, verify `process.exit(1)` called
- **"does not call collectSecret() when -y is passed"** — verify the interactive prompt is bypassed

### 3. tests/auth-socket.test.ts — 500ms grace period
- **"returns password when it arrives within 500ms of terminal exit"** — simulate terminal close (code 0), deliver password within 500ms, verify password returned
- **"returns fallback when no password arrives within 500ms of terminal exit"** — simulate terminal close (code 0), do not deliver password, verify fallback returned after 500ms
- **"cleans up waiter and pendingRequests on 500ms timeout"** — after timeout, verify `passwordWaiters` and `pendingRequests` are cleaned up

## Clean Files (no findings)

The following 26 files had no issues:

- tests/credential-store-update.test.ts
- tests/gpu-parser.test.ts
- tests/setup-git-app.test.ts
- tests/shell-escape.test.ts
- tests/task-cleanup.test.ts
- tests/activity.test.ts
- tests/agent-detail.test.ts
- tests/agent-helpers.test.ts
- tests/auth-env.test.ts
- tests/cloud-lifecycle-unit.test.ts
- tests/credential-scoping-ttl.test.ts
- tests/defensive-ux.test.ts
- tests/integration/pid-lifecycle.test.ts
- tests/platform.test.ts
- tests/prompt-errors.test.ts
- tests/registry.test.ts
- tests/send-files-collision.test.ts
- tests/statusline.test.ts
- tests/update-member.test.ts
- tests/file-transfer-matrix.test.ts
- tests/fleet-status-branch.test.ts
- tests/stop-prompt.test.ts
- tests/execute-prompt.test.ts
- tests/find-log-file.test.ts
- tests/gemini-mcp-exclude.test.ts
- tests/install.test.ts
- tests/log-path-resolver.test.ts
- tests/stall-detector-integration.test.ts
- tests/time-utils.test.ts
- tests/uninstall.test.ts
- tests/update.test.ts
- tests/credential-store-path.test.ts
- tests/register-member-oob.test.ts
