# Master-Key Hardening Plan

Status: DRAFT | Author: design-agent | Date: 2026-06-05

---

## 1. Threat Model & Goals

### Current State

The credential store uses AES-256-GCM with a 32-byte random Data
Encryption Key (DEK) stored **hex-encoded in plaintext** at
`~/.apra-fleet/data/salt` (`src/utils/crypto.ts:10,30-31`).
Encrypted credentials live in `credentials.json` in the same directory
(`src/services/credential-store.ts:74-77`).  The encryption format is
`IV:authTag:ciphertext` (all hex) per `crypto.ts:58`.

File permissions are set to `0o600` on Unix via `enforceOwnerOnly()`
(`src/utils/file-permissions.ts:9-12`), but **the function is a no-op
on Windows** (`file-permissions.ts:10`).  No OS keystore is used
anywhere.  The function is called from seven sites across the codebase
(credential-store, registry, git-config, onboarding, known-hosts,
setup-git-app), meaning the Windows ACL gap affects all sensitive file
storage, not just the master key.

### Attacker Classes

| Class | Description | In scope? |
|-------|-------------|-----------|
| A1 - Local file read | Malware, lateral movement, or another user reads `salt` and `credentials.json` | YES -- primary target |
| A2 - Backup/image leak | Disk images, VM snapshots, or unencrypted backups expose `~/.apra-fleet/data/` | YES |
| A3 - Process memory dump | Attacker dumps the running fleet process memory | OUT OF SCOPE (requires root/admin; mitigate with general hardening) |
| A4 - Physical access | Attacker has physical access to the machine | OUT OF SCOPE (full-disk encryption is the right layer) |
| A5 - Supply-chain / code tamper | Attacker modifies the apra-fleet binary itself | OUT OF SCOPE (code-signing covers this) |

### Gap Summary

1. **Windows has zero file-level protection** -- `enforceOwnerOnly`
   returns immediately on `win32` (`file-permissions.ts:10`), so
   `salt`, `credentials.json`, `registry.json`, `git-config.json`,
   `known_hosts`, and any Git app private keys all inherit the parent
   directory's ACL, which typically grants read access to all members
   of the `Users` group.
2. **Plaintext DEK on all platforms** -- any process that can read the
   `salt` file can decrypt every credential.  There is no binding to
   the current user identity or OS session.
3. **No key-wrapping** -- the DEK is the root of trust with nothing
   protecting it.

---

## 2. Design Principles

1. **Cross-platform parity is mandatory.**  apra-fleet ships as a
   single binary for Windows, macOS, and Linux
   (`scripts/package-sea.mjs` produces platform-specific executables).
   Every protection must either work on all three or degrade
   gracefully with a logged warning and a documented fallback.

2. **Envelope encryption.**  Keep the existing AES-256-GCM DEK (the
   "data key") that encrypts credentials.  Introduce a
   Key-Encryption-Key (KEK) that wraps (encrypts) the DEK.  Migration
   is non-destructive: existing ciphertext in `credentials.json` is
   untouched; only the `salt` file changes form.

3. **Graceful degradation.**  If the preferred KEK source is
   unavailable (headless server, locked keychain, missing
   `secret-tool`), the system must still start.  It falls back through
   a defined chain: `os-keystore -> passphrase/env-var -> hardened-file`.

4. **Non-destructive migration.**  Existing plaintext `salt` files are
   detected, wrapped into the new format, and the plaintext is removed.
   A rollback path exists.  `credentials.json` is never rewritten
   during migration -- only the storage of the DEK changes.

5. **No native modules.**  The SEA binary bundles everything via
   esbuild (`scripts/build-sea.mjs:30-56`).  Native `.node` addons are
   loaded as empty stubs (`build-sea.mjs:53`).  All OS integration
   must use child-process calls to OS CLIs.

---

## 3. Proposed Approach -- Envelope Encryption

### Architecture

```
credentials.json           salt (new format)
+---------------------+    +----------------------------+
| iv:tag:ciphertext   |    | version: 2                 |
| iv:tag:ciphertext   |    | kek_source: os-keystore    |
| ...                 |    |   | passphrase | file       |
+---------------------+    | wrapped_dek: <hex>         |
        ^                  | kek_params: { ... }        |
        |                  +----------------------------+
  encrypted with DEK                  ^
                                      |
                              DEK = unwrap(wrapped_dek, KEK)
                              KEK = derive_from(kek_source)
```

The `salt` file changes from a raw hex string to a JSON envelope:

```json
{
  "version": 2,
  "kek_source": "os-keystore",
  "wrapped_dek": "<hex: AES-256-GCM encrypted DEK>",
  "kek_iv": "<hex>",
  "kek_tag": "<hex>",
  "kek_params": {},
  "created_at": "<ISO-8601 timestamp>"
}
```

`version: 1` (implicit) is the current format: raw hex DEK (64 hex
characters, no JSON).

### KEK Wrapping / Unwrapping

The DEK is wrapped using AES-256-GCM with the KEK as the key.
`kek_iv` and `kek_tag` are stored alongside `wrapped_dek`.  Unwrapping
recovers the original 32-byte DEK, which is then used exactly as today
by `encryptPassword()` and `decryptPassword()` (`crypto.ts:49-72`).

### KEK Sources by OS

#### 3a. Windows -- DPAPI

**Approach:** Shell out to PowerShell's
`[System.Security.Cryptography.ProtectedData]`.

- Encrypt: pipe DEK bytes (base64) to a PowerShell one-liner that
  calls `ProtectedData.Protect(bytes, null, scope)` and returns
  base64.
- Decrypt: reverse with `ProtectedData.Unprotect(...)`.
- DPAPI is always available on Windows (no extra install) and produces
  opaque blobs bound to the Windows user SID.

**Scope selection:**

| Execution context | Detected via | DPAPI scope | Notes |
|-------------------|-------------|-------------|-------|
| Interactive desktop user | `process.stdout.isTTY === true` | `CurrentUser` | Bound to user SID; best isolation |
| Windows service (SYSTEM) | `!process.stdout.isTTY` AND `process.env.USERNAME === 'SYSTEM'` | `LocalMachine` | All SYSTEM services can unwrap; acceptable because only fleet owns the file |
| Windows service (named account) | Service running as a named user | `CurrentUser` | Bound to that service account's SID |

Note: `LocalMachine` scope means any process running as SYSTEM on the
same machine can unwrap.  This is acceptable because it matches the
threat model (A1 requires a different user; SYSTEM-to-SYSTEM is not an
attacker class we close).  Document this in the `key status` output.

**Why not a native module?**
- keytar/node-dpapi require `node-gyp` + MSVC build tools and cannot
  be bundled into the SEA binary (`build-sea.mjs:53` empties `.node`
  files).
- keytar is archived (unmaintained since 2023).
- PowerShell is guaranteed present on all supported Windows versions
  (Windows 10+/Server 2016+; PowerShell 5.1 ships inbox).
- Latency (~100-200ms cold start) is acceptable since key operations
  happen at most once per process start.

**kek_params:**
```json
{ "dpapi_scope": "CurrentUser" }
```

**Wrapping model:** DPAPI *is* the wrapping mechanism.  The DEK bytes
are encrypted by DPAPI directly; there is no separate KEK key material
to manage.  The DPAPI blob is stored in `wrapped_dek` (base64-encoded).
`kek_iv` and `kek_tag` are absent (set to `null`) because DPAPI
provides its own integrity and confidentiality.

#### 3b. macOS -- Keychain

**Approach:** Shell out to the `security` CLI.

- Store: `security add-generic-password -a apra-fleet -s apra-fleet-kek -w <base64-dek> -U`
- Retrieve: `security find-generic-password -a apra-fleet -s apra-fleet-kek -w`
- Delete: `security delete-generic-password -a apra-fleet -s apra-fleet-kek`

The `security` CLI is always present on macOS, requires no extra
dependencies, and the default keychain is unlocked when a user is
logged in.

**Wrapping model:** The DEK is stored directly in the Keychain as the
password value.  The Keychain provides encryption at rest.  The salt
file records `kek_source: "os-keystore"` with kek_params pointing to
the Keychain entry.  `wrapped_dek`, `kek_iv`, `kek_tag` are `null`
because the DEK is retrieved directly from the Keychain, not from the
salt file.

**Why not keytar?**  Same packaging constraint as Windows -- keytar is
a native module.  It is also archived/unmaintained.  The `security`
CLI provides equivalent functionality with zero build dependencies.

**kek_params:**
```json
{ "service": "apra-fleet-kek", "account": "apra-fleet" }
```

#### 3c. Linux -- Secret Service (libsecret) + Fallback

**Primary: `secret-tool` CLI** (when available and a D-Bus session bus
exists).

- Store: `echo -n <base64-dek> | secret-tool store --label='apra-fleet KEK' service apra-fleet type kek`
- Retrieve: `secret-tool lookup service apra-fleet type kek`

`secret-tool` talks to the Secret Service D-Bus API (GNOME Keyring,
KDE Wallet, KeePassXC).  It is the standard CLI for libsecret and
avoids native modules entirely.

**Wrapping model:** Same as macOS -- DEK stored directly in the secret
store.  `wrapped_dek`, `kek_iv`, `kek_tag` are `null`.

**Availability check:** Before using, verify:
1. `which secret-tool` succeeds (package `libsecret-tools` on
   Debian/Ubuntu, `libsecret` on Fedora/Arch).
2. `secret-tool` does not hang or error (timeout after 3s).
If either fails, fall to passphrase/file.

**Fallback:** passphrase-derived KEK (see section 3d).

**kek_params:**
```json
{ "label": "apra-fleet KEK", "lookup": {"service":"apra-fleet","type":"kek"} }
```

#### 3d. Passphrase / Environment Variable Fallback (All Platforms)

For headless/CI environments where no keystore is available:

- **Environment variable:** `APRA_FLEET_KEK_PASSPHRASE` provides a
  passphrase at process start.
- **KDF:** scrypt with parameters N=2^17, r=8, p=1, dkLen=32.
  (scrypt is available in Node.js `crypto` module natively via
  `crypto.scryptSync()` -- no external dependency.)
- A random 16-byte KDF salt is stored in `kek_params.kdf_salt`.
- The scrypt-derived key is the KEK.  The DEK is wrapped with
  AES-256-GCM using this KEK; `kek_iv` and `kek_tag` are populated.

```json
{
  "version": 2,
  "kek_source": "passphrase",
  "wrapped_dek": "<hex>",
  "kek_iv": "<hex>",
  "kek_tag": "<hex>",
  "kek_params": {
    "kdf": "scrypt",
    "kdf_salt": "<hex: 16 random bytes>",
    "N": 131072,
    "r": 8,
    "p": 1
  },
  "created_at": "2026-06-05T00:00:00.000Z"
}
```

**Why scrypt over argon2?**  argon2 requires a native addon (`argon2`
npm package uses `node-gyp`).  Node.js ships scrypt in
`crypto.scryptSync()` with no native dependency.  scrypt with N=2^17
provides ~100ms key derivation on modern hardware, which is adequate
for this use case.

**Minimum passphrase strength:** Document a recommendation of >=20
characters or >=128 bits of entropy.  At startup, if the passphrase
is under 12 characters, log a warning (do not refuse -- the operator
may have a short but high-entropy passphrase from a secrets manager).

#### 3e. File Mode -- Hardened ACL Only (Lowest Tier)

When no keystore is available AND no passphrase is provided, the
system falls back to file mode.  In this mode:

- The DEK is stored **unwrapped** in the v2 envelope as `dek_hex`.
- `wrapped_dek`, `kek_iv`, `kek_tag` are `null`.
- `kek_source` is `"file"`.
- Protection is purely ACL-based (see section 5).

```json
{
  "version": 2,
  "kek_source": "file",
  "dek_hex": "<64 hex chars>",
  "wrapped_dek": null,
  "kek_iv": null,
  "kek_tag": null,
  "kek_params": {},
  "created_at": "2026-06-05T00:00:00.000Z"
}
```

This is explicitly the weakest tier.  It is better than v1 only
because (a) Windows now gets real ACLs (section 5a), and (b) the
operator is warned at every startup (section 5c).  The DEK is NOT
cryptographically protected -- file permissions are the only barrier.

---

## 4. Hard Constraints

### 4a. Headless Fleet Members

Fleet members run non-interactively on servers.  The installer
registers platform services (`src/cli/install.ts` handles systemd,
launchd, and Windows Task Scheduler).  In headless contexts:

| Environment | Keystore availability | Recommended mode |
|-------------|----------------------|-----------------|
| Linux server (no desktop) | Secret Service unavailable (no D-Bus session bus) | passphrase |
| macOS CI / launchd daemon | Keychain may be locked or missing login keychain | passphrase |
| Windows service (SYSTEM) | DPAPI available (machine-scope) | os-keystore |
| Windows service (named user) | DPAPI available (user-scope) | os-keystore |
| Docker / container | No keystore of any kind | passphrase |
| CI ephemeral runner | No persistent state | passphrase (or skip -- no credentials survive the run) |

**Solution: tiered fallback chain**

```
try os-keystore
  -> if unavailable, check APRA_FLEET_KEK_PASSPHRASE env var
    -> if unset, use hardened-file mode (tightened ACLs, logged warning)
```

Each tier logs the active protection mode at startup so operators can
audit their fleet's posture.

- `os-keystore`: best protection, requires working keystore.
- `passphrase`: strong protection via KDF, requires the operator to
  supply a secret (env var, systemd EnvironmentFile, Docker secret).
- `file`: weakest tier, but still better than today's v1 once Windows
  ACLs are tightened (section 5).  Logged as a warning encouraging
  upgrade.

For headless Linux/macOS, the **recommended deployment** is
`passphrase` mode with the passphrase injected via:
- systemd: `EnvironmentFile=/etc/apra-fleet/kek.env` (mode 0600,
  root-owned)
- launchd: `EnvironmentVariables` in the plist
- Docker: `--env-file` or Docker secrets mounted to env

### 4b. Packaging -- Native Modules vs. OS CLIs

**Decision: OS CLIs only.  No native modules.**

| Approach | Pros | Cons |
|----------|------|------|
| keytar (native) | Single API across platforms | Requires node-gyp, MSVC/Xcode/gcc at build time; `.node` files are emptied by SEA bundler (`build-sea.mjs:53`); cross-compilation fragile; project archived/unmaintained |
| node-dpapi (native) | Direct DPAPI access | Windows-only; same bundling problem |
| OS CLIs (security, PowerShell, secret-tool) | Zero build deps; always present on target OS; works in SEA binary | Child-process overhead (~100-200ms); must handle CLI output parsing; CLI version differences |

The SEA packaging pipeline (`scripts/build-sea.mjs`,
`scripts/package-sea.mjs`) produces a single binary with no external
runtime dependencies.  Native modules would break this model.

**Mitigation of CLI risks:**
- Wrap each CLI call in a timeout (5s for keystore ops, 3s for
  availability probes) to prevent hangs from locked keystores or
  missing D-Bus.
- Parse output defensively; treat unexpected output as "unavailable"
  and fall to next tier.
- Pin to documented CLI interfaces (DPAPI via .NET
  `ProtectedData`, `security` POSIX flags, `secret-tool`
  lookup/store verbs) that have been stable for 10+ years.
- Log the exact CLI command (without secret values) on failure for
  debugging.

---

## 5. Fallback Hardening -- File-Based Protection

When neither OS keystore nor passphrase is available, the DEK is
stored in the v2 envelope without wrapping.  Two improvements over
today's v1:

### 5a. Windows ACL Tightening

Replace the no-op in `enforceOwnerOnly` (`file-permissions.ts:10`)
with `icacls` calls:

```
icacls <path> /inheritance:r          -- remove inherited ACEs
icacls <path> /grant:r %USERNAME%:F   -- grant full control to owner only
```

This restricts the file to the current user, equivalent to Unix
`chmod 0600`.  `icacls` is available on all Windows versions since
Vista.

Implementation: shell out to `icacls` via `child_process.execSync`
inside `enforceOwnerOnly()` on `win32`.  The function currently
returns immediately (`file-permissions.ts:10`), so this is purely
additive.

Apply to all existing callers (every file currently using
`enforceOwnerOnly` gains Windows protection for free):
- `salt` file (`crypto.ts:31`)
- `credentials.json` (`credential-store.ts:97-98`)
- `registry.json` (`registry.ts:61,88`)
- `git-config.json` (`git-config.ts:24`)
- `known_hosts` (`known-hosts.ts:51`)
- `onboarding.json` (`onboarding.ts:81`)
- Git app private keys (`setup-git-app.ts:68`)

### 5b. Directory-Level Permissions

Set the data directory itself to owner-only:
- Unix: already `0o700` (`crypto.ts:28`)
- Windows: `icacls <dir> /inheritance:r /grant:r %USERNAME%:(OI)(CI)F`
  (Object Inherit + Container Inherit = new files/subdirs inherit
  the restriction)

### 5c. Warning on File Fallback

When file mode is active, log a startup warning:

```
[WARN] Master key is protected by file permissions only (weakest tier).
       Set APRA_FLEET_KEK_PASSPHRASE or configure OS keystore for
       stronger protection. Run 'apra-fleet key status' for details.
```

Log this on every startup, not just the first time, so operators
monitoring logs are reminded.

---

## 6. Migration

### 6a. Credential Store Version Format

The `salt` file format is versioned:

| Version | Format | Description |
|---------|--------|-------------|
| 1 (implicit) | Raw hex string (64 chars) | Current format -- plaintext DEK |
| 2 | JSON envelope | Wrapped or ACL-protected DEK with KEK metadata |

Detection: if the file content starts with `{`, parse as JSON and
read `version`.  Otherwise treat as version 1 (raw hex).  This is
safe because a 64-character hex string will never start with `{`.

### 6b. Migration Path (v1 -> v2)

1. Read the plaintext DEK from `salt` (v1 format, `crypto.ts:20-21`).
2. **Backup:** copy `salt` to `salt.v1.bak` BEFORE any writes.
3. Determine the best available KEK source for this environment
   (using the `auto` resolution chain from section 7b).
4. If `os-keystore` or `passphrase`: derive/obtain the KEK, wrap the
   DEK with AES-256-GCM, populate `wrapped_dek`/`kek_iv`/`kek_tag`.
5. If `file`: store `dek_hex` unwrapped, apply hardened ACLs.
6. Write the v2 JSON envelope to `salt.tmp` (atomic staging file).
7. **Verify:** immediately read `salt.tmp`, unwrap, and compare to
   the original DEK bytes.  If mismatch, abort and leave `salt`
   untouched.
8. Rename `salt.tmp` to `salt` (atomic on POSIX; on Windows, delete
   + rename with retry on failure due to AV locks).
9. Apply `enforceOwnerOnly()` to the new `salt` file.
10. `credentials.json` is **untouched** -- the DEK is the same, only
    its storage form changed.

This mirrors the existing backup pattern at `crypto.ts:33-44`, which
already backs up `credentials.json` when the key scheme changes.

### 6c. Concurrency Safety

If two processes start simultaneously and both detect v1:
- The backup step (2) is idempotent -- copying the same content to
  `salt.v1.bak` twice is safe.
- The atomic rename (8) ensures one wins.  The loser, when it reads
  `salt` next, sees v2 and proceeds normally.
- Use an advisory lock file (`salt.lock`) with a 10s stale timeout
  to serialize migration.  If the lock is stale (holder crashed),
  break it and proceed.

### 6d. Backward-Read Compatibility

`getOrCreateKey()` (`crypto.ts:18-47`) must handle both formats:

```
if salt file is JSON with version >= 2:
    unwrap DEK using KEK from kek_source
else:
    read raw hex (existing behavior)
```

This allows a graceful downgrade path: if the user installs an older
apra-fleet binary, it will fail to read a v2 salt file -- but the
`salt.v1.bak` file preserves the original.  The `key rollback`
command or manual copy restores it.

### 6e. Rollback Procedure

1. Stop the fleet server.
2. `apra-fleet key rollback` (or manually: copy `salt.v1.bak` to
   `salt`).
3. Restart.  The old plaintext DEK is used; `credentials.json` is
   unchanged because the DEK itself never changed.
4. If the DEK was stored in an OS keystore, the keystore entry is
   orphaned but harmless.  `key rollback` can optionally clean it up.

---

## 7. Configuration

### 7a. Protection Mode Setting

Add a `key_protection` field to the install config at
`~/.apra-fleet/data/install-config.json`:

```json
{
  "key_protection": "auto"
}
```

| Value | Behavior |
|-------|----------|
| `auto` (default) | Try os-keystore -> passphrase (if env var set) -> file |
| `os-keystore` | Require OS keystore; **fail to start** if unavailable |
| `passphrase` | Require `APRA_FLEET_KEK_PASSPHRASE`; **fail to start** if unset |
| `file` | Use hardened file mode (tightened ACLs); no KEK wrapping |

When `os-keystore` or `passphrase` is explicitly set (not `auto`),
failure is fatal rather than falling through.  This prevents silent
degradation in environments where the operator requires a specific
tier.

### 7b. Per-Environment Defaults

`auto` resolves as follows:

| Environment | Detected via | Default resolution |
|-------------|-------------|-------------------|
| Windows desktop | `win32` + `process.stdout.isTTY` | DPAPI (CurrentUser) |
| Windows service (SYSTEM) | `win32` + `process.env.USERNAME === 'SYSTEM'` | DPAPI (LocalMachine) |
| Windows service (named) | `win32` + non-SYSTEM service account | DPAPI (CurrentUser) |
| macOS desktop | `darwin` + `security` probe succeeds | Keychain |
| macOS headless | `darwin` + Keychain locked/unavailable | passphrase -> file |
| Linux desktop | `linux` + `secret-tool` probe succeeds | Secret Service |
| Linux headless | `linux` + no D-Bus / no `secret-tool` | passphrase -> file |

Probe logic for `auto`:
1. Check if OS keystore is available (platform-specific CLI probe
   with 3s timeout).
2. If yes, use `os-keystore`.
3. If no, check `APRA_FLEET_KEK_PASSPHRASE` env var.
4. If set, use `passphrase`.
5. If unset, use `file` with warning.

### 7c. CLI Commands

```
apra-fleet key status     -- show current protection mode, KEK source, DEK age
apra-fleet key migrate    -- trigger v1->v2 migration manually
apra-fleet key rollback   -- restore v1 plaintext salt from backup
apra-fleet key rotate     -- generate new DEK, re-encrypt all credentials
apra-fleet key set-mode <mode>  -- set key_protection preference
```

---

## 8. Key Rotation & Re-encryption

### 8a. DEK Rotation

1. Generate a new 32-byte random DEK.
2. Load all credentials from `credentials.json`
   (`credential-store.ts:79-88`).
3. Decrypt each `encryptedValue` with the old DEK.
4. Re-encrypt each with the new DEK.
5. Wrap the new DEK with the current KEK.
6. Write new `credentials.json` to `credentials.json.tmp`.
7. Write new `salt` to `salt.tmp`.
8. **Verify:** decrypt one credential with the new DEK from the new
   salt file.  If it fails, abort (originals untouched).
9. Backup old files as `credentials.json.pre-rotate.bak` and
   `salt.pre-rotate.bak`.
10. Atomic rename both `.tmp` files to their final names.
11. Apply `enforceOwnerOnly()` to both files.

The two-file atomic rename is the riskiest step.  If the process
crashes between renaming `salt` and `credentials.json`, the old
`credentials.json` is still encrypted with the old DEK while `salt`
holds the new DEK.  Mitigation: rename `salt.tmp` last (so
`credentials.json` is always decryptable with whatever `salt`
contains).  On recovery, detect the mismatch by attempting to decrypt
and fall back to `.pre-rotate.bak` files.

### 8b. KEK Rotation

Changing the KEK source (e.g., from `file` to `os-keystore`):

1. Unwrap the DEK with the old KEK (or read `dek_hex` in file mode).
2. Wrap the DEK with the new KEK (or store in OS keystore).
3. Update `kek_source`, `kek_params`, `wrapped_dek`/`kek_iv`/`kek_tag`
   in the salt file.
4. `credentials.json` is untouched -- the DEK is the same.

This is strictly simpler than DEK rotation because only the salt file
changes.

### 8c. Scheduled Rotation Advisory

Optional: a `key_rotation_days` config value triggers a warning when
the DEK age exceeds the threshold.  The fleet server checks DEK age
at startup using the `created_at` field in the v2 envelope (or the
file's mtime for v1).

This is advisory only -- the server does not auto-rotate.  The
operator must run `apra-fleet key rotate` explicitly.

---

## 9. Risks, Dependencies, and Testing Matrix

### 9a. Risks

| Risk | Severity | Mitigation |
|------|----------|------------|
| PowerShell DPAPI call fails on locked service account | Medium | Detect scope at startup; SYSTEM uses LocalMachine; named accounts use CurrentUser; fall to passphrase/file on failure |
| `security` CLI changes interface | Low | Pin to stable flags (-a, -s, -w, -U); these have been stable since macOS 10.4 |
| `secret-tool` not installed on Linux | Medium | Availability probe at startup; fall to passphrase/file with actionable warning naming the package (`libsecret-tools` on Debian, `libsecret` on Fedora) |
| scrypt parameters too slow on low-end hardware | Low | N=2^17 targets ~100ms on modern hardware; make N configurable in kek_params for constrained environments |
| Atomic file rename fails on Windows (AV file lock) | Medium | Retry rename 3x with 100ms backoff; if all fail, fall back to direct write + verify |
| User loses passphrase and `salt.v1.bak` is deleted | High | Document backup procedures prominently; `salt.v1.bak` is never auto-deleted; advise operators to back it up externally |
| Old binary cannot read v2 salt | Medium | `salt.v1.bak` preserved; `key rollback` command; document in release notes |
| Two processes migrate simultaneously | Low | Advisory lock file with stale timeout (section 6c) |
| macOS Keychain access prompt in non-interactive context | Medium | `security` CLI may trigger a system dialog; detect TTY and skip keychain if non-interactive, fall to passphrase |

### 9b. Dependencies

| Dependency | Type | Required? | Used by |
|------------|------|-----------|---------|
| Node.js `crypto.scryptSync` | stdlib | Yes (passphrase mode) | KEK derivation |
| Node.js `child_process.execSync` | stdlib | Yes (all OS keystore modes + Windows ACLs) | CLI calls |
| PowerShell 5.1+ | OS (Windows) | Yes (DPAPI mode on Windows) | DEK wrapping |
| `security` CLI | OS (macOS) | Yes (Keychain mode on macOS) | DEK storage |
| `secret-tool` | Package (Linux) | Optional (Secret Service mode) | DEK storage |
| `icacls` | OS (Windows) | Yes (file hardening on Windows) | ACL tightening |

All dependencies are OS-provided or Node.js stdlib.  **Zero npm
additions required.**

### 9c. Testing Matrix

| # | OS | Session | KEK mode | Test |
|---|----|---------|----------|------|
| 1 | Windows 10/11 | Desktop (interactive) | DPAPI (CurrentUser) | Store, retrieve, survive reboot |
| 2 | Windows Server | Service (SYSTEM) | DPAPI (LocalMachine) | Store, retrieve, service restart |
| 3 | Windows Server | Service (named user) | DPAPI (CurrentUser) | Store, retrieve, service restart |
| 4 | macOS (ARM) | Desktop | Keychain | Store, retrieve, keychain lock/unlock |
| 5 | macOS | launchd daemon | passphrase (env) | Store, retrieve, daemon restart |
| 6 | macOS | SSH session | passphrase (env) | Keychain unavailable -> fallback |
| 7 | Linux (Ubuntu) | Desktop (GNOME) | Secret Service | Store, retrieve, session restart |
| 8 | Linux (Ubuntu) | SSH / headless | passphrase (env) | secret-tool unavailable -> fallback |
| 9 | Linux (Alpine) | Docker container | passphrase (env) | No D-Bus -> fallback |
| 10 | Linux (Ubuntu) | Headless, no env var | file (hardened) | ACL check, warning logged |
| 11 | Windows 10 | Desktop, no env var | file (hardened) | icacls ACL applied, warning logged |
| 12 | All | Any | -- | Migration v1 -> v2: credentials remain decryptable |
| 13 | All | Any | -- | Rollback v2 -> v1: backup restored, credentials work |
| 14 | All | Any | -- | DEK rotation: all credentials re-encrypted, old creds backed up |
| 15 | All | Any | -- | KEK rotation: kek_source changed, credentials untouched |
| 16 | All | Any | -- | Tamper: modified wrapped_dek detected (GCM auth tag failure) |
| 17 | All | Any | auto | Tier fallback: keystore absent -> passphrase -> file |
| 18 | All | Any | -- | Concurrent startup: two processes, one migrates, other reads v2 |
| 19 | Windows | Any | -- | icacls applied to all 7 enforceOwnerOnly call sites |
| 20 | All | Any | passphrase | Short passphrase (<12 chars) logs warning but still works |

### 9d. CI Testing Strategy

- Unit tests: mock `child_process.execSync` to simulate each CLI's
  output for all three platforms.  Test the wrapping/unwrapping logic,
  v1 detection, v2 parsing, fallback chain, and error paths.
- Integration tests on CI runners:
  - Windows runner: real DPAPI test (PowerShell is available in
    GitHub Actions Windows runners).
  - macOS runner: real Keychain test (may require `security
    unlock-keychain` in CI setup step).
  - Linux runner: `secret-tool` is typically unavailable in CI; test
    the passphrase and file fallback paths.  Optionally install
    `gnome-keyring` + `dbus-test-runner` for a real Secret Service
    test.
- Migration tests: create a v1 salt file, run migration, verify
  credentials still decrypt.  Then rollback and verify again.

---

## 10. Phased Rollout

### Phase 1 (P1) -- Highest Value, Lowest Risk

**Goal:** Close the two biggest gaps with zero new dependencies and
zero platform-specific keystore code.

1. **Windows ACL hardening** -- implement `icacls` calls in
   `enforceOwnerOnly()` (`file-permissions.ts:10`).  Apply to `salt`,
   `credentials.json`, and all other callers (registry, git-config,
   known-hosts, onboarding, git-app keys).  This is a single function
   change; all 7 call sites benefit immediately.

2. **Salt file v2 format** -- implement the JSON envelope, version
   detection logic, and `getOrCreateKey()` dual-format reader.

3. **Passphrase/KDF mode** -- implement scrypt-based KEK derivation
   from `APRA_FLEET_KEK_PASSPHRASE` env var.  This uses only Node.js
   stdlib (`crypto.scryptSync`).

4. **File mode** (v2 with `dek_hex`, hardened ACLs, startup warning).

5. **Auto migration** -- detect v1 on startup, migrate to v2 using
   the best available tier (passphrase if env var set, else file).

6. **`key status` CLI command** -- show current protection mode and
   DEK age.

**Why first:** Windows ACL is a one-function fix for the most glaring
gap.  Passphrase mode works everywhere (including headless) with zero
OS-specific keystore code.  Together they cover all platforms and all
session types.  P1 alone closes gap #1 (Windows ACLs) and
significantly narrows gap #2 (plaintext DEK) for any deployment that
sets the env var.

**Estimated effort:** 2-3 days.

### Phase 2 (P2) -- OS Keystore Integration

**Goal:** Add transparent OS-keystore protection for interactive
users.

7. **Windows DPAPI** -- PowerShell child_process integration with
   CurrentUser/LocalMachine scope detection.
8. **macOS Keychain** -- `security` CLI integration.
9. **Linux Secret Service** -- `secret-tool` CLI integration with
   availability probe.
10. **Auto-detection** -- implement the full `auto` mode fallback
    chain (section 7b).
11. **`key migrate` and `key rollback` CLI commands.**

**Why second:** OS keystore provides the strongest protection but
requires per-platform implementation and testing.  P1 already covers
headless and file-hardening, so P2 is additive security for
interactive environments.

**Estimated effort:** 3-5 days.

### Phase 3 (P3) -- Rotation & Operational Tooling

**Goal:** Full lifecycle management.

12. **DEK rotation** (`key rotate` command with atomic two-file swap).
13. **KEK rotation** (`key set-mode` to switch between protection modes).
14. **Rotation age warnings** at startup.
15. **Fleet-wide key posture reporting** -- aggregate `key status`
    across fleet members via the fleet server (new MCP tool or
    dashboard view).

**Why third:** Rotation is important for long-lived deployments but
not urgent.  P1+P2 close the immediate security gaps.  P3 is
operational maturity.

**Estimated effort:** 2-3 days.

---

## Appendix A: File Layout After Migration

```
~/.apra-fleet/data/
  salt                  # v2 JSON envelope (wrapped or ACL-protected DEK)
  salt.v1.bak           # backup of original plaintext DEK (preserved indefinitely)
  salt.lock             # advisory lock during migration (transient)
  credentials.json      # unchanged (encrypted with same DEK)
  install-config.json   # includes key_protection setting
  server.json           # unchanged
  fleet.log             # unchanged
```

## Appendix B: DPAPI PowerShell One-Liners

Encrypt (DEK -> DPAPI blob):
```powershell
Add-Type -AssemblyName System.Security
$bytes = [Convert]::FromBase64String($input)
$scope = [Security.Cryptography.DataProtectionScope]::CurrentUser
$enc = [Security.Cryptography.ProtectedData]::Protect($bytes, $null, $scope)
[Convert]::ToBase64String($enc)
```

Decrypt (DPAPI blob -> DEK):
```powershell
Add-Type -AssemblyName System.Security
$bytes = [Convert]::FromBase64String($input)
$scope = [Security.Cryptography.DataProtectionScope]::CurrentUser
$dec = [Security.Cryptography.ProtectedData]::Unprotect($bytes, $null, $scope)
[Convert]::ToBase64String($dec)
```

Note: pipe the base64 input via stdin to avoid the secret appearing
in the process command line (visible via `wmic process`).

## Appendix C: v2 Envelope Variants Summary

| kek_source | wrapped_dek | kek_iv | kek_tag | dek_hex | Notes |
|------------|-------------|--------|---------|---------|-------|
| `os-keystore` (DPAPI) | base64 DPAPI blob | null | null | null | DPAPI provides its own integrity |
| `os-keystore` (Keychain/SecretService) | null | null | null | null | DEK stored in external keystore; salt is a pointer |
| `passphrase` | hex (AES-GCM wrapped) | hex | hex | null | KEK derived from passphrase via scrypt |
| `file` | null | null | null | hex | DEK stored unwrapped; ACL-only protection |

## Appendix D: Related Source Files

| File | Lines | Relevance |
|------|-------|-----------|
| `src/utils/crypto.ts` | 1-72 | DEK management, encrypt/decrypt, `getOrCreateKey()` |
| `src/utils/file-permissions.ts` | 1-12 | `enforceOwnerOnly()` -- needs Windows ACL implementation |
| `src/services/credential-store.ts` | 1-370 | Credential CRUD, calls `encryptPassword`/`decryptPassword` |
| `src/paths.ts` | 1-10 | `FLEET_DIR` constant, data directory path |
| `scripts/build-sea.mjs` | 1-58 | SEA bundling -- `.node` loader set to `empty` (line 53) |
| `scripts/package-sea.mjs` | 1-119 | Binary packaging pipeline |
| `src/cli/install.ts` | 1-758 | Installer -- service registration, multi-provider config |
| `src/services/registry.ts` | 61,88 | `enforceOwnerOnly` caller -- registry.json |
| `src/services/git-config.ts` | 24 | `enforceOwnerOnly` caller -- git-config.json |
| `src/services/onboarding.ts` | 81 | `enforceOwnerOnly` caller -- onboarding.json |
| `src/services/known-hosts.ts` | 51 | `enforceOwnerOnly` caller -- known_hosts |
| `src/tools/setup-git-app.ts` | 68 | `enforceOwnerOnly` caller -- Git app private keys |
