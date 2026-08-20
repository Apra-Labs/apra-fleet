# Marketing Track: README Rewrite + github.io Site

Living plan for repositioning apra-fleet's public face. SELF-CONTAINED BY
DESIGN: everything decided, argued, or proposed in conversation is recorded
here so the track survives agent restarts, context compaction, and acts of
god. A fresh agent (or human) must be able to execute from this file alone.
Update statuses and the log in place as items land.

Companion file: [readme-rewrite-draft.md](readme-rewrite-draft.md) -- the
actual draft copy. This file is the WHY and the WHAT-NEXT; the draft is the
current text.

---

## 1. The problem being solved

The current /README.md commits the classic infrastructure-company sin: it
describes what the software does (install steps, member registration, PM
skills, sprints) instead of what the user gets to stop worrying about. It
leads with the software-engineering vertical, so readers file apra-fleet
as "another AI coding tool" -- the most crowded, least defensible shelf.
Months of messaging have been confusing for exactly this reason.

The architecture separation finally makes the true product visible:
- apra-fleet = core fleet platform (server, members, credentials,
  workflows runtime)
- packages/apra-fleet-se = the software-engineering VERTICAL
- packages/apra-fleet-se/auto-sprint = one flagship WORKFLOW
- apra-pm = removed to its own repo entirely

Target audiences: VCs, ProductHunt, YC, high-profile people in agentic AI.

## 2. Positioning (DECIDED)

- **Own the word "fleet"** -- not "framework", not "agents". Fleet implies
  many, heterogeneous, managed, accountable. Category claim: **agent fleet
  platform**. Drumbeat: "One control plane. Any device. Any model. Any
  workflow."
- **The k8s analogy is approved and load-bearing** (user explicitly liked
  it). Used ONCE, early, as sentence two: "What Kubernetes did for
  containers, apra-fleet does for AI agents: scheduling, credentials,
  isolation, and observability for an agentic workforce." It does category
  placement in ~4 seconds of reading.
- **Proof lead -- the recursive story**: "This repository is built by the
  product you are looking at." Autonomous sprints plan/code/review/test/
  ship this codebase, file bugs against themselves, fix them, and block
  their own release on quality gates. No competitor can honestly copy the
  claim. Always backed by REAL artifacts (recordings, transcripts, run
  logs) -- never mockups.
- **Wedge vs platform tension (argued, resolved)**: VCs read focus as
  discipline; "platform for everything" unproven is a red flag. So the
  pitch OPENS with the working vertical (autonomous software engineering,
  self-hosting today) and frames generality as the arc: "the engine does
  not know what a sprint is; it knows how to run your workflow reliably
  across your fleet." Vertical teasers (retail replenishment, logistics
  exception handling, healthcare intake, back-office ops) are one-liners,
  explicitly examples of the pattern, never promises.
- **Audience split**: README converts DEVELOPERS in 30 seconds; the
  github.io site converts INVESTORS/PRESS in 3 minutes. Different jobs,
  shared copy skeleton (README lands first, becomes the site skeleton).

## 3. Differentiators to lead with (verified against the codebase)

1. **Real devices, not sandboxes.** Members are actual machines (MacBook,
   Windows tower, GPU box, cloud VM) -- registered, credentialed,
   permission-composed, health-checked. Cloud members auto-start on
   demand (ensureCloudReady).
2. **Every provider, simultaneously.** Claude, Codex, Copilot,
   Antigravity, local models (OpenCode/vLLM) in ONE fleet. Tier-based
   routing (cheap/standard/premium) = cost governance built in.
3. **Workflows as durable programs.** Multi-hour, resumable, observable
   orchestration: supervisor, member reservations, watchdogs, atomic
   state, live dashboard. Temporal-class rigor applied to agents, not a
   prompt chain.
4. **The unsexy 20% moat**: OOB credential store ({{secure.NAME}}, TTL,
   egress policy allow/deny/confirm), per-provider permission
   composition, VCS auth provisioning/revocation, session liveness,
   dispatch locks. Boring in a feature list, decisive in diligence.
5. **It builds itself** -- see proof lead above. Real numbers only,
   sourced from stabilization log + sprint logs (2,300+ unit tests,
   76-81-file real-backend integ suite, multi-cycle unattended runs,
   10+ bugs self-filed and fixed as of run 15).

## 4. README first-30-seconds design (DECIDED)

Reader sees, in order:
1. Hero banner [GFX-1] + name + one-liner: "Run a fleet of AI agents
   across your devices, your providers, your workflows."
2. k8s sentence (category placement).
3. Credibility gut-punch: real dashboard GIF [GFX-2] captioned "built by
   the product you are looking at... not a mockup."
4. "Why a fleet?" -- four operational pains that make an agent operator
   feel seen: Which machine runs which agent? / Which model does which
   job? / Who watches the agents? / Who holds the keys? Ending in the
   drumbeat line.
5. Pillars table -> flagship (auto-sprint w/ real numbers) -> 4-step
   quickstart -> mermaid architecture -> security paragraph -> package
   map -> roadmap -> closing CTA: "Stop babysitting agents. Start
   operating fleets."

## 5. Ground rules (learned the hard way)

- ASCII only in all files (repo policy). Mermaid for evolving diagrams.
- **Every command shown must be verified against the shipped CLI/current
  README before it enters the draft.** A hallucinated quickstart
  (invented install.sh + `apra-fleet start` + CLI-first flow) was caught
  by the user on 2026-07-20. The REAL flow: npm i -g @apralabs/apra-fleet
  (install is the default action; --llm per provider) OR standalone
  installer binary from Releases; connect via /mcp in the LLM CLI;
  register members CONVERSATIONALLY in plain language (OOB password for
  remote members); then `apra-fleet workflow hello-world` /
  `apra-fleet workflow fleet-sprint --issue ... --members ... --branch
  ... --base ...`. NOTE: the real conversational flow is also the BETTER
  story -- feature it in the hook, not just accuracy.
- No fabricated numbers, ever. Dogfood stats from real run artifacts.
- README.md promotion happens at a SPRINT-RUN BOUNDARY only: the
  auto-sprint harvester appends to the live README during Final Harvest;
  landing mid-run invites merge conflicts with the running fleet.
- When rewriting README.md, do not delete the current deep-dive sections
  (transport/SSE, service mode, PM skill, cost tables, provider matrix
  details) -- MOVE them into docs/ pages and link them. They are good
  content at the wrong altitude.

## 6. Workstream 1: README.md rewrite -- status + next actions

- [x] Positioning brainstorm + decision (2026-07-20)
- [x] First full draft committed (docs/marketing/readme-rewrite-draft.md)
- [x] Quickstart corrected to the real npm//mcp/conversational flow
- [x] USER REVIEW PASS -- Slack thread, 2026-07-24 (Kashyap + user), see log
      entry below. One item still OPEN from that pass (section order).
- [ ] OPEN DECISION (Kashyap, 2026-07-24): should "Reliable Deterministic
      Workflows + Memory" be a distinct, more grounded pitch angle vs the
      current agent-fleet-platform framing? Not yet decided -- needs a
      user call before it changes positioning (section 2).
- [ ] OPEN DECISION (Kashyap, 2026-07-24): reorder draft sections -- move
      "Security model, in one paragraph" up (currently 8th of 9 sections,
      after Compare-to-alternatives). Proposed, not yet actioned pending
      user confirmation on the target position.
- [ ] Refresh dogfood numbers from the FINISHED run: cycles run, total
      tests, integ-suite size, bugs self-filed/fixed count. Sources:
      packages/apra-fleet-se/auto-sprint/docs/stabilization-log.md and
      sprint-logs/*.log. Replace the draft's current numbers.
- [x] Produce GFX-1 hero banner (spec: section 8) -- done, see
      assets/marketing/hero-banner-{dark,light}.svg, wired into the draft
- [x] Record GFX-2 dashboard GIF -- done 2026-07-24, see log entry below.
      assets/marketing/dashboard-demo.gif, wired into the draft.
- [x] Produce GFX-3 fleet topology SVG (spec: section 8) -- done, see
      assets/marketing/fleet-topology.svg, wired into the draft
- [x] Migrate current README deep-dive sections into docs/ pages (see
      ground rule) and add links from the new README -- done 2026-07-24,
      see log entry below.
- [x] Promote draft -> /README.md; delete draft file; update this plan's
      log -- done 2026-07-24, see log entry below. Note: NOT at a sprint-run
      boundary via the auto-sprint harvester -- done as a direct user-
      requested edit on this worktree/branch (auto-sprint/eft-service),
      per explicit user instruction after the ground-rule tradeoff was
      surfaced and the user chose "replace, but preserve deep-dive
      sections" over waiting for the two open positioning decisions below.

## 7. Workstream 2: github.io site -- plan + next actions

Purpose: branded marketing-grade companion. Converts investors/press in
3 minutes with actual features + evidence.

Decisions still open (decide at scaffold time): docs-site/ folder vs
gh-pages branch; plain HTML/CSS vs Astro (bias: keep trivial, no build
complexity that outlives usefulness); domain/branding linkage to
apralabs.com. Style: dark-first, single accent, real product
screenshots/recordings only.

Page map (v1):
1. Landing: hero, pillars, dashboard video embed, provider matrix
2. "It builds itself": the dogfood story w/ real sprint transcript
   excerpts + run timelines as evidence
3. Security: credential store, OOB secrets, egress policy, permission
   composition, provisioned/revocable VCS auth
4. Workflows: durable-program model (resumable, observable) + supervisor
   (launch/stop over HTTP, reservation ledger, watchdog, history)
5. Get started: mirrors README quickstart + docs links

- [ ] Scaffold decision (folder vs branch; generator)
- [ ] Landing page prototype AS A PRIVATE ARTIFACT for user reaction
      BEFORE anything goes public (explicitly agreed sequencing)
- [ ] Copy adaptation from final README
- [ ] Domain/branding decision
- [ ] Publish + link from README hero nav (the draft already points nav
      at https://apra-labs.github.io/apra-fleet -- placeholder until live)

## 8. Asset inventory + production specs

| Asset | Spec | Status |
|---|---|---|
| GFX-1 hero banner | 1280x320 SVG/PNG, dark+light variants via GitHub picture element. Wordmark + tagline. Visual: constellation of device silhouettes (laptop, tower, rack, cloud) connected by orbit lines to a central control hexagon; small provider glyphs per device; subtle grid background. | done -- assets/marketing/hero-banner-{dark,light}.svg |
| GFX-2 dashboard GIF | REAL recording of the auto-sprint viewer during a live run: phase transitions, doer dispatch landing, verdict appearing. 20-30s loop, 1200px wide, <8MB. Highest-credibility asset -- prioritize. LANDING PREREQUISITE: draft must not promote to /README.md without it. The old YouTube video (SGdHvIkSbY8) was tried as interim media and REJECTED (user, 2026-07-20): it is PM-skill-era material that contradicts the new positioning. | done -- assets/marketing/dashboard-demo.gif (27 frames, 4.7MB, captions burned in); see docs/marketing/gfx2-story.md for the beat sheet |
| GFX-3 fleet topology | 900x520 SVG, static, dark+light variants via GitHub picture element (same convention as GFX-1). Centered control-plane hexagon with radial glow -> 5 heterogeneous member devices (laptop/tower/GPU box/cloud VM/CI rack), provider glyph badges + OS labels, directional dashed spokes with arrowheads, amber pill callouts: "reserved by sprint A", "tier: premium", "credential: scoped". Mono-accent, hero-banner palette and grid. | done (redesigned 2026-07-24) -- assets/marketing/fleet-topology{,-dark}.svg |
| GFX-4 architecture | mermaid block in README (renders natively on GitHub, diffs in PRs). Already in draft. | in draft |
| Badges | shields.io: build (GH Actions), latest release, license, "providers: 5+", platform trio (win/mac/linux). No custom infra. | pending README landing |

### Pillar decision addendum (2026-07-20, user-proposed, critiqued, adopted)

Fourth pillar **Any domain** added below Any workflow; drumbeat is now
"One control plane. Any device. Any model. Any workflow. Any domain."
Critique applied: (a) aspiration-trap risk managed by making examples
concrete WORKFLOW SHAPES (each passes "decomposes into agent-sized pieces
+ needs orchestration + leaves an audit trail"), not industry name-drops,
and by keeping the honesty clause in the pillar itself ("software
engineering is the vertical running today -- your domain is a workflow
away"); (b) redundancy removed -- the retail/logistics/healthcare sentence
moved OUT of the flagship section into the pillar (single home); flagship
keeps only "the engine does not know what a sprint is".

### Token-economics insight (2026-07-20, user-proposed, assessed SHARE)

New README section "Explore with agents. Operate with programs." Thesis:
LLM orchestration is the right mode for DISCOVERING a workflow; once the
workflow is known, control flow hardens into deterministic programs and
the model is consulted only at judgment nodes -- execute_command (zero
tokens) vs execute_prompt (tokens where thinking lives). Development/NRE
tokens are not operating tokens; runtime cost SHRINKS as a workflow
matures instead of scaling with every step (the CrewAI/AutoGen/LangGraph
contrast: their orchestration itself burns tokens on every run, forever).
Why share: answers the VC unit-economics question (improving cost curve),
is architecturally checkable in the API surface, and auto-sprint is the
lived proof (exploration -> hardened engine; models only as planner/doer/
reviewer/tester/harvester). Placement discipline: mid-README after "How
it works" -- too dense for the 30-second window; gets a full page on the
github.io site (add to page map when scaffolding).
Second axis (user, same day): the collapse is two-dimensional -- control
flow moves model->program AND the surviving judgment nodes move frontier->
cheap/local, because a well-specified task no longer needs discovery-grade
reasoning. Canonical line: "Develop a workflow with Claude; operationalize
it on OpenCode against a local or OpenRouter model. Same fleet, same
workflow -- swap the members." Tier routing = registration change, not a
rewrite.
Exclusivity punchline (user): "and that is only possible with fleet" --
worded defensibly on architecture: the unit of execution is the MEMBER
(machine + provider, swappable at registration); single-provider tools
cannot leave their vendor, in-process frameworks cannot move orchestration
out of the token path -- both capabilities must coexist in one platform
for the explore-cheaply-operate-cheaper trade to exist. Closer sentence:
"the same hardened workflow runs on frontier models the day you design it
and on commodity models every day after."

### Integration-tester value insight (2026-07-20, measured from sprint logs, assessed SHARE -- no hyperbole)

Source: full sweep of sprint-logs across runs 13-15 (13 integ dispatches).
The honest numbers, usable verbatim:
- 13 integration-test dispatches, ZERO passed:true -- a 100% failed-verdict
  streak. Lead with this, not around it: the gate never let a false PASS
  through, and that is the claim.
- While ~2,400 unit tests were green, the integ role discovered/reproduced
  11 distinct real defects unit tests could not see: a P0 dev-install bug
  (every sandbox shipped a broken client), a sandbox Dolt-push escape
  stopped only by missing credentials, an indefinite dispatch hang, a
  self-reservation deadlock, and more.
- It is the only role that proved landed fixes WRONG: run 15's central
  finding (three bugs with merged fix+test commits that did not hold
  end-to-end) exists only because the integ runner re-ran the smoke test
  every cycle and updated the bugs with fresh evidence.
- It verified-and-closed 9 product features + 1 bug -- closure authority
  exercised on test evidence, not on diff review.
- Honest cost: 3 of 13 dispatches (run 13) executed zero tests
  (permission/turn-budget infrastructure failures). Include this; the
  waste became engine fixes and the candor is what makes the rest
  believable.

Marketing framing (grounded): "quality is a ROLE in the workflow, not a
promise" -- auto-sprint ships an adversarial integration gate whose
verdicts are recorded in the same logs as everything else, and in our own
dogfood it is the reason a release-candidate FAIL verdict was trustworthy.
The one-liner: "our integration tester has never said PASS falsely --
including the 13 straight times it said FAIL to us."
Placement: README quality/how-it-works section (short paragraph + the
13/0 stat); full evidence table is github.io material. Discipline: every
number above must be re-derived from logs at publish time (runs land
daily; 13/0 will change -- possibly to 13/1, which is a BETTER story:
"the first PASS meant something").

## 9. Log (append-only)

- 2026-07-20: positioning decided (fleet + k8s simile + recursive proof);
  first draft written and committed; hallucinated quickstart caught by
  user, replaced with real flow, ground rule recorded; track moved to
  docs/marketing/; plan expanded to be fully self-contained per user
  direction ("every idea must survive agent restart/compaction").
- 2026-07-20 (hole-poking pass vs actual repo, user-directed): draft now
  uses the REAL badge row from current README (CI/Apache-2.0/platform/
  MCP-compatible/DeepWiki) instead of placeholders; embeds the EXISTING
  3-min YouTube run (youtu.be/SGdHvIkSbY8) as the interim GFX-2 until the
  lean-viewer GIF is recorded; carries over the "different blind spots"
  cross-provider-review line, the production fleet snippet (Opus
  orchestrator/Sonnet doer/Antigravity/Opus reviewer), and a
  compare-to-alternatives table (extended with a LangGraph/CrewAI row:
  in-process frameworks vs operating agents across machines/providers/
  days); integ-suite number refreshed to 81 files. Standing directive:
  keep refining the draft against the actual work product as sprint work
  lands.
- 2026-07-20 (integration-tester insight, user-directed "grounded truth
  and honesty"): measured 13-dispatch/0-pass history from runs 13-15
  distilled into a SHARE-assessed section above (quality is a role;
  adversarial gate; honest 3-wasted-dispatch cost included). Numbers must
  be re-derived from logs at publish time.
- 2026-07-24 (graphics pass, user-directed "current ones are placeholders,
  redo them"): GFX-1 (hero banner) and GFX-3 (fleet topology) produced as
  real hand-authored SVGs -- assets/marketing/hero-banner-{dark,light}.svg
  and assets/marketing/fleet-topology.svg -- and wired into the draft
  (GitHub `<picture>` element for the dark/light hero pair). Palette:
  near-black/white grounds, single amber accent (#f2a93b dark / #c97a1e
  light), device silhouettes (laptop/tower/GPU box/cloud/CI rack) on
  orbit lines around a control-plane hexagon. GFX-2 (dashboard GIF) is
  unchanged and still the one asset that cannot be hand-authored -- it
  needs a real recording, still blocked on run 16+.
- 2026-07-24 (Slack feedback, Kashyap + user): the workflow-engine/
  auto-sprint feature is landing as a genuinely valuable product on its
  own, prompting Kashyap to float a more grounded pitch angle -- "Reliable
  Deterministic Workflows + Memory" -- as possibly stronger than the
  current agent-fleet-platform framing. NOT DECIDED; recorded as an open
  positioning question (section 6), separate from the graphic/reorder
  asks below, which ARE actioned.
  Kashyap also asked for a real (not random) graphic in "Explore with
  agents. Operate with programs." showing $ falling as a workflow moves
  from exploration to operation, used to trim the surrounding prose.
  DONE: assets/marketing/cost-collapse-{dark,light}.svg, sourced from 5
  real GitHub Actions runs of this repo's own e2e setup+teardown step --
  not modeled or invented. Four historical LLM-driven runs (Sonnet-decided
  register/provision/verify steps): $0.46 (run 28469587797, 2026-06-30),
  $0.49 (run 28458732457, 2026-06-30), $0.88 (run 28551599212, 2026-07-01),
  $3.05 (run 28554565041, 2026-07-01, remote 2-member suite -- costliest
  because of SSH/auth provisioning). After migrating to the deterministic
  `.github/e2e/fleet-setup.mjs` script (execute_command only, no LLM in
  the loop): $0.00, confirmed from run 30122124609 (2026-07-24) -- no
  claude invocation at all in that run's setup/teardown artifacts. Wired
  into the draft with a one-line real caption, replacing the prior
  abstract "cost curve" prose per the "reduce the text" ask.
  Kashyap's third comment -- possible section reorder (security up) --
  is logged as an open decision above, not yet applied to the draft.
- 2026-07-24 (GFX-3 redesign, user feedback "does not look as attractive
  as hero"): fleet topology rebuilt from scratch and a dark variant added
  (assets/marketing/fleet-topology{,-dark}.svg, 900x520), embedded via a
  GitHub `<picture>` element like the hero. Diagnosed weaknesses of v1:
  light-only (flashed white in dark mode next to the dark hero), flat
  ground with no grid/vignette, small edge-hugging hub with no hierarchy,
  thin directionless mixed dashed/solid lines, off-palette callout colors
  (#fff8ec/#8a5a12), and a seam-y three-circle cloud icon. v2: hub
  centered with a radial amber glow + dashed outer hexagon ring, hero's
  grid + exact palette reused, five devices arranged radially with
  heavier-stroke refined icons (terminal-on-screen laptop, turbine-fan
  GPU box, single-path cloud with VM chip, LED-status CI rack),
  directional dashed spokes with arrowheads/ports/in-flight packets,
  callouts restyled as amber-tinted pills, tagline moved into a
  hero-style eyebrow title block ("FLEET TOPOLOGY"). Both variants
  verified by headless-Chrome render.
- 2026-07-24 (standalone graphic for the undecided "memory" pitch,
  user-directed): produced assets/marketing/workflow-memory-{dark,light}.svg
  (1280x660) to help evaluate Kashyap's "Reliable Deterministic Workflows +
  Memory" angle -- NOT wired into the draft or the positioning section,
  since that angle is still undecided (open question logged above). Same
  asset family: hero 80px grid + palette (near-black/white grounds, amber
  #f2a93b dark / #c97a1e light), hero-style eyebrow title block. Chart
  grammar deliberately differs from cost-collapse's bar chart -- this is a
  two-lane run timeline. Argument grounds strictly in the real resumable-run
  mechanism (apra-fleet-workflow-architecture.md sec 5 + 4.5): every
  agent()/command() call is written to an append-only journal.jsonl; on
  resume each call recomputes a deterministic replay key and a COMPLETED
  match is returned straight from the journal with zero re-dispatch (no LLM
  call, no cost, no shell re-run), while the budget re-debits the journaled
  cost so the resumed total reflects the whole logical run. Lane A (memory
  on) shows steps 1-4 replayed free from a ghosted/checked journal band,
  an honest CRASH break at the in-flight step 5, then live steps 5-6-7 to a
  done terminal. Lane B (stateless) shows the same four steps thrown away by
  a cold-restart loop-back arrow. A "what it costs you" ledger crystallizes
  it: time lost either way, but work + spend kept only with the journal.
  No fabricated dollar/time figures (no specific resumed run to cite yet) --
  qualitative labels only. Both variants verified by headless-Chrome render
  with a collision check. Complements cost-collapse (which covers the
  "deterministic control flow is cheaper" half); this carries the
  "memory / graceful failure" half nothing else covered.
- 2026-07-24 (GFX-2 dashboard GIF, real capture, no longer blocked): launched
  a real `apra-fleet workflow auto-sprint` run (branch auto-sprint/gfx2-demo,
  base auto-sprint/eft-service, member fleet-rev, viewer at localhost:18300)
  against two intentionally simple beads (apra-fleet-9te, apra-fleet-20i) to
  get a genuine dashboard to record against, per the delivered-binary launch
  convention (not the docs/README.md raw-cli.mjs bypass pattern -- see
  auto-sprint-1, and the new apra-fleet-wkg bead filed this session for the
  "auto-sprint" naming collision between Claude Code's own Workflow-tool
  skill and apra-fleet's product CLI workflow that caused early confusion).
  Recorded via claude-in-chrome gif_creator directly against the live
  viewer. The run turned out more interesting than planned: Cycle 1's own
  integration-test gate found two real bugs in apra-fleet itself (a stale
  vendor/apra-pm install path that broke `workflow auto-sprint` for
  everyone, P1; a stale-status-file handling bug in run-integ-suites.mjs)
  and filed them against itself as apra-fleet-9te.2/9te.3; Cycle 2 planned,
  fixed, reviewer-approved, and closed both. That self-discovered-bug arc
  became the GIF's actual story instead of the mundane target beads.
  Captioned with burned-in text (Pillow -- no ffmpeg available locally) per
  the beat sheet in docs/marketing/gfx2-story.md (frame-range-verified
  against extracted PNGs, not guessed). Final asset:
  assets/marketing/dashboard-demo.gif (27 frames, 4.7MB, 1568x717), wired
  into the draft's GFX-2 slot, replacing the placeholder block.
- 2026-07-24 (README promotion, user-directed): promoted
  docs/marketing/readme-rewrite-draft.md to /README.md and deleted the
  draft file. Before replacing, migrated the deep-dive sections the ground
  rule (section 5) says not to delete on promotion: Transport + Event Bus +
  stdio + Service Mode + Supported user-facing interfaces -> new
  docs/transport-and-service-mode.md; Cost (model tiers, shell-over-
  prompts, smart sessions, measured token spend) -> new docs/cost-model.md;
  The PM skill (command table, cost accounting) -> new
  docs/pm-skill-overview.md; the provider role-matrix/OpenCode/local-model/
  register-from-shell content -> merged into the existing
  docs/provider-guide.md (its role table already existed; only the missing
  content was appended, not duplicated). The old README's Documentation/
  Community/Development/License sections were preserved as-is (not part of
  the draft, not marketing copy, would otherwise have been silently
  dropped) and appended after the draft's "Status and roadmap" section;
  the Documentation table gained rows for the three new docs pages. Image
  paths were rewritten from the draft's docs/marketing-relative
  `../../assets/...` to root-relative `assets/...` since README.md lives
  at the repo root. The old README's "Watch a real run" YouTube embed
  (SGdHvIkSbY8) and its `/pm`-first quickstart are gone, superseded by the
  draft's GFX-2 GIF and conversational-registration quickstart -- this was
  the intended positioning change, not an oversight.
  NOTE (deferred, not done here): the two open positioning decisions
  (section 6) -- the "Reliable Deterministic Workflows + Memory" pitch
  angle and the Security-section reorder -- were still unresolved when
  this promotion happened; the user explicitly chose to promote now rather
  than wait. If either decision lands later, README.md itself is the
  editable source now (the draft file no longer exists).
