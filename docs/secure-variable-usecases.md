# Secure Variables (`{{secure.NAME}}`)

`{{secure.NAME}}` tokens are resolved server-side before execution. The plaintext secret never appears in chat, logs, or LLM context. Only specific tool parameters support resolution - see the supported fields table below.

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
containing `{{secure.NAME}}` is rejected outright, since secrets must never
reach an LLM prompt. Use `execute_command` instead.

> **WARNING**: `{{secure.NAME}}` only resolves in the fields listed above. Using it in any other parameter (e.g. a prompt, a path field) passes the literal string through - the secret is NOT injected.

---

## Behavior notes


- Delivery vs. persistence: Running `apra-fleet secret --set NAME` without `--persist` delivers to a waiting OOB request but does NOT store in the vault. `{{secure.NAME}}` requires vault storage - use `--persist`.
- `credential_store_set` **blocks** - when called, the tool opens an OOB terminal and waits synchronously for the user to enter the secret. It does not return a "Waiting..." intermediate status or require a second call. On success it returns `[OK] NAME stored [session/persistent]. Use {{secure.NAME}} in commands.`
- Failed resolution is always explicit - the tool returns an error and aborts. No silent pass-through of the token string.

## CI / Non-Interactive Usage

For CI pipelines or scripts where interactive input is unavailable, use the `-y` flag with `apra-fleet secret --set` to read the value from stdin instead of opening an OOB terminal:

```bash
# Store a secret non-interactively (value from stdin)
echo "$TOKEN" | apra-fleet secret --set github_pat --persist -y

# Pipe from a file or command substitution
cat ~/.token | apra-fleet secret --set deploy_key --persist -y
```

The `-y` flag bypasses OOB terminal launch entirely - the value is read from stdin and stored directly. This is safe in CI because stdin is already a controlled, non-LLM channel. The same success message is returned: `[OK] github_pat stored [persistent]. Use {{secure.github_pat}} in commands.`
