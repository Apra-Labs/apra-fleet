# Cloud Compute Member Management — Requirements

## Objective
Add first-class support for cloud compute members (starting with AWS EC2) in apra-fleet. A cloud member should start/stop automatically based on demand, run long-lived tasks (ML training) reliably, and minimize costs by never sitting idle.

## Context: Lessons from edge-vision-trainer

The edge-vision-trainer (EC2 g5.2xlarge, A10G GPU) was manually set up with shell scripts (`fleet-ec2.sh`, watchdog). Here's what worked and what didn't:

### What worked:
- `fleet-ec2.sh ensure <conf>` — starts instance, waits for SSH, updates fleet member IP
- `fleet-ec2.sh watchdog <conf>` — auto-stops after 30 min idle
- Activity file touch mechanism (`/tmp/fleet-ec2-activity-<instance-id>`)
- `provision_auth` to deploy Claude CLI credentials after instance start
- `provision_vcs_auth` to deploy GitHub App tokens for git access

### What broke repeatedly:
1. **Watchdog killed the instance during active work** — The activity file is on the PM machine, but when Claude is running on the remote member via `execute_prompt`, nothing touches the local activity file. The watchdog saw 30 min of "no activity" and stopped the instance mid-task.
2. **Dynamic IP changes** — No Elastic IP, so every restart gets a new IP. Required manual `update_member` call each time. The `ensure` script updates the fleet, but PM code had to handle this explicitly.
3. **Training crashes went undetected** — A DataLoader OOM killed the training process, but the GPU held 19GB of orphaned memory. No monitoring detected this for hours.
4. **Rate limits on remote Claude CLI** — When the remote Claude CLI hit rate limits, the instance sat idle burning money with no useful work happening.
5. **No auto-restart for long tasks** — Training crashed and had to be manually restarted from checkpoint. No self-healing wrapper.
6. **`execute_prompt` timeouts** — Long-running prompts would timeout on the PM side while the remote Claude process continued. PM lost track of the session state.

## Requirements

### R1: Cloud Member Registration
- Extend `register_member` to accept cloud provider config:
  - `provider: "aws"` (start with AWS, design for extensibility)
  - `instance_id: "i-0eeca56616115726c"`
  - `aws_profile: "apra"` (or default)
  - `aws_region: "us-east-1"` (or default)
  - `ssh_key_path: "/path/to/key.pem"`
  - `ssh_username: "ubuntu"`
- Store cloud config in the member registry alongside existing fields
- Display cloud status in `fleet_status` and `member_detail`

### R2: Auto Start/Stop
- **Start on demand**: When PM dispatches work (`execute_prompt`, `execute_command`) to a stopped cloud member, automatically:
  1. Start the instance (`aws ec2 start-instances`)
  2. Wait for running state + SSH ready
  3. Get the new public IP
  4. Update the member's host
  5. Execute the original command
- **Stop on idle**: Built-in idle detection (not a separate shell script):
  - Track last activity time per member (updated on every `execute_command`/`execute_prompt` call)
  - Configurable idle timeout (default 30 min)
  - **GPU-aware**: Before stopping, check if the GPU has active processes (`nvidia-smi`). If GPU is busy, DON'T stop — reset the idle timer.
  - **Process-aware**: Check for known long-running processes (training scripts, nohup jobs)
- **No Elastic IP needed**: Handle dynamic IPs transparently — the member's host updates automatically on every start

### R3: Long-Running Task Support
- **Self-healing wrapper**: When `execute_prompt` launches a long-running task (training), wrap it in a resilient shell script that:
  - Runs the task via nohup/screen
  - Auto-restarts from checkpoint on crash (configurable retry count, default 3)
  - Logs stdout/stderr to a known location
  - Touches the activity marker on each checkpoint/epoch
- **Task monitoring**: New tool `monitor_task` that:
  - Tails the log file
  - Reports GPU utilization
  - Detects crashes (process died but GPU memory held)
  - Returns structured status: `running | completed | crashed | idle`
- **Auto-shutdown on completion**: When the long-running task completes (exit code 0), optionally stop the instance to save costs

### R4: Efficient Data Exchange
- **Minimize PM-member data transfer**:
  - PM sends: task files (PLAN.md, progress.json, CLAUDE.md) — small
  - Member returns: progress updates (progress.json), commit hashes — small
  - Large data (datasets, models) stays on the member, never transferred to PM
- **Progress polling**: Use `execute_command` (cheap) to poll `cat progress.json` instead of running Claude prompts for status checks
- **Git as transport**: All code changes go through git push/pull, not file transfer
- **Log streaming**: `execute_command` to tail logs, not full file downloads

### R5: Cost Controls
- Dashboard/report: `fleet_status` should show:
  - Instance state (running/stopped)
  - Uptime since last start
  - Estimated cost (instance_type → $/hr lookup)
  - Current GPU utilization
  - Active task (if any)
- Configurable budget alerts (optional, future)
- Force-stop command for emergencies

## Non-Functional Requirements
- AWS credentials: Use the PM machine's AWS CLI config (profiles, default creds). Don't store AWS keys in the fleet server.
- Extensibility: Design the cloud provider interface so GCP/Azure can be added later (but only implement AWS now)
- Backward compatible: Existing non-cloud members must work exactly as before
- No new external dependencies if possible (use AWS CLI via shell, not boto3)

## Definition of Done
1. `register_member` accepts cloud config for AWS EC2
2. `execute_command`/`execute_prompt` on a stopped cloud member auto-starts it
3. Idle detection stops instances after configurable timeout (GPU/process-aware)
4. `fleet_status` shows cloud member state, uptime, cost estimate
5. Long-running task wrapper with auto-restart from checkpoint
6. `monitor_task` tool returns structured task status
7. All existing non-cloud functionality unchanged
8. Tests for start/stop lifecycle
9. Documentation updated

## Architecture Notes
- The fleet server already manages members via SSH. Cloud support adds a lifecycle layer on top.
- Start/stop is a PM-side operation (AWS CLI runs on PM machine, not on the member)
- The member itself doesn't know it's a cloud instance — it's just an SSH target. The cloud awareness is in the fleet server.
