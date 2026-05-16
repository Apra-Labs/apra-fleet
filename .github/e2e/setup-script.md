# Fleet E2E Setup Phase - {{SUITE_ID}}

Automated end-to-end test of the apra-fleet product. This phase registers members and verifies basic connectivity.

PM: {{PM_OS}} / {{PM_PROVIDER}} | VCS: {{VCS}} | Toy: {{TOY_PROJECT_URL}}

## Rules

- Do all work directly in this top-level conversation. Do not use the Agent
  tool or spawn sub-agents -- run every fleet call and command yourself.
- Run every test in this phase even if earlier ones fail.
- After each test emit one line in this exact format (no backticks, no code block):
  CHECKPOINT: [{"test":"T1","status":"PASS","notes":"..."}]
  Always include every test completed so far **in this phase** in the array.

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

---

## T2: Basic Execution

On each member, run `echo "e2e-ok-$(hostname)"` and confirm the output contains `e2e-ok-`.

Send a file containing `fleet-e2e-roundtrip` to each member, receive it back, and confirm the content matches.

Write any scratch files into the run directory (the current working directory), not /tmp.

---
