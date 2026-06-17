# Getting Started with OpenCode in Apra Fleet

OpenCode is an open-source AI coding assistant (opencode.ai) that works as both a
**fleet member** (a worker that receives tasks) and an **orchestrator** (the PM agent
that dispatches tasks to other members). Unlike Claude Code or Gemini CLI, OpenCode
is provider-agnostic -- it routes to self-hosted Ollama models, Google Gemini, cloud
APIs, or OpenCode Go's hosted open-source models.

---

## Prerequisites

Install OpenCode on the target machine:

```bash
# Linux
curl -fsSL https://opencode.ai/install | bash

# macOS / Windows
npm install -g opencode-ai
```

Verify:

```bash
opencode --version
```

---

## Model Setup

OpenCode supports several model sources. Choose one or configure multiple.

### Option A -- Self-hosted Ollama (tested and working)

Best for: air-gapped environments, no API costs, GPU-rich machines.

Add your Ollama server to `~/.config/opencode/opencode.json`:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "provider": {
    "ollama": {
      "npm": "@ai-sdk/openai-compatible",
      "name": "Ollama (your server name)",
      "options": {
        "baseURL": "http://<your-ollama-host>:11434/v1"
      },
      "models": {
        "qwen3-coder:30b": { "name": "Qwen3-Coder 30B" },
        "qwen3-coder-next": { "name": "Qwen3-Coder-Next" },
        "MichelRosselli/GLM-4.5-Air:Q4_K_M": { "name": "GLM-4.5-Air" }
      }
    }
  }
}
```

**Tested and verified models (via Ollama):**

| Model ID | Notes |
|---|---|
| `ollama/qwen3-coder:30b` | Solid coding model, good instruction following |
| `ollama/qwen3-coder-next` | Faster variant, recommended for standard tier |
| `ollama/MichelRosselli/GLM-4.5-Air:Q4_K_M` | Good for premium tasks, larger context |

For local Ollama (same machine), use `http://localhost:11434/v1`.

---

### Option B -- Google Gemini via OAuth (tested and working)

Best for: users with Google AI Ultra subscription ($129/month), no per-token billing.

**1. Add the auth plugin to `~/.config/opencode/opencode.json`:**

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": ["opencode-gemini-auth@latest"]
}
```

**2. Authenticate:**

```bash
opencode auth login
# Select Google -> complete browser OAuth flow
```

**3. Use Google models** by selecting them in the OpenCode TUI or setting them in
fleet model_tiers (see below).

**Tested and verified Google models:**

| Model ID | Notes |
|---|---|
| `google/gemini-2.5-flash` | Fast, cost-efficient, good for most tasks |
| `google/gemini-2.5-pro` | Higher reasoning, use for complex planning |

**Note on auth:** The `GOOGLE_GENERATIVE_AI_API_KEY` environment variable is the
exact key name OpenCode uses (not `GEMINI_API_KEY` or `GOOGLE_API_KEY`). If you
prefer API key auth over OAuth, set this variable before launching OpenCode.

---

### Option C -- OpenCode Go free models (tested and working, no account needed)

Best for: quick testing, zero setup, no API key required.

OpenCode bundles access to free-tier models from OpenRouter out of the box. No
configuration needed -- they appear in the model picker labeled "Free".

**Tested and verified:**

| Model ID | Notes |
|---|---|
| `DeepSeek V4 Flash Free` | Works out of the box, ~20-50 req/day free limit |

**Rate limits:** Free models are rate-limited per IP (typically 20-50 requests/day).
Fine for testing; for production use, subscribe to OpenCode Go ($10/month) to unlock
higher limits and additional models.

---

## Registering an OpenCode Member in Fleet

```
register_member
  friendly_name: "my-opencode-worker"
  member_type: local          (or remote for SSH members)
  work_folder: "/path/to/work"
  llm_provider: opencode
  model_tiers: {
    cheap: "ollama/qwen3-coder:30b",
    standard: "ollama/qwen3-coder-next",
    premium: "ollama/MichelRosselli/GLM-4.5-Air:Q4_K_M"
  }
```

Fleet validates `model_tiers` against `opencode models` output at registration time
and warns if any model ID is not found -- this catches typos before they cause
silent failures at prompt time.

To update tiers after registration:

```
update_member
  member_name: "my-opencode-worker"
  model_tiers: {
    cheap: "ollama/qwen3-coder:30b",
    standard: "google/gemini-2.5-flash",
    premium: "google/gemini-2.5-pro"
  }
```

You can mix providers within a single member's tier map (e.g. Ollama for cheap,
Google for premium).

---

## Using OpenCode as an Orchestrator

To use OpenCode as the PM agent that dispatches tasks to fleet members, install
fleet with `--llm opencode` and it will register the MCP server inside OpenCode
automatically.

### Method 1 -- npm (requires Node.js 22+)

```bash
npm install -g @apralabs/apra-fleet
apra-fleet install --llm opencode
```

### Method 2 -- standalone binary (no Node.js required)

**macOS (Apple Silicon)**
```bash
curl -fsSL https://github.com/Apra-Labs/apra-fleet/releases/latest/download/apra-fleet-installer-darwin-arm64 -o apra-fleet-installer && chmod +x apra-fleet-installer && ./apra-fleet-installer install --llm opencode
```

**Linux (x64)**
```bash
curl -fsSL https://github.com/Apra-Labs/apra-fleet/releases/latest/download/apra-fleet-installer-linux-x64 -o apra-fleet-installer && chmod +x apra-fleet-installer && ./apra-fleet-installer install --llm opencode
```

**Windows (x64)** -- run in PowerShell:
```powershell
Invoke-WebRequest -Uri https://github.com/Apra-Labs/apra-fleet/releases/latest/download/apra-fleet-installer-win-x64.exe -OutFile apra-fleet-installer.exe; .\apra-fleet-installer.exe install --llm opencode
```

After install, restart OpenCode to load the MCP server. All fleet tools
(`register_member`, `execute_prompt`, `fleet_status`, etc.) will be available
inside OpenCode sessions, and OpenCode can dispatch work to Claude Code, Gemini,
or other fleet members.

**Note on Gemini compatibility:** If OpenCode is used as orchestrator with a Google
model, the fleet MCP schema is fully compatible. Earlier `anyOf` schema issues have
been resolved as of fleet v0.3.0.

---

## Permissions

Set permissions for an OpenCode member using `compose_permissions`:

```
compose_permissions
  member_name: "my-opencode-worker"
  role: doer
```

This writes `.opencode/settings.json` in the member's work folder with:

```json
{ "permission": { "edit": "allow", "write": "allow", "bash": "allow" } }
```

For a reviewer role (read-only):

```json
{ "permission": { "edit": "deny", "write": "allow", "bash": "allow" } }
```

OpenCode uses coarse-grained permissions (edit/write/bash allow/deny) rather than
the granular `Bash(npm:*)` style used by Claude Code.

---

## Sidebar / TUI Controls

| Action | Default keybind |
|---|---|
| Toggle sidebar | `<leader>b` (leader = `ctrl+x`) |
| Show tool details | (none -- assign in tui.json) |

Customize keybinds in `~/.config/opencode/tui.json`:

```json
{
  "keybinds": {
    "sidebar_toggle": "ctrl+b"
  }
}
```

---

## Troubleshooting

**"Google Generative AI API key is missing"**
Set `GOOGLE_GENERATIVE_AI_API_KEY` in your environment, or run `opencode auth login`
with the `opencode-gemini-auth` plugin installed.

**"Requested entity was not found" from Google**
The model name is wrong or your account does not have access to it. Try
`google/gemini-2.5-flash` (GA model) first to confirm auth is working, then check
the exact model ID via `opencode models`.

**Model not appearing after adding to opencode.json**
Restart OpenCode -- config is read at startup only.

**model_tiers warning at registration**
Fleet ran `opencode models` and could not find the specified model ID. Check the
exact model ID with `opencode models` on the member machine and update via
`update_member model_tiers: { ... }`.

**"command not found: opencode"**
OpenCode is not installed or not on PATH. Run `npm install -g opencode-ai` and
ensure `~/.npm-global/bin` (or equivalent) is on PATH.
