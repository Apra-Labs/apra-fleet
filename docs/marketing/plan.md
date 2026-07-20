# Marketing Track: README Rewrite + github.io Site

Living plan for repositioning apra-fleet's public face. Maintained
alongside the work; update statuses in place as items land.

## Positioning (decided)

- **Category claim**: agent fleet platform -- own the word "fleet".
  One control plane: any device, any model, any workflow.
- **Analogy** (used once, early): "What Kubernetes did for containers,
  apra-fleet does for AI agents" -- category placement in one sentence.
- **Proof lead**: "This repository is built by the product you are looking
  at." Real dashboard recording, real sprint transcripts, never mockups.
- **Wedge vs platform**: the pitch OPENS with the working vertical
  (autonomous software engineering via auto-sprint) and frames platform
  generality (retail/logistics/healthcare) as the arc -- focus reads as
  discipline; "platform for everything" unproven reads as a red flag.
- **Audience split**: README converts developers in 30 seconds;
  github.io converts investors/press/high-rollers in 3 minutes.

## Ground rules

- ASCII only (repo policy). Mermaid for evolving diagrams (diffs in PRs).
- Every command shown must be verified against the shipped CLI/README --
  no invented flows (a hallucinated quickstart was caught 2026-07-20;
  the REAL flow -- npm/binary install, /mcp connect, conversational member
  registration, `apra-fleet workflow ...` -- is also the better story).
- No fabricated numbers: dogfood stats come from real runs (suite counts,
  cycles, bugs self-filed/fixed).

## Workstream 1: README.md rewrite

Draft: [readme-rewrite-draft.md](readme-rewrite-draft.md) (promote to
/README.md at a sprint-run boundary -- the harvester appends to the live
README during Final Harvest, so landing mid-run invites merge noise).

Structure (first 30 seconds -> 5 minutes):
1. Hero banner [GFX-1] + one-line claim + k8s sentence
2. Dashboard GIF [GFX-2] + "built by itself" proof caption
3. "Why a fleet?" -- 4 operational pains + pillars drumbeat
4. Pillars table (Any device / Any model / Any workflow)
5. Flagship: auto-sprint with real dogfood numbers
6. Quick start (verified real flow, 4 steps)
7. How it works (mermaid) + security paragraph + package map
8. Status/roadmap + closing CTA

Status:
- [x] Positioning brainstorm + decision (2026-07-20)
- [x] First full draft committed
- [x] Quickstart corrected to the real npm//mcp/conversational flow
- [ ] User review pass on draft copy
- [ ] Dogfood numbers refreshed from the finished run (cycles, tests,
      bugs self-filed/fixed) -- source: stabilization log + sprint logs
- [ ] GFX-1 hero banner produced (spec in draft footer)
- [ ] GFX-2 dashboard GIF recorded -- WAIT for run 16+ (lean-state viewer,
      eft.27) so the hero asset is smooth, not the sluggish old viewer
- [ ] GFX-3 fleet topology SVG produced (spec in draft footer)
- [ ] Promote draft to /README.md at run boundary; keep deep-dive
      sections (transport, service mode, PM skill) by moving them into
      docs/ rather than deleting

## Workstream 2: github.io site

Purpose: branded, marketing-grade companion -- features, story, evidence.
Target audiences: VCs / ProductHunt / YC / agentic-AI press.

Plan:
- Hosting: GitHub Pages. Preference: `docs-site/` folder (or gh-pages
  branch) on this repo; decide when scaffolding.
- Stack: keep trivial -- plain HTML/CSS or Astro; no build complexity
  that outlives its usefulness. Dark-first, one accent, real product
  screenshots/recordings only.
- Page map (v1):
  1. Landing: hero, pillars, dashboard video embed, provider matrix
  2. "It builds itself": the dogfood story with real sprint transcript
     excerpts and run timelines as evidence
  3. Security: credential store, OOB secrets, egress policy, permission
     composition
  4. Workflows: engine model (durable, resumable, observable) + supervisor
  5. Get started: mirrors README quickstart + links to docs
- Sequencing: README lands first; its copy becomes the site skeleton.
  Prototype the landing page as a private artifact for user reaction
  before anything goes public.

Status:
- [ ] Scaffold decision (docs-site/ vs gh-pages branch)
- [ ] Landing page prototype (private artifact for review)
- [ ] Copy adaptation from final README
- [ ] Domain/branding decision (apralabs.com linkage)
- [ ] Publish + link from README hero nav

## Asset inventory

| Asset | Spec | Status |
|---|---|---|
| GFX-1 hero banner | 1280x320 SVG/PNG, dark+light variants, device constellation + control hexagon | not started |
| GFX-2 dashboard GIF | real recording, 20-30s, 1200px, <8MB, record on run 16+ viewer | blocked on eft.27 viewer |
| GFX-3 fleet topology | 900px SVG, control plane -> heterogeneous members with provider badges | not started |
| GFX-4 architecture | mermaid in README (renders natively) | in draft |
| Badges | shields.io: build, release, license, providers, platforms | pending README landing |

## Log

- 2026-07-20: positioning decided; first draft written and committed;
  hallucinated quickstart caught by user and replaced with the real flow;
  track moved to docs/marketing/.
