# Plan: DRY OAuth Support in provision_auth (Issue #62)

## PHASE 1: Update OS Commands for Generic Credentials

### Task 1: Update `OsCommands` Interface
- **File:** `src/os/os-commands.ts`
- **Changes:** Modify the signatures of `credentialFileCheck()`, `credentialFileWrite(json: string)`, and `credentialFileRemove()` to include a `provider: ProviderAdapter` parameter.

### Task 2: Implement Generic Credential Paths in OS Adapters
- **Files:** `src/os/linux.ts`, `src/os/macos.ts`, `src/os/windows.ts`
- **Changes:** Update the implementation of the three credential file methods to use `provider.credentialPath` instead of hardcoded `.claude` paths. Ensure OS-specific path resolution is handled (e.g. expanding `~` to `C:\Users\akhil` on Windows).

### Task 3: Update Credential Validation Logic
- **File:** `src/utils/credential-validation.ts`
- **Changes:** Update `validateCredentials` to accept a `provider: ProviderAdapter`. If `provider.name !== 'claude'`, return `{ status: 'valid' }` by default since we only validate Claude's token format currently.

## PHASE 2: Update Auth Orchestration

### Task 4: Refactor `provision-auth.ts`
- **File:** `src/tools/provision-auth.ts`
- **Changes:**
  - Update `readMasterCredentials()` to take `provider: ProviderAdapter` and resolve the `credentialPath`.
  - Update `provisionMasterToken()` to pass `provider` to `readMasterCredentials` and `cmds.credentialFileWrite`.
  - Replace `verifyWithClaudePrompt` with a generic `verifyWithPrompt` that uses `provider.headlessInvocation("hello")` and `cmds.agentCommand`.

### Task 5: Refactor `remove-member.ts`
- **File:** `src/tools/remove-member.ts`
- **Changes:** Pass the `provider` argument to `cmds.credentialFileRemove(provider)` during cleanup.

### Task 6: VERIFY
- **Action:** Run `npm run build` and `npm test` to ensure there are no type errors and all tests pass (fixing any test mocks as needed).
