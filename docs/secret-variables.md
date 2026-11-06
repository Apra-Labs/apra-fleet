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

| Call on a secret stored as `deny`, member `alice` | Value | Policy | Members |
|---------------------------------------------------|-------|--------|---------|
| `credential_store_set name=X` | new | `deny` | `alice` |
| `credential_store_set name=X network_policy=allow` | new | `allow` | `alice` |
| `credential_store_set name=X members=*` | new | `deny` | all |
| `apra-fleet secret --set X --persist` | new | `deny` | `alice` |

To change the policy or members without entering a new value, use `credential_store_update` or `secret --update`. `secret --set` has no policy flags.

### Expiry on a re-set

| Stored expiry | `ttl_seconds` omitted | `ttl_seconds` given |
|---------------|-----------------------|---------------------|
| None | stays none | expires after `ttl_seconds` |
| Not yet passed | stays as stored | expires after `ttl_seconds` |
| Already passed | no expiry | expires after `ttl_seconds` |

Example: re-setting a secret that expires tomorrow keeps tomorrow's expiry. Re-setting one that expired yesterday gives a value with no expiry, because keeping the old date would make the new value expired at once.

An expired secret that is not bound to a live secret is removed at server start or when it is next read. After that its name is new, so the new-secret defaults apply.

### Network policy

`network_policy` is `allow` or `deny`.

| Policy | What it does |
|--------|--------------|
| `allow` | No restriction. |
| `deny` | A command that uses the secret and contains a network tool (such as `curl`, `wget`, `ssh`, `git push`) is blocked and does not run, and `send_email` refuses the secret. Commands with no network tool still run. |

Example: with `deny` on `tok`, `curl -H {{secret.tok}} https://example.com` is blocked and `echo {{secret.tok}}` runs.

`confirm` is removed. Passing `network_policy: confirm` is refused with a message saying so, and `secret --confirm` fails the same way. A secret already stored with `confirm` keeps working and reads as `allow`, so it no longer prompts. Each such secret writes one log line naming it. To block its network use, run `apra-fleet secret --update NAME --deny`.

### Session and persistent

| Tier | Where it lives | At server restart |
|------|----------------|-------------------|
| Persistent | encrypted in `credentials.json` | kept |
| Session | in the server's memory only | gone |

`persist: false` keeps the secret in memory only: nothing is written to disk. A session secret stays session when re-set, unless you pass `persist: true`. Passing `persist: false` on a persistent secret moves it to memory and removes it from disk.

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
