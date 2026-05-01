## Planning Session
- Member: fleet-dev2
- Date: 2026-05-01
- Gemini session: 5a72fea9 (start fresh session on fleet-dev2 to resume planning context)

---

# Credential audit log — Implementation Plan

> Add an append-only audit log at `~/.apra-fleet/data/credential-audit.log` that records every credential lifecycle event (SET, DELETED, RESOLVED, REJECTED, EXPIRED) — names only, no values.

---

## Tasks

### Phase 1: Audit log service

#### Task 1: Create `src/services/credential-audit.ts`
- **Change:** New module exporting a single function `appendAuditLog(entry: AuditEntry): void`. `AuditEntry` type: `{ event: 'SET' | 'DELETED' | 'RESOLVED' | 'REJECTED' | 'EXPIRED'; member: string; credential: string; tool?: string; scope?: string; reason?: string }`. The function: (1) formats a log line as `<ISO8601>  <EVENT>  member=<m>  credential=<c> [tool=<t>] [scope=<s>] [reason=<r>]` — optional fields omitted if absent; (2) appends to `path.join(FLEET_DIR, 'credential-audit.log')` using `fs.appendFileSync`; (3) enforces `0o600` on the file after the first write (check with `fs.statSync` — set mode only if file was just created, avoid repeated chmod on every append); (4) rotates: if file size exceeds `MAX_AUDIT_LOG_BYTES` (default `10 * 1024 * 1024`), rename `.log` → `.log.1` (overwriting any prior `.1`) then start fresh. Rotation and append are best-effort — catch and swallow errors so a log failure never breaks the calling operation.
- **Files:** `src/services/credential-audit.ts` (new)
- **Tier:** cheap
- **Done when:** Unit test can call `appendAuditLog()` and read back a correctly-formatted line; rotation triggers at the configured byte threshold; file mode is `0o600`
- **Blockers:** none

#### VERIFY: Phase 1
- `npm run build` passes
- `npm test` passes (new unit tests from Task 1)

---

### Phase 2: Wire audit events into credential-store.ts

#### Task 2: Add `tool?: string` parameter to `credentialResolve()`
- **Change:** In `src/services/credential-store.ts`, add an optional third parameter `tool?: string` to `credentialResolve(name, callingMember?, tool?)`. This parameter is threaded through to the audit calls added in Task 3. No change to callers yet — the parameter is optional, so existing callers compile unchanged.
- **Files:** `src/services/credential-store.ts`
- **Tier:** cheap
- **Done when:** `npm run build` passes; function signature updated; no callers broken
- **Blockers:** Task 1

#### Task 3: Add audit calls to all credential-store events
- **Change:** In `src/services/credential-store.ts`, call `appendAuditLog()` at each event point — import from `./credential-audit.js`:
  - `credentialSet()` — after writing to store: `appendAuditLog({ event: 'SET', member: 'PM', credential: name, scope: allowedMembers === '*' ? '*' : allowedMembers.join(',') })`
  - `credentialDelete()` — after deletion confirmed: `appendAuditLog({ event: 'DELETED', member: 'PM', credential: name })`
  - `credentialResolve()` — four paths: (a) `{ expired }` returned → `appendAuditLog({ event: 'REJECTED', member: callingMember ?? 'PM', credential: name, tool, reason: 'expired' })`; (b) `{ denied }` returned → `appendAuditLog({ event: 'REJECTED', member: callingMember ?? 'PM', credential: name, tool, reason: 'scope_violation' })`; (c) success → `appendAuditLog({ event: 'RESOLVED', member: callingMember ?? 'PM', credential: name, tool })`; (d) `null` returned (not found) — no audit entry (credential doesn't exist; not a security event)
  - `purgeExpiredCredentials()` — for each deleted credential: `appendAuditLog({ event: 'EXPIRED', member: 'PM', credential: name })`
- **Files:** `src/services/credential-store.ts`
- **Tier:** standard
- **Done when:** All 5 event types appear in the log file during a manual test session; `npm test` passes
- **Blockers:** Tasks 1, 2

#### VERIFY: Phase 2
- `npm run build` passes
- `npm test` passes
- Manual: run `credential_store_set` + `execute_command` with `{{secure.NAME}}` → verify both `SET` and `RESOLVED` lines appear in `~/.apra-fleet/data/credential-audit.log`

---

### Phase 3: Update call sites to pass tool name

#### Task 4: Pass `tool` name at all `credentialResolve()` call sites
- **Change:** Update the 7 call sites that call `credentialResolve()` to pass the tool name as the third argument:
  - `src/tools/execute-command.ts` → `credentialResolve(name, callingMember, 'execute_command')`
  - `src/tools/provision-auth.ts` → `credentialResolve(name, agent.friendlyName, 'provision_auth')`
  - `src/tools/provision-vcs-auth.ts` → `credentialResolve(name, callingMember, 'provision_vcs_auth')`
  - `src/tools/register-member.ts` → `credentialResolve(name, input.friendly_name, 'register_member')`
  - `src/tools/setup-git-app.ts` → `credentialResolve(tokenMatch[1], '*', 'setup_git_app')`
  - `src/tools/update-member.ts` → `credentialResolve(name, existing.friendlyName, 'update_member')`
  - `src/tools/credential-store-update.ts` → `credentialResolve(input.name, undefined, 'credential_store_update')`
- **Files:** All 7 files listed above
- **Tier:** cheap
- **Done when:** All 7 files updated; `npm run build` passes; audit log entries for each tool show the correct `tool=` field
- **Blockers:** Task 2

#### VERIFY: Phase 3
- `npm run build` passes
- `npm test` passes
- Each tool's `RESOLVED` log entry includes the correct `tool=` value

---

### Phase 4: Tests

#### Task 5: Unit tests for `credential-audit.ts`
- **Change:** In `tests/credential-audit.test.ts` (new), using `tmp` directory and mocked `FLEET_DIR`: (a) `appendAuditLog()` with all optional fields → assert full line format; (b) with no optional fields → assert optional fields absent; (c) rotation: create a log file at `MAX_AUDIT_LOG_BYTES - 1` bytes, call `appendAuditLog()`, assert `.log.1` created and `.log` is fresh single line; (d) file mode: assert `0o600` after first write; (e) errors swallowed: mock `fs.appendFileSync` to throw → assert no exception propagates.
- **Files:** `tests/credential-audit.test.ts` (new)
- **Tier:** standard
- **Done when:** `npm test` passes with all 5 cases covered
- **Blockers:** Task 1

#### Task 6: Integration tests for credential-store audit calls
- **Change:** In `tests/credential-store.test.ts` (create if absent), spy on `appendAuditLog` from `credential-audit.ts`. Test: (a) `credentialSet()` → spy called with `{ event: 'SET', member: 'PM', credential: name }`; (b) `credentialDelete()` → spy called with `{ event: 'DELETED' }`; (c) `credentialResolve()` success → `{ event: 'RESOLVED', tool: 'execute_command' }`; (d) `credentialResolve()` scope denied → `{ event: 'REJECTED', reason: 'scope_violation' }`; (e) `credentialResolve()` expired → `{ event: 'REJECTED', reason: 'expired' }`; (f) `purgeExpiredCredentials()` → `{ event: 'EXPIRED' }`.
- **Files:** `tests/credential-store.test.ts`
- **Tier:** standard
- **Done when:** `npm test` passes with all 6 cases covered
- **Blockers:** Tasks 3, 4

#### VERIFY: Phase 4
- `npm test` passes clean across all suites
- `credential-audit.log` present after a real session with correct entries

---

## Risk Register

| Risk | Impact | Mitigation |
|------|--------|------------|
| Audit write fails (disk full, permission error) — breaks credential operations | high | `appendAuditLog()` catches all errors and swallows them; credential operations are never blocked by audit |
| Log file grows unbounded on high-volume deployments | med | Rotation at 10MB cap (configurable via `FLEET_AUDIT_MAX_BYTES` env var) |
| `0o600` chmod on every append adds latency at scale | low | Check file size only once per write; mode set only on first write |
| Rotation race condition: two concurrent resolves at boundary | low | Fleet is single-process; no concurrency concern |
| `callingMember` is `undefined` at some call sites — log shows `PM` | low | Intentional: undefined member = operator/PM context; documented in audit entry |

## Notes
- Base branch: `main`
- Implementation branch: `feat/credential-audit-log`
- Each task = one git commit
- VERIFY = checkpoint, stop and report
- Audit log path: `path.join(FLEET_DIR, 'credential-audit.log')` — respects `APRA_FLEET_DATA_DIR` env override
