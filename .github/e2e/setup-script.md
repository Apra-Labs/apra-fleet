# Fleet E2E Setup Phase - {{SUITE_ID}}

Automated end-to-end test of the apra-fleet product. This phase registers members and verifies basic connectivity.

PM: {{PM_OS}} / {{PM_PROVIDER}} | VCS: {{VCS}} | Toy: {{TOY_PROJECT_URL}}

## Members

- **doer** (name: `doer`, provider: {{DOER_PROVIDER}})
  - Host: {{DOER_HOST}} (local if value is "local", otherwise a remote test machine)
  - Username: {{DOER_USER}}
  - Work folder: {{DOER_FOLDER}}
  - Credentials resolved from the fleet credential store key E2E_ACRED
  - Auth: for remote members, prefer auth_type=key via setup_ssh_key as primary; password ({{secure.E2E_ACRED}}) as explicit secondary fallback

- **reviewer** (name: `reviewer`, provider: {{REVIEWER_PROVIDER}})
  - Host: {{REVIEWER_HOST}} (local if value is "local", otherwise a remote test machine)
  - Username: {{REVIEWER_USER}}
  - Work folder: {{REVIEWER_FOLDER}}
  - Credentials resolved from the fleet credential store key E2E_ACRED
  - Auth: for remote members, prefer auth_type=key via setup_ssh_key as primary; password ({{secure.E2E_ACRED}}) as explicit secondary fallback

## Rules

- Run every test in this phase even if earlier ones fail.
- After each test emit one line in this exact format (no backticks, no code block):
  CHECKPOINT: [{"test":"T1","status":"PASS","notes":"..."}]
  Always include every test completed so far **in this phase** in the array.

---

## T1: Member Registration

Register both members. For each:
- If `host` is `"local"`: `register_member(member_name=..., work_folder=...)` - no host/username/password needed.
- If `host` is an IP address: first attempt `setup_ssh_key(member_name=..., host=..., username=..., password={{secure.E2E_ACRED}})` then `register_member(member_name=..., host=..., username=..., auth_type="key", work_folder=...)`. If key setup fails, fall back to `register_member(member_name=..., host=..., username=..., password={{secure.E2E_ACRED}}, auth_type="password", work_folder=...)`.

After each: `update_member unattended="auto"`.

Provision LLM AUTH on both members.

Verify both online in `fleet_status`.

On each member verify `bd`: `which bd 2>/dev/null || find ~/.nvm -name bd -type f 2>/dev/null | head -1`
If missing: `npm install -g @beads/bd`

Verify `dolt`: `which dolt 2>/dev/null || ~/bin/dolt version 2>/dev/null`
If missing:
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

On each member: `echo "e2e-ok-$(hostname)"` - verify `e2e-ok-` in response.
Send a file containing `fleet-e2e-roundtrip` to each member, receive it back, verify content matches.
Write scratch files into the run directory (current working directory), not /tmp.

---
