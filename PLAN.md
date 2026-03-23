# PR #1 Fixes — Implementation Plan

**Requirements**: `requirements.md`
**Progress**: `progress.json`
**Created**: 2026-03-23
**Branch**: `feature/cloud-compute` (additional commits on same PR)

## Context

All original 19 tasks are COMPLETE. A PR review identified 10 improvement items + 8 test gaps.
The user reported 6 additional bugs/issues (U1-U6). This plan addresses all must-fix and should-fix items.

## Requirements Coverage

| Requirement | Task(s) | Priority |
|---|---|---|
| U5/PR#3: Task ID validation + security audit (incl. credential leakage, config validation) | T1 | Must-fix |
| PR#5: AWS CLI timeout (15s) | T2 | Should-fix |
| U3/PR#6: Remove python3 dependency | T3 | Must-fix |
| PR#1: Test restart_command retry path | T4 | Must-fix |
| PR#2: Test F5 auth re-provisioning | T4 | Must-fix |
| U1: Pricing UX improvements (incl. start/stop anomaly detection) | T5 | Must-fix |
| U4: Custom workload detection | T6 | Must-fix |
| PR#4: Extract GPU utilization parser | T6 | Should-fix |
| U6: Defensive UX for unsupported scenarios (incl. unsupported provider warning) | T7 | Must-fix |
| U2: OS support documentation + handling | T7 | Should-fix |

---

## Phase 1: Security Hardening

### T1 — Task ID validation + credential leakage audit + cloud config validation

**Files**: `src/tools/monitor-task.ts`, `src/tools/execute-command.ts`, `src/services/cloud/lifecycle.ts`,
`src/services/cloud/aws.ts`, `src/tools/register-member.ts`, `tests/security-hardening.test.ts`

**What**:
1. **Task ID validation**: Add task_id regex validation to `monitorTaskSchema`:
   `z.string().regex(/^task-[a-z0-9]{4,20}$/)`
2. Add shared `validateTaskId(id: string)` function (or inline Zod regex — keep it simple)
3. Audit all `${taskDir}` and `${input.task_id}` interpolations in `monitor-task.ts` — currently 4 shell
   interpolation sites (lines 30, 34, 36, 42) where unvalidated task_id goes into commands like
   `cat ${taskDir}/status.json`. With regex validation on the schema, path traversal
   (`../../../etc/passwd`) and shell injection (`; rm -rf /`) are blocked at the Zod layer
4. In `execute-command.ts`, the task ID is auto-generated (`task-` + `Date.now().toString(36)`),
   which always matches the regex. Add a comment noting this. Also validate in the launch path
   for defense-in-depth

5. **Credential leakage audit (U5)**: Review all error messages and log statements in cloud files
   for credential/secret exposure:
   - `lifecycle.ts`: `reProvisionAuth` catch blocks (lines 43, 59) log `err.message` —
     verify provisionAuth/provisionVcsAuth don't include tokens in thrown error messages.
     If they do, truncate to first 50 chars in the log line
   - `aws.ts`: `getInstanceDetails` catch (line 125) logs raw stdout — redact if it could
     contain sensitive fields. Currently it's a JSON parse error which is safe (no credentials)
   - `cloud-control.ts`: error messages use `err.message` — already safe (AWS CLI errors
     don't contain credentials)
   - Add a test: provisionAuth error message is logged but does not contain mock credential strings

6. **Cloud config input validation (U5)**: In `register_member`, add Zod validation for
   cloud config fields beyond what already exists:
   - `cloud_region`: `z.string().regex(/^[a-z]{2}-[a-z]+-\d+$/)` (already validated in aws.ts
     `validateRegion`, but add at schema level too for early rejection)
   - `cloud_instance_id`: `z.string().regex(/^i-[0-9a-f]{8,17}$/)` (already validated in aws.ts
     `validateInstanceId`, but add at schema level too)
   - `cloud_idle_timeout_min`: `z.number().min(1).max(1440)` (1 min to 24 hours)
   - `cloud_ssh_key_path`: `z.string().min(1)` (already exists, verify non-empty)

7. Add tests to `security-hardening.test.ts`:
   - Valid task IDs pass schema validation
   - Path traversal attempts rejected (`../../../etc/passwd`)
   - Shell injection rejected (`; rm -rf /`, `$(whoami)`, `` `id` ``)
   - Empty string rejected
   - Overly long task IDs rejected
   - Invalid cloud_region rejected at schema level
   - Invalid cloud_instance_id rejected at schema level
   - cloud_idle_timeout_min out of range rejected

**Done when**:
- `monitorTaskSchema.parse({ member_id: 'x', task_id: '../../../etc/passwd' })` throws ZodError
- `monitorTaskSchema.parse({ member_id: 'x', task_id: 'task-abc123' })` succeeds
- Cloud config fields validated at schema level (region regex, instance ID regex, timeout range)
- Error logs audited — no credential strings in log output
- All existing tests pass
- 8+ new security tests pass

**Risks**: Adding schema-level validation for cloud config duplicates the runtime validation in
aws.ts. This is intentional defense-in-depth — schema validation gives better error messages
and catches issues before any AWS CLI call. See Risk Register R-3.

### T2 — AWS CLI call timeout

**Files**: `src/services/cloud/aws.ts`, `tests/cloud-provider.test.ts`

**What**:
1. Add constant: `const AWS_CLI_TIMEOUT_MS = 15_000` (15 seconds)
2. Add `{ timeout: AWS_CLI_TIMEOUT_MS }` to all `this.run()` calls that don't already have a timeout:
   - `getInstanceState` (line 63)
   - `startInstance` (line 75)
   - `stopInstance` (line 81)
   - `getPublicIp` (line 106)
   - `getInstanceDetails` (line 119)
3. Keep existing 300s timeout on `waitForRunning`/`waitForStopped` — those are intentionally long
4. Update existing tests: verify timeout option is passed in exec calls
5. Add test: timeout option present in getInstanceDetails call

**Done when**:
- All 5 non-wait AWS CLI calls pass `{ timeout: 15_000 }`
- `waitForRunning`/`waitForStopped` still pass `{ timeout: 300_000 }`
- Tests verify the timeout values
- All existing tests pass

**Risks**: See Risk Register R-6. 15s could be tight for slow AWS regions, but it's strictly better
than no timeout (infinite hang on network issues). The constant is named for easy tuning.

### V1: VERIFY
Build succeeds. All tests pass. Security tests cover task ID validation. AWS CLI calls have timeouts.

---

## Phase 2: Task Wrapper Fix + Test Gaps

### T3 — Remove python3 dependency from task wrapper

**Files**: `src/services/cloud/task-wrapper.ts`, tests

**What**:
1. In `generateTaskWrapper()`, replace the `python3` call in `update_status()` (line 70):
   ```bash
   # BEFORE (python3 dependency):
   started=$(python3 -c "import json; d=json.load(open('$TASK_DIR/status.json')); print(d.get('started',''))" 2>/dev/null || date -u +%Y-%m-%dT%H:%M:%SZ)

   # AFTER (pure bash — grep + cut):
   started=$(grep -o '"started":"[^"]*"' "$TASK_DIR/status.json" 2>/dev/null | head -1 | cut -d'"' -f4)
   [ -z "$started" ] && started=$(date -u +%Y-%m-%dT%H:%M:%SZ)
   ```
   This works because we control the JSON format — it's single-line with known keys, produced by
   our own `write_status` function using `printf`. No arbitrary JSON to parse.
2. Add unit test: `generateTaskWrapper()` output contains no `python3` reference
3. Add unit test: the `update_status` bash function correctly preserves the `started` timestamp
   (verify the grep/cut pattern extracts the ISO timestamp correctly)

**Done when**:
- `generateTaskWrapper()` output contains zero occurrences of `python3`
- The `update_status` function uses `grep` + `cut` to extract the started timestamp
- Fallback to `date` if status.json is missing or malformed
- All existing tests pass + new wrapper tests pass

**Risks**: See Risk Register R-2. grep/cut is fragile for arbitrary JSON, but we control the exact
format (`write_status` uses `printf` with `date -u` which never produces escaped quotes). The
fallback to `date` handles edge cases (missing file, corrupted JSON). If someone later changes the
JSON format, the grep pattern would need updating — but that would be caught by the test.

### T4 — Unit tests for restart_command retry + F5 re-provisioning

**Files**: `tests/task-wrapper.test.ts` (new), `tests/cloud-lifecycle-unit.test.ts` (new)

**What**:
1. **restart_command retry test (PR#1)** in `task-wrapper.test.ts`:
   - Call `generateTaskWrapper({ command: 'python train.py', restartCommand: 'python train.py --resume ckpt.pt', ... })`
   - Verify MAIN_CMD and RESTART_CMD are different base64 strings in the generated script
   - Verify the first run uses `$MAIN_CMD` (line starting with `bash -c "$MAIN_CMD"`)
   - Verify the retry loop uses `$RESTART_CMD` (line starting with `bash -c "$RESTART_CMD"`)
   - Verify when `restartCommand` is omitted, both MAIN_CMD and RESTART_CMD are the same base64

2. **F5 re-provisioning test (PR#2)** in `cloud-lifecycle-unit.test.ts`:
   - Mock: `awsProvider` (getInstanceState→'stopped', startInstance, waitForRunning, getPublicIp→'1.2.3.4')
   - Mock: `net.createConnection` for SSH poll (resolve immediately)
   - Mock: `provisionAuth` and `provisionVcsAuth`
   - Call `ensureCloudReady(stoppedCloudAgent)`
   - Verify call order: startInstance → waitForRunning → getPublicIp → SSH poll → provisionAuth → provisionVcsAuth
   - Verify provisionAuth is called with `{ member_id: agent.id }`
   - Verify provisionVcsAuth is called with agent's gitAccess + gitRepos
   - Verify provisionVcsAuth is NOT called when agent has no gitRepos
   - Verify re-provision failures are logged but don't throw (best-effort)

**Done when**:
- task-wrapper.test.ts: 4+ tests covering restart_command behavior
- cloud-lifecycle-unit.test.ts: 4+ tests covering F5 re-provisioning
- All existing tests still pass

**Risks**: The lifecycle unit test requires mocking multiple modules (aws, registry, net,
provision-auth, provision-vcs-auth). Complex mock setup but follows the pattern established
in cloud-integration.test.ts.

### V2: VERIFY
Build succeeds. All tests pass. No `python3` in wrapper output. Restart_command + F5 re-provision
have dedicated unit tests.

---

## Phase 3: UX Improvements

### T5 — Pricing UX enhancements

**Files**: `src/services/cloud/cost.ts`, `src/tools/cloud-control.ts`, `src/tools/check-status.ts`, tests

**What**:
1. Add named constants and functions to `cost.ts`:
   ```typescript
   /** Threshold constants — named for easy tuning and test reference */
   export const COST_WARNING_THRESHOLD = 10;       // dollars — warn if session cost exceeds this
   export const RATE_WARNING_THRESHOLD = 5;         // $/hr — warn if hourly rate exceeds this
   export const UPTIME_WARNING_THRESHOLD_HRS = 12;  // hours — flag sessions longer than this
   ```
   - `costWarning(instanceType: string | undefined, uptimeHours: number): string | null`
     Returns warning string if:
     - Estimated cost > `COST_WARNING_THRESHOLD`: `"High cost: $XX.XX this session"`
     - Hourly rate > `RATE_WARNING_THRESHOLD`: `"Expensive instance: $X.XX/hr"`
     - Instance type not in pricing table: `"Unknown pricing for instance type 'X'"`
     Returns null if no warning.
   - `isKnownInstanceType(type: string): boolean` — export for use in defensive UX
   - `uptimeWarning(uptimeHours: number): string | null` — returns warning if uptime exceeds
     `UPTIME_WARNING_THRESHOLD_HRS`, which may indicate a start/stop detection anomaly:
     `"Long session: Xh — verify idle detection is working correctly"`

2. **Start/stop anomaly indication (U1)**: In `cloud_control status` output, detect and flag
   anomalies:
   - If uptime > `UPTIME_WARNING_THRESHOLD_HRS`: append `"⚠ Long session — check idle detection"`
   - If instance is running but `lastUsed` is >2h old and idle manager hasn't stopped it:
     append `"⚠ Instance running but no recent activity — idle manager may not be active"`
   These heuristics don't catch all anomalies but surface the most common case (instance left
   running when it should have been auto-stopped).

3. Enhance `cloud_control status` output (cloud-control.ts):
   - Add hourly rate line: `rate: $1.212/hr`
   - Add cost warning line if applicable: `warning: High cost: $15.50 this session`
   - Add anomaly warning if applicable (from point 2 above)
   - Current output has `est cost: $X.XX` — keep it, add rate + warnings

4. Enhance `fleet_status` compact output (check-status.ts):
   - Add hourly rate in cloud info: `[cloud:running g5.2xlarge 7m $0.15 @$1.21/hr]`
   - Add warning indicator for high cost: `[cloud:running g5.2xlarge 7m $0.15 @$1.21/hr ⚠]`

5. Add unit tests for `costWarning`, `uptimeWarning`, and `isKnownInstanceType`:
   - Known instance type, low cost → null
   - Known instance type, high cost → warning string referencing `COST_WARNING_THRESHOLD`
   - Unknown instance type → warning string
   - Expensive instance type → rate warning referencing `RATE_WARNING_THRESHOLD`
   - Short uptime → null
   - Long uptime (>12h) → anomaly warning referencing `UPTIME_WARNING_THRESHOLD_HRS`

**Done when**:
- `costWarning('g5.2xlarge', 20)` returns high-cost warning (20h * $1.21 = $24.24)
- `costWarning('unknown.type', 1)` returns unknown-pricing warning
- `costWarning('t3.micro', 1)` returns null (low cost, known type)
- `uptimeWarning(15)` returns long-session anomaly warning
- `uptimeWarning(2)` returns null
- `cloud_control status` output includes rate, cost warnings, and anomaly indicators
- `fleet_status` compact shows rate in cloud bracket with warning indicator
- Thresholds are named constants, not inline magic numbers
- Tests pass for all new functions

**Risks**: See Risk Register R-4 for threshold tuning considerations.

### T6 — Custom workload detection + GPU parser extraction

**Files**: `src/services/cloud/types.ts`, `src/services/cloud/activity.ts`, `src/tools/register-member.ts`,
`src/tools/update-member.ts`, `src/utils/gpu-parser.ts` (new), `src/tools/monitor-task.ts`,
`src/tools/check-status.ts`, `tests/activity.test.ts`, tests

**What**:
1. **GPU parser extraction (PR#4)**: Create `src/utils/gpu-parser.ts` with:
   ```typescript
   export function parseGpuUtilization(stdout: string): number | undefined {
     const trimmed = stdout.trim();
     const parsed = parseInt(trimmed, 10);
     return isNaN(parsed) ? undefined : parsed;
   }
   ```
   Replace inline `parseInt` + `isNaN` checks in `monitor-task.ts` (line 63) and
   `check-status.ts` (lines 117-119) with this helper.

2. **Custom activity command**: Add optional field to `CloudConfig`:
   ```typescript
   activityCommand?: string;  // custom shell command: outputs "busy" or "idle"
   ```

3. In `register_member` and `update_member` schemas: add `cloud_activity_command?: z.string().optional()`

4. In `checkMemberActivity` (activity.ts): after GPU check and before process check, if
   `agent.cloud?.activityCommand` is set, run it via strategy.execCommand:
   - If stdout.trim() === 'busy' and exit code 0 → return 'busy-process'
   - Otherwise continue to existing process check
   This allows users to detect CPU-intensive tasks, download tasks, or any arbitrary workload.

5. Tests:
   - `parseGpuUtilization` unit tests (valid number, empty, non-numeric, whitespace)
   - `checkMemberActivity` with custom activityCommand returning 'busy' → returns 'busy-process'
   - `checkMemberActivity` with custom activityCommand returning 'idle' → falls through
   - `checkMemberActivity` with custom activityCommand failing → falls through (defensive)

**Done when**:
- GPU parsing extracted to shared helper, used by monitor-task + check-status
- `checkMemberActivity` runs custom `activityCommand` when configured
- Registration accepts `cloud_activity_command` parameter
- 6+ new tests pass

**Risks**: Custom activity command runs on the remote member, same trust level as execute_command.
No additional security concern — the user already has shell access to the member. The command
should be validated to be non-empty if provided, but no further sanitization needed since it
runs on the member (not the PM). See Risk Register R-1 for the critical timeout requirement —
the activityCommand call MUST use `ACTIVITY_TIMEOUT_MS` (5s) to prevent a hanging command from
blocking the idle manager's check loop.

### V3: VERIFY
Build succeeds. All tests pass. Pricing warnings shown in cloud_control + fleet_status.
Custom activity command works end-to-end. GPU parser extracted.

---

## Phase 4: Defensive UX + OS Support

### T7 — Defensive UX for unsupported scenarios + OS support handling

**Files**: `src/tools/register-member.ts`, `src/tools/cloud-control.ts`, `src/tools/execute-command.ts`,
`docs/cloud-compute.md`, tests

**What**:
1. **OS support warning (U2)**: In `register_member`, when `cloud_provider` is set and OS is not
   'linux' (or is unset), append a warning to the success message:
   `"Note: Cloud features (GPU detection, task wrapper, activity monitoring) are designed for Linux. Some features may not work on [os]."`
   Cloud registration still succeeds — this is a warning, not a block.

2. **Missing tools note (U6)**: In `cloud_control status` action (`cloud-control.ts`, lines 45-66),
   add a GPU utilization check after the existing `getInstanceDetails` call. Specifically:
   - After line 47 (`const details = await awsProvider.getInstanceDetails(agent.cloud)`), if
     `details.state === 'running'`, call `strategy.execCommand(cmds.gpuUtilization(), 10000)`
     inside a try/catch
   - **nvidia-smi not found**: `gpuUtilization()` (defined in `linux.ts:199-201`) returns an
     empty string when nvidia-smi is unavailable (the `2>/dev/null` suppresses the error).
     So: if `stdout.trim() === ''` → display `gpu: n/a (nvidia-smi not found)`
   - **nvidia-smi returns 0%**: `stdout.trim()` will be `'0'` — a valid numeric string.
     `parseGpuUtilization()` (from T6) returns `0` → display `gpu: 0%`
   - **nvidia-smi returns valid utilization**: e.g. `stdout.trim()` is `'45'` →
     `parseGpuUtilization()` returns `45` → display `gpu: 45%`
   - **SSH/strategy error**: the try/catch catches any error from `strategy.execCommand` →
     display `gpu: n/a (check failed)` — this covers cases like SSH timeout or agent offline
   - If instance is not running, skip the GPU check entirely (no SSH available)

3. **Unknown instance type (U6)**: Already covered by T5's `costWarning` for pricing. In
   `cloud_control status`, surface the warning from `costWarning()` which already flags unknown types.

4. **Unsupported provider warning (U6)**: In `register_member`, if a user sets `cloud_provider`
   to any value, validate it is `'aws'`. The Zod schema already uses `z.enum(['aws'])` which
   rejects other values. Add a more helpful error message:
   `"Only 'aws' is supported as a cloud provider. GCP and Azure support is planned."`
   This is already enforced by Zod enum but the default error message (`Invalid enum value`)
   is unhelpful. Add `.describe()` or use `z.enum(['aws'], { errorMap: ... })` for a clear message.

5. **Unsupported long_running on non-linux (U6)**: In `execute-command.ts`, when `long_running: true`
   and agent OS is not linux, return a warning message:
   `"Long-running tasks use a bash wrapper script designed for Linux. The member's OS is [os], which may not support this feature."`
   Still proceed (don't block) — user may have bash available via WSL or similar.

6. **Document OS requirements (U2)**: Add "Supported Platforms" section to `docs/cloud-compute.md`:
   - Linux: fully supported (GPU detection, task wrapper, idle management)
   - macOS: partial (no nvidia-smi, task wrapper untested)
   - Windows: limited (task wrapper not supported, GPU detection not supported)

7. Tests:
   - Register cloud member with os='windows' → success message contains OS warning
   - Register cloud member with os='linux' → no OS warning
   - Long-running on non-linux agent → warning in response
   - cloud_control status on running instance without nvidia-smi → shows `gpu: n/a (nvidia-smi not found)`
   - cloud_control status on running instance with nvidia-smi at 0% → shows `gpu: 0%`
   - Register with `cloud_provider: 'gcp'` → helpful error about only AWS being supported

**Done when**:
- Cloud registration with non-linux OS shows warning but succeeds
- `cloud_control status` distinguishes nvidia-smi-not-found (empty stdout) from 0% utilization
- `cloud_control status` shows `gpu: n/a (check failed)` on SSH/strategy errors
- Unsupported `cloud_provider` value gives helpful error message
- Long-running task on non-linux shows warning
- `docs/cloud-compute.md` has "Supported Platforms" section
- Tests cover all warning and detection scenarios

**Risks**: Low — these are additive warning messages, not behavioral changes. See Risk Register
R-5 for the GPU detection edge case.

### V4: VERIFY
Full test suite passes. All must-fix and should-fix items addressed. Build clean. Documentation updated.

---

## Risk Register

| ID | Risk | Task | Likelihood | Impact | Mitigation |
|----|------|------|-----------|--------|------------|
| R-1 | **T6 activityCommand has no timeout** — a hanging custom command blocks the idle manager's activity check loop, preventing all subsequent agents from being checked in that cycle | T6 | Medium | High (idle manager stalls) | Pass `ACTIVITY_TIMEOUT_MS` (5000ms, already defined in activity.ts line 8) as the timeout to `strategy.execCommand` when running `activityCommand`. On timeout, treat result as 'unknown' (safe default: don't stop). Test: mock execCommand to reject with timeout error → returns 'unknown'. |
| R-2 | **T3 grep/cut JSON parser extracts wrong data if JSON values contain escaped quotes** — e.g. a `started` value like `2026-03-23T10:00:00Z"extra` would confuse `cut -d'"' -f4` | T3 | Low | Medium (wrong timestamp preserved) | We control the JSON format: `write_status` uses `date -u +%Y-%m-%dT%H:%M:%SZ` which never produces escaped quotes. Add a test that verifies `update_status` works correctly with a typical ISO timestamp. Add a comment in the wrapper noting the format assumption. If the grep/cut returns empty, the fallback `[ -z "$started" ] && started=$(date ...)` fires, which is safe (slightly wrong timestamp, not data loss). |
| R-3 | **T1 schema-level task ID validation could reject auto-generated IDs in edge cases** — `Date.now().toString(36)` produces lowercase alphanumeric strings of 8-9 chars, which matches `^task-[a-z0-9]{4,20}$`. But if a future code change modified the prefix or used uppercase, existing tasks would fail validation | T1 | Low | Medium (monitor_task rejects valid tasks) | The auto-generation code (`execute-command.ts:39`) and the validation regex are in the same codebase, so any format change would be caught by existing integration tests (cloud-integration.test.ts line 223: `expect(result).toMatch(/task_id=task-[0-9a-z]+/)`). Rollback: if schema validation proves too strict, widen the regex — a one-line change. No data migration needed since task IDs are ephemeral. |
| R-4 | **T5 warning thresholds may be too aggressive or too lenient** — $10 total and $5/hr are reasonable for ML GPU workloads but could cause alert fatigue for heavy users or miss overspend on cheap instances left running for days | T5 | Medium | Low (noisy warnings) | Thresholds are named constants (`COST_WARNING_THRESHOLD`, `RATE_WARNING_THRESHOLD`, `UPTIME_WARNING_THRESHOLD_HRS`) that can be tuned in one place. Future: make configurable per-member via CloudConfig. For now, the chosen values flag p3/p4 instances (>$3/hr) and sessions over ~3h on g5 instances ($1.21/hr × 8h = $9.68 ≈ threshold). |
| R-5 | **T7 GPU detection: nvidia-smi installed but GPU driver crashed** — nvidia-smi may exist but return an error string (e.g. "NVIDIA-SMI has failed...") instead of a utilization number | T7 | Low | Low (confusing display) | `parseGpuUtilization()` (from T6) returns `undefined` for non-numeric output. The T7 detection logic treats `undefined` the same as empty string → displays `gpu: n/a (nvidia-smi not found)`. Slightly misleading label but safe behavior. Could refine label to `gpu: n/a` (without "not found") when stdout is non-empty but non-numeric — but this is an edge case not worth a separate code path. |
| R-6 | **T2 AWS CLI 15s timeout too tight for cross-region calls** — `describe-instances` typically takes 1-3s but can take 10-15s under AWS throttling | T2 | Low | Low (transient failures) | 15s is 5-10x the typical latency. If timeouts occur, the constant `AWS_CLI_TIMEOUT_MS` is a single named value — easy to tune. Operations that legitimately take longer (wait commands) keep their 300s timeout. |

## Summary

| Phase | Tasks | Focus | Key Deliverable |
|-------|-------|-------|-----------------|
| 1 | T1-T2 | Security | Task ID validation, AWS CLI timeout |
| 2 | T3-T4 | Fixes | Python3 removal, missing unit tests |
| 3 | T5-T6 | UX | Pricing warnings, custom workload detection |
| 4 | T7 | Polish | Defensive warnings, OS docs |

**Total**: 7 work tasks, 4 verify checkpoints
