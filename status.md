# apra-fleet — Status

**Last updated:** 2026-04-24

## Project
- **Base branch:** `main`
- **Repo:** Apra-Labs/apra-fleet

---

## Sprint 1 — Session Lifecycle + Auth UX (COMPLETE)

Issues: #147, #160, #148, #106

---

## Sprint 2 — Credential & Trust Model + Polish (COMPLETE — PR OPEN)

### Branch
`sprint/session-lifecycle-oob-fix` → main

### Issues
- **#157** Credential scoping — restrict secret access to 1, N, or all members ✅
- **#158** Credential TTL — auto-expire persistent credentials ✅
- **#163** provision_vcs_auth credential file isolation ✅
- **#54** Remove dangerously_skip_permissions from execute_prompt; unattended mode ✅

### Polish
- **Windows PID fix** — `pidWrapWindows` now emits Claude CLI PID via `Start-Process -PassThru` instead of PowerShell's `$PID`; `stop_prompt` now correctly kills the full process tree on Windows ✅ (`b238154`)

### PR
- **#183** — https://github.com/Apra-Labs/apra-fleet/pull/183
- Title updated to cover Sprint 1+2
- CI: Ubuntu ✅ | macOS ✅ | Windows ⏳ (pending)

### Tests
- 1006 passing, 0 failures (up from 984 post-Sprint 2, 906 at Sprint 1 baseline)

### Members

#### 🟠 fleet-dev (doer)
- **State:** IDLE — polish complete, branch clean at `b238154`

#### 🟧 fleet-rev (reviewer)
- **State:** IDLE — polish complete, branch clean at `b238154`

---

## Next Sprint: Sprint 3 — Session Comms + Data Layer

Clusters B + F:
- **#75** Inter-session attention mechanism (PM↔member communication) — requires Cluster A stable ✅
- **#152** Inter-fleet messaging — requires #75
- **#98** Glob patterns + directories in send_files/receive_files
- **#91** Git worktree .git path corruption on Windows
