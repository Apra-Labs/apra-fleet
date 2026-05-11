# E2E Test Runbook

Tests run on **fleet-e2e-win** (192.168.1.25), triggered from the PM machine via fleet `execute_command`.
All scripts live in `.github/e2e/` in the apra-fleet repo.

---

## One-time setup (fleet-e2e-win)

```
# Clone apra-fleet if not already present
git clone https://github.com/Apra-Labs/apra-fleet.git C:/gh-fleet/apra-fleet
```

Ensure these credentials are set in the fleet store **on fleet-e2e-win**:

| Name            | Description                        |
|-----------------|------------------------------------|
| `APASS`         | SSH password for akhil on members  |
| `e2e_bb_token`  | Bitbucket token                    |
| `e2e_bb_user`   | Bitbucket username                 |
| `e2e_gh_token`  | GitHub token                       |
| `e2e_ado_token` | Azure DevOps token                 |

Set via (on fleet-e2e-win): `echo "<value>" | apra-fleet secret --set <name> --persist -y`

---

## Per-run steps

### 1. Provision LLM auth (from PM)

```
provision_llm_auth fleet-e2e-win claude
```

Verify with: `execute_command fleet-e2e-win "claude -p 'say: ready' --max-turns 1"`
Only proceed if response contains `ready`.

### 2. Run tests

```
execute_command fleet-e2e-win \
  "cd C:/gh-fleet/apra-fleet && git pull && bash .github/e2e/run-e2e.sh <suite>"
```

Suites: `s1` (Windows PM) · `s2` (Linux PM) · `s3` (macOS PM)  
Run as background task — typical duration 30–45 min.

### 3. Collect artifacts

```
receive_files fleet-e2e-win [
  "C:/gh-fleet/apra-fleet/e2e-out/results.json",
  "C:/gh-fleet/apra-fleet/e2e-out/raw-output.txt",
  "C:/gh-fleet/apra-fleet/e2e-out/logs/fleet-pm.log",
  "C:/gh-fleet/apra-fleet/e2e-out/logs/doer-session.jsonl",
  "C:/gh-fleet/apra-fleet/e2e-out/logs/reviewer-session.jsonl"
]
```

### 4. Review

- `results.json` → overall PASS/FAIL and per-test status
- `raw-output.txt` → full PM transcript
- `logs/fleet-pm.log` → fleet daemon timing
- `node .github/e2e/extract-telemetry.js` from the output dir for the token/timing table

---

## Suite config

Suites are defined in `.github/e2e/suites.json`.
Member connection details are in `.github/e2e/members.json`.
The test template is `.github/e2e/test-script.md` — substitution happens on fleet-e2e-win at run time.
