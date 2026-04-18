<!-- llm-context: This guide covers apra-fleet's AWS EC2 integration — auto start/stop, GPU-aware idle detection, long-running tasks, cost tracking, and custom workload detection. Consult when a user asks about cloud instances, GPU workloads, cost management, or task monitoring. -->
<!-- keywords: AWS, EC2, cloud, GPU, nvidia-smi, idle detection, auto stop, cost tracking, long-running task, monitor_task, cloud_control -->
<!-- see-also: ../README.md (general setup), architecture.md (how fleet manages members) -->

# Cloud Compute Guide

## 1. Overview

Cloud compute extends apra-fleet with full EC2 lifecycle management:

- **Auto-start**: stopped EC2 instances start automatically when a tool is called
- **Idle auto-stop**: instances stop themselves after a configurable period of inactivity
- **Long-running tasks**: background task wrapper survives SSH disconnects, auto-retries on crash, keeps idle manager from stopping the instance while work is running
- **GPU monitoring**: `fleet_status`, `member_detail`, and `monitor_task` report live GPU utilization via `nvidia-smi`
- **Cost visibility**: uptime and estimated on-demand cost shown in status output

---

## 2. Architecture

```
PM (Claude)
    |
    | MCP calls
    v
apra-fleet MCP server (this machine)
    |                    |
    | SSH (execCommand)  | AWS CLI
    v                    v
EC2 instance         AWS EC2 API
(cloud member)       (start/stop/describe)
```

The MCP server runs on your local machine. It talks to EC2 via the AWS CLI and to the instance via SSH. The idle manager runs inside the server process, polling every 60 seconds.

---

## 3. AWS Setup

### IAM permissions required

The AWS identity (user or role) running the server needs:

```json
{
  "Effect": "Allow",
  "Action": [
    "ec2:StartInstances",
    "ec2:StopInstances",
    "ec2:DescribeInstances"
  ],
  "Resource": "*"
}
```

### AWS CLI configuration

Install the AWS CLI and configure credentials:

```bash
aws configure                      # default profile
aws configure --profile apra       # named profile (use cloud_profile param)
```

Verify access:

```bash
aws ec2 describe-instances --instance-ids i-0abc123def456789a --region us-east-1
```

---

## 4. Registering a Cloud Member

```
register_member(
  friendly_name      = "gpu-trainer",
  work_folder        = "/home/ubuntu/training",
  member_type        = "remote",
  username           = "ubuntu",
  cloud_provider     = "aws",
  cloud_instance_id  = "i-0abc123def456789a",
  cloud_region       = "us-east-1",
  cloud_profile      = "apra",               # optional AWS CLI profile
  key_path = "/home/you/.ssh/gpu-trainer.pem",
  cloud_idle_timeout_min = 30,               # auto-stop after 30min idle
)
```

**Parameter notes:**

| Parameter | Required | Notes |
|---|---|---|
| `cloud_provider` | yes | Only `"aws"` supported |
| `cloud_instance_id` | yes | EC2 instance ID, e.g. `i-0abc…` |
| `cloud_region` | no | Default: `us-east-1` |
| `cloud_profile` | no | AWS CLI named profile |
| `key_path` | yes | Path to SSH private key on this machine; also sets the SSH `key_path` for the member |
| `cloud_idle_timeout_min` | no | Default: 30. Per-agent idle timeout in minutes. |

The instance does **not** need to be running at registration time. The server will start it on first use.

---

## 5. Auto-Start

When `execute_command`, `execute_prompt`, or `send_files` is called on a cloud member, `ensureCloudReady()` runs first:

1. Calls `aws ec2 describe-instances` to get current state
2. **stopped** → calls `aws ec2 start-instances`, waits for `running` state
3. **stopping** → waits for `stopped`, then starts
4. **pending** → waits for `running`
5. **running** → verifies public IP is current, updates registry if changed
6. **terminated / shutting-down** → throws error (cannot be used)

After the instance is running:
- Polls SSH port (TCP connect) every 2 seconds, up to 60 seconds
- Re-provisions Claude OAuth credentials (`provision_llm_auth`) — F5
- Re-mints GitHub App tokens if the member has git repos configured — F5

The returned agent object has the fresh public IP. All subsequent SSH calls use it.

---

## 6. Idle Auto-Stop

The idle manager runs in the background and checks all cloud members every 60 seconds.

**Stop conditions (all must be true):**
1. Member has been idle longer than `cloud_idle_timeout_min` (per-agent) or the global fallback
2. Instance is currently `running`
3. No GPU compute processes detected (`nvidia-smi` shows no active jobs)
4. No fleet or other Claude processes running in the work folder

**Timer reset:** Every successful tool call (`execute_command`, etc.) calls `touchAgent()`, which resets the idle timer for that member.

**Server restart persistence (R-9):** On startup, the idle manager pre-loads `lastActivity` from each member's `lastUsed` timestamp in the registry. A member that was active 5 minutes before a server restart will not be stopped until the full timeout expires from that last-used time.

**Safe default:** If activity cannot be determined (SSH unreachable, nvidia-smi error), the stop is deferred. Unknown = don't stop.

---

## 7. Long-Running Tasks

For GPU training jobs or other tasks that outlast an SSH session, use `long_running=true`:

```
execute_command(
  member_id      = "<gpu-trainer-id>",
  command        = "python train.py --epochs 100 --data /data/train",
  long_running   = true,
  max_retries    = 3,
  restart_command = "python train.py --resume checkpoint.pt",  # F1
)
```

**What happens:**

1. A bash wrapper script is generated and base64-encoded
2. The wrapper is decoded and written to `~/.fleet-tasks/<task_id>/run.sh` on the member
3. Launched with `nohup bash run.sh &` — survives SSH disconnect
4. Returns immediately: `Task launched: task_id=task-<id>`

**Wrapper behavior:**

- Writes PID to `task.pid`, JSON status to `status.json`
- Background loop touches `~/.fleet-tasks/<task_id>/activity` every 5 minutes while running — this prevents the idle manager from stopping the instance during active work (F3)
- On non-zero exit: retries up to `max_retries` times using `restart_command` (F1)
  - `restart_command` is designed for checkpoint resume (different flags on retry)
  - Falls back to `command` if `restart_command` not provided
- On completion or max retries: updates `status.json`, removes `task.pid`

**Checking progress:**

```
monitor_task(
  member_id = "<gpu-trainer-id>",
  task_id   = "task-lx4k2z",
  auto_stop = true,   # stop instance automatically when task completes
)
```

Returns JSON:

```json
{
  "taskId": "task-lx4k2z",
  "status": "running",          // running | completed | failed | retrying | unknown
  "exitCode": null,
  "retries": 0,
  "started": "2026-03-18T10:00:00Z",
  "updated": "2026-03-18T10:45:00Z",
  "pidAlive": true,
  "gpuUtilization": 87,
  "logTail": "Epoch 45/100, loss=0.234..."
}
```

---

## 8. cloud_control Reference

Manual control over a cloud member's instance:

```
cloud_control(member_id="<id>", action="start")   # start + wait for SSH ready
cloud_control(member_id="<id>", action="stop")    # stop immediately (bypasses idle timer)
cloud_control(member_id="<id>", action="status")  # show current state + cost
```

**Actions:**

| Action | Behaviour |
|---|---|
| `start` | Calls `ensureCloudReady` — starts the instance, waits for SSH, re-provisions auth |
| `stop` | Calls `aws ec2 stop-instances` directly — immediate, no idle check |
| `status` | Calls `getInstanceDetails` — returns state, IP, instance type, uptime, estimated cost |

**`stop` vs idle auto-stop:** `cloud_control stop` bypasses all activity checks. Use it to forcefully stop an instance regardless of what's running. The idle manager's stop goes through GPU + process checks first.

---

## 9. Cost Estimation

`fleet_status` and `member_detail` show an estimated running cost based on:

- Instance type (from `aws ec2 describe-instances`)
- Uptime = `now - LaunchTime` (from the same API call)
- Hourly rate from a built-in lookup table (`src/services/cloud/cost.ts`)

**Supported families:** g4dn, g5, p3, p4d, t3, m5, c5 (us-east-1 on-demand pricing)

**Limitations:**
- Rates are hard-coded approximations. Actual AWS charges may differ due to spot pricing, savings plans, data transfer, EBS, etc.
- Instance types not in the table show `?` for cost.
- The lookup table is in `src/services/cloud/cost.ts` — edit `HOURLY_RATES` to add custom types or update prices.

---

## 10. Supported Platforms

Cloud compute features are designed and tested for **Linux** EC2 instances (Ubuntu, Amazon Linux 2, Debian).

| Feature | Linux | macOS | Windows |
|---|---|---|---|
| GPU detection (`nvidia-smi`) | ✅ Full | ❌ Not supported | ❌ Not supported |
| Long-running task wrapper | ✅ Full | ⚠ Untested | ❌ Not supported |
| Idle activity monitoring | ✅ Full | ⚠ Partial | ❌ Not supported |
| Auto-start / auto-stop | ✅ Full | ✅ Full | ✅ Full |
| SSH connectivity | ✅ Full | ✅ Full | ⚠ Requires OpenSSH |

**Notes:**
- Registering a cloud member with a non-Linux OS will succeed but show a warning about unsupported features.
- The task wrapper script (`long_running=true`) uses `bash`, `nohup`, and POSIX shell utilities. It is not compatible with Windows Command Prompt or PowerShell.
- macOS GPU detection is not supported (`nvidia-smi` is not available on Apple Silicon or macOS in general).
- Only `aws` is supported as a `cloud_provider`. GCP and Azure support is planned.
