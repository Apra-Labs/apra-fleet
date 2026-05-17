# Fleet E2E Setup Phase - {{SUITE_ID}}

Automated end-to-end test of the apra-fleet product. This phase registers members and verifies basic connectivity.

PM: {{PM_OS}} / {{PM_PROVIDER}} | VCS: {{VCS}} | Toy: {{TOY_PROJECT_URL}}

Do all work yourself in this conversation -- no sub-agents. If a step fails, move on to the next one.

## Checkpoints

When you finish a step, print one line, exactly like this, as plain text (no code block, no backticks):

  CHECKPOINT: {"id":"T1","status":"PASS","notes":"one short note"}

- One line per step. One JSON object, not an array. Print it once.
- If a step fails, print it with `"status":"FAIL"` and move on to the next step.
- The steps are: `T1`, `T2`, `T2-done`.
- Print `T2-done` last, only after T1 and T2. If `T2-done` is missing, the phase failed.

---

## T1: Member Registration

for local members skip Host, Username and password details
for remote members use {{secure.E2E_ACRED}} as password first and then `setup_ssh_key`

### doer
/pm register a {{DOER_TYPE}} member doer. Details:
- Provider: {{DOER_PROVIDER}}
- Host: {{DOER_HOST}}
- Username: {{DOER_USER}}
- Work folder: {{DOER_FOLDER}}

### reviewer
/pm register a {{REVIEWER_TYPE}} member named reviewer. Details:
- Provider: {{REVIEWER_PROVIDER}}
- Host: {{REVIEWER_HOST}}
- Username: {{REVIEWER_USER}}
- Work folder: {{REVIEWER_FOLDER}}

### After registering each member

- Call `update_member` for the member with `unattended="auto"`.
- Provision LLM auth on the member.

Then confirm both members show online in `fleet_status`.

### Verify tools on each member

Check `bd` is installed: run `which bd`. If it is missing, run `npm install -g @beads/bd`.

Check `dolt` is installed: run `which dolt || ~/bin/dolt version`. If it is missing, install it:

```
OS=$(uname -s | tr '[:upper:]' '[:lower:]')
ARCH=$(uname -m | sed 's/x86_64/amd64/')
mkdir -p ~/bin
curl -fsSL -o /tmp/dolt.tar.gz https://github.com/dolthub/dolt/releases/latest/download/dolt-${OS}-${ARCH}.tar.gz
tar -xzf /tmp/dolt.tar.gz -C /tmp/ && mv /tmp/dolt-${OS}-${ARCH}/bin/dolt ~/bin/ && chmod +x ~/bin/dolt
grep -q 'HOME/bin' ~/.profile 2>/dev/null || echo 'export PATH=$HOME/bin:$PATH' >> ~/.profile
~/bin/dolt version
```

CHECKPOINT: {"id":"T1","status":"PASS","notes":"..."}

---

## T2: Basic Execution

On each member, run `echo "e2e-ok-$(hostname)"` and confirm the output contains `e2e-ok-`.

Send a file containing `fleet-e2e-roundtrip` to each member, receive it back, and confirm the content matches.

Write any scratch files into the run directory (the current working directory), not /tmp.

CHECKPOINT: {"id":"T2","status":"PASS","notes":"..."}

### Done

Print this only after T1 and T2 are done:

CHECKPOINT: {"id":"T2-done","status":"PASS","notes":"setup phase finished"}
