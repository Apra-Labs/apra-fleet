# blindfold

**Secure credential vault for AI agents.** Blindfold keeps secrets out of LLM context windows by collecting them through an out-of-band (OOB) side-channel, encrypting them with AES-256-GCM, and resolving them only at the last moment — right before a shell command runs. The LLM only ever sees a `{{secure.NAME}}` token; the plaintext never touches the model.

---

## Quick start

```bash
npm install -g blindfold
blindfold install        # registers the MCP server with Claude Desktop and Claude Code
# Restart your AI client
```

Once registered, Claude will have five new MCP tools for storing and resolving credentials.

---

## Library usage

For most use cases, store credentials through the MCP tool (`credential_store_set`) rather than calling the lower-level API directly. The MCP tool handles the full OOB flow. If you need to drive the flow programmatically:

```typescript
import { initBlindfold, collectOobApiKey, decryptPassword, resolveSecureTokens, redactOutput } from 'blindfold';

initBlindfold({ dataDir: '/var/lib/myapp/blindfold' });

// Collect a secret from the user via OOB side-channel (terminal popup / GUI prompt).
// Returns { password?: string; fallback?: string; persist?: boolean }
// `password` is encrypted — call decryptPassword() to get the plaintext.
const result = await collectOobApiKey('MY_API_KEY', 'credential_store_set', {
  prompt: 'Enter your API key',
});
if (result.password) {
  const plaintext = decryptPassword(result.password);
  // use plaintext...
} else if (result.fallback) {
  // User could not open a terminal — handle gracefully
}

// Later: resolve {{secure.MY_API_KEY}} tokens inside a command string.
// Returns { resolved: string; credentials: ResolvedCredential[] } | { error: string }
const result2 = resolveSecureTokens('curl -H "Authorization: Bearer {{secure.MY_API_KEY}}" https://api.example.com');
if ('error' in result2) throw new Error(result2.error);
const { resolved, credentials } = result2;
// Run `resolved` as a shell command, then scrub secrets from the output:
// const safeOutput = redactOutput(rawOutput, credentials);
```

The MCP server entrypoint is importable separately:

```typescript
import { startMcpServer } from 'blindfold/mcp';
await startMcpServer();
```

---

## MCP tool reference

| Tool | Description |
|------|-------------|
| `credential_store_set` | Collect a new secret from the user via OOB side-channel and store it |
| `credential_store_update` | Update an existing credential (rotate secret, change TTL, adjust policy) |
| `credential_store_delete` | Delete a stored credential by name |
| `credential_store_list` | List stored credentials (names and metadata only — no plaintext) |
| `resolve_secure` | Resolve `{{secure.NAME}}` tokens in a string, returning the plaintext with shell escaping |

---

## `{{secure.NAME}}` token syntax

Pass `{{secure.NAME}}` anywhere you would normally put a secret (command arguments, environment values, API call parameters). Blindfold resolves it just before execution:

```
# In a shell command:
docker login -u myuser -p {{secure.DOCKER_TOKEN}} registry.example.com

# In a URL parameter passed to a tool:
curl https://api.example.com/data?key={{secure.API_KEY}}
```

Token names must match `[a-zA-Z0-9_-]{1,64}`. Unresolved tokens cause an error rather than silently passing an empty value.

---

## CLI reference

| Command | Description |
|---------|-------------|
| `blindfold` | Start the MCP server (stdio transport) |
| `blindfold serve` | Alias for starting the MCP server |
| `blindfold install` | Register blindfold with Claude Desktop and Claude Code |
| `blindfold install --for claude` | Register with Claude Desktop only |
| `blindfold secret --set NAME` | Store a secret interactively |
| `blindfold secret --set NAME --persist` | Store and persist the secret to disk (encrypted) |
| `blindfold secret --set NAME -y` | Read secret value from stdin (non-interactive) |
| `blindfold secret --list` | List stored credentials (names and metadata only) |
| `blindfold secret --update NAME` | Rotate or update a stored credential |
| `blindfold secret --update NAME --members LIST` | Restrict credential to comma-separated member list |
| `blindfold secret --update NAME --ttl SECONDS` | Set credential expiry (TTL in seconds from now) |
| `blindfold secret --update NAME --allow` | Set network policy to allow |
| `blindfold secret --update NAME --deny` | Set network policy to deny |
| `blindfold secret --delete NAME` | Delete a named credential |
| `blindfold secret --delete --all` | Delete all stored credentials (prompts for confirmation) |
| `blindfold auth --confirm` | Confirm a pending OOB authentication request |
| `blindfold --version` | Print version |
| `blindfold --help` | Print usage |

---

## Security model

Secrets are collected through a **Unix Domain Socket (UDS) side-channel** that is inaccessible to the LLM. When a credential is needed, the agent calls `credential_store_set`; blindfold opens a separate terminal or GUI prompt on the user's desktop, collects the secret there, and delivers it back through the UDS — never through the MCP stdio stream that the LLM reads. Persisted credentials are encrypted with **AES-256-GCM** using a randomly generated key stored in a file with owner-only (`0600`) permissions. In-memory (session) credentials are held in a process-local map and never written to disk. Token resolution applies shell escaping by default, preventing injection through crafted credential values.

---

## Requirements

- **Node.js 20+** (the MCP SDK requires Node 18+; Node 20 LTS is recommended)
- **Platforms**: Linux (primary), macOS (supported), Windows (supported, UDS requires Windows 10 1903+)
- **Peer dependency**: `@modelcontextprotocol/sdk ^1.27.0` (required when using blindfold as an MCP server; optional for library-only use)
