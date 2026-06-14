# OpenCode Exploration

Living notes on what works / does not work with **OpenCode** (https://opencode.ai,
repo sst/opencode), based on REAL observations. Goal: add OpenCode as another
supported LLM provider in apra-fleet (alongside claude, gemini, codex, copilot, agy).

Status legend:
- [OK]   = verified by direct observation in this environment
- [FAIL] = verified broken / does not work
- [DOC]  = stated by official docs, NOT yet verified here
- [TBD]  = open question, needs investigation before integration

Last updated: 2026-06-13

---

## 1. Why OpenCode (vs Codex) for local models

Context: we are hosting gpt-oss / Qwen coder models locally on the "spark" DGX Spark
(GB10, 128GB unified) via Ollama, and want a CLI agentic coder against them.

- [FAIL] **Codex CLI does NOT work with local models (vLLM path).** Codex 0.139 only
  speaks the OpenAI Responses API (`wire_api="chat"` was removed) and unconditionally
  injects non-standard tool types (`namespace`, `custom`, `image_generation`). vLLM's
  `/v1/responses` rejects them: `400 "tool type namespace not supported"`. No Codex
  config flag stops the injection. Ref: https://github.com/openai/codex/issues/2257
- [FAIL] **Codex `--oss` (Ollama) chats but its agentic loop fails.** `codex exec --oss`
  returns chat text, but on a real file-edit task the model's tool call is rejected by
  Codex's own router: `error=codex_core::tools::router: error=unsupported call: apply_patch`
  (seen twice, then the model spiraled, 30k tokens, no file created). Codex's router
  dead-ends on a malformed/unknown tool call.
- [OK] **OpenCode works where Codex failed.** OpenCode uses its OWN tool set via the
  ai-sdk and RECOVERS from a bad model tool-call instead of dead-ending. It is
  provider-agnostic (any OpenAI-compatible endpoint), which is the whole point for
  local models. This matches NVIDIA's DGX Spark CLI-coding-agent playbook (OpenCode +
  Ollama). Ref: https://build.nvidia.com/spark/cli-coding-agent

Takeaway for integration: OpenCode is a much better fit than Codex for self-hosted /
OpenAI-compatible endpoints.

---

## 2. Install

- [OK] **Linux (spark, aarch64):** standalone binary, no Node required.
  `curl -fsSL https://opencode.ai/install | bash` -> `~/.opencode/bin/opencode`
  (156MB binary). Verified version: `1.17.4`.
- [OK] **Windows (laptop):** `npm install -g opencode-ai` (Node v22). Verified `1.17.4`.
  Lands as `opencode.ps1` shim on PATH.
- [DOC] Other documented installers exist (brew, scoop). Not tested here.

---

## 3. Configuration

- [OK] Config file path:
  - Linux:   `~/.config/opencode/opencode.json`
  - Windows: `C:\Users\<user>\.config\opencode\opencode.json`
- [OK] **Custom provider for a local/remote OpenAI-compatible endpoint (Ollama):**
  uses the `@ai-sdk/openai-compatible` npm adapter. Verified working config:

  ```json
  {
    "$schema": "https://opencode.ai/config.json",
    "provider": {
      "ollama": {
        "npm": "@ai-sdk/openai-compatible",
        "name": "Ollama (spark @ 192.168.1.150)",
        "options": { "baseURL": "http://192.168.1.150:11434/v1" },
        "models": {
          "qwen3-coder:30b": { "name": "Qwen3-Coder 30B (spark)" },
          "gpt-oss:20b": { "name": "gpt-oss 20B (spark)" }
        }
      }
    }
  }
  ```

- [OK] Model is referenced as `<provider>/<model>`, e.g. `ollama/qwen3-coder:30b`.
- [TBD] Auth: for a local Ollama endpoint no API key was needed. For endpoints that
  require a key, how OpenCode sources it (env var name? config field?) is not yet
  confirmed for the openai-compatible adapter.

---

## 4. Running it (CLI surfaces)

- [OK] **Interactive TUI:** `cd <project> && opencode -m ollama/qwen3-coder:30b`
- [OK] **Non-interactive (headless), the key one for apra-fleet:**
  `opencode run -m ollama/<model> "<task>"`  -> prints result to stdout, executes
  tools, exits. This is the analog of `claude -p` / `codex exec`.
- [FAIL] **First-run hang when piped + weak model.** On the laptop, `opencode run` with
  `gpt-oss:20b` produced only the startup banner and then sat with near-zero CPU and no
  file for many minutes (effectively hung). Suspected first-run trust/onboarding gate
  and/or the weak model failing to drive tools. Killing + re-running with a real coder
  model (qwen3-coder:30b) worked cleanly. INTEGRATION RISK: headless runs may need a
  flag/config to bypass the first-run trust gate (see [TBD] below).
- [OK] **Headless is a SUBCOMMAND, not a flag: `opencode run "<message>"`** (analogous to
  `claude -p`). NOTE: there is NO `--prompt` flag - passing `--prompt` is unrecognized and
  OpenCode falls back to launching the interactive TUI (observed). The message is a
  positional arg.
- [OK] **`opencode run` flags (from `opencode run --help`, v1.17.4):**
  - `-m, --model provider/model` (e.g. `ollama/qwen3-coder:30b`)
  - `--agent <name>` - run as a specific agent (e.g. the installed `doer`/`reviewer`)
  - `--dangerously-skip-permissions` - **auto-approve permissions** (the headless
    trust/approval bypass; replaces the wrong Codex-style flags I used earlier)
  - `--format default|json` - **`--format json` emits raw JSON events** (this is the
    `parseResponse` / jsonOutputFlag answer)
  - `-c, --continue` (continue last session), `-s, --session <id>`, `--fork` - **session
    resume** (the supportsResume/resumeFlag answer)
  - `--variant high|max|minimal` (reasoning effort), `-f, --file <f>` (attach files),
    `--title`, `--dir <path>`, `--attach http://host:4096` (drive a REMOTE opencode
    server), `-p/-u` (basic auth for attach), `--print-logs`, `--pure`
  - The fleet `claude -p` equivalent: `opencode run -m ollama/<model>
    --dangerously-skip-permissions --format json [--agent <name>] "<prompt>"`

---

## 5. Verified agentic loop (the real test)

Task given: "create fib.js that prints first 10 Fibonacci numbers, then run it with node".

- [OK] **OpenCode + gpt-oss:20b ON spark:** wrote `/tmp/oc_test/fib.py` (valid code) and
  ran it -> `0 1 1 2 3 5 8 13 21 34`. Independently re-verified with `cat` + `python3`.
  One `Invalid Tool` hiccup (model called a tool named `type`) but OpenCode recovered
  and completed the task.
- [OK] **OpenCode on LAPTOP -> spark (remote inference) with qwen3-coder:30b:** wrote
  `fib.js` (valid JS) on the laptop and ran it via node -> `0 1 1 2 3 5 8 13 21 34`.
  Clean, no tool stumble. Confirms the "spark = endpoint, OpenCode = local frontend"
  architecture. NOTE: this HTTP path (laptop -> 192.168.1.150:11434) is independent of
  the fleet SSH/rport layer and works even when SSH is saturated.

Tools exposed by OpenCode at runtime (from a live run): `bash, edit, glob, grep, read,
skill, task, todowrite, webfetch, write` (plus `invalid`). Note `skill` and `task`
(subagent) are built in.

---

## 6. Feature support: MCP, Skills, Agents

- [DOC] **MCP:** supported, local (stdio) and remote (HTTP, with OAuth/Dynamic Client
  Registration). Configured under `"mcp"` in opencode.json:
  ```json
  { "mcp": { "name": { "type": "local", "command": ["npx","-y","..."], "enabled": true } } }
  { "mcp": { "name": { "type": "remote", "url": "https://...", "headers": {"Authorization":"Bearer ..."} } } }
  ```
  Caveat (docs): MCP tools add a lot of context tokens; the GitHub MCP server "can
  easily exceed the context limit". Relevant for local models. CLI: `opencode mcp auth <server>`.
  Ref: https://opencode.ai/docs/mcp-servers/
- [DOC] **Skills (Anthropic-compatible SKILL.md):** discovered from
  `.opencode/skills/<name>/SKILL.md`, `~/.config/opencode/skills/*/SKILL.md`,
  **`.claude/skills/<name>/SKILL.md`** (Claude-compatible -> existing Claude skills are
  reusable), and `.agents/skills/<name>/SKILL.md`. Frontmatter requires `name`
  (`^[a-z0-9]+(-[a-z0-9]+)*$`) + `description`; optional `license`, `compatibility`,
  `metadata`. Invoked via the native `skill` tool. Ref: https://opencode.ai/docs/skills/
- [DOC] **Agents / subagents:** primary agents (Tab-switch) + subagents (`@mention` or
  the `task` tool). Defined in opencode.json `"agent"` or markdown in
  `~/.config/opencode/agents/` (global) or `.opencode/agents/` (project). Each agent can
  set its own `model`, `prompt`, `mode` (primary|subagent), and `permission`
  (edit/bash/... = allow|deny|ask). Ref: https://opencode.ai/docs/agents/
- [OK] **Skills auto-discovery from `.claude/skills/` CONFIRMED.** `opencode agent list`
  output included `external_directory` allow-patterns for `C:\Users\akhil\.claude\skills\pm-lite\*`,
  `...\pm\*`, `...\github-discussions-faq\*` - OpenCode really does pick up existing
  Claude skills with no extra config.
- [TBD] Verify MCP/skills/agents actually FUNCTION (run) with LOCAL models (they lean on
  tool-calling + instruction-following; expected less reliable than frontier models).
  Registration is confirmed; runtime behavior not yet exercised.

---

## 6.1 Adding agents to OpenCode (VERIFIED 2026-06-13)

Verified end-to-end: converted 4 Claude Code agents -> OpenCode agents and confirmed
registration with `opencode agent list`.

- [OK] **Location:** `~/.config/opencode/agents/<name>.md` (plural "agents").
  On Windows: `C:\Users\<user>\.config\opencode\agents\<name>.md`. The agent NAME is the
  filename (no `name:` field needed - unlike Claude agents which have `name:`).
- [OK] **CLI:** `opencode agent list` (shows `name (primary|subagent|all)`),
  `opencode agent create` (interactive scaffold). Built-in agents seen: build,
  compaction, explore, general, plan, summary, title.
- [OK] **Working frontmatter format:**
  ```markdown
  ---
  description: <one line, shown to the orchestrating agent>
  mode: subagent            # primary | subagent | all
  permission:
    edit: deny              # allow | deny | ask  (per tool)
    write: allow
    bash: allow
  ---
  <system prompt body>
  ```
  Optional: `model: <provider>/<model>` (omit -> inherits the session model),
  `temperature`. Omitting `model` is cleanest for local use.
- [OK] **Claude agent -> OpenCode agent conversion** (what I did for the 4 fleet agents):
  Claude format is `--- name / description / tools: [Read,Edit,Write,Bash,Grep,Glob,Agent] ---`.
  Mapping:
  - `name:` -> DROP (filename carries it).
  - `description:` -> keep as-is.
  - add `mode: subagent` (the fleet roles are specialized, task-invoked).
  - `tools:` allowlist -> `permission:` map. Tools NOT in the Claude allowlist become
    `deny`. Concretely: doer had `Edit` so `edit: allow`; planner/plan-reviewer/reviewer
    had NO `Edit` (only Read/Grep/Glob/Bash/Write) so `edit: deny`, `write: allow`,
    `bash: allow`. (read/grep/glob are always available; Claude's `Agent` tool maps to
    OpenCode's `task` tool.)
  - body (system prompt) -> carried over largely verbatim.
- [OK] Installed doer, planner, plan-reviewer, reviewer; all four appear in
  `opencode agent list` as `(subagent)`.
- [TBD] Not yet RUN: actually invoking one of these agents against a local model. The
  prompt bodies reference fleet concepts (progress.json, {{secure.NAME}}, fleet
  dispatch) that won't apply outside apra-fleet - faithful copy, runtime fidelity
  against a 30-106B local model unverified.
- INTEGRATION NOTE: this is exactly how an apra-fleet `opencode` provider would install
  doer/reviewer roles onto a member - write markdown to `~/.config/opencode/agents/`.
  The Claude `tools` allowlist -> OpenCode `permission` map is the `composePermissionConfig`
  analog for the adapter.

---

## 6.2 Ollama memory + model-switching behavior (VERIFIED 2026-06-13)

Relevant because apra-fleet may run multiple model tiers via one OpenCode/Ollama member.
OpenCode is hands-off here - it only sends `{model: "..."}`; Ollama owns memory.

- [OK] **Switching models does NOT offload the previous one immediately.** Loaded
  `gpt-oss:20b` then `qwen3-coder:30b`; `ollama ps` showed BOTH resident (100% GPU), each
  counting down `UNTIL ~4 min`. Default `OLLAMA_KEEP_ALIVE=5m0s`, `OLLAMA_MAX_LOADED_MODELS=0`
  (auto = multiple allowed). After keep-alive idle, the unused model auto-offloads.
- [OK] If a new model will not fit, Ollama EVICTS older loaded models to make room - it
  manages memory gracefully, no OOM crash (unlike the vLLM Marlin path).
- [OK] **Loaded size >> on-disk size due to KV cache.** `qwen3-coder:30b` = 18GB on disk
  but **45GB loaded** (it allocated its full 256K context). So two big models often will
  NOT coexist on the 128GB box (e.g. qwen 45GB + GLM ~70GB ~= 115GB, near ceiling ->
  eviction + reload on switch-back).
- Tuning levers: `OLLAMA_KEEP_ALIVE` (0 = offload immediately after each request; default
  5m), `OLLAMA_MAX_LOADED_MODELS` (1 = only one resident at a time), per-model `num_ctx`
  (smaller context -> smaller KV cache -> smaller loaded footprint). Can also pass
  `keep_alive` per request in the Ollama API.
- INTEGRATION NOTE: a fleet member juggling cheap/standard/premium tiers as different
  Ollama models will, by default, keep several resident for 5 min. For large models set
  `OLLAMA_MAX_LOADED_MODELS=1` (or KEEP_ALIVE=0) to avoid eviction thrash / memory
  pressure.

## 7. Model observations (Ollama backend, spark GB10)

- [OK] **qwen3-coder:30b** (18GB): reliable agentic coding, clean tool calls. Daily driver.
- [FAIL-ish] **gpt-oss:20b** (12.8GB): too weak for the agentic loop - tool stumbles,
  hung on the remote laptop run. Fine for plain chat, not for agentic editing.
- [TBD] **qwen3-coder-next** (80B-A3B, 51GB): in official Ollama lib (`ollama pull
  qwen3-coder-next`); downloading. Expected strong agentic coder (3B active = fast).
- [TBD] **GLM-4.5-Air** (106B): NOT in official Ollama lib (only old `glm4` is). Use
  community build `ollama pull MichelRosselli/GLM-4.5-Air:Q4_K_M`. The unsloth HF GGUF
  has a known ollama-pull error (https://huggingface.co/unsloth/GLM-4.5-Air-GGUF/discussions/5).
- [TBD] **gpt-oss:120b** (~65GB MXFP4): `ollama pull gpt-oss:120b`; should load via
  llama.cpp mmap without the vLLM Marlin-finalize OOM. Not yet pulled on Ollama.
- Note: HF safetensors models in `~/.cache/huggingface` are NOT reusable by Ollama
  (Ollama uses its own GGUF blob store). Re-pull via `ollama pull` is required.

### Model sources + download speed
- [OK] Ollama pulls come from **Ollama's registry** (`registry.ollama.ai` / `ollama.com`),
  NOT Hugging Face. Official lib (`qwen3-coder:30b`, `gpt-oss:20b`, `qwen3-coder-next`)
  and community namespace (`MichelRosselli/GLM-4.5-Air`) are both Ollama-registry. Only
  an explicit `hf.co/<user>/<repo>:<quant>` prefix fetches from HF.
- [OK] Therefore a **HF token does NOT expedite Ollama-registry downloads** (wrong
  source). Even on the `hf.co/` route an HF token mainly grants gated access + higher
  rate limits, not raw bandwidth; HF Pro does not meaningfully boost download speed.
- [OK] **Real bottleneck = spark's Ethernet NIC negotiated at 100 Mb/s, not 1 Gbps**
  (MEASURED 2026-06-13). `ethtool enP7s7` / `cat /sys/class/net/enP7s7/speed` -> `100Mb/s`
  Full duplex. That is the ~11 MB/s ceiling (100BASE-T ~= 11.5 MB/s practical). NOT the
  internet uplink: laptop on the same line measured **206 MB/s (1.6 Gbps)** single-stream
  from Cloudflare. This also explains SSH going dark during pulls - the download ate
  spark's whole 100Mb link. (An earlier note here WRONGLY blamed the internet uplink -
  corrected after measuring.) HF token / parallel downloads / quant size are all moot
  vs a 100Mb link cap.
- [OK] **RESOLVED 2026-06-13: it WAS the cable. Swapping it -> gigabit -> 117 MB/s
  (~10x).** After a cable swap, `cat /sys/class/net/enP7s7/speed` = `1000`, ethtool
  Speed 1000Mb/s Full, link partner now advertises `1000baseT/Full`, and the ollama
  pull jumped from 11 MB/s to **117 MB/s** (gigabit saturated; 72GB GLM model ETA
  dropped ~1.5h -> ~10min).
- [FAIL-of-reasoning] LESSON: I earlier concluded "link partner advertises only 10/100
  => it's the switch port, a cable won't help." That was WRONG. A faulty cable
  (damaged/missing pairs) BREAKS 1000BASE-T autonegotiation (gigabit needs all 4 pairs),
  so the link falls back and the partner appears to advertise only 10/100. The switch
  was gigabit-capable all along; the cable was the fault. Do NOT infer "switch port" from
  a partner-advertised-100 reading alone - a bad cable produces the same symptom. NIC =
  Realtek RTL8127 (`r8127`), 10GbE-capable, so a 2.5G/10G port could go even faster.
- Integration relevance: an apra-fleet `opencode` provider pulling Ollama-registry
  models needs NO HF credential (unlike the vLLM/HF safetensors path which used
  `HF_RO_TOKEN`).

---

## 8. apra-fleet integration plan (provider adapter)

Goal: implement `src/providers/opencode.ts` as a `ProviderAdapter` (mirror
`src/providers/codex.ts`) and register it in `src/providers/index.ts`. Below maps the
adapter surface to OpenCode, with confidence markers.

| Adapter member            | OpenCode mapping                                  | Status |
|---------------------------|---------------------------------------------------|--------|
| name / processName        | `opencode`                                        | [OK]   |
| cliCommand(args)          | `opencode <args>`                                 | [OK]   |
| versionCommand()          | `opencode --version`                              | [OK]   |
| installCommand(os)        | linux/win: `npm install -g opencode-ai`; or curl  | [OK]   |
| buildPromptCommand()      | `cd <dir> && opencode run -m <prov>/<model> "..."`| [OK] (flags [TBD]) |
| headlessInvocation()      | `run "<prompt>"`                                   | [OK]   |
| modelFlag(model)          | `-m <provider>/<model>`                            | [OK]   |
| skipPermissionsFlag()     | trust/approval bypass for headless                | [TBD]  |
| permissionModeAutoFlag()  | OpenCode permission system (allow/ask/deny)       | [TBD]  |
| composePermissionConfig() | opencode.json `permission`/agent perms per role   | [TBD]  |
| permissionConfigPaths()   | `opencode.json` (and/or `.opencode/`)             | [TBD]  |
| parseResponse()           | parse `--format json` NDJSON events (see 8a)      | [OK]   |
| jsonOutputFlag()          | `--format json` on `opencode run`                 | [OK]   |
| supportsResume()/resumeFlag()| OpenCode sessions; headless resume mechanism   | [TBD]  |
| supportsMaxTurns()        | unknown                                           | [TBD]  |
| authEnvVar / credentialPath| local: none; remote endpoints: key sourcing      | [TBD]  |
| instructionFileName       | AGENTS.md (verified: opencode.ai/docs/rules/)     | [OK]   |
| modelTiers()/modelForTier()| map cheap/standard/premium -> local model ids    | [OK-ish] |
| classifyError()           | map OpenCode error strings -> auth/server/overloaded | [TBD] |

Cross-cutting:
- OpenCode model id includes the provider prefix (`ollama/...`), unlike other adapters
  that pass a bare model name. The adapter must compose `<provider>/<model>` and the
  fleet member must ship an opencode.json defining that provider+endpoint.
- This ties into apra-fleet issue #299 (MODEL_EP_URL for codex+opencode providers): the
  endpoint URL must be injected into opencode.json `provider.<x>.options.baseURL`.
- Permission roles (doer/reviewer) map to OpenCode's per-tool permission system
  (edit/bash/... = allow|deny|ask), analogous to codex composePermissionConfig.

### Open questions to resolve before/while coding the adapter
1. [OK] Headless trust/approval bypass = `--dangerously-skip-permissions` on `opencode run`.
2. [OK] Structured output = `opencode run --format json` (raw JSON events).
3. [OK] Session resume = `opencode run -c|--continue` or `-s|--session <id>` (+ `--fork`).
4. [OK] AGENTS.md (primary) at project root, with CLAUDE.md as fallback, plus `instructions` field in opencode.json. Ref: https://opencode.ai/docs/rules/
5. [OK-partial] Per-tool permission config = agent frontmatter `permission:` map
   (edit/write/bash = allow|deny|ask), verified via the doer/reviewer install (section 6.1).
   Still TBD: full tool-name list + global vs per-agent precedence.
6. [TBD] How fleet should template the endpoint into opencode.json (per member) - ties to #299.

---

## 8a. VERIFIED `opencode run --format json` event schema (parseResponse spec + fixture)

Captured live on spark (opencode v1.17.4 + ollama). `--format json` emits NDJSON: one JSON
object per line, each with a top-level `type` and `sessionID`, plus a `part` object. This is
the REAL schema -- use it as the test fixture for T3.4. (The earlier design draft guessed
`{type:text, content:...}` and "usage unavailable" -- BOTH WRONG; corrected below.)

Top-level event `type` values and what parseResponse must extract:

| `type`        | `part.type`  | Key fields                                                            | parseResponse use                          |
|---------------|--------------|----------------------------------------------------------------------|--------------------------------------------|
| `step_start`  | `step-start` | (boundary marker)                                                    | ignore                                     |
| `text`        | `text`       | `part.text` (assistant message), `part.time`                         | COLLECT `part.text` -> result string       |
| `tool_use`    | `tool`       | `part.tool` (e.g. "write"), `part.callID`, `part.state.{status,input,output,metadata,title,time}` | tool actions; status="completed" + output  |
| `step_finish` | `step-finish`| `part.reason` ("stop" \| "tool-calls"), `part.tokens` `{total,input,output,reasoning,cache:{write,read}}`, `part.cost` | finish reason + USAGE                       |

Rules for parseResponse:
- `result` = concatenation (in order) of every `text` event's `part.text`.
- `usage` IS available -> last `step_finish.part.tokens` (NOT unavailable as first assumed).
- `sessionID` is top-level on EVERY event -> trivial resume capture (no separate call).
- `isError`: TRUE if any line has top-level `type:"error"` (now captured -- see below), an
  unparseable line, or a `step_finish.part.reason` outside {stop, tool-calls}.

Error-event shape (VERIFIED -- induced via `opencode run -m ollama/nonexistent-model --format
json`):
```
{"type":"error","timestamp":N,"sessionID":"ses_...","error":{"name":"UnknownError","data":{"message":"Model not found: ollama/nonexistent-model-xyz123."}}}
```
- Error events have top-level `type:"error"` + `sessionID` but NO `part` field (unlike
  text/tool/step events) -- the parser must not assume `part` exists.
- `error.data.message` = human message; `error.name` = error class (e.g. UnknownError).
- MULTIPLE error events can appear in one run (a generic "Unexpected server error" followed by
  a specific "Model not found: ...") -- prefer the most specific (last) message for the result.
- A separate pretty-printed `ERROR (#NNN): failed {...}` block goes to STDERR (not the NDJSON
  stream) -- parse the `{"type":"error"}` JSON lines, not the stderr log block.

Captured shapes (verbatim, trimmed):
```
{"type":"step_start","sessionID":"ses_...","part":{"type":"step-start"}}
{"type":"text","sessionID":"ses_...","part":{"type":"text","text":"hello","time":{...}}}
{"type":"tool_use","sessionID":"ses_...","part":{"type":"tool","tool":"write","callID":"call_nxvlfvg2","state":{"status":"completed","input":{"content":"hello","filePath":"/tmp/oc_json2/hi.txt"},"output":"Wrote file successfully.","metadata":{...},"time":{...}}}}
{"type":"step_finish","sessionID":"ses_...","part":{"type":"step-finish","reason":"tool-calls","tokens":{"total":7167,"input":7165,"output":2,"reasoning":0,"cache":{"write":0,"read":0}},"cost":0}}
```
Save these lines (happy-path + the verified error line above) as
`tests/fixtures/opencode-output.ndjson` and drive the unit tests off them -- do NOT hand-invent
fixtures. The schema is now FULLY captured (text/tool/step/error) -- T3.4 has no remaining
unknowns.

---

## 9. References

- OpenCode docs (home): https://opencode.ai/docs
- MCP servers: https://opencode.ai/docs/mcp-servers/
- Agents: https://opencode.ai/docs/agents/
- Skills: https://opencode.ai/docs/skills/
- NVIDIA DGX Spark CLI coding agent playbook: https://build.nvidia.com/spark/cli-coding-agent
- Codex-vs-vLLM incompatibility (why not Codex): https://github.com/openai/codex/issues/2257
- Codex --oss vs vLLM pull issue: https://github.com/openai/codex/issues/2507
- GLM-4.5-Air community Ollama build: https://ollama.com/MichelRosselli/GLM-4.5-Air
- apra-fleet issue #299 (MODEL_EP_URL for codex+opencode): see repo issues

---

## 10. Changelog
- 2026-06-13: Created. Recorded install (linux binary + win npm, v1.17.4), ollama
  provider config, verified agentic loop (gpt-oss:20b on spark; qwen3-coder:30b
  laptop->spark remote), Codex failure analysis, MCP/skills/agents support (from docs),
  model observations, and the initial provider-adapter mapping + open questions.
- 2026-06-13: Added section 6.1 "Adding agents (VERIFIED)" - installed the 4 Claude
  fleet agents (doer/planner/plan-reviewer/reviewer) into OpenCode at
  `~/.config/opencode/agents/`, confirmed via `opencode agent list`; documented the
  Claude->OpenCode frontmatter conversion + tools->permission mapping. Confirmed
  OpenCode auto-discovers `.claude/skills/` (flipped that from [DOC] to [OK]).
- 2026-06-13: Added section 6.2 "Ollama memory + model-switching" (VERIFIED): switching
  models keeps the old one resident ~5m (keep_alive), multiple models coexist if they
  fit, loaded size includes KV cache (qwen3-coder:30b = 45GB loaded @ 256K ctx).
- 2026-06-13: Resolved 3 headless [TBD]s from `opencode run --help`: headless =
  `opencode run "<msg>"` (NOT `--prompt`); bypass = `--dangerously-skip-permissions`;
  JSON = `--format json`; resume = `-c`/`-s`. Network fix logged: spark NIC was 100Mb
  (bad cable) -> gigabit after swap, ollama pulls 11 -> 117 MB/s.
- 2026-06-13: Added section 8a "VERIFIED --format json event schema" - captured REAL NDJSON
  (text/tool_use/step_start/step_finish) live on spark; corrected the design's wrong
  assumptions (text is in part.text NOT content; usage IS emitted in step_finish.part.tokens;
  sessionID is top-level on every event). Flipped parseResponse + jsonOutputFlag to [OK].
  This de-risks T3.4 (the plan's #1 risk). Only the error-event shape remained [TBD].
- 2026-06-13: Captured the error-event shape (induced via `opencode run -m
  ollama/nonexistent-model --format json`): top-level `type:"error"` + `sessionID`, NO `part`,
  message at `error.data.message`; multiple error events possible (prefer most specific);
  stderr also carries a pretty `ERROR (#NNN)` block to ignore. T3.4 schema now 100% captured
  (text/tool/step/error) -- zero remaining unknowns.
