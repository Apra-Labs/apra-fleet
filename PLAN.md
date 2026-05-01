## Planning Session
- Member: fleet-dev2
- Date: 2026-05-01
- Gemini session: C:\Users\akhil\.gemini\tmp\apra-fleet-2

---

# apra-fleet secret CLI – Implementation Plan

This plan outlines the redesign of the \pra-fleet\ secret management CLI, transitioning from the internal-only \uth\ command to a robust, user-facing \secret\ subcommand. The work includes creating the new CLI entry point, enhancing the Out-Of-Band (OOB) signaling mechanism for secret delivery, hardening the credential store path management to support environment-based overrides, and providing comprehensive test coverage.

---

## Tasks

### Phase 1: New secret CLI entry point

#### Task 1: Create src/cli/secret.ts
- **Change:** New file implementing --set, --set --persist, --list, --update, --delete, --delete --all. Read requirements.md for exact flag semantics. Reuse secureInput() from utils/secure-input.ts. Connect to getSocketPath() for OOB delivery. Call credentialSet/credentialList/credentialDelete/credentialUpdate from services/credential-store.ts for vault ops.
- **Files:** src/cli/secret.ts (new)
- **Tier:** standard
- **Done when:** \pra-fleet secret --help\ shows correct synopsis; --set with no waiter and no --persist errors correctly; --list shows table
- **Blockers:** none

#### Task 2: Wire secret into src/index.ts
- **Change:** Add \else if (arg === 'secret')\ branch importing cli/secret.js. Update --help block to replace auth line with secret lines. Keep \uth\ branch as undocumented alias.
- **Files:** src/index.ts
- **Tier:** cheap
- **Done when:** \pra-fleet secret --help\ reachable from CLI; \pra-fleet auth\ still works as undocumented path
- **Blockers:** none

#### VERIFY: Phase 1
- npm run build passes
- apra-fleet secret --help shows synopsis from requirements
- apra-fleet secret --set testkey (no server running) errors with correct message
- apra-fleet --help shows secret lines, not auth line

---

### Phase 2: OOB signal upgrade in credential_store_set

#### Task 3: Three-signal OOB in src/tools/credential-store-set.ts
- **Change:** When waiting for OOB secret: (1) spawn terminal with \pra-fleet secret --set <name>\ (record spawned PID), (2) return tool message "Waiting for secret NAME. Run: apra-fleet secret --set NAME" to LLM console, (3) log to fleet log at info level. On receipt via any path: kill recorded terminal PID (SIGTERM/taskkill).
- **Files:** src/tools/credential-store-set.ts, src/services/auth-socket.ts (add PID tracking)
- **Tier:** standard
- **Done when:** credential_store_set returns the waiting message immediately; auto-launched terminal closes when secret delivered via separate shell
- **Blockers:** PID kill cross-platform (SIGTERM on POSIX, taskkill on Windows)

#### VERIFY: Phase 2
- npm test passes
- credential_store_set OOB flow tested manually or via integration test

---

### Phase 3: Credential store path hardening

#### Task 4: Make CREDENTIALS_PATH call-time in src/services/credential-store.ts
- **Change:** Replace module-level \const CREDENTIALS_PATH = path.join(FLEET_DIR, 'credentials.json')\ with a function \getCredentialsPath()\ that reads \process.env.APRA_FLEET_DATA_DIR ?? FLEET_DIR\ at call time. Update all internal usages.
- **Files:** src/services/credential-store.ts
- **Tier:** cheap
- **Done when:** \APRA_FLEET_DATA_DIR=/tmp/test apra-fleet secret --list\ reads from /tmp/test/credentials.json
- **Blockers:** none (purely internal refactor, no public API change)

#### VERIFY: Phase 3
- npm test passes
- Manually verify APRA_FLEET_DATA_DIR env var redirects vault path

---

### Phase 4: Tests

#### Task 5: Unit tests for secret CLI
- **Change:** Tests for --set error when no waiter and no --persist; --list table format; --delete --all confirmation prompt; name validation regex.
- **Files:** tests/secret-cli.test.ts (new)
- **Tier:** standard
- **Done when:** npm test passes with new suite

#### Task 6: Unit tests for credential-store path derivation
- **Change:** Test that getCredentialsPath() respects APRA_FLEET_DATA_DIR.
- **Files:** tests/credential-store.test.ts (existing or new)
- **Tier:** cheap
- **Done when:** npm test passes

#### VERIFY: Phase 4
- npm test passes clean, all new tests included

---

## Risk Register

| Risk | Impact | Mitigation |
|------|--------|------------|
| PID kill cross-platform (SIGTERM vs taskkill) | med | Detect platform in kill helper, use taskkill /F /PID on Windows |
| auth socket backward compat – auth.ts still uses old collectOobApiKey signature | low | Keep auth.ts unchanged; only credential-store-set.ts uses new multi-signal flow |
| CREDENTIALS_PATH refactor breaks existing tests | med | Update all call sites in same commit; run full test suite in VERIFY |
| Gemini trust directory blocks execute_prompt | med | Already mitigated by compose_permissions settings.json |

## Notes
- Base branch: main
- Each task = one git commit
- VERIFY = checkpoint, stop and report
