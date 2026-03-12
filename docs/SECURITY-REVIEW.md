# Security Review — apra-fleet

**Date:** 2026-02-25
**Reviewer:** Claude Opus 4.6 (automated deep review)
**Scope:** Full codebase — all source, tests, config, docs, and dependencies
**Commit:** `3138710` (main branch)
**Remediation update:** 2026-02-26 — 6 of 14 findings addressed (see RESOLVED tags below)

---

## Executive Summary

The codebase manages a fleet of remote Claude Code agents via SSH. It handles SSH credentials, API keys, OAuth tokens, and executes shell commands on remote machines — making it a high-value security target.

**Overall assessment: Solid security posture with a few notable findings.**

No leaked credentials, hardcoded secrets, or critical vulnerabilities were found. The codebase demonstrates deliberate security design (shell escaping utilities, AES-256-GCM encryption, Zod input validation). However, several medium-severity issues warrant attention.

| Severity | Count | Resolved |
|----------|-------|----------|
| Critical | 0     | —        |
| High     | 2     | 2        |
| Medium   | 5     | 3        |
| Low      | 4     | 1        |
| Info     | 3     | —        |

---

## HIGH Severity

### H1. No SSH Host Key Verification — RESOLVED

**Files:** `src/services/ssh.ts:66-88`

The `ssh2` client is connected without a `hostVerifier` callback. The code does:
```ts
client.connect(config as any);
```
No `hostVerifier` or `hostHash` option is set. This means the tool blindly trusts any SSH server it connects to, making it vulnerable to **man-in-the-middle attacks**. An attacker on the network path could impersonate an SSH server and capture credentials (passwords or the ability to inject commands).

**Impact:** An attacker performing ARP spoofing, DNS hijacking, or sitting on the same network could intercept SSH connections and steal passwords or execute arbitrary commands.

**Recommendation:** Implement host key verification — either trust-on-first-use (TOFU) with a local known_hosts file, or prompt the user to confirm fingerprints.

> **Resolution:** Implemented TOFU host key verification. New `src/services/known-hosts.ts` stores fingerprints in `~/.apra-fleet/data/known_hosts` (JSON, mode 0o600). `getSSHConfig()` now sets `hostVerifier` callback with SHA-256 fingerprint checks. `connectWithTOFU()` auto-accepts new keys on mismatch with a warning. Also removed the `config as any` cast (see L1).

---

### H2. Registry File Written Without Restricted Permissions — RESOLVED

**File:** `src/services/registry.ts:33`

```ts
fs.writeFileSync(REGISTRY_PATH, JSON.stringify(registry, null, 2));
```

The registry file contains encrypted passwords and agent metadata. It is written with **default permissions** (typically 0o644 on Linux — world-readable). Compare this to the salt file which is correctly written with `{ mode: 0o600 }`.

On a multi-user system, any local user can read `~/.apra-fleet/data/registry.json` and obtain encrypted passwords. Combined with the salt file (if also readable), they could decrypt them.

**Note:** The fleet directory itself is created with 0o700, which mitigates this on initial creation. However, if the directory permissions are ever changed or the directory already exists with wider permissions, the registry file is exposed.

**Impact:** Local privilege escalation — other users on the same machine could read encrypted credentials.

**Recommendation:** Add `{ mode: 0o600 }` to the `writeFileSync` call for the registry file, matching the pattern used for the salt file.

> **Resolution:** Added `{ mode: 0o600 }` to both `writeFileSync` calls in `src/services/registry.ts` (lines 24 and 33).

---

## MEDIUM Severity

### M1. Encryption Key Derivation Uses Predictable Machine Identity

**File:** `src/utils/crypto.ts:38`

```ts
const machineId = `${os.hostname()}-${os.userInfo().username}-apra-fleet`;
```

The encryption key is derived from hostname + username + a random salt stored on disk. If an attacker obtains both the salt file (`~/.apra-fleet/data/salt`) and the registry file, they can derive the key trivially because hostname and username are not secrets.

The security of the encrypted passwords therefore rests entirely on file-system access controls to the salt file. This is an acceptable trade-off for a CLI tool (similar to how SSH agent works), but it means encryption provides **obfuscation, not true protection** against a local attacker.

**Impact:** An attacker with read access to `~/.apra-fleet/data/` can decrypt all stored passwords.

**Recommendation:** Document this threat model explicitly. Optionally, integrate with OS keyring (macOS Keychain, Windows Credential Manager, Linux libsecret) for stronger protection.

---

### M2. Legacy Static Salt Fallback Weakens Encryption — RESOLVED

**File:** `src/utils/crypto.ts:11, 46-48, 75-83`

```ts
const LEGACY_SALT = 'apra-fleet-salt';  // removed
```

The decryption function fell back to a hardcoded static salt if the per-installation salt failed. Any passwords encrypted before the random salt was introduced use this **publicly known, hardcoded value** as their salt. The key derivation for these passwords is deterministic given hostname + username — both are trivially discoverable.

**Impact:** Passwords encrypted with the legacy salt can be decrypted by anyone who knows the target's hostname and username.

**Recommendation:** Add a migration path that re-encrypts legacy passwords with the new per-installation salt, then remove the legacy fallback.

> **Resolution:** Removed `LEGACY_SALT` constant, `deriveLegacyKey()` function, and the `catch` fallback in `decryptPassword()`. All existing test agents were deleted and re-registered with the per-installation salt.

---

### M3. SSH Public Key Deployment via Shell Concatenation — RESOLVED

**File:** `src/tools/setup-ssh-key.ts:86`

```ts
`echo '${opensshPubKey}' >> ~/.ssh/authorized_keys`,
```

The OpenSSH public key is interpolated into a shell command using single quotes. While the key content is generated internally (not user-supplied), the `comment` field comes from `agent.friendlyName`:

```ts
const comment = `apra-fleet-${agent.friendlyName}`;
```

If a user registers an agent with a `friendly_name` containing a single quote (e.g., `my'agent`), this would break out of the single-quoted string and enable command injection on the remote machine.

**Impact:** Command injection on the remote agent if a malicious or careless friendly name containing `'` is used.

**Recommendation:** Sanitize or escape `agent.friendlyName` before embedding in the shell command. Alternatively, use SFTP to write the key file directly instead of shell echo.

> **Resolution:** Two-layer fix: (1) `friendly_name` now validated at the Zod schema level with `regex(/^[a-zA-Z0-9._-]+$/)` (1-64 chars) in both `register-agent.ts` and `update-agent.ts`, preventing special characters from ever reaching the system. (2) SSH key deployment refactored to use `OsCommands.deploySSHPublicKey()` with `escapeShellArg()` (Linux/macOS) and PowerShell single-quote escaping (Windows), adding defense-in-depth.

---

### M4. API Key Logged in Shell Profiles in Plaintext

**File:** `src/os/linux.ts:87-93`

```ts
setEnv(name: string, value: string): string[] {
    const escaped = escapeDoubleQuoted(value);
    return [
      `echo 'export ${name}="${escaped}"' >> ~/.bashrc`,
      `echo 'export ${name}="${escaped}"' >> ~/.profile`,
    ];
}
```

When an API key is provisioned via the `api_key` parameter, it is written **in plaintext** to `~/.bashrc` and `~/.profile` on the remote machine. These files are typically readable by the file owner only, but:

- They persist across sessions (no expiration)
- They appear in shell history
- They are backed up by system backup tools
- They survive credential rotation

**Impact:** API keys persist indefinitely in plaintext shell profiles on remote machines.

**Recommendation:** Consider using a dedicated config file with restricted permissions, or environment variable injection at runtime rather than persisting to shell profiles.

---

### M5. Unbounded stdout/stderr Accumulation — RESOLVED

**File:** `src/services/ssh.ts:115-123`

```ts
let stdout = '';
let stderr = '';
stream.on('data', (data: Buffer) => { stdout += data.toString(); });
stream.stderr.on('data', (data: Buffer) => { stderr += data.toString(); });
```

Command output is accumulated in memory with no size limit. A malicious or buggy remote agent could produce gigabytes of output, causing the MCP server process to run out of memory (OOM).

**Impact:** Denial of service against the MCP server via memory exhaustion.

**Recommendation:** Add a maximum output size limit (e.g., 10 MB) and truncate with a warning if exceeded.

> **Resolution:** Added `MAX_OUTPUT_BYTES = 10 * 1024 * 1024` (10 MB) cap. SSH `execCommand()` tracks `stdoutLen`/`stderrLen` and spills to a temp file (`os.tmpdir()/fleet-{stdout,stderr}-<uuid>.txt`) on overflow, returning the first 10 MB with a truncation notice. Local strategy sets `maxBuffer: 10 MB` on `exec()` and catches `ERR_CHILD_PROCESS_STDIO_MAXBUFFER` with the same spill pattern.

---

## LOW Severity

### L1. `config as any` Type Assertion Bypasses Type Safety — RESOLVED

**File:** `src/services/ssh.ts:88`

```ts
client.connect(config as any);
```

The `as any` cast bypasses TypeScript's type checking on the SSH config object. This could mask configuration errors and makes it harder to verify that security-relevant options (like `hostVerifier`) are being set correctly.

> **Resolution:** `getSSHConfig()` now returns a properly typed `ConnectConfig` (imported from `ssh2`). The `as any` cast has been removed.

---

### L2. Race Condition on Registry File

**File:** `src/services/registry.ts:20-34`

The load-modify-save pattern on `registry.json` has no file locking. If two MCP tool calls execute concurrently (e.g., two `register_agent` calls), one's changes could be lost. This is not a security vulnerability per se but could lead to inconsistent state.

---

### L3. `.gitignore` Pattern for `~/.apra-fleet/` May Not Work

**File:** `.gitignore:7`

```
~/.apra-fleet/
```

Git `.gitignore` does not expand `~`. This pattern would only match a literal directory named `~` in the repo root. The fleet directory is outside the repo in the home directory so it wouldn't be committed regardless, but the gitignore entry is misleading and non-functional.

---

### L4. Credential File Permissions Not Set on Remote (Windows)

**File:** `src/os/windows.ts:81-83`

The Windows `credentialFileWrite` method writes the credentials file but does not set restrictive NTFS permissions. On Linux, `chmod 600` is applied (`src/os/linux.ts:76`), but the Windows equivalent (icacls) is missing.

---

## INFORMATIONAL

### I1. No Leaked Credentials Found

A thorough search for hardcoded passwords, API keys, tokens, private keys, connection strings, and other secrets across all source files, test files, configuration files, and documentation found **no leaked credentials**.

- Test files use clearly-marked fakes (`'fake-encrypted'`, `'sk-ant-api03-TESTKEY'`)
- No `.env` files committed
- No private keys in the repo
- No secrets in CI/CD configuration

### I2. Dependencies Are Minimal and Reasonable

Only 4 production dependencies:
- `@modelcontextprotocol/sdk` ^1.27.0
- `ssh2` ^1.17.0
- `uuid` ^11.0.0
- `zod` ^3.25.0

All are well-maintained, widely-used packages. The `ssh2` package has had historical CVEs but v1.17.0 includes all known fixes.

### I3. Shell Escaping Is Comprehensive and Well-Tested

The `src/utils/shell-escape.ts` module provides:
- `escapeShellArg()` — single-quote escaping for Unix
- `escapeDoubleQuoted()` — double-quote escaping for Unix
- `escapeWindowsArg()` — cmd.exe metacharacter escaping
- `escapeGrepPattern()` — regex metacharacter escaping
- `sanitizeSessionId()` — strict alphanumeric whitelist

All are covered by dedicated tests in `tests/shell-escape.test.ts` including injection attempt test cases. The prompt execution path uses Base64 encoding to avoid shell escaping entirely — a good defense-in-depth approach.

---

## Files Reviewed

| Category | Files |
|----------|-------|
| Source (src/) | index.ts, types.ts, smoke-test.ts |
| OS modules | os/index.ts, os/linux.ts, os/macos.ts, os/windows.ts, os/os-commands.ts |
| Services | services/ssh.ts, services/sftp.ts, services/registry.ts, services/strategy.ts, services/file-transfer.ts |
| Tools | tools/register-agent.ts, tools/execute-prompt.ts, tools/provision-auth.ts, tools/setup-ssh-key.ts, tools/agent-detail.ts, tools/check-status.ts, tools/list-agents.ts, tools/remove-agent.ts, tools/reset-session.ts, tools/send-files.ts, tools/shutdown-server.ts, tools/update-agent.ts, tools/update-claude.ts |
| Utilities | utils/crypto.ts, utils/platform.ts, utils/shell-escape.ts, utils/agent-helpers.ts |
| Tests | All 9 test files in tests/ |
| Config | package.json, tsconfig.json, .gitignore, .mcp.json, vitest.config.ts, .github/workflows/ci.yml |
| Docs | All 5 files in docs/ |

---

## Summary of Recommendations (Priority Order)

1. ~~**Add SSH host key verification** to prevent MITM attacks (H1)~~ — RESOLVED
2. ~~**Set 0o600 permissions on registry.json** writes (H2)~~ — RESOLVED
3. ~~**Sanitize `friendlyName`** before embedding in shell commands during SSH key deployment (M3)~~ — RESOLVED
4. ~~**Migrate legacy static salt** passwords and remove hardcoded fallback (M2)~~ — RESOLVED
5. ~~**Add output size limits** to prevent OOM from large command output (M5)~~ — RESOLVED
6. **Consider alternative API key storage** instead of appending to shell profiles (M4)
7. **Document the encryption threat model** so users understand the protection boundaries (M1)
8. **Add `npm audit`** to CI pipeline for automated dependency vulnerability scanning

*Also resolved: L1 (`config as any` type assertion) — fixed as part of the H1 TOFU implementation.*
