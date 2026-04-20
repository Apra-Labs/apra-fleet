# Plan: Features A and E — Credential Store Expansion

## Branch: feat/oob-improvements
## Base: main

## Feature A — OOB fallback for provision_vcs_auth and provision_auth

Add OOB (out-of-band TTY) fallback to provision_vcs_auth and provision_auth, matching the pattern in register_member/update_member. If credential field is absent, prompt user OOB rather than erroring.

### Task A1 — provision_vcs_auth OOB fallback
- **File:** src/tools/provision-vcs-auth.ts
- **Done when:** GitHub token, Bitbucket api_token, Azure DevOps pat each have OOB fallback via collectOobApiKey()
- **Status:** completed (commits afed739, 60f9fdd)

### Task A2 — provision_auth OOB fallback
- **File:** src/tools/provision-auth.ts
- **Done when:** api_key has OOB fallback via collectOobApiKey()
- **Status:** completed (commits afed739, 60f9fdd)

---

## Feature E — {{secure.NAME}} in setup_git_app private_key_path

Support {{secure.NAME}} token in private_key_path where resolved value is PEM key content (not a file path). Write to temp file, pass to existing loadPrivateKey(), delete in finally block.

### Task E1 — Implement token resolution + temp file handling
- **File:** src/tools/setup-git-app.ts
- **Done when:** {{secure.NAME}} in private_key_path resolves to PEM content, written to temp file, deleted after use. Plain file path unchanged.
- **Status:** completed (commit 75bdcf9)

### Task E2 — Tests
- **File:** tests/setup-git-app.test.ts
- **Done when:** test for {{secure.NAME}} → PEM content path, test for plain file path regression
- **Status:** completed (commit 75bdcf9)

### Task E3 — Rebase, build, test, push
- Rebase local commits onto origin/feat/oob-improvements
- npm run build — clean
- npm test — all pass
- git push origin feat/oob-improvements
- **Status:** completed (build clean, 784 tests pass, pushed)
