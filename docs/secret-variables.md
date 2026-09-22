# Secret Variables (`{{secret.NAME}}`)

## Terminology

- **Secret variable** - a named value in the credential store.
- **`{{secret.NAME}}`** - the only reference syntax for a secret variable.
- **Credential store** - the container holding secret variables (`credential_store_*` tools, `apra-fleet secret` CLI).
- **Out-of-band (OOB) entry** - how values get into the credential store.
- `{{secure.NAME}}` is the deprecated legacy spelling -- still accepted, prints a warning, never use it in new text.

`{{secret.NAME}}` tokens are resolved server-side before execution. The plaintext secret never appears in chat, logs, or LLM context. Only specific tool parameters support resolution - see the supported fields table below.

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
- `credential_store_set` **blocks by default** - when a TTY is attached and `return_url` is not passed, the tool opens an OOB terminal and waits synchronously for the user to enter the secret. It does not return a "Waiting..." intermediate status or require a second call. On success it returns `[OK] NAME stored [session/persistent]. Use {{secret.NAME}} in commands.`
- **Non-blocking alternative**: when the server has no TTY attached (headless/service context), or `return_url: true` is passed explicitly, the tool instead returns immediately with `structuredContent: {url, expiresAt}` - a one-time browser URL the user opens to submit the secret asynchronously. The secret is stored the moment that form is submitted; no follow-up tool call is needed. See `docs/features/oob-auth.md` for the full mechanism.
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
