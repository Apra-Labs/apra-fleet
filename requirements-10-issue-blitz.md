# Sprint Requirements — 10-Issue Blitz

This sprint implements 10 open issues from the apra-fleet backlog. Each issue below includes full context and acceptance criteria. The sprint must also run `npm test` as the integration test gate after each phase — all tests must pass before VERIFY is called.

---

## Issue #167 — ESM __dirname shim in compose-permissions.ts

**File:** `src/tools/compose-permissions.ts:63`
**Problem:** Uses bare `__dirname` in an ESM module. In dev mode via `tsx` this throws `ReferenceError: __dirname is not defined`. SEA binary is unaffected — dev mode only.
**Fix:**
```ts
import { fileURLToPath } from 'url';
import { dirname } from 'path';
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
```
Same shim already applied to `install.ts` in #33.
**Acceptance:** `tsx src/tools/compose-permissions.ts` does not throw ReferenceError. `npm test` passes.

---

## Issue #161 — Release update notification in fleet_status

**Summary:** On server start, fetch the latest release tag from the GitHub Releases API and compare with the installed version. If newer, surface a one-line notice in `fleet_status` output.

**Behaviour:**
1. On server start: `GET https://api.github.com/repos/Apra-Labs/apra-fleet/releases/latest` → `tag_name`. Compare semver with installed version (from `version.json`). Cache result for the session. Fire-and-forget: failure must never block startup or any tool call.
2. `fleet_status` includes the notice when a newer version exists:
   > ℹ️ apra-fleet v0.1.8 is available (installed: v0.1.7). Run `/pm deploy apra-fleet` to update.
3. No output when already on latest version.
4. Update fleet skill `SKILL.md` to instruct the PM to surface this notice and offer `/pm deploy apra-fleet`.

**Acceptance criteria:**
- `fleet_status` shows update notice when mock latest tag > installed version
- `fleet_status` silent when already on latest
- Network failure during version check is silent — no error in tool output
- Unit tests cover: newer version triggers notice, same version silent, network failure silent, pre-release tags ignored
- `npm test` passes

---

## Issue #146 — receive_files rejects all paths on Windows remote members

**Problem:** Path resolution uses a string prefix check. On Windows, `work_folder` uses backslashes (`C:\Users\aUser\ODM`) but `path.resolve()` may normalise to forward slashes or vice versa, causing the prefix check to fail even for valid relative paths.

**Affected paths (all rejected):**
```
"build\logs\net.log"
"build/logs/net.log"
"net.log"
"C:\Users\aUser\ODM\net.log"
```

**Fix:** Use `path.normalize()` on both sides of the containment check, or use a cross-platform path containment helper. Detect platform correctly — do not assume Unix separators.

**Acceptance:** Unit tests covering all four path formats above pass on a simulated Windows work_folder (`C:\Users\aUser\ODM`). `npm test` passes.

---

## Issue #150 — register_member: confusing error when SSH auth fails

**Problem:** All SSH auth failures produce identical generic message:
```
❌ Failed to connect to <host>:22 — All configured authentication methods failed
```
Cannot distinguish: wrong password / OOB prompt didn't open / host unreachable / wrong port.

Additionally: the post-register hook fires and prints the onboarding checklist even when registration **fails**.

**Fix:**
1. Parse the underlying SSH error to produce specific messages:
   - `Authentication failed` → `Authentication failed — wrong password or key not accepted`
   - `ECONNREFUSED` → `Connection refused — check host and port`
   - `ETIMEDOUT` / `ENOTFOUND` → `Host unreachable — check hostname and network`
   - OOB prompt window failed to open → `Password prompt could not be opened. Try passing the password directly via the 'password' field.`
2. Post-register hook must only fire on successful registration.

**Acceptance:** Unit tests covering each error code → message mapping. Hook invocation gated on success. `npm test` passes.

---

## Issue #70 — send_files: preserve relative paths / warn on collision

**Problem:** `send_files` places files by basename only. If two source files share a name (different directories), the second silently overwrites the first on the member.

**Fix (choose one):**
- Option A (preferred): Preserve the relative path structure from the declared source root on placement
- Option B: Detect basename collision and return an error before any transfer

**Acceptance:** Test with two files of the same name in different source directories — either paths are preserved or an error is returned. No silent overwrite. `npm test` passes.

---

## Issue #8 — Stale task directories cleanup

**Problem:** Long-running tasks create `~/.fleet-tasks/<taskId>/` with output logs, activity markers, and PID files. Never cleaned up. Accumulates on VMs.

**Fix:**
- On task completion (success): schedule cleanup after 1-hour retention
- On task failure: retain for 7 days
- On server startup: scan `~/.fleet-tasks/` and remove directories older than their retention window
- `FLEET_TASK_RETENTION_HOURS` env var override (default: 168 for failures, 1 for success)

**Acceptance:** Tests confirm retention logic, startup scan, and env var override. `npm test` passes.

---

## Issue #69 — provision_auth: auto-remove credential helper after token expiry

**Problem:** `gitCredentialHelperWrite()` writes `~/.fleet-git-credential` and sets git config. Token expires in ~1 hour. File and git config entry linger indefinitely.

**Fix:** Schedule cleanup at token expiry (from `expiresAt`) or safe default TTL (55 min). Cleanup: remove `~/.fleet-git-credential` and unset `credential.helper` in git config. Store timer per credential. Best-effort — cleanup failure must not surface to user.

**Acceptance:** Tests verify cleanup scheduled and fires at TTL. Multiple simultaneous credentials don't clobber each other. `npm test` passes.

---

## Issue #144 — SSH usernames containing spaces

**Problem:** Usernames like `tester tester` (valid on Windows) fail registration. Suspected: username split on whitespace somewhere before being passed to the SSH library.

**Investigation:** Trace username from `register_member` input → SSH client construction. If interpolated into a shell string, add proper quoting/escaping.

**Fix:** Pass username directly as parameter to the SSH library — never interpolate into a shell string. Accept usernames with spaces in input validation.

**Acceptance:** Unit test: `username = "tester tester"` constructs SSH connection with correct username (not split). Input validation accepts spaces. `npm test` passes.

---

## Issue #72 — remove_member: full decommissioning protocol

**Problem:** `remove_member` leaves behind SSH public key in `authorized_keys` and remote working folder with sprint files.

**Full decommission flow:**
1. Verify member is idle
2. Revoke VCS auth (remove git credential helper + git config entry)
3. Remove fleet SSH public key from remote `~/.ssh/authorized_keys`
4. Remove from registry

Local members: skip SSH key step. Skip remote folder deletion (non-destructive default).

**Acceptance:** Tests verify idle check, VCS revoke call, SSH key removal attempted for remote (not local). `npm test` passes.

---

## Issue #151 — Local members wastefully load fleet-mcp on startup

**Problem:** Local members load fleet-mcp (the PM's MCP server) in their Claude Code config. Doers and reviewers don't need fleet-mcp — it wastes startup time and memory.

**Investigation:** Determine how fleet-mcp is registered. Evaluate options:
- A: Pass `--no-mcp` flag (or equivalent) to suppress fleet-mcp loading in member dispatch
- B: `compose_permissions` delivers a member config that explicitly disables fleet-mcp
- C: Move fleet-mcp to a PM-only profile

Pick the least disruptive option. Document decision in `design.md`.

**Acceptance:** Chosen option implemented. PM can still use fleet-mcp. Local member dispatches in test do not include fleet-mcp. `npm test` passes.

---

## Integration Testing Gate

After every VERIFY phase:
1. `npm run build` — must succeed with 0 errors
2. `npm test` — all tests must pass
3. Report: test count before vs after (each issue must add ≥ 1 new test)
4. Run `npm run lint` if available

Reviewer must verify test count increased — "tests pass" is not sufficient if no new tests were added for an issue.
