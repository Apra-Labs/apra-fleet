## Planning Session
- Member: fleet-dev2
- Date: 2026-05-01
- Gemini session: C:\Users\akhil\.gemini\tmp\apra-fleet-2

---

# apra-fleet secret CLI – Implementation Plan

This plan outlines the redesign of the \pra-fleet\ secret management CLI, transitioning from the internal-only \uth\ command to a robust, user-facing \secret\ subcommand. The work includes hardening the credential store path management, creating the new CLI entry point, enhancing the Out-Of-Band (OOB) signaling mechanism, and providing comprehensive test coverage.

---

## Tasks

### Phase 1: Credential store path hardening

#### Task 1: Make CREDENTIALS_PATH call-time in src/services/credential-store.ts
- **Change:** Replace module-level \const CREDENTIALS_PATH = path.join(FLEET_DIR, 'credentials.json')\ with a function \getCredentialsPath()\ that reads \process.env.APRA_FLEET_DATA_DIR ?? FLEET_DIR\ at call time. Update all internal usages (\credentialSet\, \credentialGet\, \credentialList\, \credentialDelete\, \credentialResolve\, \purgeExpiredCredentials\).
- **Files:** src/services/credential-store.ts
- **Tier:** cheap
- **Done when:** \APRA_FLEET_DATA_DIR=/tmp/test apra-fleet secret --list\ reads from /tmp/test/credentials.json
- **Blockers:** none

#### VERIFY: Phase 1
- npm test passes
- Manually verify APRA_FLEET_DATA_DIR env var redirects vault path

---

### Phase 2: New secret CLI entry point

#### Task 2a: Create src/cli/secret.ts (OOB delivery path)
- **Change:** New file implementing \--set <name>\ and \--set <name> --persist\. Use \secureInput()\ from \utils/secure-input.ts\. Name must match \[a-zA-Z0-9_]{1,64}\.
    - **Use Case 1 (OOB delivery):** Connect to \getSocketPath()\ and send value to waiting request.
    - **Use Case 2 (OOB delivery + persist):** Same as (1), but also call \credentialSet\ to write to \credentials.json\.
    - **Use Case 3 (Persist only):** If no waiter on socket, require \--persist\. If missing, error: "No pending request for NAME. Use --persist to store for future use."
- **Files:** src/cli/secret.ts (new)
- **Tier:** standard
- **Done when:** \pra-fleet secret --set NAME\ delivers to waiting server; \--set NAME --persist\ writes to vault; errors correctly if no waiter and no \--persist\.
- **Blockers:** none

#### Task 2b: Create src/cli/secret.ts (Vault management)
- **Change:** Implement \--list\, \--update <name>\, \--delete <name>\, \--delete --all\.
    - **--list:** Print table with columns: NAME, SCOPE, POLICY, MEMBERS, EXPIRES. SCOPE is 'session' or 'persistent'. Values MUST NOT be shown.
    - **--update <name>:** Update metadata (flags: \--allow\, \--deny\, \--members <list>\, \--ttl <seconds>\) via \credentialUpdate\.
    - **--delete <name>:** Delete named secret via \credentialDelete\.
    - **--delete --all:** Prompt for confirmation: "Delete all secrets? Type yes to confirm: ".
- **Files:** src/cli/secret.ts
- **Tier:** standard
- **Done when:** Table displays correctly; metadata updates without re-entering value; \--all\ requires confirmation; invalid names rejected.
- **Blockers:** none

#### Task 3: Wire secret into src/index.ts
- **Change:** Add \else if (arg === 'secret')\ branch importing \cli/secret.js\. Update top-level \--help\ to show:
  \\\
    apra-fleet secret --set <name>           Deliver a secret to a waiting request
    apra-fleet secret --list                 List secrets
    apra-fleet secret --delete <name>        Delete a secret
  \\\
  Keep \uth\ branch as undocumented alias for backward compatibility.
- **Files:** src/index.ts
- **Tier:** cheap
- **Done when:** \pra-fleet secret --help\ reachable; \pra-fleet auth\ still works.
- **Blockers:** none

#### VERIFY: Phase 2
- npm run build passes
- \pra-fleet secret --help\ shows correct synopsis
- \pra-fleet --help\ shows secret lines, not auth line

---

### Phase 3: OOB signal upgrade in credential_store_set

#### Task 4: Three-signal OOB in src/tools/credential-store-set.ts
- **Change:** When waiting for OOB secret: (1) spawn terminal with \pra-fleet secret --set <name>\ (record spawned PID), (2) return tool message "Waiting for secret NAME. Run: apra-fleet secret --set NAME" to LLM console, (3) log to fleet log at info level. On receipt via any path: kill recorded terminal PID (SIGTERM on POSIX, \	askkill /F /PID\ on Windows).
- **Files:** src/tools/credential-store-set.ts, src/services/auth-socket.ts (add PID tracking)
- **Tier:** standard
- **Done when:** \credential_store_set\ returns waiting message immediately; auto-launched terminal closes on delivery.
- **Blockers:** Task 2a must be merged.

#### VERIFY: Phase 3
- npm test passes
- OOB flow tested manually or via integration test

---

### Phase 4: Tests

#### Task 5: Unit tests for secret CLI
- **Change:** Tests for \--set\ error cases; \--list\ table formatting; \--delete --all\ confirmation; name validation regex \[a-zA-Z0-9_]{1,64}\.
- **Files:** tests/secret-cli.test.ts (new)
- **Tier:** standard
- **Done when:** npm test passes

#### Task 6: Unit tests for credential-store path derivation
- **Change:** Test that \getCredentialsPath()\ respects \APRA_FLEET_DATA_DIR\ at call time.
- **Files:** tests/credential-store.test.ts (existing or new)
- **Tier:** cheap
- **Done when:** npm test passes

#### VERIFY: Phase 4
- npm test passes clean, all new tests included

---

## Risk Register

| Risk | Impact | Mitigation |
|------|--------|------------|
| PID kill cross-platform | med | Detect platform in kill helper, use \	askkill /F /PID\ on Windows |
| \uth\ alias backward compat | med | Keep \uth\ branch in \index.ts\; add integration test for \pra-fleet auth <name>\ |
| Non-TTY \secureInput\ fallback | low | Detect \process.stdin.isTTY\; if false, print error and exit 1 |
| CREDENTIALS_PATH refactor | med | Update all call sites in Task 1; run full test suite in VERIFY |
| Gemini trust directory | med | Already mitigated by compose_permissions \settings.json\ |

## Notes
- Base branch: main
- Each task = one git commit
- VERIFY = checkpoint, stop and report
