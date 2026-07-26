# Context Rot Detection: an apra-fleet advanced capability

> A proposed capability that watches a member's live LLM session (across
> Claude, Gemini, and eventually Codex/Copilot/AGY) for signs that its
> conversation context has degraded -- via digression, staleness, or sheer
> size -- and surfaces that signal to the human/orchestrator before the
> member's output quality visibly drops, with concrete next-step suggestions
> (compact, fork a sub-agent, or restart with a distilled brief).

Status: PROPOSED
Author: apra-fleet (this session), informed by a deep-research pass (see
"State of the art" below for sources)

---

## Motivation

apra-fleet already runs many long-lived LLM-driven sessions in parallel
across providers (Claude, Gemini, and other members via SSH/local/relay
execution) to drive a project or sprint. A session's context often starts
sharp and linear -- a clear goal, a focused sequence of edits and checks --
and degrades over time as digressions, dead ends, stale tool output, and
repeated exploration accumulate. This is the same failure mode this very
session has now seen twice in this conversation: real bugs were caught only
because someone looked closely, not because the session itself flagged that
its own context had drifted.

Today apra-fleet has no signal for this at all. A member can be actively
burning tokens on a stale, unfocused, or looping context and nothing in the
fleet notices until a human happens to read the transcript or the member's
output visibly gets worse. This proposal is about closing that gap: giving
apra-fleet a way to detect -- not just mitigate after the fact -- when a
member's context has rotted, and to say so with an actionable suggestion.

## State of the art (deep-research summary, 2026-07)

A `/deep-research` pass (93 sub-agent calls, 13 sources fetched, 25 claims
adversarially verified, 20 confirmed / 5 refuted) found:

- **"Context rot" is now a named, measured phenomenon**, not just informal
  folklore: Chroma's 2025 multi-model study (18 frontier models, a
  repeated-word test scored by Levenshtein distance) and the Feb 2026
  LOCA-bench paper (arXiv:2602.07962, "Benchmarking Language Agents Under
  Controllable and Extreme Context Growth") both show LLM reliability
  deteriorating unevenly and unpredictably as context grows, rather than
  scaling uniformly with window size. LOCA-bench specifically targets
  *agentic* context growth (accumulated through multi-step tool use), not
  just a long static document -- closer to what a coding-agent session
  actually looks like.
- **"Lost in the Middle" is the best-established mechanism** (Liu et al.
  2023, Stanford/UC Berkeley, arXiv:2307.03172): a U-shaped accuracy curve
  where information near the start or end of context is retrieved/used far
  better than information in the middle (originally ~70-75% accuracy at
  position 1 falling to ~55-60% mid-context, on a 20-document retrieval
  task). Replicated across six-plus model families. **Caveat: a specific
  "15-30% degradation from 8K to 128K tokens" figure and a "RoPE decay
  persists under randomization" mechanism both failed adversarial
  verification in this research pass and should not be treated as
  established** -- the phenomenon is real, some of the precise numbers
  circulating about it are not.
- **Detection methods in the literature fall into three families**: (1)
  synthetic benchmark probes (repeated-word/Levenshtein tests,
  needle-in-haystack at varying positions) -- offline, not deployable in a
  live session; (2) statistical/ML-ops-style drift detection on embeddings
  (distribution shift via MMD, cosine distance) -- borrowed from production
  ML monitoring, not validated specifically for conversational context rot;
  (3) informal behavioral heuristics (vague answers, disappearing details,
  drifting tool choice) -- used qualitatively by vendors, not as calibrated
  metrics. **A specific claim that "contradictions, repeated questions, and
  instruction drift reliably indicate context rot" was explicitly refuted on
  verification** -- these are plausible symptoms, not proven signals.
- **In production, almost nobody actually *detects* context rot -- they
  pre-emptively *mitigate* it on a blind threshold.** LangChain's Deep
  Agents: offload tool results over 20,000 tokens to the filesystem with a
  path + preview; at 85% context-window capacity, truncate older tool
  input/output and replace with pointers; as a last resort, generate a
  structured summary of intent/artifacts/next-steps. Anthropic's own
  multi-agent research system and Claude Code's subagent/Task-tool feature
  isolate exploratory work in a disposable sub-agent context, returning only
  a distilled result to the orchestrator. None of these are informed by a
  measurement of whether the context has actually degraded -- they fire on
  size alone.
- **Open gap confirmed by this research**: no published, calibrated,
  real-time "is this session's context currently rotted" detector was found
  in production use anywhere -- for any product, including the ones this
  research specifically looked for evidence on (Cursor, Devin, GitHub
  Copilot workspace agents, OpenCode). This is a genuine, not-yet-crowded
  space for apra-fleet to build a real capability, not a "catch up to what
  everyone else already ships" feature.

Full source list and confidence levels are in the research transcript this
proposal is based on; the two headline primary sources are Liu et al. 2023
(arXiv:2307.03172) and LOCA-bench (arXiv:2602.07962).

## What apra-fleet is uniquely positioned to build

Most of the industry's mitigation techniques (compaction, sub-agent
isolation, filesystem offload) live *inside* a single provider's own agent
runtime and only see that one session. apra-fleet sits one layer up: it
already orchestrates multiple members, across multiple providers, and
already resolves each provider's on-disk session transcript
(`src/services/stall/log-path-resolver.ts` today knows Claude's
`~/.claude/projects/<encoded-path>/<sessionId>.jsonl` and Gemini's
`~/.gemini/tmp/<project>/chats/<sessionId>.jsonl`; AGY/Codex/Copilot are
explicitly unsupported today -- `throw new Error('Unsupported log polling
for provider: ...')`). That means apra-fleet can build a **provider-agnostic,
fleet-wide** rot detector, not a single-vendor feature -- and it already has
the periodic-polling architecture (`src/services/stall/stall-poller.ts`) and
the human-facing signal path (`report-status`, `respond-to-message` MCP
tools) to act on it without inventing new plumbing.

## Proposed design: three tiers, cheapest first

Ship this in tiers so the cheap, useful part lands immediately and the more
speculative LLM-judge tier is opt-in and clearly labeled as experimental
(per the research finding that no validated real-time detector exists yet
anywhere -- apra-fleet should not overclaim precision it can't back up).

### Tier 0: heuristic signals (no LLM calls, ships first)

Read directly from the resolved session transcript (JSONL), no model calls
needed:

- **Context size**: running token estimate (chars/4 heuristic is fine) vs.
  the provider's known context window; flag at configurable thresholds
  (e.g. 70% / 85%, matching the shape of LangChain Deep Agents' 85% trigger
  cited above).
- **Turn/tool-call ratio**: a rising ratio of tool-call turns to
  substantive-text turns over a trailing window is a cheap proxy for
  "digging without synthesizing."
- **Repetition/redundancy**: near-duplicate tool calls (same file read N
  times, same grep pattern re-run) in a trailing window -- a strong,
  cheap signal of a stuck/looping session, independent of raw size.
- **Session age / turn count**: simple duration and turn-count thresholds,
  as a coarse fallback signal when the above aren't conclusive.

This tier alone is enough to flag "this session is probably getting
unwieldy" and is exactly the class of signal every production system
surveyed above actually ships today (threshold-triggered, not
diagnosis-based) -- so it's low-risk and immediately useful, not a research
bet.

### Tier 1: structural drift signals (cheap, still no LLM judge call)

- **Goal-statement anchoring**: keep the session's original stated goal (or
  the most recent explicit user redirect) as a fixed anchor string; compute
  embedding cosine distance between that anchor and a rolling window of
  recent turns using a small, cheap local/embedding-API call. Rising
  distance over time is a topic-drift signal. (This is the one signal in
  the research that is plausible but explicitly **not yet empirically
  validated** against live agent sessions -- ship it labeled as an
  experimental signal, not a certainty, and weight it lower than Tier 0
  signals until apra-fleet's own usage data can validate or refute it.)
- **File/topic churn**: track distinct files touched and distinct topics
  (e.g. distinct top-level directories, distinct beads issue IDs referenced)
  per trailing window; a sudden broadening after a period of narrow focus is
  a digression signal, a sudden narrowing after broad exploration is a
  "found the real problem" signal (i.e. not all drift is bad -- this needs
  care, see Risks below).

### Tier 2: LLM-judge self-reflective check (opt-in, cost-gated)

A cheap, periodic sub-agent call (forked with only the session's stated goal
plus a compressed slice of recent turns, not the full transcript) scoring:

- Goal alignment: does the last N turns' activity still serve the stated
  goal?
- Redundancy: is the session re-deriving something it already established?
- Staleness: is the session acting on information that a later turn
  superseded or corrected?

Returns a rot score (low/medium/high) plus a one-line reason and a
suggested action: recommend `/compact`, recommend forking a fresh sub-agent
with a distilled brief for the next chunk of work, or recommend restating
the goal. This tier costs real tokens per check, so it should run on a
much longer cadence than Tier 0/1 (e.g. only when Tier 0/1 signals are
already elevated, not on a fixed timer), and should be opt-in per
project/session, not default-on.

## OKF as the distillation target, and a maintenance loop to keep it fresh

A gap in the tiers above: when Tier 2 (or a human) decides a session's
context should be distilled and refreshed, *what format does the distilled
knowledge land in*? "A structured summary" is not enough of an answer --
it needs to be something the next session (or a different member, or a
different provider entirely) can actually consume without re-deriving the
same context from scratch.

The [Open Knowledge Format](https://github.com/GoogleCloudPlatform/knowledge-catalog/blob/main/okf/SPEC.md)
(OKF), a real, minimal spec from Google Cloud's knowledge-catalog project,
fits this gap well: a knowledge bundle is just a directory of markdown
files with YAML frontmatter (`type` required; `title`/`description`/
`resource`/`tags`/`timestamp` recommended), cross-linked via plain markdown
links, with an optional `index.md` per directory for progressive disclosure
and an optional `log.md` for chronological history. It is deliberately
un-opinionated about tooling -- "if you can `cat` a file, you can read
OKF" -- which matters here because apra-fleet's members span multiple
providers (Claude, Gemini, and eventually AGY/Codex/Copilot) that must all
be able to consume the same distilled knowledge without a shared SDK.

Concretely, this proposal's Tier 2 mitigation action ("recommend forking a
fresh sub-agent with a distilled brief") should write that brief as an OKF
concept document, not a one-off prose blob:

- `type: Session Distillation`, `title`/`description` naming the original
  goal, `tags` for the beads issue IDs / project area involved,
  `timestamp` of the distillation.
- Body sections for what was established, what's still open, and what to
  avoid re-deriving -- exactly the "intent, artifacts created, next steps"
  shape LangChain Deep Agents already falls back to, just given a durable,
  cross-session home instead of living only in that one session's context.
- Cross-linked (via OKF's plain markdown links) to the beads issue(s) it
  came from and to prior distillations for the same area, so a *later*
  session facing the same rot signal on the same project inherits the
  earlier distillation instead of starting cold.

This is also a genuinely good fit for apra-fleet's existing memory/docs
sprawl independent of context-rot detection specifically: `docs/*.md`
today is ad hoc prose with no consistent frontmatter, no `index.md`, and no
machine-checkable "what type of document is this" signal. Adopting OKF's
conventions for anything durable (ADRs, design docs, cross-repo negotiation
records) would make that corpus something an agent can traverse
systematically rather than grep and hope.

**"OKF-maintain"**: no such artifact exists in the knowledge-catalog repo
today (checked directly and via GitHub code search -- zero hits) -- treat
this as a needed *practice*, not something to adopt off the shelf. An OKF
bundle left alone accumulates the same rot a conversation does: stale
`index.md` entries, dangling `log.md`, links to concepts that were renamed
or removed. The natural fix is to fold bundle maintenance into the same
periodic loop this proposal already needs for Tier 0/1 polling
(`stall-poller.ts`'s architecture, reused rather than duplicated per
"Integration points" below): on the same cadence, a maintenance pass
regenerates affected `index.md`/`log.md` entries and flags (not
silently drops) broken cross-links, exactly matching OKF's own
conformance rule that consumers must tolerate broken links rather than
reject the bundle -- the maintenance loop's job is to *notice* and log
them for a human to resolve, not to enforce a stricter contract than the
format itself requires.

## Integration points (concrete, not hypothetical)

- **Extend `log-path-resolver.ts`** to support AGY/Codex/Copilot transcript
  locations (today explicitly throws "Unsupported log polling for
  provider") -- required before Tier 0 can be fleet-wide rather than
  Claude/Gemini-only.
- **Reuse `stall-poller.ts`'s polling architecture** for Tier 0/1 checks
  instead of building a second poller -- rot checks and stall checks are
  the same shape of periodic, per-member, transcript-driven work.
- **Surface via a new MCP tool** (e.g. `check_context_rot`, alongside the
  existing `check-status.ts`) so a human or a PM-skill orchestrator can
  query a member's current rot signal on demand, plus a proactive push via
  `report-status`/`respond-to-message` when a threshold is crossed.
- **Feed into auto-sprint/PM skill decisions**: a doer whose rot signal is
  elevated before starting its next task is a concrete, actionable trigger
  for the orchestrator to compact or re-brief that doer first, rather than
  handing it more work on top of an already-degraded context.

## Non-goals

- This is **not** a model-internal probe (no access to attention weights,
  perplexity, or logits via any of the providers apra-fleet supports) --
  every signal here is derived from the transcript and behavior visible
  externally, matching what the research found is actually possible today.
- This does not replace each provider's own internal compaction/context
  management (Claude Code's auto-compaction, etc.) -- it's a fleet-level
  signal layered on top, informing *when* to trigger those existing
  mechanisms rather than reimplementing them.

## Risks and open questions

- **False positives on legitimate broadening.** Not all topic/file-churn
  growth is rot -- a session that correctly discovers the real scope of a
  problem after initial exploration will look identical to "digressing" on
  Tier 1's file/topic-churn signal alone. Tier 0's repetition/redundancy
  signal is more robust for this reason and should be weighted higher.
- **No validated ground truth yet.** Per the research, nobody has published
  a calibrated real-time detector to compare against -- apra-fleet would be
  building the first one it can find evidence of. Ship Tier 0 first, gather
  apra-fleet's own before/after data (does flagging + compacting actually
  improve subsequent output quality?), and let that data -- not borrowed
  vendor claims -- calibrate Tier 1/2 thresholds.
- **Tier 2 cost/latency**: an LLM-judge call on every check is expensive at
  fleet scale; must be gated behind already-elevated Tier 0/1 signals, not
  run unconditionally.
- **Open research question this proposal inherits, unresolved**: does
  embedding cosine distance between early and late conversation turns
  actually correlate with measurable output-quality degradation in *live
  agent* sessions specifically (as opposed to the ML-ops production/
  baseline-drift sense it's borrowed from)? This research pass found no
  validated answer either way -- Tier 1's goal-anchoring signal should be
  treated as a hypothesis apra-fleet is testing, not an established
  technique, until there's fleet-collected evidence either way.

## Suggested rollout

1. Tier 0 heuristics (size/turn-ratio/repetition), Claude + Gemini only
   (existing log-path support), surfaced read-only via a new MCP tool.
2. Extend log-path-resolver for AGY/Codex/Copilot so Tier 0 is fleet-wide.
3. Wire Tier 0 into `stall-poller.ts`'s cadence and add proactive
   `report-status` push on threshold crossing.
4. Tier 1 structural-drift signals, labeled experimental, off by default.
5. Tier 2 LLM-judge, opt-in per project, gated on elevated Tier 0/1 signal;
   its distillation output is written as an OKF concept document (see
   "OKF as the distillation target" above), not one-off prose.
6. Fold OKF-bundle maintenance (regenerating `index.md`/`log.md`, flagging
   broken links) into the same periodic loop as step 3, once step 5 has
   produced enough distillations for there to be a bundle worth
   maintaining.
