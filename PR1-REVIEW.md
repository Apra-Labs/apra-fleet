# PR #1 Review — Add First-Class Cloud Compute Member Support (AWS EC2)

> Branch: `feature/cloud-compute` → `main`
> Author: kashhash (kjois)
> 32 files changed, +3519 / -302, 22 commits
> Smoke tested on real EC2 g5.2xlarge (A10G GPU)

---

## 1. What This PR Does

Adds end-to-end AWS EC2 lifecycle management to apra-fleet. Cloud members are remote members with an additional `cloud` config block — no new member type, no new strategy class. The implementation covers:

- **Auto start/stop**: stopped instances auto-start when a tool is invoked; idle instances auto-stop after a configurable timeout
- **GPU-aware idle detection**: nvidia-smi checks prevent stopping instances during active GPU training
- **Long-running tasks**: nohup wrapper with PID tracking, checkpoint restart (`restart_command`), activity markers, and auto-retry
- **New tools**: `cloud_control` (manual start/stop/status) and `monitor_task` (structured task monitoring)
- **Cloud enrichment**: `fleet_status` and `member_detail` show instance state, uptime, cost estimate, GPU utilization

### Motivation

Manual EC2 management with shell scripts (fleet-ec2.sh, watchdog) was unreliable:
- Watchdog killed instances during active GPU training
- Dynamic IPs required manual update on every restart
- Training crashes went undetected for hours
- No auto-restart from checkpoints

---

## 2. Architecture

```
PM → execute_command/prompt/send_files
       ↓
  ensureCloudReady(agent)          ← lifecycle.ts
       ├─ awsProvider.startInstance()  ← aws.ts (AWS CLI, no SDK)
       ├─ waitForSsh()                 ← TCP polling, 30×2s = 60s max
       ├─ Update registry IP           ← registry.ts
       └─ reProvisionAuth()            ← best-effort OAuth + VCS tokens
       ↓
  strategy.execCommand()           ← existing SSH/local strategy
       ↓
  touchAgent()                     ← resets idle timer via hook

IdleManager (background, 60s interval)
  ├─ checkMemberActivity()         ← activity.ts (GPU + process check)
  ├─ GPU busy? → defer stop
  ├─ Process busy? → defer stop
  ├─ Unknown? → defer stop (safe default)
  └─ Idle > timeout? → awsProvider.stopInstance()
```

### New files (services/cloud/)

| File | Purpose |
|------|---------|
| `types.ts` | CloudConfig, CloudProvider interface, InstanceState, ActivityStatus |
| `aws.ts` | AwsCloudProvider — all EC2 ops via `aws ec2` CLI commands |
| `lifecycle.ts` | `ensureCloudReady()` — state machine for instance startup + SSH polling + auth re-provision |
| `activity.ts` | `checkMemberActivity()` — GPU (nvidia-smi) + process checks → busy-gpu/busy-process/idle/unknown |
| `idle-manager.ts` | Background daemon — periodic idle checks, per-member timeout, mutex on stop ops |
| `task-wrapper.ts` | Generates self-contained bash scripts for long-running background tasks |
| `cost.ts` | Static pricing table (~50 instance types), uptime/cost formatting |

### Modified files

| File | What changed |
|------|-------------|
| `types.ts` | Added optional `cloud?: CloudConfig` to Agent interface |
| `register-member.ts` | Cloud params (provider, instance_id, region, profile, ssh_key_path, idle_timeout), validation, warnings system |
| `update-member.ts` | Cloud config partial updates, icon support |
| `execute-command.ts` | `ensureCloudReady` + `touchAgent` + long_running task wrapper support |
| `execute-prompt.ts` | `ensureCloudReady` + `touchAgent` |
| `send-files.ts` | `ensureCloudReady` + `touchAgent` |
| `check-status.ts` | Parallel cloud enrichment (state, type, uptime, cost, GPU) |
| `member-detail.ts` | Parallel cloud enrichment + GPU utilization |
| `index.ts` | Register 2 new tools, start IdleManager on server init |
| `agent-helpers.ts` | `setIdleTouchHook()` + `touchAgent()` with session update |
| `os-commands.ts` | `gpuProcessCheck()` + `gpuUtilization()` interface |
| `linux.ts` | nvidia-smi implementations |
| `windows.ts` | GPU stubs (exit 2 / empty string) |

---

## 3. Design Decisions — Assessment

### Good decisions

| Decision | Why it's good |
|----------|---------------|
| Cloud member = remote + cloud config block | No new strategy class, no conditional branching in tools. Clean extension. |
| AWS via CLI, no SDK dependency | Zero new dependencies. Uses existing `child_process.exec`. Profile/region support for free. |
| `ensureCloudReady()` as lifecycle wrapper | Transparent to tools — they just call it before SSH. Single point of change. |
| Activity: unknown → don't stop (safe default) | Prevents data loss from aggressive idle stopping. Learned from watchdog failures. |
| Base64 encoding in task wrapper | Eliminates shell escaping issues across SSH → bash → command chain. |
| Hook pattern for idle touch | `setIdleTouchHook()` avoids circular imports between idle-manager ↔ agent-helpers. |
| lastUsed preloading (R-9) | Idle timer survives server restarts. No surprise stops after PM crash/restart. |
| Mutex on stop operations | Prevents concurrent stop attempts on the same instance. |

### Questionable decisions

| Decision | Concern |
|----------|---------|
| Python3 dependency in task wrapper | `python3 -c` used to parse JSON for timestamp preservation. Assumes Python3 available on all cloud instances. Could use `jq` or pure bash. |
| Hardcoded pricing table (50 types) | Will drift from actual AWS pricing. No mechanism to update. Returns "?" for unknown types (acceptable but limiting). |
| 60s SSH timeout (30×2s) | Linear polling, no exponential backoff. Adequate for current use but could be smarter. |
| No explicit timeout on AWS CLI calls | If `aws ec2 describe-instances` hangs, `ensureCloudReady` hangs. Should have a timeout wrapper. |

---

## 4. Security Review

### Command Injection

| Vector | Protection | Assessment |
|--------|-----------|------------|
| AWS CLI commands | `validateInstanceId()` (regex: `i-[0-9a-f]{8,17}`), `validateRegion()` (regex), `escapeShellArg()` for profile | **Good** — defense-in-depth |
| Task wrapper commands | Base64 encoded, decoded on remote side | **Good** — bypasses shell metacharacter issues entirely |
| nvidia-smi commands | No user input injected | **Safe** — static command strings |
| Task ID in file paths | Used in `~/.fleet-tasks/${taskId}/` | **Minor risk** — no format validation. Should validate `^task-[a-z0-9]+$` |

### Credential Handling

| Area | Approach | Assessment |
|------|----------|------------|
| AWS credentials | Relies on AWS CLI credential chain (~/.aws/credentials or env vars) | **Good** — no credentials in fleet code |
| SSH key path | Stored as path string, not key contents | **Good** — key never leaves filesystem |
| Auth re-provisioning (F5) | Best-effort after cold start, errors logged not thrown | **Acceptable** — failure means stale creds, not security breach |

### No concerns found

- No credential leakage in error messages
- No secrets in logs or status output
- Cloud config stored in existing encrypted registry

---

## 5. DRY Analysis

### Duplicated patterns (should consolidate)

| Pattern | Files | Copies | Suggested fix |
|---------|-------|--------|---------------|
| Cost/uptime formatting | cloud-control.ts, check-status.ts, member-detail.ts | 3 | Already in `cost.ts` — ensure all callers use it (verify they do) |
| GPU utilization parsing (`parseInt(stdout.trim())`) | monitor-task.ts, check-status.ts, member-detail.ts | 3 | Extract to a `parseGpuUtilization()` helper in activity.ts |
| Cloud details struct building | check-status.ts, member-detail.ts | 2 | Extract shared `getCloudSummary(agent)` function |
| `ensureCloudReady` + try/catch pattern | execute-command.ts, execute-prompt.ts, send-files.ts | 3 | Already centralized in lifecycle.ts — the 3-line call pattern in each tool is acceptable |
| Statusline write/clear | execute-command.ts, execute-prompt.ts, send-files.ts | 3 | Extract `withStatusline(agentId, fn)` wrapper |

### Acceptable repetition

- `touchAgent()` calls in each tool — intentional, each tool is responsible for its own activity signaling
- `ensureCloudReady()` guard in each tool — 3 lines, extracting adds indirection without benefit

---

## 6. Test Coverage

### What's well tested (336 tests)

| Area | Tests | Quality |
|------|-------|---------|
| AWS provider (aws.ts) | cloud-provider.test.ts | Excellent — all states, validation, injection defense |
| Activity detection | activity.test.ts | Excellent — GPU, process, error paths, safe defaults |
| Idle manager | idle-manager.test.ts | Excellent — timeout, GPU/process busy, mutex, R-9 preload |
| Cloud lifecycle wiring | cloud-lifecycle.test.ts | Good — ensureCloudReady called, IP updated, errors propagate |
| Integration scenarios | cloud-integration.test.ts | Good — full lifecycle, idle stop, long-running, monitor |
| Registry cloud fields | registry.test.ts | Good — store, retrieve, update, persist |

### Test gaps (should add before merge)

| Gap | Risk | Priority |
|-----|------|----------|
| Auth re-provisioning after cold start (F5) | Stale credentials after instance restart → git/claude failures | **High** |
| Crash → retry with restart_command path | Core feature (F1) not unit tested, only verified on real hardware | **High** |
| Activity marker touching during long-running task (F3) | Idle manager could stop instance during 6+ hour training | **Medium** |
| Task ID validation (injection via path) | Minor — used in safe path context, but unvalidated | **Medium** |
| IP change detection in ensureCloudReady | Stale IP after instance restart | **Medium** |
| Concurrent auto-start on same member (race) | Duplicate AWS start calls | **Low** |
| AWS CLI timeout / network failure | Hung ensureCloudReady | **Low** |
| nvidia-smi timeout (hung GPU check) | Blocked idle manager | **Low** |

### Mock strategy assessment

All test files use appropriate mocking:
- AWS CLI responses mocked via `makeExec()` factory
- Strategy/registry mocked via vitest module mocks
- No real AWS API calls in test suite
- Mutex testing uses promise resolution control (clever)

---

## 7. Documentation Review

`docs/cloud-compute.md` is comprehensive and accurate. Minor gaps:

| Missing from docs | Where it should go |
|-------------------|--------------------|
| SSH polling details (30×2s = 60s max, TCP port 22) | §4 Auto-Start |
| Activity marker path (`~/.fleet-tasks/<taskId>/activity`) | §7 Long-Running Tasks |
| Log file path (`~/.fleet-tasks/<taskId>/output.log`) | §7 Long-Running Tasks |
| `max_retries` default value (3) | §7 Parameters |
| F5 auth re-provision is best-effort (errors logged, not thrown) | §4 Auto-Start |

---

## 8. Requirements Traceability

| Requirement | Status | Evidence |
|-------------|--------|----------|
| R1: Cloud member registration | **Done** | register-member.ts, 6 new params |
| R2: Auto start/stop | **Done** | lifecycle.ts + idle-manager.ts |
| R3: Long-running tasks | **Done** | task-wrapper.ts + monitor-task.ts |
| R4: Efficient data exchange | **Done** | Existing send_files + git transport |
| R5: Cost controls | **Partial** | Cost display done. Budget alerts not implemented (marked future). |
| F1: restart_command for checkpoints | **Done** | task-wrapper.ts |
| F2: Task dependency ordering | **Done** | PLAN.md, touchAgent wiring |
| F3: Activity marker every 5 min | **Done** | task-wrapper.ts |
| F4: cloud.sshKeyPath in CloudConfig | **Done** | types.ts, register-member.ts |
| F5: Re-provision auth after cold start | **Done** | lifecycle.ts |
| R-9: lastUsed survives restart | **Done** | idle-manager.ts preloading |

---

## 9. Improvement Suggestions

### Before merge

1. **Add unit test for restart_command retry path** — F1 is a headline feature with no unit test coverage. The task wrapper generates the retry logic but it's never tested in isolation.

2. **Add unit test for F5 auth re-provisioning** — `reProvisionAuth()` in lifecycle.ts is called after cold start but not tested. Verify it calls `provisionAuth()` and `provisionVcsAuth()`, handles errors gracefully.

3. **Validate task ID format** — `monitor_task` and `execute_command` (long_running) accept user-provided task IDs used in file paths. Add regex validation: `^task-[a-z0-9]{8,}$`.

4. **Extract GPU utilization parsing** — `parseInt(stdout.trim())` appears in 3 tools. Create `parseGpuUtilization(stdout: string): number | undefined` in activity.ts.

### After merge (nice-to-have)

5. **Add timeout to AWS CLI calls** — `exec()` calls in aws.ts have no timeout. A hung `aws ec2 describe-instances` blocks `ensureCloudReady` indefinitely. Add 15s timeout.

6. **Replace Python3 dependency in task wrapper** — `python3 -c` is used to parse JSON for timestamp preservation. Use `jq` (more commonly available on GPU instances) or pure bash string extraction.

7. **Extract cloud summary builder** — `check-status.ts` and `member-detail.ts` both construct cloud detail objects with the same fields. Extract to `getCloudSummary(agent): CloudSummary`.

8. **Add exponential backoff to SSH polling** — Current linear polling (2s fixed) could be smarter: 1s, 2s, 4s, 8s... caps at 16s. Reduces unnecessary TCP connections during slow starts.

9. **Document activity marker path** — `~/.fleet-tasks/<taskId>/activity` is critical for idle manager integration but not documented in cloud-compute.md.

10. **Budget alerts (R5)** — Marked as future/optional in requirements. Consider adding a warning when estimated cost exceeds a threshold.

---

## 10. Verification Gates (all passed on real hardware)

| Gate | Result | Details |
|------|--------|---------|
| V1 | Pass | Build clean, 291 tests, cloud member registerable |
| V2 | Pass | Stopped instance auto-started, IP updated, auth re-provisioned |
| V3 | Pass | GPU-aware idle manager confirmed via nvidia-smi |
| V4 | Pass | fleet_status shows `[cloud:running g5.2xlarge 7m $0.15]`, cloud_control stop works |
| V5 | Pass | Long-running task launched (task-mmvzq382), monitor_task shows PID alive + GPU util |
| V6 | Pass | 336 tests, docs complete, build clean |

---

## 11. Overall Assessment

**Quality: High.** Clean architecture (cloud logic isolated in `services/cloud/`), thoughtful design (safe defaults, hook pattern, state machine), comprehensive testing (336 tests), real hardware validation. The PR is well-structured with 13 work commits following the plan exactly.

**Main risks:** Three high-value features (F1 restart, F3 activity marker, F5 auth re-provision) are verified on real hardware but lack unit tests. Adding these tests before merge would significantly increase confidence for future refactoring.

**Recommendation:** Merge after adding tests for items 1-3 from the improvement list. Items 4-10 can be addressed post-merge.
