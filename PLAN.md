# Cloud Compute Member Management — Implementation Plan

**Requirements**: `requirements.md`
**Progress**: `progress.json`
**Created**: 2026-03-18

## Design Decisions

### Cloud Member = Remote Member + Cloud Metadata
A cloud member is a **remote** member with an optional `cloud` config block. `agentType` stays `'remote'` — no new strategy class. RemoteStrategy still handles all SSH. Cloud logic is a lifecycle wrapper that ensures the instance is running and the IP is current before the existing strategy executes.

```
  Tool Layer (execute_command, execute_prompt, send_files)
       |
       v
  ensureCloudReady(agent)         <-- NEW: starts instance if stopped, updates IP
       |
       v
  Strategy Layer (RemoteStrategy -> SSH)    <-- UNCHANGED
```

### Type Extension
```typescript
// Added to Agent in types.ts
cloud?: {
  provider: 'aws';
  instanceId: string;
  region: string;          // default 'us-east-1'
  profile?: string;        // AWS CLI profile
  idleTimeoutMin: number;  // default 30
};
```

### AWS via CLI (No SDK)
All AWS operations use `child_process.exec('aws ec2 ...')` on the PM machine. No new npm dependencies.

### Cloud Provider Interface
```typescript
interface CloudProvider {
  getInstanceState(config): Promise<InstanceState>;
  startInstance(config): Promise<void>;
  stopInstance(config): Promise<void>;
  waitForRunning(config): Promise<void>;
  waitForStopped(config): Promise<void>;
  getPublicIp(config): Promise<string>;
}
```
Only AWS implemented now. GCP/Azure slot in later by adding new providers.

---

## Phase 1: Cloud Provider Foundation

### T1 — Cloud types + AWS provider implementation
**Files**: `src/services/cloud/types.ts` (new), `src/services/cloud/aws.ts` (new)
**What**:
- Define `CloudConfig` type and `CloudProvider` interface in `types.ts`
- Implement `AwsCloudProvider` in `aws.ts`:
  - `getInstanceState()` via `aws ec2 describe-instances --query '..State.Name'`
  - `startInstance()` via `aws ec2 start-instances`
  - `stopInstance()` via `aws ec2 stop-instances`
  - `waitForRunning()` via `aws ec2 wait instance-running`
  - `waitForStopped()` via `aws ec2 wait instance-stopped`
  - `getPublicIp()` via `aws ec2 describe-instances --query '..PublicIpAddress'`
- Pre-check: validate `aws` CLI is available on first call; cache result
- All commands use `--profile` and `--region` from config

**Done**: `AwsCloudProvider` passes unit tests with mocked `exec`. Commands are correct for start/stop/status/wait/getIP.
**Could block**: AWS CLI not installed — handled with clear error message.

### T2 — Extend Agent type + register_member
**Files**: `src/types.ts`, `src/tools/register-member.ts`, `src/tools/update-member.ts`
**What**:
- Add `cloud?: CloudConfig` to `Agent` interface in `types.ts`
- Add flat cloud fields to `registerMemberSchema`:
  - `cloud_provider: z.enum(['aws']).optional()`
  - `cloud_instance_id: z.string().optional()` (required if cloud_provider set)
  - `cloud_region: z.string().default('us-east-1').optional()`
  - `cloud_profile: z.string().optional()`
  - `cloud_idle_timeout_min: z.number().default(30).optional()`
- Validation: if `cloud_provider` is set, `cloud_instance_id` is required
- Build `cloud` object and attach to `tempAgent` before save
- Skip SSH connectivity test if instance is stopped — validate instance exists via AWS CLI instead
- Add cloud fields to `updateMemberSchema` too

**Done**: Can register a cloud member with `cloud_provider: "aws"` + `cloud_instance_id`. Registry stores cloud config. Non-cloud registration unchanged. Tests pass.
**Could block**: Connectivity check assumes instance is running — handle stopped state gracefully.

### T3 — Unit tests for cloud provider + registration
**Files**: `tests/cloud-provider.test.ts` (new), extend `tests/registry.test.ts`
**What**:
- Test `AwsCloudProvider`: mock exec, verify correct AWS CLI commands for each method
- Test error handling: instance not found, AWS CLI missing, unexpected states
- Test register_member with cloud config: valid registration, missing instance_id validation, non-cloud unchanged

**Done**: 15+ new tests pass. Build clean.
**Could block**: Nothing — pure unit tests.

### VERIFY (V1)
Build succeeds. All existing + new tests pass. Can register a cloud member in the registry.

---

## Phase 2: Auto-Start on Demand

### T4 — Cloud lifecycle service (ensureCloudReady)
**Files**: `src/services/cloud/lifecycle.ts` (new)
**What**:
- `ensureCloudReady(agent: Agent): Promise<Agent>`:
  1. If `!agent.cloud` — return agent unchanged (not a cloud member)
  2. Get instance state via `CloudProvider.getInstanceState()`
  3. If `running` — verify IP matches `agent.host`, update if changed, return
  4. If `stopped` — start, wait for running, get IP, update member host, wait for SSH
  5. If `stopping` — wait for stopped, then start (same as stopped flow)
  6. If `terminated` — return error
  7. Return updated agent (re-fetched from registry after IP update)
- SSH readiness: poll with retry (port 22 connect check), max 30 attempts x 2s
- Reset idle timer on successful start

**Done**: `ensureCloudReady` returns a running, SSH-ready agent. IP is updated in registry. Mocked tests cover: already-running, stopped-to-started, stopping-to-waited-to-started, IP changed.
**Could block**: SSH readiness timing varies — use generous timeout (60s).

### T5 — Wire auto-start into work tools
**Files**: `src/tools/execute-command.ts`, `src/tools/execute-prompt.ts`, `src/tools/send-files.ts`
**What**:
- In each tool, after `getAgentOrFail()` and before `getStrategy()`:
  ```typescript
  const readyAgent = await ensureCloudReady(agent);
  ```
- 3-line addition per tool. The rest of each tool is unchanged.
- Add tests: mock cloud provider, verify ensureCloudReady called for cloud members, skipped for non-cloud.

**Done**: `execute_command` on a stopped cloud member auto-starts it, updates IP, executes command. Non-cloud members unaffected.
**Could block**: Agent object mutation — ensureCloudReady returns fresh agent from registry, not stale reference.

### VERIFY (V2)
Dispatch work to a stopped cloud member — it auto-starts — command executes — member IP updated. Existing non-cloud tools unchanged.

---

## Phase 3: Idle Management

### T6 — GPU/process activity check
**Files**: `src/os/os-commands.ts`, `src/os/linux.ts`, `src/services/cloud/activity.ts` (new)
**What**:
- Add to `OsCommands` interface + `LinuxCommands`:
  - `gpuProcessCheck()` — `nvidia-smi --query-compute-apps=pid,name,used_gpu_memory --format=csv,noheader 2>/dev/null || echo "no-gpu"`
  - `gpuUtilization()` — `nvidia-smi --query-gpu=utilization.gpu,memory.used,memory.total --format=csv,noheader,nounits 2>/dev/null || echo "no-gpu"`
- Create `checkMemberActivity(agent): Promise<'busy-gpu' | 'busy-process' | 'idle'>`:
  1. Run `gpuProcessCheck()` via strategy — if GPU processes found, return `'busy-gpu'`
  2. Run `fleetProcessCheck()` — if Claude busy, return `'busy-process'`
  3. Check `agent.lastUsed` vs now — if recent (< 5 min), return `'busy-process'`
  4. Otherwise return `'idle'`
- Handle `nvidia-smi` not installed: treat as no GPU, skip GPU check

**Done**: `checkMemberActivity` returns correct status. GPU with active processes returns busy. No GPU falls through to process check. Tests with mocked strategy.
**Could block**: `nvidia-smi` output varies across driver versions — parse defensively, treat parse errors as "unknown" (don't stop).

### T7 — Idle manager service
**Files**: `src/services/cloud/idle-manager.ts` (new), `src/index.ts` (start on server init)
**What**:
- `IdleManager` class:
  - `start()` — begins periodic check (every 60s)
  - `stop()` — clears interval
  - `resetTimer(agentId)` — called by tools on every cloud member operation
  - Periodic check logic:
    1. For each cloud member with `cloud` config
    2. Get instance state — skip if not running
    3. Check `lastUsed` — if within idle timeout, skip
    4. Run `checkMemberActivity()` — if busy, touch `lastUsed`, skip
    5. If idle > timeout AND not busy — `stopInstance()`, log to stderr
  - Timer is `unref()`'d (doesn't prevent Node exit)
  - Mutex per instance: never run two stop attempts concurrently
- Wire into `src/index.ts`: start idle manager after server connects
- Wire `resetTimer` into `touchAgent` helper so every tool call resets it

**Done**: Idle manager stops instances after configured timeout. GPU activity prevents stop. Timer resets on tool calls. Tests with mocked provider + activity check.
**Could block**: Timer races — mutex/flag prevents concurrent stop on same instance.

### VERIFY (V3)
Cloud member left idle > timeout auto-stops. Cloud member with active GPU stays running. Timer resets on every tool call. All tests pass.

---

## Phase 4: Cloud Status & Control

### T8 — fleet_status + member_detail cloud enrichment
**Files**: `src/tools/check-status.ts`, `src/tools/member-detail.ts`
**What**:
- For cloud members, add to status output:
  - Instance state: `running` / `stopped` / `stopping` (via `getInstanceState`)
  - If running: uptime since last start
  - Estimated cost: lookup table `{ 'g5.2xlarge': 1.212, ... }` x uptime hours
  - GPU utilization: run `gpuUtilization()` if online
- Compact format: `[cloud:running 2h $2.42 GPU:45%]` after existing status
- JSON format: add `cloud` object with all fields
- For stopped cloud members: show `OFF(cloud)` instead of `OFFLINE` — distinguish instance-stopped from network-unreachable
- Run AWS state queries in parallel with SSH checks to avoid latency penalty

**Done**: `fleet_status` shows cloud state, uptime, cost, GPU. `member_detail` shows detailed cloud info. Non-cloud members unchanged. Tests pass.
**Could block**: AWS describe-instances latency — parallel execution mitigates.

### T9 — cloud_control tool
**Files**: `src/tools/cloud-control.ts` (new), `src/index.ts` (register)
**What**:
- New tool `cloud_control`:
  - Schema: `member_id`, `action: 'start' | 'stop' | 'status'`
  - `start`: calls `ensureCloudReady`, returns new IP and confirmation
  - `stop`: calls `stopInstance` directly, bypasses idle timer, returns confirmation
  - `status`: returns instance state, IP, uptime, cost — no side effects
- Validation: reject if member has no cloud config
- Stop action also pauses idle timer for that member

**Done**: Can manually start/stop cloud members. Stop kills instance immediately. Status shows state without side effects.
**Could block**: Nothing significant.

### VERIFY (V4)
`fleet_status` shows cloud member state + cost. `cloud_control stop` force-stops instance. All tests pass.

---

## Phase 5: Long-Running Tasks

### T10 — Task wrapper script + launch mechanism
**Files**: `src/services/cloud/task-wrapper.ts` (new), extend `src/tools/execute-command.ts` schema
**What**:
- `generateTaskWrapper(config)` generates a bash script that:
  - Runs the user's command via `nohup`
  - Redirects stdout/stderr to `~/.fleet-tasks/<task-id>/output.log`
  - Writes PID to `~/.fleet-tasks/<task-id>/pid`
  - Writes status to `~/.fleet-tasks/<task-id>/status` (`running | completed:0 | crashed:N`)
  - On crash (non-zero exit): retry up to N times (configurable, default 3)
  - Touches fleet activity marker on each retry (prevents idle stop during retries)
  - On completion: writes final status
- Add `long_running: boolean` and `max_retries: number` options to `execute_command` schema
- When `long_running: true`:
  1. Generate wrapper script with unique task ID
  2. Push to member via strategy.transferFiles
  3. Execute wrapper via nohup (non-blocking)
  4. Return task ID for later monitoring

**Done**: Can launch a long-running command that survives SSH disconnect. Task ID returned. Script logs to known location. Auto-retries on crash.
**Could block**: `screen` not installed — fall back to plain `nohup` (always available on Linux).

### T11 — monitor_task tool
**Files**: `src/tools/monitor-task.ts` (new), `src/index.ts` (register)
**What**:
- New tool `monitor_task`:
  - Schema: `member_id`, `task_id`, `auto_stop: boolean` (optional)
  - Checks (all via strategy.execCommand — cheap, no Claude):
    1. Read `status` file
    2. Check if PID alive (`kill -0 $PID`)
    3. If GPU available: `nvidia-smi` for utilization + memory
    4. Crash detection: PID dead but GPU memory held = `crashed (GPU memory leak)`
    5. Tail last 50 lines of `output.log`
  - Returns structured JSON: `{ status, pid_alive, gpu_util, gpu_memory, log_tail, retries_remaining }`
  - If task completed and `auto_stop` is true, trigger instance stop

**Done**: `monitor_task` returns structured status. Detects running, completed, crashed states. GPU memory leak detected. Log tail readable.
**Could block**: Race between task completion and monitor — status file is authoritative.

### VERIFY (V5)
Launch long-running task — disconnect — reconnect — monitor shows status. Crashed task auto-retries. Completed task optionally stops instance. All tests pass.

---

## Phase 6: Polish & Documentation

### T12 — Integration tests for cloud lifecycle
**Files**: `tests/cloud-lifecycle.test.ts` (new)
**What**:
- End-to-end test with fully mocked AWS CLI + SSH:
  - Register cloud member — auto-start on execute_command — idle timeout — auto-stop
  - Long-running task: launch — monitor — complete — auto-stop
  - IP change handling: instance restarts with new IP — next command works
  - Error cases: terminated instance, AWS CLI missing, SSH unreachable after start

**Done**: Integration test covers the full lifecycle. All tests pass.
**Could block**: Test isolation — mock AWS CLI at exec level.

### T13 — Documentation updates
**Files**: `docs/architecture.md`, `docs/tools-lifecycle.md`, `docs/tools-work.md`, `docs/tools-observability.md`, `README.md`
**What**:
- Architecture: add "Cloud Lifecycle" section explaining the wrapper layer
- tools-lifecycle: document `cloud_control` tool, cloud registration fields
- tools-work: document `long_running` option, `monitor_task` tool
- tools-observability: document cloud fields in fleet_status/member_detail
- README: add cloud setup section (AWS CLI prereq, registration example)

**Done**: Docs complete, internally consistent, no stale references.
**Could block**: Nothing.

### VERIFY (V6)
All tests pass. Docs complete. Full build clean. Non-cloud functionality verified unchanged.

---

## Risk Register

| ID | Risk | Likelihood | Impact | Mitigation |
|----|------|-----------|--------|------------|
| R-1 | `nvidia-smi` output varies across driver versions | Medium | High (wrong idle decision) | Parse defensively; treat errors as "unknown" (don't stop). Validated in T6. |
| R-2 | AWS CLI not installed on PM machine | Low | Critical (all cloud ops fail) | Pre-check in AwsCloudProvider; clear error message. |
| R-3 | Instance in terminated/pending state | Low | Medium (can't start) | Handle all 5 EC2 states. Error on terminated. Wait on pending. |
| R-4 | SSH not ready after instance start | Medium | Medium (command fails) | Poll 30 attempts x 2s (60s total). Same pattern as fleet-ec2.sh. |
| R-5 | Idle timer races with concurrent tool calls | Medium | Medium (premature stop) | Re-check lastUsed + GPU before stopping. Never stop if lastUsed < 5 min. |
| R-6 | nohup unavailable on member | Very Low | Medium (can't run long tasks) | nohup is POSIX — available on all Linux. screen is optional. |
| R-7 | execute_prompt timeout for long-running work | Medium | High (PM loses track) | Use `long_running: true` to decouple from SSH session. |
| R-8 | AWS API rate limits on frequent describe-instances | Low | Low (transient) | Cache state 30s. Idle manager polls every 60s. |

---

## Summary

| Phase | Tasks | Focus | Key Deliverable |
|-------|-------|-------|-----------------|
| 1 | T1-T3 | Foundation | Cloud types, AWS provider, registration |
| 2 | T4-T5 | Auto-Start | Stopped member auto-starts on tool call |
| 3 | T6-T7 | Idle Stop | GPU-aware idle detection + auto-stop |
| 4 | T8-T9 | Status/Control | Cloud info in fleet_status, manual start/stop |
| 5 | T10-T11 | Long Tasks | nohup wrapper, monitor_task tool |
| 6 | T12-T13 | Polish | Integration tests, documentation |

**Total**: 13 work tasks, 6 verify checkpoints
