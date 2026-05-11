# E2E Test Runbook

Tests are triggered by the PM on a designated runner member using fleet `execute_command`. The runner checks out the apra-fleet repo and executes the suite locally. All scripts live in `.github/e2e/`.

---

## Prepare

Before issuing any commands, query the runner's profile:

```
member_detail <runner>
```

Note the `work_folder` and `os` — use these to construct all paths and commands below. The repo is expected at `<work_folder>/gh-fleet/apra-fleet`.

---

## One-time setup (on the runner)

Clone the repo if not already present. Use `execute_command` with the correct syntax for the runner's OS:

```
cd <work_folder> && git clone https://github.com/Apra-Labs/apra-fleet.git gh-fleet/apra-fleet
```

Ensure these credentials are set in the fleet store **on the runner**:

| Name            | Description                       |
|-----------------|-----------------------------------|
| `APASS`         | SSH password for akhil on members |
| `e2e_bb_token`  | Bitbucket token                   |
| `e2e_bb_user`   | Bitbucket username                |
| `e2e_gh_token`  | GitHub token                      |
| `e2e_ado_token` | Azure DevOps token                |

**`apra-fleet` is never on PATH — always use the full binary path:**
- Linux/macOS: `~/.apra-fleet/bin/apra-fleet`
- Windows: `$env:USERPROFILE\.apra-fleet\bin\apra-fleet.exe`

Set via: `echo "<value>" | ~/.apra-fleet/bin/apra-fleet secret --set <name> --persist -y`

Verify all are present: `~/.apra-fleet/bin/apra-fleet secret --list`

---

## Per-run steps

### 1. Provision LLM auth

```
provision_llm_auth <runner> claude
```

Verify the token is live — do not skip this:

```
execute_command <runner> "claude -p 'say: ready' --max-turns 1"
```

Only proceed if the response contains `ready`. If it does not, re-provision and retry once.

### 2. Pull latest and run

```
execute_command <runner> "cd gh-fleet/apra-fleet && git pull && node .github/e2e/run-e2e.mjs <suite>"
```

Run as a **background task**. Typical duration: 30–45 min.

Available suites are defined in `.github/e2e/suites.json` — check that file for suite IDs and what each covers.

### 3. Collect artifacts

Once the run completes, receive output files from the runner (paths relative to the repo root):

```
receive_files <runner> [
  "gh-fleet/apra-fleet/e2e-out/results.json",
  "gh-fleet/apra-fleet/e2e-out/raw-output.txt",
  "gh-fleet/apra-fleet/e2e-out/logs/fleet-pm.log",
  "gh-fleet/apra-fleet/e2e-out/logs/doer-session.jsonl",
  "gh-fleet/apra-fleet/e2e-out/logs/reviewer-session.jsonl"
]
```

### 4. Review results

| File | What it contains |
|------|-----------------|
| `e2e-out/results.json` | Overall PASS/FAIL and per-test breakdown |
| `e2e-out/raw-output.txt` | Full PM transcript |
| `e2e-out/logs/fleet-pm.log` | Fleet daemon per-call timing |
| `e2e-out/logs/doer-session.jsonl` | Doer member session log |
| `e2e-out/logs/reviewer-session.jsonl` | Reviewer member session log |

For a token/timing summary table, run from the `e2e-out/` directory:

```
node ../.github/e2e/extract-telemetry.js
```

---

## Suite and member config

| File | Purpose |
|------|---------|
| `.github/e2e/suites.json` | Suite definitions — PM/doer/reviewer roles per suite |
| `.github/e2e/members.json` | Member IPs and work folders referenced by suites |
| `.github/e2e/test-script.md` | Test script template — substituted at run time by `run-e2e.mjs` |
