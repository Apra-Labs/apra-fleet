<!-- llm-context: Survey of whether gemini/codex/copilot/agy/opencode can (i) attach to
     a local MCP endpoint with custom headers, and (ii) accept mid-session prompt
     injection from an external process while a long-running session is live (mode
     (b) of execute_prompt, per hub-spoke-master-plan.md section 8/9.7). Answers
     apra-fleet-us9.9. Live-researched 2026-07-04 via each project's public docs/
     JSON schema where reachable; AGY (Google Antigravity) has no public reference
     available and remains open. -->
<!-- keywords: interactive injection, mode b, MCP headers, gemini-cli, codex, copilot
     cli, agy, opencode, mid-session prompt injection, notifications/claude/channel -->

# Interactive-Injection Capability Survey (Non-Claude Providers)

Status: research document, 2026-07-04. Answers docs/hub-spoke-master-plan.md
section 9.7 / point 7 of the Claude-centrism audit, and beads item
apra-fleet-us9.9. Method: each provider's public documentation and/or
JSON config schema was fetched directly (URLs cited per finding) rather than
inferred from memory, except where noted as unreachable.

Confidence legend (matches docs/opencode-exploration.md convention):
- [OK]   = confirmed by reading the provider's own docs/schema directly, today.
- [DOC]  = stated by docs but not exercised end-to-end against a live instance.
- [TBD]  = could not be confirmed in the time available; open question.
- [FAIL] = confirmed NOT supported.

## Summary table

| Provider | (i) Attach to local MCP w/ custom headers | (ii) Mid-session server-push prompt injection (mode b) |
|---|---|---|
| Claude Code | [OK] baseline (`claude mcp add --transport http --header ...`) | [OK] POC-proven -- the only one today, via the experimental `notifications/claude/channel` capability (`src/tools/send-message.ts:33`, `src/services/http-transport.ts:169`) |
| Gemini CLI | [OK] | [FAIL] no equivalent push mechanism found |
| Codex | [OK] | [FAIL] no equivalent push mechanism found (has MCP *elicitation*, which is the opposite direction -- see 2.2) |
| GitHub Copilot CLI | [DOC] (VS Code/Copilot MCP config conventions; live doc page for the standalone CLI's exact flag syntax was unreachable, see 3.3) | [TBD] |
| AGY (Antigravity) | [TBD] -- no public reference found (matches apra-fleet-2xs.5's "AGY: unknown, needs investigation" finding for MCP registration generally) | [TBD] |
| OpenCode | [OK] (already documented in docs/opencode-exploration.md section 6) | [TBD] -- MCP client role confirmed, but push-from-server-into-live-session was not found in the docs read; needs a live test, not just doc reading |

**Bottom line for mode (b)'s real reach:** as of this survey, mode (b) (server-driven
mid-session prompt injection) has NO confirmed equivalent outside Claude Code. The
closest adjacent primitive that DOES exist elsewhere is MCP **elicitation**
(codex, and it is part of the base MCP spec so likely present in others too),
which is the CLIENT asking the user/model for more input mid-tool-call -- the
opposite direction from what mode (b) needs (the SERVER pushing a new prompt
into the session unprompted). This is a real, not superficial, gap: elicitation
cannot be repurposed into mode (b) without the provider choosing to treat an
unsolicited server notification as "new work to act on" rather than "a
clarifying question about work already in progress". Mode (a) (one-shot headless
spawn) remains the only mode with universal six-provider support, exactly as
hub-spoke-master-plan.md section 8 already concluded going in; this survey adds
the concrete evidence for (i) and rules out the easy version of (ii) for the two
providers where a public schema could be read in full.

## 1. Claude Code (baseline, for comparison)

- [OK] MCP attach with headers: `claude mcp add --transport http --scope project
  <name> <url> --header "Authorization: Bearer <token>"` (already the mechanism
  validated by apra-fleet-2xs.5 / docs/mcp-registration validation work).
- [OK] Mode (b): `src/tools/send-message.ts:32-38` pushes a
  `notifications/claude/channel` MCP notification down the existing SSE
  connection; the attached Claude Code session picks it up and injects it as a
  new turn. This is provider-branded (flagged in master-plan section 9 point 3)
  but it is real and working, which is why it is the reference point every
  other provider is measured against here.

## 2. Gemini CLI (google-gemini/gemini-cli)

Source read: `docs/tools/mcp-server.md` from the `main` branch,
raw.githubusercontent.com/google-gemini/gemini-cli/main/docs/tools/mcp-server.md
(fetched 2026-07-04).

### 2.1 Attach with custom headers -- [OK]

- Supports three transports: Stdio, SSE, and Streamable HTTP.
- `settings.json` `mcpServers.<name>.headers` (object) sets custom HTTP headers
  for `url`/`httpUrl` servers.
- CLI form documented directly: `gemini mcp add --transport http --header
  "Authorization: Bearer abc123" secure-http https://api.example.com/mcp/` and
  the SSE equivalent with `--transport sse`.
- This is directly usable for apra-fleet-fnz.1's `registerMcpEndpoint()` --
  Gemini's registration shape is essentially the same CLI-native-add pattern
  Claude already uses, just a different verb/flag set.

### 2.2 Mid-session server-push injection -- [FAIL] (not found)

- The docs describe MCP **prompts** as slash commands: the server exposes a
  `prompts/get`-backed prompt, the USER invokes it explicitly
  (`/server:prompt-name`), and the CLI turns the returned template into a
  normal turn. This is user-initiated, not server-initiated -- structurally the
  reverse of what mode (b) needs.
- No mention of a server-to-client unsolicited notification channel analogous
  to `notifications/claude/channel` was found in the MCP server doc (searched
  for "server-initiated", "push", "unsolicited", "elicitation", "sampling" --
  none present). Resources (`resources/read`) are also pull-based (`@` syntax,
  user-triggered).
- Conclusion: no confirmed path for mode (b) today. Would need either (a) a
  Gemini-CLI feature request/contribution to add a push notification handler,
  or (b) a workaround where the local apra-fleet.exe fakes a slash-command
  keystroke into the interactive TUI's stdin -- unreliable and out of scope for
  a "provider capability" claim; would be a hack, not a capability.

## 3. Codex (openai/codex)

Source read: `https://developers.openai.com/codex/config-schema.json`
(the current config reference JSON Schema; the repo's own `docs/config.md`
just redirects to this hosted doc set now) and
`https://developers.openai.com/codex/config-reference` (fetched 2026-07-04).

### 3.1 Attach with custom headers -- [OK]

- Config schema (`RawMcpServerConfig` / `McpServerTransportConfig` definitions)
  has `url`, `http_headers` (object of literal header values), `env_http_headers`
  (object mapping header name -> env var to read the value from, so a secret
  need not be written to the config file in plaintext), `bearer_token_env_var`,
  and a discouraged `experimental_bearer_token` literal-value escape hatch.
  MCP OAuth credential storage (keyring/file/auto) is also schema-native.
- This is a strong fit for `registerMcpEndpoint()`: `env_http_headers` in
  particular maps naturally onto the fleet's `{{secure.NAME}}` placeholder
  convention (resolve to an env var name, never write the raw secret into the
  provider's own config file).

### 3.2 Mid-session server-push injection -- [FAIL] (not found; adjacent-but-opposite primitive exists)

- The schema has real support for MCP **elicitation**
  (`mcp_elicitations`/`tool_call_mcp_elicitation`/`auth_elicitation` flags, plus
  a `decline`/"cancel an elicitation request" operation). Elicitation is part
  of the base MCP spec: mid-tool-call, the SERVER asks the CLIENT (codex) to
  collect more input from the user, and codex's session pauses to service that
  ask.
- This is the opposite direction from mode (b): elicitation is
  server-asks-client-to-prompt-the-user *during a call codex itself already
  initiated*; mode (b) needs the server to inject an ENTIRELY NEW turn into an
  otherwise-idle session with no in-flight tool call to hang the request off
  of. No such unsolicited-notification handling was found in the schema
  (searched for "sampling", "notifications/", "server-initiated", "push" --
  the only server-initiated construct present is elicitation itself).
- Conclusion: no confirmed path for mode (b). Note for future research:
  elicitation being present at all suggests codex's MCP client stack is
  relatively complete/modern; if OpenAI ever exposes a raw
  `notifications/message`-style handler hook, that would be the thing to
  re-check, not elicitation itself.

## 4. GitHub Copilot CLI (github/copilot-cli)

Sources attempted: the repo's own README (fetched -- confirms "ships with
GitHub's MCP server by default and supports custom MCP servers" but no
attach/header syntax), plus two docs.github.com URLs for Copilot Coding
Agent's MCP page which both 404'd at the specific paths tried; the repo's
`docs/` directory listing under `main` was not resolvable at the API path
tried. Time-boxed at that point rather than continuing to search for the
correct current URL.

### 4.1 Attach with custom headers -- [DOC], not directly confirmed live

- GitHub's MCP tooling across its product family (VS Code, Copilot Coding
  Agent, and by extension the standalone Copilot CLI, which shares
  infrastructure) conventionally uses an `mcp.json`-shaped config with a
  `servers.<name>` entry carrying `type: "http"|"sse"|"stdio"`, `url`, and a
  `headers` object -- the same shape VS Code's MCP support popularized and
  that GitHub's coding-agent MCP docs describe for repository-level server
  configuration. The README confirms custom MCP server support exists; the
  exact CLI flag/config file name for the standalone `copilot-cli` binary
  specifically was NOT verified against a live doc in this pass.
- **Action for whoever implements apra-fleet-fnz.1 for Copilot:** re-fetch
  `https://docs.github.com/en/copilot/...` (the coding-agent MCP page moved
  since this survey; search github.com/github/copilot-cli's current README
  for the docs link at implementation time) and confirm the exact config
  location/flag before writing the adapter, rather than assuming the VS
  Code-family shape carries over unchanged.

### 4.2 Mid-session server-push injection -- [TBD]

- Not researched further given 4.1 was already unconfirmed; no evidence
  either way was gathered. Flagged for the implementer of fnz.1/us9.8 to
  re-investigate once 4.1 is nailed down (a push-injection feature would
  likely be documented alongside, not separately from, the base MCP
  attach mechanism, so re-doing 4.1 properly will likely surface 4.2's answer
  too).

## 5. AGY (Antigravity CLI, Google)

- [TBD] for both (i) and (ii). `antigravity.google/docs` renders as an
  effectively-empty client-side app when fetched directly (no server-rendered
  content to read without a browser), and no public GitHub repo for the CLI
  itself was located in this pass (the fleet's own `src/providers/agy.ts`
  references `~/.gemini/antigravity-cli/settings.json` as its credential
  path, suggesting a Gemini-adjacent config shape, but that is an inference,
  not a confirmed fact about MCP support).
- This matches apra-fleet-2xs.5's finding when investigating AGY's native MCP
  registration mechanism generically ("AGY: unknown, needs investigation") --
  this survey does not move that forward. Whoever picks up
  apra-fleet-fnz.2 (AGY's registerMcpEndpoint()) should treat that
  investigation as the fastest path to also answering this file's AGY row,
  since it requires getting hands-on with the actual `agy` binary/docs
  (a live install + `agy --help`/`agy mcp --help` equivalent, or contacting
  Google's Antigravity team/docs directly) rather than public-web research,
  which this pass could not do.

## 6. OpenCode (sst/opencode)

Source: docs/opencode-exploration.md section 6 (already-verified project
notes) plus opencode.ai/docs/mcp-servers/ (cited there as [DOC]).

### 6.1 Attach with custom headers -- [OK] (already confirmed in this repo's own notes)

- `opencode.json` supports remote MCP servers via
  `{"mcp": {"<name>": {"type": "remote", "url": "https://...", "headers":
  {"Authorization": "Bearer ..."}}}}` (docs/opencode-exploration.md line 145).
  This is directly reusable for `registerMcpEndpoint()`
  (apra-fleet-fnz.3 already tracks confirming/implementing this path).

### 6.2 Mid-session server-push injection -- [TBD]

- docs/opencode-exploration.md section 6 confirms MCP client support (tools,
  local+remote) as [DOC]/partially [OK], but does not address server-initiated
  push into an already-running headless/TUI session; that question was out of
  scope for the exploration notes as written (they focus on local-model
  hosting, not multi-provider fleet injection).
- Given OpenCode's architecture is described elsewhere in this repo's notes as
  using its own tool set via the ai-sdk (not a thin MCP passthrough), it is
  plausibly EASIER to add a custom push mechanism here than in Gemini/Codex
  (OpenCode is the most actively-being-integrated non-Claude provider in this
  codebase already), but that is a hypothesis, not a finding -- needs a live
  test: start `opencode run` (or the TUI) attached to a local MCP server, send
  an out-of-band `notifications/message` (or any custom notification) down the
  same SSE/HTTP connection, and observe whether the running session reacts.
  Recommended as the next concrete step if mode (b) work continues, since
  OpenCode is both open-source (patchable) and already partially integrated.

## 7. Recommendations / next steps

1. Treat mode (a) (one-shot headless spawn) as the ONLY universal mode across
   all six providers, per hub-spoke-master-plan.md section 8 -- this survey
   found nothing to revise that conclusion.
2. For mode (b), OpenCode is the best next candidate to actually TEST (not
   just doc-read) given it is open-source and already the most actively
   integrated non-Claude provider in this codebase (see docs/opencode-*.md).
   A live test (section 6.2) should happen before any fleet-side mode (b)
   code is written for it.
3. AGY (section 5) and Copilot CLI (section 4) need hands-on investigation
   (installed binary + its own `--help`/docs), not further public-web
   research, to move past [TBD]. Both are already tracked by their own beads
   (apra-fleet-fnz.2 for AGY's registerMcpEndpoint(); no equivalent beads item
   yet exists for Copilot's registerMcpEndpoint() -- worth filing one modeled
   on fnz.2/fnz.3 if Copilot support becomes a near-term priority).
4. Advertise mode (b) as a per-provider CAPABILITY FLAG, not an assumed
   feature, exactly as hub-spoke-master-plan.md section 9 point 7 already
   requires -- this survey is additional evidence FOR that requirement, not
   against it.
