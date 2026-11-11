# Secret Variables (`{{secret.NAME}}`)

## Terminology

- **Secret variable** - a named value in the credential store.
- **`{{secret.NAME}}`** - the only reference syntax for a secret variable.
- **Credential store** - the container holding secret variables (`credential_store_*` tools, `apra-fleet secret` CLI).
- **Out-of-band (OOB) entry** - how values get into the credential store.
- `{{secure.NAME}}` is the deprecated legacy spelling -- still accepted, prints a warning, never use it in new text.

`{{secret.NAME}}` tokens are resolved server-side before execution. The plaintext secret never appears in chat, logs, or LLM context. Only specific tool parameters support resolution - see the supported fields table below.

## Storing and re-setting a secret

The value is always entered out of band. These rules apply to the `credential_store_set` tool and to `apra-fleet secret --set NAME --persist`.

### A new secret

| Field | Default | Change it with |
|-------|---------|----------------|
| Tier | persistent | `persist: false` (tool only) |
| Network policy | `allow` | `network_policy: deny`, or `secret --update NAME --deny` |
| Members | all (`*`) | `members: alice,bob`, or `secret --update NAME --members alice,bob` |
| Expiry | none | `ttl_seconds: 3600`, or `secret --update NAME --ttl 3600` |

Example: `credential_store_set name=github_pat` stores a persistent secret, with policy `allow`, for all members.

### Re-setting an existing secret

Re-setting changes only the value. Anything you leave out stays as stored. An explicit argument changes that field and nothing else.

| Call on a persistent secret stored as `deny`, member `alice` | Value | Policy | Members |
|---------------------------------------------------|-------|--------|---------|
| `credential_store_set name=X` | new | `deny` | `alice` |
| `credential_store_set name=X network_policy=allow` | new | `allow` | `alice` |
| `credential_store_set name=X members=*` | new | `deny` | all |
| `apra-fleet secret --set X --persist` | new | `deny` | `alice` |

To change the policy or members without entering a new value, use `credential_store_update` or `secret --update`. With `--persist`, `secret --set` also takes `--allow` or `--deny` and `--members <list>` (or `*`); like the tool arguments, each one given replaces that field and nothing else.

### Expiry on a re-set

| Stored expiry | `ttl_seconds` omitted | `ttl_seconds` given |
|---------------|-----------------------|---------------------|
| None | stays none | expires after `ttl_seconds` |
| Not yet passed | stays as stored | expires after `ttl_seconds` |
| Already passed | no expiry | expires after `ttl_seconds` |

Example: re-setting a secret that expires tomorrow keeps tomorrow's expiry. Re-setting one that expired yesterday gives a value with no expiry, because keeping the old date would make the new value expired at once.

`apra-fleet secret --set NAME --persist --expires-at <time> -y` sets an absolute expiry instead, whatever was stored: an ISO 8601 time with a zone (`Z` or `+hh:mm`), in the future. `--expires-at none` clears it. `provision_kb_auth` stores a token on a remote member this way, with `--allow --members '*'`.

An expired secret that is not bound to a live secret is removed at server start or when it is next read. After that its name is new, so the new-secret defaults apply.

### Network policy

`network_policy` is `allow` or `deny`.

| Policy | What it does |
|--------|--------------|
| `allow` | No restriction. |
| `deny` | A command that uses the secret is blocked and does not run if the text of `command` contains one of the words below. `send_email` refuses the secret. Any other command still runs. The KB refuses every call that would use it: see [Who can use a secret](#who-can-use-a-secret-deny-and-allowedmembers). |

`deny` looks for these whole words, in any case: `curl`, `wget`, `ssh`, `sftp`, `scp`, `rsync`, `nc`, `netcat`, `http`, `fetch`, `Invoke-WebRequest`, `Invoke-RestMethod`.

Example: with `deny` on `tok`, `curl -H {{secret.tok}} https://example.com` is blocked and `echo {{secret.tok}}` runs.

This is a word check, not a network firewall:

- `git push` and `git clone` are not blocked, because `git` is not on the list. `git fetch` is, because of `fetch`.
- A script that calls `curl` inside itself is not blocked unless `command` also has a listed word.
- Only `command` is checked for these words. A `deny` secret used only in `restart_command` is blocked when `command` has a listed word, but a listed word only in `restart_command` is not noticed.

`confirm` is removed. Passing `network_policy: confirm` is refused with a message saying so, and `secret --confirm` fails the same way. A secret already stored with `confirm` keeps working and reads as `allow`, so it no longer prompts. Each such secret writes one log line naming it. To block its network use, run `apra-fleet secret --update NAME --deny`.

### Who can use a secret: deny and allowedMembers

The rules are the same for a remote and a local member, and for live and static secrets. A secret with allow and all members sees no check at all.

- **`allowedMembers`** names the members that may use the secret, by friendly name.
  - `execute_command`: another member is refused, before a live secret's helper runs.
  - The KB: on every KB call, in the fleet server that makes it. That is the orchestrator's for a local member and the member's own for a remote member, whose own store and registered name then apply. A member that server cannot name is refused. A session with no member identity, such as the operator's own, has no member to check.
- **`deny`** stops the value leaving.
  - `execute_command`: the word check in [Network policy](#network-policy), before a live secret's helper runs.
  - The KB: every KB call is refused, for every caller, because every KB call sends the token over the network. Nothing is sent. `kb_setup` refuses a `deny` secret, so a config cannot be set up that fails on every call.

The KB's refusal is `E-KB-HTTP-AUTH`, reason `policy-deny` or `member-not-allowed`. A capture, invalidate or feedback refused this way is not queued: the caller gets the error, and retries once the policy allows it. See [Named credentials](knowledge-layer.md#named-credentials-and-refreshers).

### Session and persistent

| Tier | Where it lives | At server restart |
|------|----------------|-------------------|
| Persistent | encrypted in `credentials.json` | kept |
| Session | in the server's memory only | gone |

`persist: false` keeps the secret in memory only: nothing is written to disk. A session secret stays session when re-set, unless you pass `persist: true`. `persist: false` on a persistent secret is refused before any value is asked for: delete the secret first if you really want a session value. Deleting also drops its policy and members.

Example: `credential_store_set name=one_off persist=false` stores a value that ends at the next server restart.

Two limits:

- A name bound to a live secret must be persistent, so `persist: false` on it is refused before any value is asked for.
- `--persist` always means persistent, and the CLI reads only `credentials.json`. It cannot see a server's session secrets, so for a name that exists only as a session secret it uses the new-secret defaults. That persistent record then takes over from the session value.

## Supported Fields

| Tool | Parameter | Notes |
|------|-----------|-------|
| `register_member` | `password` | SSH password for remote member registration |
| `update_member` | `password` | SSH password update |
| `provision_llm_auth` | `api_key` | Provider API key |
| `provision_vcs_auth` | `token`, `api_token` | GitHub PAT / Azure DevOps PAT, Bitbucket API token |
| `setup_git_app` | `private_key_path` | If the resolved value starts with `-----BEGIN`, it is used as PEM content directly |
| `execute_command` | `command`, `restart_command` | Resolved server-side, then redacted from the output |

`execute_prompt` deliberately does NOT resolve these tokens: a prompt
containing `{{secret.NAME}}` is rejected outright, since secrets must never
reach an LLM prompt. Use `execute_command` instead.

> **WARNING**: `{{secret.NAME}}` only resolves in the fields listed above. Using it in any other parameter (e.g. a prompt, a path field) passes the literal string through - the secret is NOT injected.

---

## Behavior notes


- Delivery vs. persistence: Running `apra-fleet secret --set NAME` without `--persist` delivers to a waiting OOB request but does NOT store in the vault. `{{secret.NAME}}` requires vault storage - use `--persist`.
- `credential_store_set` **blocks** - when called, the tool opens an OOB terminal and waits synchronously for the user to enter the secret. It does not return a "Waiting..." intermediate status or require a second call. On success it returns `[OK] NAME stored [session/persistent]. Use {{secret.NAME}} in commands.`
- A value typed with `apra-fleet secret --set NAME --persist` while `credential_store_set` or `register_member` waits for NAME goes to that call, which stores it with the policy and members it asked for. That command does not store it again, so its `--allow`, `--deny`, `--members` and `--expires-at` are not applied: change them afterwards with `secret --update`.
- Failed resolution is always explicit - the tool returns an error and aborts. No silent pass-through of the token string.

## CI / Non-Interactive Usage

For CI pipelines or scripts where interactive input is unavailable, use the `-y` flag with `apra-fleet secret --set` to read the value from stdin instead of opening an OOB terminal:

```bash
# Store a secret non-interactively (value from stdin)
echo "$TOKEN" | apra-fleet secret --set github_pat --persist -y

# Pipe from a file or command substitution
cat ~/.token | apra-fleet secret --set deploy_key --persist -y
```

The `-y` flag bypasses OOB terminal launch entirely - the value is read from stdin and stored directly. This is safe in CI because stdin is already a controlled, non-LLM channel. The same success message is returned: `[OK] github_pat stored [persistent]. Use {{secret.github_pat}} in commands.`

---

## Live secrets

A live secret is a static secret that knows its expiry and is generated on demand.
You register a small script, called a helper. When the token is needed, the
orchestrator runs the helper, keeps the token in memory, never in a file, and uses
it as `{{secret.NAME}}`. A restart empties the cache, and the next use mints again.
No command, tool or channel returns the value.

> **TEMPORARY LIMITS IN 0.4.5. BOTH WILL BE REMOVED.** Live secrets are meant to work
> like static secrets, everywhere. Until then:
>
> 1. **Live secrets work only in `execute_command` and the KB.** Every other
>    `{{secret.NAME}}` field in the table above gives a clear error, because it
>    would keep the value in a file, where a short-lived token expires with no way to
>    renew it.
> 2. **`secret --live` is refused on a remote member's install,** because renewal comes
>    only from the orchestrator. The error points you there. A remote member's install
>    is one with `data/member-install.json`. A full install clears that marker, so if
>    this machine is your orchestrator and is still refused, rerun `apra-fleet install`.
>    `apra-fleet update` on a member keeps it.

### The two helper forms

From the CLI, on the orchestrator:

```bash
apra-fleet secret --live NAME --inline '<script with {{secret.R}}>'
apra-fleet secret --live NAME [--env 'VAR={{secret.R}}']... <script file> [args]
```

- **Inline** is one line in the orchestrator's shell: bash, or PowerShell on Windows.
  Write `{{secret.R}}` bare, never inside your own quotes. It is rewritten to an env
  var reference (`"$FLEET_SECRET_R"` or `${env:FLEET_SECRET_R}`), so the value is
  never on a command line and needs no escaping. A `-` in the name becomes `_`, and
  two names that then collide, or differ only by case, are refused.
- **Script file** is for anything complex. Bound secrets arrive in the env vars you
  name with `--env`, never as arguments, and a placeholder in the arguments is
  refused. A name without a path separator is looked up on absolute PATH entries only;
  a name with one is taken as a file. The absolute path is stored.

The script's working folder is the fleet data folder, so give any file it needs as an
absolute path.

Options come first. Parsing stops at the first argument that is not an option: that is
the script path, and everything after it goes to the script untouched, including
arguments starting with `-`.

- `--` before the script path is optional. Write a file whose name starts with `-` as
  `./-name.sh`. `--` is needed only for a script found on PATH by a bare name starting
  with `-`.
- npm's PowerShell shim drops a bare `--`, so to give your script its own `--`, quote
  it: `'--'`.
- An unknown option before the path is an error, and so is an `--env` value not of the
  form `VAR={{secret.R}}`.
- `--inline` takes one script and no script path. Windows PowerShell 5.1 removes the
  double quotes inside an inline script before apra-fleet sees it. A script split by
  that fails with `inline-extra-args`; one changed without a split (`$x = "abc"` arriving
  as `$x = abc`) fails with `inline-quotes-changed`, found by checking the command's own
  command line on Windows. If that line cannot be read the result is `inline-unverified`.
  Each saves nothing: use doubled single quotes, as in the examples, or a script file.

### Script types per OS

Every form gets the same input. Registration fails with the reason shown when a type
cannot run.

| Script | Windows | Linux and macOS |
|---|---|---|
| `.ps1` | `powershell.exe -File` | `pwsh -File`; no pwsh: `launcher-not-found` |
| `.sh` | Git for Windows' bash, never the WSL launcher in `System32`; no Git Bash: `launcher-not-found` | With the execute bit: run directly, so its shebang decides. Without it: `/bin/sh` |
| `.bat`, `.cmd` | `cmd.exe /d /v:off /s /c`, every piece quoted | `script-type-unsupported` |
| `.exe`, `.com` | Run directly | Run directly, like any other file |
| Anything else | `script-type-unsupported` | Run directly; no execute bit: `script-not-executable` |

`cmd`, `taskkill` and `powershell` come from `%SystemRoot%\System32` or an absolute PATH
entry, never from the current folder or a relative PATH entry.

### The helper contract

The helper gets `FLEET_CREDENTIAL` (its own name) and its bound secrets in env, and
nothing on stdin. It prints one JSON object on stdout and exits 0:

```json
{"token":"<token>","expires_at":"2026-01-01T12:00:00Z"}
```

- `token`: not empty, no whitespace.
- `expires_at`: ISO 8601 with an explicit zone (`Z` or `+hh:mm`), in the future.
- Limits: 64 KiB of stdout, and 30 seconds, after which the whole process tree is killed.
  A non-zero exit, a timeout, too much output, invalid JSON or a bad field is a failed run.

### The test at registration

Registering runs in the CLI process:

1. Every bound secret must exist, be readable, and be persistent and static. Any other
   is named in the error.
2. The helper runs once, and is saved only if that worked. Otherwise nothing is written
   and any existing record is unchanged.
3. It prints only `OK: expires <time>`, or `FAILED: <reason code>` with the exit code
   when there is one.

**Nothing from the helper is ever shown.** The token is discarded, stderr is read and
thrown away, and neither stdout nor stderr reaches an error, a log line or `fleet_status`.

Known limit: the service's PATH or `az login` state can differ from your terminal's.
`fleet_status` shows `not run` until the first real mint, then the real state.

There is no approval step: any process running as the orchestrator's OS user can register
a helper, and a badly written script can expose its own secrets, as any `execute_command`
can. Secrets enter only by reference. Text that looks like a known token format is refused,
as a best-effort check: a value typed into a script cannot always be caught.

### Bindings are permanent

A secret a helper reads, through `{{secret.R}}` or `--env`, is bound to it.

- **It cannot be deleted while that helper exists.** `secret --delete` and
  `credential_store_delete` fail with `secret is in use by: <live secrets>`. Delete the
  helper first. Registering a helper over a bound name is refused the same way.
  `secret --delete --all` removes helpers first, then secrets.
- **Its value can be updated,** for rotation, with `apra-fleet secret --set R --persist`, which
  keeps its policy and members. That does not re-run the test, and a token minted with the old value stays cached until
  it is replaced.
- **An expired bound secret is kept:** the binding is to the name, not the value. Member
  commands get `expired` for it, the startup purge skips it, and a helper run that uses it
  writes a warning to the fleet log. `secret --update` and `credential_store_update` refuse
  it until it has a new value, so neither can bring the old one back.
- **A bound name cannot have a session value.** Setting one is refused: use `--persist`.
- **A session secret cannot be bound,** because it disappears on restart. Store it with
  `--persist` (see [Session and persistent](#session-and-persistent)).
- **A live secret cannot be bound** to another helper.

### When a token is minted

On each use: while the remaining lifetime is at least T the current token is handed off;
below T, or once expired, a new one is minted first and replaces it. Nothing mints on a
timer here. Concurrent callers share one mint.

T is `min(refreshFraction x lifetime, refreshMaxSeconds)`, from `liveSecrets` in the fleet
`config.json`. These are the defaults:

```json
{ "liveSecrets": { "refreshFraction": 0.1, "refreshMaxSeconds": 600 } }
```

`refreshFraction` must be between 0 and 1 (both exclusive) and `refreshMaxSeconds` above 0;
an invalid value is reported on the server's stderr and the default is used.

After a failed run the helper is not run again until a backoff has passed: 10 seconds,
doubling with each consecutive failure, up to 5 minutes. Calls inside the window fail at
once and say when it will next run. If the failed run was a refresh and the previous token
has not expired, that token keeps being used. Registering again clears the backoff. A failed
run is the typed error `E-LIVE-SECRET`, naming the secret and the cause, such as `exit code 1`,
never a value or stderr.

The value of a long-running `execute_command` is fixed at launch, so it keeps a dead token
until restarted.

### Managing a live secret

A live record has the same policy fields as a static one (see
[Who can use a secret](#who-can-use-a-secret-deny-and-allowedmembers)), with the defaults of
`secret --set --persist`: allow, all members. `apra-fleet secret --update NAME` changes them
(`--ttl` does not apply: the expiry comes from the token). Output redaction also applies as
for a static secret.

`apra-fleet secret --set NAME --persist -y` replaces it with a static one that keeps its policy
fields, `--delete` removes it, and `--list` marks it `live`. Registering again under the same name replaces the script,
starts a fresh cache entry, and keeps the policy fields of the record it replaces. The MCP tools
`credential_store_set`, `credential_store_update` and `credential_store_delete` refuse a live
name, and `register_member` refuses one in its password field.

`fleet_status` lists every live secret on one `live secret NAME` line each (the `liveSecrets`
array in JSON): the script or path, args and bindings with placeholders only, state (`not run`,
`refreshing`, `ok`, `failed`, `expired`), last minted, expiry, and any last failure with the
next run time. The state is this fleet server process's.

For az's login state and other problems when a helper runs without a terminal, see the
[KB guide](knowledge-layer.md#live-secrets).

### Examples: inline helpers

An inline helper is one line, with no file to keep. On Windows it runs in Windows
PowerShell whatever shell you type it in; on Linux and macOS in bash.

**Sample: Entra ID through az, bash (Linux, macOS).** az's `expires_on` (Unix
seconds) becomes `expires_at`. `jq` must be on the service's PATH.

<!-- live-secret-sample:az-bash -->
```bash
apra-fleet secret --live KB_TOKEN --inline 'az account get-access-token --resource api://kb-app --query "{t:accessToken,e:expires_on}" -o json | jq -c "{token:.t, expires_at:(.e|todate)}"'
```

**Sample: Entra ID through az, PowerShell (Windows).**

<!-- live-secret-sample:az-powershell -->
```powershell
apra-fleet secret --live KB_TOKEN --inline '$t = (az account get-access-token --resource api://kb-app --query ''{t:accessToken,e:expires_on}'' -o json | Out-String) | ConvertFrom-Json; @{ token = $t.t; expires_at = [DateTimeOffset]::FromUnixTimeSeconds([long]$t.e).ToString(''o'') } | ConvertTo-Json -Compress'
```

Typed in PowerShell, use doubled single quotes inside the script as shown:
Windows PowerShell strips double quotes from an argument it hands to a program.

**Sample: OAuth client credentials with a bound secret, bash (Linux, macOS).** The
`{{secret.sp_secret}}` is bare, and reaches curl on stdin.

<!-- live-secret-sample:oauth-inline-bash -->
```bash
apra-fleet secret --live KB_TOKEN --inline 'printf %s {{secret.sp_secret}} | curl -fsS https://idp.example.test/token --data-urlencode grant_type=client_credentials --data-urlencode client_id=my-client --data-urlencode client_secret@- | jq -c "{token:.access_token, expires_at:((now|floor) + .expires_in | todate)}"'
```

**Sample: OAuth client credentials with a bound secret, PowerShell (Windows).**

<!-- live-secret-sample:oauth-inline-powershell -->
```powershell
apra-fleet secret --live KB_TOKEN --inline '$b = @{ grant_type = ''client_credentials''; client_id = ''my-client''; client_secret = {{secret.sp_secret}} }; $r = Invoke-RestMethod -UseBasicParsing -Method Post -Uri https://idp.example.test/token -Body $b; @{ token = $r.access_token; expires_at = [DateTimeOffset]::UtcNow.AddSeconds([long]$r.expires_in).ToString(''o'') } | ConvertTo-Json -Compress'
```

Store `sp_secret` first, in both: `apra-fleet secret --set sp_secret --persist`.

### Examples: script-file helpers

**`.sh`.** On Windows it runs under Git for Windows' bash, and `jq` and `curl` must
be on the PATH there.

**Sample: Entra ID service principal, bash.** Save it as `/opt/kb/mint-sp.sh` and
`chmod 755` it. The client secret goes to curl on stdin (`client_secret@-`), so
it stays off curl's own command line too.

<!-- live-secret-sample:sp-bash -->
```bash
#!/usr/bin/env bash
# Usage: mint-sp.sh <tenant> <client-id> <scope>. The secret arrives in CLIENT_SECRET.
set -euo pipefail
printf '%s' "$CLIENT_SECRET" | curl -fsS "https://login.microsoftonline.com/$1/oauth2/v2.0/token" \
  --data-urlencode 'grant_type=client_credentials' \
  --data-urlencode "client_id=$2" \
  --data-urlencode "scope=$3" \
  --data-urlencode 'client_secret@-' \
  | jq -c '{token:.access_token, expires_at:((now|floor) + .expires_in | todate)}'
```

<!-- live-secret-sample:sp-bash-register -->
```bash
apra-fleet secret --live KB_TOKEN --env 'CLIENT_SECRET={{secret.sp_secret}}' /opt/kb/mint-sp.sh <tenant> <client-id> <app-id-uri>/.default
```

**Sample: generic OAuth client credentials, bash.** The same script for any token
endpoint, taking its URL as the first argument.

<!-- live-secret-sample:oauth-bash -->
```bash
#!/usr/bin/env bash
# Usage: mint-oauth.sh <token-url> <client-id> <scope>. The secret arrives in CLIENT_SECRET.
set -euo pipefail
printf '%s' "$CLIENT_SECRET" | curl -fsS "$1" \
  --data-urlencode 'grant_type=client_credentials' \
  --data-urlencode "client_id=$2" \
  --data-urlencode "scope=$3" \
  --data-urlencode 'client_secret@-' \
  | jq -c '{token:.access_token, expires_at:((now|floor) + .expires_in | todate)}'
```

<!-- live-secret-sample:oauth-bash-register -->
```bash
apra-fleet secret --live KB_TOKEN --env 'CLIENT_SECRET={{secret.sp_secret}}' /opt/kb/mint-oauth.sh <token-url> <client-id> <scope>
```

**`.ps1`.** On Linux and macOS it runs under `pwsh`.

**Sample: generic OAuth client credentials, PowerShell** (also the Entra ID
service principal, with `https://login.microsoftonline.com/<tenant>/oauth2/v2.0/token`
as the URL). The secret goes in the request body, never on a command line. Save
it as `C:\kb\mint-oauth.ps1`.

<!-- live-secret-sample:oauth-powershell -->
```powershell
param([string]$TokenUrl, [string]$ClientId, [string]$Scope)
$body = @{ grant_type = 'client_credentials'; client_id = $ClientId; scope = $Scope; client_secret = $env:CLIENT_SECRET }
$r = Invoke-RestMethod -UseBasicParsing -Method Post -Uri $TokenUrl -Body $body
@{ token = $r.access_token; expires_at = [DateTimeOffset]::UtcNow.AddSeconds([long]$r.expires_in).ToString('o') } | ConvertTo-Json -Compress
```

<!-- live-secret-sample:oauth-powershell-register -->
```powershell
apra-fleet secret --live KB_TOKEN --env 'CLIENT_SECRET={{secret.sp_secret}}' C:\kb\mint-oauth.ps1 <token-url> <client-id> <scope>
```

Keep `--env` values in quotes: PowerShell reads unquoted braces as a script block.

**`.bat` (Windows).** The same request from a batch file. Batch has no safe way to
pass a value on to a program, so it hands the work to PowerShell, which reads the
secret from env. Never expand `%CLIENT_SECRET%` on a command line. Save it as
`C:\kb\mint-oauth.bat`.

<!-- live-secret-sample:oauth-bat -->
```bat
@echo off
rem Usage: mint-oauth.bat <token-url> <client-id> <scope>. The secret arrives in CLIENT_SECRET.
powershell -NoProfile -NonInteractive -ExecutionPolicy Bypass -Command "$b = @{ grant_type = 'client_credentials'; client_id = '%~2'; scope = '%~3'; client_secret = $env:CLIENT_SECRET }; $r = Invoke-RestMethod -UseBasicParsing -Method Post -Uri '%~1' -Body $b; @{ token = $r.access_token; expires_at = [DateTimeOffset]::UtcNow.AddSeconds([long]$r.expires_in).ToString('o') } | ConvertTo-Json -Compress"
exit /b %errorlevel%
```

<!-- live-secret-sample:oauth-bat-register -->
```powershell
apra-fleet secret --live KB_TOKEN --env 'CLIENT_SECRET={{secret.sp_secret}}' C:\kb\mint-oauth.bat <token-url> <client-id> <scope>
```
