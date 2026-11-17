# Endpoint Transport: a memberless FleetApi over a plain HTTP model endpoint

## What it is

`@apralabs/apra-fleet-client/endpoint` (`makeEndpointApi(config)`) builds a
`FleetApi` object that talks directly to an OpenAI-compatible or Anthropic
native HTTP endpoint -- no fleet MCP server, no registered member, no SSH,
no work folder. The result can be handed straight to
`new FleetWorkflow(fleetApi)`: the workflow engine calls exactly three
methods on that object (`executePrompt`, `executeCommand`,
`getMemberModelPricing`), and this factory answers all three, so the engine
runs unmodified against either transport.

The first consumer is a serverless function with no SSH, no member and no
writable script directory available to it -- exactly the case the
MCP/member-based transport cannot serve at all. Endpoint transport is a
second, parallel way to obtain a `FleetApi`, not a replacement for the
MCP-server transport.

## Why it is not a seventh provider adapter

`src/providers/` models a provider as `ProviderAdapter`, a large CLI- and
filesystem-shaped interface (build a shell command, parse an `SSHExecResult`,
resolve a session log path, manage OAuth credential files, trust a
workspace, install a CLI, ...). A direct HTTP call to a model endpoint has no
work folder, no session transcript, no permission config, nothing to
install and nothing to trust -- it would implement a handful of those methods
honestly and stub the rest, which quietly lies about what the object can do.

Instead, the seam chosen is `FleetApi` itself: the workflow engine already
depends on that three-method surface and knows nothing about MCP, members,
or SSH. Endpoint transport is a sibling implementation of that same surface,
built over HTTP, entirely separate from the provider-adapter/member
machinery. The MCP server is untouched by this design.

## Two call shapes, one shared core, never sniffed

The driving requirement was to support both LLM call shapes in general use --
the completion/message pattern (OpenAI-compatible: `/chat/completions` and
legacy `/completions`) and the Anthropic-native `/v1/messages` pattern --
rather than hard-depending on a single gateway. OpenAI-compatible is base-URL
configurable, so the same adapter also covers any compatible gateway (e.g.
openrouter.ai) with no extra adapter and no vendor lock-in.

The two shapes are siblings, not a shared adapter with a special case bolted
in: Anthropic auth (`x-api-key` + a required `anthropic-version` header,
required `max_tokens`, a `content` array of typed blocks) differs from
OpenAI's bearer-token/`choices[0]` shape in every place that matters, so
forcing them into one code path would just relocate the special-casing
rather than remove it.

Within the OpenAI-compatible adapter, which of `/chat/completions` vs
`/completions` is used is **explicit configuration** (`config.pattern`),
never inferred from the model name/id. Guessing from the model name would
silently change call shape the moment a caller reconfigures which model they
point at; an unrecognized pattern value is a construction-time `TypeError`
instead.

Both adapters converge on the same shared core (below) so a caller cannot
tell which shape produced a given envelope or error.

## The shared core: one envelope contract, one error taxonomy

A transport-neutral core module owns exactly two responsibilities, and no
HTTP client code at all (no `fetch`, no headers, no `process.env`):

1. **Engine envelope.** The workflow engine's dispatch path reads
   `structuredContent.response` and indexes `content[0].text`; handing it
   anything else fails deep inside the engine with a confusing, generic
   transport error. Every adapter builds successful replies through one
   `buildEnvelope()` call so this shape can never be gotten wrong
   independently per adapter.

   Token usage is normalized from whichever spelling the provider used
   (`input_tokens`/`output_tokens` for Anthropic, `prompt_tokens`/
   `completion_tokens` for OpenAI-compatible), and is **omitted entirely**
   -- never zero-filled -- when the provider reported none. The engine
   treats a usage object carrying a numeric `total_tokens` as real spend, so
   inventing zeros would misreport a paid call as free and silently corrupt
   downstream budget and cost totals. A provider that genuinely reports
   zeros is taken at its word; only "nothing reported" gets the `null`/
   omitted treatment.

2. **Failure classification.** The engine re-raises anything
   `instanceof WorkflowError` untouched and wraps everything else in a
   generic transport error, so every distinguishable failure mode is mapped
   onto the engine's own existing typed error taxonomy rather than a
   parallel one:
   - a cooperative cancellation (the caller's own `AbortSignal` fired) ->
     `CancelledError`
   - the request's own deadline expiring with no response -> `FleetTransportError`
     (kept distinct from cancellation: a stalled provider is not the same
     fact as "someone asked to stop")
   - a genuine connectivity failure (DNS/socket/TLS, no response at all) ->
     `FleetTransportError`
   - a response body this transport could not read, or a caller-supplied
     prompt that was missing/empty -> `AgentOutputError`
   - a well-formed non-2xx HTTP response -> reported (not thrown) on the
     engine's own `structuredContent.isError`/`reason` channel, which the
     engine itself turns into a typed `AgentDispatchError`. This mirrors how
     `execute_prompt` already reports a dispatch that failed before any real
     LLM content existed (busy member, non-zero exit); a non-2xx from an
     endpoint is the same kind of failure and is kept on that same channel
     instead of becoming a raw rejection.

   Distinguishing an abort from a plain rejection is done by **inspecting
   the request's own composed `AbortSignal` state**, not by pattern-matching
   the rejection's name/code. A cooperative-cancellation error can itself be
   named e.g. `CancelledError`, which a naive `err.name === 'AbortError'`
   check would miss entirely; checking whether the signal that was passed to
   `fetch` actually fired is unambiguous regardless of what the underlying
   rejection looks like. The same signal-state check is applied at every
   point a failure can surface: before the request is even sent, on the
   fetch rejection itself, and on a failure reading the response body (some
   `fetch` implementations resolve the fetch promise as soon as headers
   arrive, so a cancellation or deadline expiry can still show up as a
   body-read failure rather than a fetch rejection).

## Request deadlines are always enforced, deliberately not via `AbortSignal.timeout()`

A stalled connection must never hang a dispatch indefinitely, so a request
deadline (a caller's `timeoutMs`/`timeout_s`, falling back to per-transport
config, falling back to a fixed default) is always composed with the
caller's own abort signal via `AbortSignal.any()`.

The deadline timer is implemented as a plain, ref'd `setTimeout`, explicitly
**not** `AbortSignal.timeout()`. That built-in helper's internal timer is
unref'd, meaning Node will not keep the process alive on its account alone --
a dispatch whose only other pending work is the fetch itself (e.g. DNS still
resolving, or a test stub with no live handle yet) can let the process exit
before the deadline ever fires, silently defeating the whole point of
enforcing one. A ref'd `setTimeout`, cleared as soon as the request settles
for any other reason, guarantees the deadline actually fires while still
never holding the process open past a fast/successful call.

## Config is always injected, never read from the environment

Nothing in the endpoint transport (core, HTTP plumbing, or either shape
adapter) reads `process.env`. `fetch` itself is injected the same way. This
is a hard invariant, not a style preference: the first consumer's config
layer is a deliberate single source of truth with no fallbacks, and a
transport that silently reached for environment variables behind that
consumer's back would break that contract. It is also what makes every
adapter fully testable with a stubbed `fetch` and no network access or API
key present.

## Answering the two non-`executePrompt` methods honestly

The engine also calls `executeCommand` and `getMemberModelPricing` on
whatever object it was constructed with. Only `executePrompt` has an
obvious meaning over a bare HTTP endpoint, so the other two are answered
deliberately rather than left as stubs that could mislead a caller:

- **`executeCommand` always refuses.** There is no member, no SSH and no
  work folder behind this transport, so returning a fabricated success (or
  an empty result) would let a workflow believe a shell command ran when
  nothing did. It rejects with the engine's own `CommandError` type (not a
  look-alike class), so the workflow engine's own re-raise/wrap logic
  reports it as the real capability gap it is, rather than blaming the
  network for something that was never possible.
- **`getMemberModelPricing` prices from injected config, or explicitly says
  it cannot.** There is no member and, more decisively, no *tier
  resolution* here: every shape adapter sends exactly the one configured
  model on every dispatch regardless of which tier keyword the engine
  passes. A per-tier price table would therefore encode a resolution this
  transport does not perform. What the operator can honestly report is the
  price of the single model they configured, so a single
  `{promptPrice, completionPrice}` pair is reported identically for all
  three tiers, because all three genuinely bill at that one model's rate.
  When no pricing config was supplied, this does not fall back to a guess:
  it returns the same explicit "unpriced" signal (an `error` field, no
  `pricing` field) that the engine's own pricing resolution already
  understands and falls through from, so an unconfigured endpoint degrades
  to "cost unknown" rather than a fabricated number. A caller who wants a
  dispatch's real cost enforced must pass pricing config; passing none is a
  deliberate, visible trade-off, not a silent zero-cost default.

## Package boundary: workflow's error taxonomy now lives in the client package

The workflow engine's typed error classes (`WorkflowError`,
`AgentDispatchError`, `AgentOutputError`, `CommandError`,
`FleetTransportError`, `BudgetExceededError`, `CancelledError`) were moved to
live in `@apralabs/apra-fleet-client`, with the workflow package's own error
module re-exporting them rather than defining a second copy. This is
load-bearing, not cosmetic: the endpoint transport needs to raise these
exact classes from inside the client package, and `instanceof WorkflowError`
checks inside the engine only keep working across that package boundary if
both sides import the same class objects rather than two independently
defined ones with the same names.

## Known, deliberately deferred trade-offs

A few behaviors were consciously left for follow-up rather than treated as
launch blockers:

- **No retry/backoff on rate limiting.** An HTTP 429 currently hard-fails a
  workflow step immediately rather than being retried or mapped onto the
  engine's own busy-wait/poll mechanism. This matters most against shared
  gateways where rate limiting is routine, and is tracked as follow-up work
  rather than solved here.
- **A caller-declared long-running budget (`max_total_s`) is not honored as
  a deadline source.** Only per-call timeout options and transport config
  are consulted when resolving the request deadline; a caller expressing a
  long budget solely through that other field will still be cut off at the
  default deadline. Documented as a known gap rather than silently
  "handled."
- **Pricing is opt-in per the injected `pricing` config field, not derived
  automatically.** A consumer that configures a budget but forgets to also
  configure pricing gets an unenforced budget with no error, since "unpriced"
  and "budget met" are not currently distinguished loudly enough at the
  point a workflow is configured.

None of these affect the core envelope/error-classification contract above;
they are gaps in how much of the engine's optional feature surface
(retry-on-busy, long deadlines, automatic cost enforcement) this transport
currently participates in.
