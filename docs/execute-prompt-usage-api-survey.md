<!-- llm-context: Survey of each provider adapter's usage/quota-API reality for
     execute_prompt budget awareness (apra-fleet-eft.80). Records, per
     provider, whether a provider-NATIVE usage/cost signal exists that a
     getUsage() adapter capability could read (per apra-fleet-eft.80's
     "PRIMARY SOURCE: provider-native usage/quota APIs/SDKs, NOT fleet-side
     self-metering" direction), vs. where only the fleet-side token-count
     fallback (apra-fleet-eft.80.2/.80.3) will apply. Required first step of
     apra-fleet-eft.80.1, ahead of any adapter code. Live-researched
     2026-07-27 by fetching each provider's own docs/config-schema/source
     where reachable (curl, GitHub API tree search) rather than inferring
     from memory, mirroring docs/interactive-injection-provider-survey.md's
     method; unreachable sources (platform.openai.com, antigravity.google)
     are flagged as such rather than guessed. -->
<!-- keywords: usage API, quota, budget, getUsage, Admin API, cost report,
     rate limit, execute_prompt, provider adapter, Anthropic Admin API,
     OpenAI usage API, Gemini quota, Copilot premium requests, AGY,
     OpenCode ACP usage, apra-fleet-eft.80 -->

# Provider Usage/Quota-API Survey (execute_prompt budget awareness)

> **Historical note:** Gemini was a supported provider when this survey was
> written (2026-07-27); it has since been fully removed from apra-fleet. The
> Gemini section below is retained as a point-in-time technical record of the
> `gemini-cli` quota/usage investigation and does not describe a currently
> supported provider.

Status: research document, 2026-07-27. Answers the first-implementation-step
requirement of beads item apra-fleet-eft.80.1 (parent: apra-fleet-eft.80,
"Usage/budget awareness in execute_prompt"). Mirrors
docs/interactive-injection-provider-survey.md's method and confidence
legend. Providers surveyed match `src/providers/*.ts`: claude, codex,
gemini (removed, see historical note above), copilot, agy, opencode (`none` is out of scope -- see section 7).

Confidence legend (matches docs/interactive-injection-provider-survey.md):
- [OK]   = confirmed by reading the provider's own docs/schema/source directly, today.
- [DOC]  = stated by docs but not exercised end-to-end / not fetched live in this pass.
- [TBD]  = could not be confirmed in the time available; open question.
- [FAIL] = confirmed NOT supported / not reachable.

## Summary table

| Provider | Provider-native usage/quota signal | Programmatically readable by a headless `getUsage()`? |
|---|---|---|
| Claude (API-key members) | [OK] Anthropic Admin API: `GET /v1/organizations/usage_report/messages` and `GET /v1/organizations/cost_report`, both `group_by[]`-filterable, both require a separate **Admin API key** (not the member's own API key) | [OK] yes -- a plain authenticated REST call; the gap is credential plumbing (Admin key != member key), not API existence |
| Claude (OAuth subscription members) | [DOC] Claude Code CLI's own `/usage` command shows plan-limit usage (rolling 5h + weekly windows) computed from local session history; hits an internal "usage endpoint" that can itself be rate-limited | [TBD] `/usage` is an interactive TUI command; whether it (or its underlying endpoint) is reachable/parseable from a headless `-p` dispatch was not confirmed. **Fallback signal that IS confirmed headless-safe:** the CLI's own error text ("You've hit your session limit" / "You've hit your weekly limit" / "You've hit your Opus limit") surfaces in `-p` output on exhaustion -- classifiable via `classifyError()`, same mechanism `PromptErrorCategory` already exists for |
| Codex | [DOC]/[TBD] OpenAI platform Usage API (org-level, Admin-key-scoped) is public and well-documented in general OpenAI knowledge, but `platform.openai.com` returned HTTP 403 (bot-protected) in this pass -- not re-confirmed live. Codex's own config schema (`developers.openai.com/codex/config-reference`, fetched live) confirms an **internal** "rate-limit windows" / "remaining percentage" concept (`memories.min_rate_limit_remaining_percent` setting) exists in the CLI itself | [TBD] internal signal confirmed to exist, but no confirmed CLI flag/output surfaces it to an external caller; OpenAI's org Usage API is a plausible fallback source pending live re-verification |
| Gemini CLI | [OK] `docs/resources/quota-and-pricing.md` (fetched live from google-gemini/gemini-cli) documents daily-request-count quotas per auth method, and the `/stats model` interactive command for in-session usage; source also confirms dedicated `googleQuotaErrors.ts` / `quotaErrorDetection.ts` modules for quota-error detection | [TBD] `/stats model` is interactive-only (same headless-reachability gap as Claude's `/usage`); no public REST endpoint for pulling remaining quota was found. The quota-error-detection source modules ARE a confirmed headless-safe fallback signal (error-text classification, same pattern as Claude's session-limit messages) |
| GitHub Copilot CLI | [OK] GitHub REST API `GET /orgs/{org}/copilot/metrics/reports/organization-1-day` (docs.github.com, fetched live) returns org-level 28-day Copilot usage metrics via signed download links | [FAIL] for member/session scope -- this endpoint is **organization-admin-scoped**, not a per-user/per-session remaining-quota signal, and needs an org-owner token distinct from any individual member's credentials. The standalone `copilot-cli` binary's own repo (github/copilot-cli, tree fetched live) has no public source to inspect (thin installer-only repo, 19 files, matches the finding already on record in docs/interactive-injection-provider-survey.md section 4) -- no CLI-native usage signal confirmed |
| AGY (Antigravity) | [TBD] -- unchanged from docs/interactive-injection-provider-survey.md section 5's finding. `antigravity.google/docs/quickstart` still returns 404/empty client app; no public GitHub repo found (GitHub code search for "antigravity google" surfaces unrelated third-party repos only) | [TBD] -- blocked on the same hands-on-investigation gap noted in the prior survey (apra-fleet-fnz.2's implementer is best positioned to also answer this) |
| OpenCode | [OK] confirmed in TWO independent ways: (1) this repo's own docs/opencode-exploration.md (line ~360-387) already verified live that OpenCode's `step_finish` session event carries `part.tokens {total,input,output,reasoning,cache}` AND `part.cost` inline on every turn; (2) opencode's own source (`packages/opencode/src/acp/usage.ts`, fetched live from sst/opencode) defines a `totalSessionCost(messages)` aggregator and `buildUsage()`/`latestAssistantMessage()` helpers built on that same per-message `cost`/`tokens` data | [OK] yes, and uniquely so among all six providers -- no separate usage-API call is needed at all: cost/token usage is emitted inline with every response, matching the shape `ParsedResponse.usage` in `src/providers/provider.ts` already expects, so accumulation is just a matter of reading a field that's already present in the parsed output |
| none (`src/providers/none.ts`) | N/A | N/A -- `execute_prompt` rejects `llm_provider: "none"` members outright (plain command executor, no LLM concept at all); no usage/budget signal is meaningful here |

**Bottom line for apra-fleet-eft.80.2's implementation order:** OpenCode is
the only provider where a real `getUsage()`-shaped signal is BOTH confirmed
to exist AND confirmed headless-readable today (it's already inline in
every parsed response) -- cheapest to implement first as the reference
`getUsage()` capability. Claude API-key members are the next-strongest case
(a real, documented, callable REST API) but need Admin-key credential
plumbing distinct from the member's own key. Every other row (Claude OAuth,
Codex, Gemini) has a confirmed provider-side signal that is either
interactive-only or org-scoped, so `apra-fleet-eft.80`'s FALLBACK path
(fleet-side accumulation from dispatch-result token counts, `source:
"estimated"`) is expected to be the operative path for those rows at
launch, with error-text classification (session-limit / quota-exceeded
messages) as a best-effort supplementary signal per the parent feature's
"subscription-plan members without a priceable meter" clause. Copilot and
AGY need further hands-on investigation (matching the disposition already
on record for both in docs/interactive-injection-provider-survey.md) before
either can move past [TBD]/[FAIL].

## 1. Claude

### 1.1 API-key members -- [OK]

Source: `https://platform.claude.com/docs/en/manage-claude/usage-cost-api`
(fetched live 2026-07-27; the URL redirects there from
`docs.anthropic.com/en/api/usage-cost-api`).

- Two Admin-API-key-authenticated endpoints:
  - `GET /v1/organizations/usage_report/messages` -- token/request usage,
    `group_by[]`-filterable (e.g. by workspace, API key, model).
  - `GET /v1/organizations/cost_report` -- dollar cost, same grouping shape.
- Both require an **Admin API key** (`Admin API key` scope, distinct from a
  regular member's API key) -- this is the main plumbing gap for
  apra-fleet-eft.80.2: the adapter would need a separately-provisioned
  Admin key per organization, not each member's own credential.
- This is a strong, real, callable REST API -- the best-documented usage
  source of any provider surveyed.

### 1.2 OAuth subscription members -- [DOC] interactive; [TBD] headless

Source: `https://docs.claude.com/en/docs/claude-code/costs` (fetched live
2026-07-27).

- `/usage` (interactive Claude Code command, Pro/Max/Team/Enterprise plans)
  shows a plan-limit breakdown (skills/subagents/plugins/MCP servers as %
  of recent usage), toggle between last-24h/last-7d, computed from **local
  session history on this machine** (so cross-device/claude.ai usage is
  NOT included -- an important caveat for a fleet member whose sessions
  may span machines).
- The doc explicitly notes the usage figure comes from "the usage endpoint"
  and that this endpoint can itself be rate-limited, in which case `/usage`
  falls back to a same-machine snapshot from within the last 60 minutes.
  This confirms there IS a network call underneath, but nothing in the doc
  states a non-interactive/JSON-output form for it (`-p` mode is not
  mentioned in connection with `/usage` anywhere in the fetched page).
- Rolling window shape (subscription-relevant): seat allowance resets on a
  **rolling five-hour window AND a weekly window**, shared across models
  (switching models via `/model` does not restore session-limit access).
  Matches the "priceable meter" gap the parent feature (apra-fleet-eft.80)
  anticipates for subscription-plan members.
- **Confirmed headless-safe fallback signal:** when a dispatch actually
  hits a limit, Claude Code's own error text is one of a small fixed set
  ("You've hit your session limit", "You've hit your weekly limit",
  "You've hit your Opus limit") -- these are exactly the kind of
  "rate-limit/quota error sniffing" the parent feature's fallback clause
  calls for, and fit naturally into the existing `classifyError()` /
  `PromptErrorCategory` mechanism in `src/providers/provider.ts` rather
  than requiring a new subsystem.
- **Open question for apra-fleet-eft.80.2's implementer:** whether the
  `/usage` command (or its underlying HTTP call) is invocable/parseable
  from a headless `-p` dispatch at all. Needs a live test (run `claude -p
  "/usage"` or equivalent and inspect the output), not further doc reading.

## 2. Codex (OpenAI)

### 2.1 OpenAI platform Usage API -- [DOC]/[TBD], not re-confirmed live

- `platform.openai.com/docs/api-reference/usage` returned HTTP 403 (bot
  protection / Cloudflare) both with and without a browser User-Agent
  header in this pass -- could not be fetched live.
- OpenAI's org-level Usage API (`/v1/organization/usage/*` family,
  Admin-key-scoped, analogous in shape to Anthropic's) is well-established
  general knowledge but is recorded here as [DOC] rather than [OK] per
  this survey's own confidence convention, since it was NOT read directly
  in this pass. **Action for apra-fleet-eft.80.2's implementer:** re-fetch
  via an authenticated session or the OpenAI OpenAPI spec (not the bot-
  gated doc site) to confirm the exact endpoint/field shape before coding
  against it.

### 2.2 Codex CLI's own rate-limit signal -- [OK] exists; [TBD] externally readable

Source: `https://developers.openai.com/codex/config-reference` (fetched
live 2026-07-27; the JSON-schema-backed config reference page, confirmed
reachable unlike the platform.openai.com doc site).

- The config schema defines `memories.min_rate_limit_remaining_percent`
  ("Minimum remaining percentage required in Codex rate-limit windows
  before memory generation starts. Defaults to 25, clamped 0-100") and
  `notice.hide_rate_limit_model_nudge` -- both confirm the Codex CLI
  internally tracks a "rate-limit windows" / "remaining percentage"
  concept and gates its OWN behavior (memory generation, model-switch
  nudges) on it live, today.
- This means the underlying signal genuinely exists inside the CLI
  process. What is NOT confirmed: whether that percentage is exposed via
  any flag, `--json` field, or log line an external caller (fleet) could
  read from a headless dispatch. The `docs/guides/rate-limits` page linked
  from the nav returned 404 in this pass (moved/renamed since indexed).
  Matches this repo's own `docs/provider-matrix.md` line 83 finding
  ("Codex message quotas: rolling 5-hour message windows instead of token
  budgets... Spread work across time or use API key tier"), which is
  consistent with, but does not add to, this finding.
- **Action for apra-fleet-eft.80.2's implementer:** find the current
  rate-limits guide URL (search developers.openai.com's nav/sitemap at
  implementation time) and/or run `codex` with a verbose/debug flag to see
  if the remaining-percentage value is logged anywhere parseable.

## 3. Gemini CLI (google-gemini/gemini-cli)

Source: `docs/resources/quota-and-pricing.md` fetched live 2026-07-27 from
`raw.githubusercontent.com/google-gemini/gemini-cli/main/`, located via a
full repo-tree search (GitHub API) for quota/usage-related paths.

### 3.1 Provider-native quota signal -- [OK]

- Documents per-auth-method daily request-count quotas (e.g. 1,000/day for
  Gemini Code Assist Individual via Google-account login, 1,500/day
  Google AI Pro, 250/day free-tier API key, etc.) -- a **request-count**
  ceiling, not a token/dollar meter, for the subscription-style auth paths.
- In-session usage: `/stats model` (interactive command) "provides a
  snapshot of your current session's token usage, as well as information
  about the limits associated with your current quota"; a summary also
  prints on session exit. Same interactive-only shape as Claude's `/usage`
  and the same [TBD]-for-headless caveat applies.
- No public REST endpoint for pulling remaining quota programmatically was
  found in the doc (pay-as-you-go paths point to Vertex AI /
  ai.google.dev's own rate-limit docs, which describe request/token-per-
  minute CEILINGS, not a query-current-remaining-quota API).

### 3.2 Confirmed headless-safe fallback signal -- [OK]

- The repo-tree search (GitHub API, fetched live) surfaced two
  purpose-built source files: `packages/core/src/utils/googleQuotaErrors.ts`
  and `packages/core/src/utils/quotaErrorDetection.ts` -- dedicated
  quota-error-detection modules shipped in the CLI itself. This confirms
  Gemini CLI already classifies quota-exhaustion errors internally, which
  is exactly the "rate-limit/quota error sniffing" pattern the parent
  feature's fallback clause anticipates, and (like Claude's session-limit
  error strings) is a natural fit for `classifyError()` rather than a new
  subsystem.

## 4. GitHub Copilot CLI (github/copilot-cli)

### 4.1 Org-level REST usage API -- [OK], but wrong scope for a member `getUsage()`

Source: `https://docs.github.com/en/rest/copilot/copilot-usage` fetched
live 2026-07-27.

- `GET /orgs/{org}/copilot/metrics/reports/organization-1-day` returns
  signed download links to a 28-day aggregated org-level Copilot usage
  metrics report (ndjson), covering feature-adoption/engagement metrics.
  Requires an org-owner or "View Organization Copilot" fine-grained
  permission -- explicitly organization-scoped, not a per-member/per-
  session remaining-quota check a single fleet member's own credential
  could call.
- `docs.github.com/en/copilot/concepts/copilot-billing/understanding-and-
  managing-requests-in-copilot` (fetched live, 200) confirms Copilot's
  billing model is built around **premium requests** as the meterable
  unit, consistent with a per-request quota concept existing at the
  product level, but this survey did not find a corresponding per-member
  "requests remaining" API endpoint (only the org-aggregate metrics report
  above).

### 4.2 Copilot CLI-native signal -- [FAIL] not found (repo has no public source)

- `github/copilot-cli`'s repo tree (fetched live via GitHub API) contains
  only 19 files -- issue templates, workflows, `README.md`, `changelog.md`,
  `install.sh` -- i.e. it is a closed-source, installer-only repo with no
  application source to inspect. This matches (does not newly discover)
  the finding already on record in
  docs/interactive-injection-provider-survey.md section 4: the standalone
  CLI's exact usage-surfacing behavior needs a live install +
  `copilot --help`/config inspection, not further public-repo research.

## 5. AGY (Antigravity CLI, Google)

- [TBD], unchanged from docs/interactive-injection-provider-survey.md
  section 5. `antigravity.google/docs/quickstart` still renders as an
  effectively-empty client app (404 in this pass); no public GitHub repo
  for the CLI was found via GitHub code/repo search (results are
  unrelated third-party "antigravity" projects). `src/providers/agy.ts`'s
  `~/.gemini/antigravity-cli/settings.json` credential path suggests a
  Gemini-adjacent config shape, consistent with but not proof of any
  particular usage-API behavior.
- As the prior survey already recommended, whoever picks up
  apra-fleet-fnz.2 (AGY's `registerMcpEndpoint()`) is best positioned to
  also resolve this row, since it requires a live install +
  `agy --help`/`agy` config inspection rather than public-web research.

## 6. OpenCode (sst/opencode)

### 6.1 Provider-native usage/cost signal -- [OK], doubly confirmed

- **This repo's own prior verified notes:** docs/opencode-exploration.md
  (around line 360-387) already confirmed LIVE that OpenCode's streamed
  `step_finish` session event carries `part.tokens
  {total,input,output,reasoning,cache:{write,read}}` AND `part.cost`
  inline on every turn -- explicitly correcting an earlier "usage
  unavailable" assumption recorded in the same doc.
- **OpenCode's own source, fetched live 2026-07-27** (GitHub repo-tree
  search on `sst/opencode` surfaced `packages/opencode/src/acp/usage.ts`
  among other usage/cost-named files):
  `packages/opencode/src/acp/usage.ts` defines an `Interface` with
  `buildUsage(message)`, `latestAssistantMessage(messages)`, and
  `totalSessionCost(messages)` -- i.e. OpenCode already ships its own
  cost-aggregation helper built directly on the same per-message
  `cost`/`tokens` fields. The repo tree also surfaced a broader
  usage/cost/budget surface elsewhere in the monorepo (a console
  `usage` dashboard route, a `providerBudgetTracker.ts`, and a
  `20260510033149_session_usage.ts` DB migration), suggesting usage
  tracking is a first-class, actively-maintained concern in the project,
  not an incidental field.

### 6.2 Headless readability -- [OK]

- Because `tokens`/`cost` arrive INLINE on every parsed session event
  (not via a separate query call), this is directly usable by a headless
  fleet dispatch with no extra network round-trip: it is structurally the
  closest fit to `ParsedResponse.usage: { input_tokens, output_tokens }`
  already defined in `src/providers/provider.ts`, just needing the `cost`
  field folded in alongside token counts. Among the six providers, this
  is the only one confirmed OK on both axes (signal exists AND is
  headless-readable) without any open question.

## 7. `none` provider -- N/A

`src/providers/none.ts` implements `llm_provider: "none"` for plain
command-executor members with no CLI/LLM concept at all;
`execute_prompt` rejects these members outright (use `execute_command`
instead, per that file's own doc comment). No usage/budget signal applies.

## 8. Recommendations for apra-fleet-eft.80.2

1. Implement OpenCode's `getUsage()` (or equivalent inline-usage read)
   FIRST -- it is the only provider with a fully-confirmed, headless-safe,
   already-inline signal (section 6). Cheapest path to a working
   `source: "provider"` example the other adapters' stub/fallback
   implementations can be checked against.
2. Implement Claude API-key members' `getUsage()` second, against the
   Admin API (section 1.1) -- real and well-documented, but explicitly
   flag the Admin-key-vs-member-key credential-plumbing gap as a
   configuration/secrets-management dependency, not a code-complexity one.
3. For Claude OAuth, Codex, and Gemini (sections 1.2, 2, 3): treat the
   FALLBACK path (fleet-side token-count accumulation, `source:
   "estimated"`, per apra-fleet-eft.80's own fallback clause) as the
   operative implementation for launch, layered with the already-shipped
   error-classification signals as best-effort supplementary warnings
   (session-limit / quota-error text -> `classifyError()`), rather than
   blocking on a headless usage query these providers may not offer.
4. Copilot (section 4) and AGY (section 5) remain [TBD]/[FAIL] pending
   hands-on investigation with the live binaries -- do not build
   `getUsage()` for either until that investigation happens; both already
   fall back cleanly to the estimated-source path per apra-fleet-eft.80's
   design.
5. Before writing adapter code, re-verify OpenAI's Usage API shape
   (section 2.1) against a reachable source (authenticated session or
   OpenAPI spec) -- this survey could not get past `platform.openai.com`'s
   bot protection, so its [DOC] marker there is a re-verification TODO,
   not a confirmed finding, unlike every [OK] row in this document.
